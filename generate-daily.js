/**
 * generate-daily.js
 * -----------------
 * 1. Picks today's criminal from criminals.json
 * 2. Gemini 2.5 Pro → full article + short audio summary
 * 3. Azure TTS → audio/{{slug}}.mp3 (full article, no char limit on free tier)
 * 4. Builds criminals/{{slug}}.html from template-criminal.html
 * 5. Builds index.html from template-index.html (homepage)
 * 6. Rebuilds archive.html from template-archive.html
 *
 * Env vars: GEMINI_API_KEY, AZURE_SPEECH_KEY, AZURE_SPEECH_REGION
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────

const GEMINI_API_KEY      = process.env.GEMINI_API_KEY;
const AZURE_SPEECH_KEY    = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION; // e.g. "eastus"
const AZURE_VOICE         = 'en-GB-RyanNeural'; // cinematic British voice

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(
      { hostname, path: urlPath, method: 'POST',
        headers: { 'Content-Length': Buffer.byteLength(bodyStr), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function getTodayDayNumber() {
  const launch = new Date('2026-03-31T00:00:00Z');
  const diff   = Math.floor((new Date() - launch) / 86400000);
  return (diff % 365) + 1;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textToParagraphs(text) {
  return text.split(/\n\n+/)
    .map(p => p.trim().replace(/\n/g, ' '))
    .filter(p => p.length > 0)
    .map(p => `      <p>${escapeHtml(p)}</p>`)
    .join('\n\n');
}

function getFirstParagraph(text) {
  const paras = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
  return paras[0] || '';
}

function nameDisplay(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? `${parts.slice(0, -1).join(' ')}<br>${parts[parts.length - 1]}`
    : name;
}

// ── Load data ─────────────────────────────────────────────────────────────────

const criminals = JSON.parse(fs.readFileSync('criminals.json', 'utf8'));
const dayNumber = getTodayDayNumber();
const criminal  = criminals.find(c => c.day === dayNumber) || criminals[0];

console.log(`Day ${dayNumber}: ${criminal.name} (${criminal.country})`);

// ── Gemini: generate full article + audio summary ─────────────────────────────

async function generateContent(criminal) {
  console.log('Calling Gemini 2.5 Pro...');

  const systemPrompt = `You are a true crime journalist writing for a serious long-form publication.
Your style is precise, factual, and restrained — like a seasoned detective reviewing a cold case file.
No melodrama, no purple prose. Clinical where necessary, human where it matters.
Think: the tone of a BBC documentary narrated by someone who has seen too much to be shocked anymore.
Write in English.`;

  const userPrompt = `Write a 5-paragraph profile of ${criminal.name}${criminal.alias ? ` ("${criminal.alias}")` : ''} from ${criminal.country}.

Wikipedia context: ${criminal.wiki_summary || 'No context available.'}
Facts: active ${criminal.period}, ${criminal.victims} victims.

Structure:
- Paragraph 1: who they were before the crimes — background, context, ordinary life
- Paragraph 2: the crimes — method, pattern, victims, timeline. Be specific: how did they select victims, what exactly happened, what did investigators find. Named victims where known. Do not sanitize but do not sensationalize.
- Paragraph 3: how they evaded detection and why — institutional failures, luck, geography
- Paragraph 4: capture and trial — how it ended
- Paragraph 5: what the case revealed — about the system, the era, human nature

Rules:
- No cinematic opening lines
- No metaphors about darkness or shadows
- Specific details over general atmosphere
- 600-800 words, pure prose, no headers
- Do not add any labels, titles, or structural markers like "Part 1" or "Paragraph 1"
- Start directly with the first sentence of the profile`;

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.85, maxOutputTokens: 8192 }
  };

  const { status, buffer } = await httpsPost(
    'generativelanguage.googleapis.com',
    `/v1beta/models/gemini-2.5-pro:generateContent?key=${GEMINI_API_KEY}`,
    { 'Content-Type': 'application/json' },
    body
  );

  const data = JSON.parse(buffer.toString());

  if (status !== 200) {
    console.error('Gemini error:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.error('No text from Gemini. Full response:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  // Strip any structural labels Gemini might add despite instructions
  const cleaned = text
    .replace(/^(Part\s+\w+|Paragraph\s+\d+|Section\s+\d+)[:\s]*/gim, '')
    .replace(/^\*\*.*?\*\*\s*/gm, '')
    .trim();

  console.log(`Article generated: ${cleaned.length} chars`);
  return cleaned;
}

// ── Azure TTS: generate audio from full article ───────────────────────────────

async function generateAudio(slug, text) {
  console.log('Calling Azure TTS...');

  // Step 1: get access token
  const tokenRes = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: `${AZURE_SPEECH_REGION}.api.cognitive.microsoft.com`,
        path: '/sts/v1.0/issueToken',
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
          'Content-Length': 0
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on('error', reject);
    req.end();
  });

  if (tokenRes.status !== 200) {
    console.error('Azure token error:', tokenRes.status, tokenRes.body);
    process.exit(1);
  }

  const accessToken = tokenRes.body;

  // Step 2: synthesize speech with SSML
  // Clean text for SSML — remove special chars that break XML
  const cleanText = text
    .replace(/&/g, 'and')
    .replace(/</g, '')
    .replace(/>/g, '')
    .replace(/"/g, '')
    .replace(/'/g, "'");

  const ssml = `<speak version='1.0' xml:lang='en-GB'>
  <voice name='${AZURE_VOICE}'>
    <prosody rate='0.95' pitch='-5%'>
      ${cleanText}
    </prosody>
  </voice>
</speak>`;

  const { status, buffer } = await httpsPost(
    `${AZURE_SPEECH_REGION}.tts.speech.microsoft.com`,
    '/cognitiveservices/v1',
    {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
      'User-Agent': 'CriminalOfTheDay'
    },
    ssml
  );

  if (status !== 200) {
    console.error(`Azure TTS error ${status}:`, buffer.toString());
    process.exit(1);
  }

  const audioDir = path.join(__dirname, 'audio');
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

  // Salvăm cu slug pentru pagina individuală
  fs.writeFileSync(path.join(audioDir, `${slug}.mp3`), buffer);
  // Salvăm și ca current.mp3 pentru homepage
  fs.writeFileSync(path.join(audioDir, 'current.mp3'), buffer);
  console.log(`Audio saved: audio/${slug}.mp3 + audio/current.mp3 (${(buffer.length / 1024).toFixed(1)} KB)`);
}

// ── Build criminal page ───────────────────────────────────────────────────────

function buildCriminalPage(criminal, fullArticle) {
  const template = fs.readFileSync('template-criminal.html', 'utf8');

  const slug        = criminal.slug;
  const dayPadded   = String(criminal.day).padStart(3, '0');
  const year        = new Date().getFullYear();
  const countryCode = criminal.country.slice(0, 2).toUpperCase();
  const aliasDisplay = criminal.alias ? `"${escapeHtml(criminal.alias)}"` : '&nbsp;';
  const metaDesc    = `${criminal.name}${criminal.alias ? `, known as ${criminal.alias},` : ''} — serial killer from ${criminal.country}, active ${criminal.period}. ${getFirstParagraph(fullArticle).slice(0, 120)}...`;

  const tagsHtml = (criminal.tags || [])
    .filter(t => t && t.length > 1)
    .map(t => `      <span class="tag">${escapeHtml(t)}</span>`)
    .join('\n');

  const html = template
    .replace(/\{\{NAME\}\}/g,          escapeHtml(criminal.name))
    .replace(/\{\{NAME_DISPLAY\}\}/g,  nameDisplay(criminal.name))
    .replace(/\{\{ALIAS_DISPLAY\}\}/g, aliasDisplay)
    .replace(/\{\{ALIAS\}\}/g,         escapeHtml(criminal.alias || criminal.name))
    .replace(/\{\{SLUG\}\}/g,          slug)
    .replace(/\{\{COUNTRY\}\}/g,       escapeHtml(criminal.country))
    .replace(/\{\{COUNTRY_CODE\}\}/g,  countryCode)
    .replace(/\{\{PERIOD\}\}/g,        escapeHtml(criminal.period))
    .replace(/\{\{VICTIMS\}\}/g,       escapeHtml(criminal.victims))
    .replace(/\{\{SENTENCE\}\}/g,      escapeHtml(criminal.sentence || '—'))
    .replace(/\{\{DAY_PADDED\}\}/g,    dayPadded)
    .replace(/\{\{YEAR\}\}/g,          String(year))
    .replace(/\{\{META_DESCRIPTION\}\}/g, escapeHtml(metaDesc))
    .replace(/\{\{ARTICLE\}\}/g,       textToParagraphs(fullArticle))
    .replace(/\{\{TAGS\}\}/g,          tagsHtml);

  const criminalsDir = path.join(__dirname, 'criminals');
  if (!fs.existsSync(criminalsDir)) fs.mkdirSync(criminalsDir, { recursive: true });

  const outputPath = path.join(criminalsDir, `${slug}.html`);
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`Criminal page: criminals/${slug}.html`);
}

// ── Build homepage ────────────────────────────────────────────────────────────

function buildHomepage(criminal, fullArticle) {
  const template = fs.readFileSync('template-index.html', 'utf8');

  const slug        = criminal.slug;
  const dayPadded   = String(criminal.day).padStart(3, '0');
  const year        = new Date().getFullYear();
  const countryCode = criminal.country.slice(0, 2).toUpperCase();
  const aliasDisplay = criminal.alias ? `"${escapeHtml(criminal.alias)}"` : '&nbsp;';
  const metaDesc    = `Today on Criminal of the Day: ${criminal.name}${criminal.alias ? ` (${criminal.alias})` : ''} from ${criminal.country}.`;

  // Preview = first 2 paragraphs only
  const previewText = fullArticle.split(/\n\n+/).slice(0, 2).join('\n\n');

  const tagsHtml = (criminal.tags || [])
    .filter(t => t && t.length > 1)
    .map(t => `      <span class="tag">${escapeHtml(t)}</span>`)
    .join('\n');

  // Recent cards — last 7 published criminals (those with existing pages)
  const criminalsDir = path.join(__dirname, 'criminals');
  const recentCards = criminals
    .filter(c => c.day < criminal.day && fs.existsSync(path.join(criminalsDir, `${c.slug}.html`)))
    .sort((a, b) => b.day - a.day)
    .slice(0, 7)
    .map(c => `    <a href="/criminals/${c.slug}.html" class="recent-card">
      <div class="recent-card-day">Day ${String(c.day).padStart(3,'0')} · ${escapeHtml(c.country)}</div>
      <div class="recent-card-name">${escapeHtml(c.name)}</div>
      ${c.alias ? `<div class="recent-card-alias">"${escapeHtml(c.alias)}"</div>` : ''}
      <div class="recent-card-meta">${escapeHtml(c.period)} · ${escapeHtml(c.victims)} victims</div>
    </a>`)
    .join('\n');

  const html = template
    .replace(/\{\{NAME\}\}/g,          escapeHtml(criminal.name))
    .replace(/\{\{NAME_DISPLAY\}\}/g,  nameDisplay(criminal.name))
    .replace(/\{\{ALIAS_DISPLAY\}\}/g, aliasDisplay)
    .replace(/\{\{ALIAS\}\}/g,         escapeHtml(criminal.alias || criminal.name))
    .replace(/\{\{SLUG\}\}/g,          slug)
    .replace(/\{\{COUNTRY\}\}/g,       escapeHtml(criminal.country))
    .replace(/\{\{COUNTRY_CODE\}\}/g,  countryCode)
    .replace(/\{\{PERIOD\}\}/g,        escapeHtml(criminal.period))
    .replace(/\{\{VICTIMS\}\}/g,       escapeHtml(criminal.victims))
    .replace(/\{\{SENTENCE\}\}/g,      escapeHtml(criminal.sentence || '—'))
    .replace(/\{\{DAY_PADDED\}\}/g,    dayPadded)
    .replace(/\{\{YEAR\}\}/g,          String(year))
    .replace(/\{\{META_DESCRIPTION\}\}/g, escapeHtml(metaDesc))
    .replace(/\{\{ARTICLE_PREVIEW\}\}/g,  textToParagraphs(previewText))
    .replace(/\{\{TAGS\}\}/g,          tagsHtml)
    .replace(/\{\{RECENT_CARDS\}\}/g,  recentCards || '    <div style="padding:2rem;color:#4a3f32;font-family:\'Space Mono\',monospace;font-size:9px;">No previous cases yet.</div>');

  fs.writeFileSync('index.html', html, 'utf8');
  console.log('Homepage: index.html');
}

// ── Build archive ─────────────────────────────────────────────────────────────

function buildArchive() {
  const template = fs.readFileSync('template-archive.html', 'utf8');
  const criminalsDir = path.join(__dirname, 'criminals');

  const published = criminals
    .filter(c => fs.existsSync(path.join(criminalsDir, `${c.slug}.html`)))
    .sort((a, b) => b.day - a.day);

  const archiveCards = published
    .map(c => `  <a href="/criminals/${c.slug}.html" class="archive-card">
    <div class="archive-card-day">Day ${String(c.day).padStart(3,'0')} · ${escapeHtml(c.country)}</div>
    <div class="archive-card-name">${escapeHtml(c.name)}</div>
    ${c.alias ? `<div class="archive-card-alias">"${escapeHtml(c.alias)}"</div>` : ''}
    <div class="archive-card-meta">${escapeHtml(c.period)} · ${escapeHtml(c.victims)} victims</div>
  </a>`)
    .join('\n');

  const countries = new Set(published.map(c => c.country)).size;

  const html = template
    .replace(/\{\{TOTAL\}\}/g,    String(published.length))
    .replace(/\{\{COUNTRIES\}\}/g, String(countries))
    .replace(/\{\{ARCHIVE_CARDS\}\}/g, archiveCards || '  <div style="padding:2rem;color:#4a3f32;font-family:\'Space Mono\',monospace;font-size:9px;">No cases yet.</div>');

  fs.writeFileSync('archive.html', html, 'utf8');
  console.log(`Archive: archive.html (${published.length} cases)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const article = await generateContent(criminal);
    await generateAudio(criminal.slug, article);
    buildCriminalPage(criminal, article);
    buildHomepage(criminal, article);
    buildArchive();
    console.log('\nAll done!');
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
