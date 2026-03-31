/**
 * generate-daily.js
 * -----------------
 * 1. Picks today's criminal from criminals.json
 * 2. Gemini 2.5 Pro → full article + short audio summary
 * 3. ElevenLabs → audio/{{slug}}.mp3 (from short summary, fits free tier)
 * 4. Builds criminals/{{slug}}.html from template-criminal.html
 * 5. Builds index.html from template-index.html (homepage)
 * 6. Rebuilds archive.html from template-archive.html
 *
 * Env vars: GEMINI_API_KEY, ELEVENLABS_API_KEY
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────

const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE   = 'pNInz6obpgDQGcFmaJgB'; // Adam — free tier
const ELEVENLABS_MODEL   = 'eleven_multilingual_v2';
const MAX_AUDIO_CHARS    = 2400; // safe under ElevenLabs free tier limit

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

  const systemPrompt = `You are a true crime writer with a literary noir style.
Write criminal profiles like opening chapters of a crime novel — atmospheric, precise, cold.
Think Thomas Harris. No headers, no bullets, only flowing prose. Always in English.`;

  const userPrompt = `Write TWO pieces about ${criminal.name}${criminal.alias ? ` ("${criminal.alias}")` : ''} from ${criminal.country}.

Wikipedia context: ${criminal.wiki_summary || 'No context available.'}
Facts: active ${criminal.period}, ${criminal.victims} victims.

PIECE 1 — FULL ARTICLE (label it exactly: FULL_ARTICLE_START)
5 paragraphs, 600-800 words, literary noir prose.
Cover: origins, crimes, investigation, capture, psychological/social meaning.
Cinematic first sentence. No preamble.

PIECE 2 — AUDIO SUMMARY (label it exactly: AUDIO_SUMMARY_START)
2 paragraphs, maximum 350 words. Same noir style but tighter.
This will be read aloud — write for the ear, not the eye.
No em-dashes (use commas instead). No complex punctuation.

Format your response EXACTLY like this:
FULL_ARTICLE_START
[full article here]
AUDIO_SUMMARY_START
[audio summary here]`;

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

  // Parse the two sections
  const fullMatch  = text.match(/FULL_ARTICLE_START\s*([\s\S]*?)(?=AUDIO_SUMMARY_START|$)/);
  const audioMatch = text.match(/AUDIO_SUMMARY_START\s*([\s\S]*?)$/);

  const fullArticle  = fullMatch  ? fullMatch[1].trim()  : text.trim();
  const audioSummary = audioMatch ? audioMatch[1].trim() : getFirstParagraph(text);

  console.log(`Full article: ${fullArticle.length} chars`);
  console.log(`Audio summary: ${audioSummary.length} chars`);

  if (audioSummary.length > MAX_AUDIO_CHARS) {
    console.warn(`Audio summary truncated from ${audioSummary.length} to ${MAX_AUDIO_CHARS}`);
  }

  return {
    fullArticle,
    audioSummary: audioSummary.slice(0, MAX_AUDIO_CHARS)
  };
}

// ── ElevenLabs: generate audio from summary ───────────────────────────────────

async function generateAudio(slug, text) {
  console.log('Calling ElevenLabs...');

  const body = JSON.stringify({
    text,
    model_id: ELEVENLABS_MODEL,
    voice_settings: {
      stability: 0.55, similarity_boost: 0.80,
      style: 0.25, use_speaker_boost: true, speed: 1.15
    }
  });

  const { status, buffer } = await httpsPost(
    'api.elevenlabs.io',
    `/v1/text-to-speech/${ELEVENLABS_VOICE}`,
    { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body
  );

  if (status !== 200) {
    console.error('ElevenLabs error:', buffer.toString());
    process.exit(1);
  }

  const audioDir = path.join(__dirname, 'audio');
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

  const outputPath = path.join(audioDir, `${slug}.mp3`);
  fs.writeFileSync(outputPath, buffer);
  console.log(`Audio saved: audio/${slug}.mp3 (${(buffer.length / 1024).toFixed(1)} KB)`);
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
    const { fullArticle, audioSummary } = await generateContent(criminal);
    await generateAudio(criminal.slug, audioSummary);
    buildCriminalPage(criminal, fullArticle);
    buildHomepage(criminal, fullArticle);
    buildArchive();
    console.log('\nAll done!');
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
