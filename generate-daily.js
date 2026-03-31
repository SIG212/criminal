/**
 * generate-daily.js
 * -----------------
 * Runs daily via GitHub Actions.
 * 1. Reads criminals.json → picks today's criminal by day number
 * 2. Calls Gemini Flash to generate a literary noir article
 * 3. Updates index.html with new content
 * 4. Calls ElevenLabs to generate audio/current.mp3
 *
 * Env vars required:
 *   GEMINI_API_KEY
 *   ELEVENLABS_API_KEY
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────

const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE   = 'pNInz6obpgDQGcFmaJgB'; // Adam
const ELEVENLABS_MODEL   = 'eleven_multilingual_v2';
const MAX_CHARS_FREE     = 2500; // ElevenLabs free tier limit per request

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: { 'Content-Length': Buffer.byteLength(bodyStr), ...headers }
      },
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

function getTodayDayNumber() {
  // Day 1 = 2026-03-31 (launch date) — adjust to your actual launch date
  const launch = new Date('2026-03-31T00:00:00Z');
  const now    = new Date();
  const diff   = Math.floor((now - launch) / (1000 * 60 * 60 * 24));
  return (diff % 365) + 1; // cycles through the year
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapParagraphs(text) {
  return text
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map(p => `      <p>${escapeHtml(p)}</p>`)
    .join('\n\n');
}

// ── Step 1: Pick today's criminal ─────────────────────────────────────────────

const criminals = JSON.parse(fs.readFileSync('criminals.json', 'utf8'));
const dayNumber = getTodayDayNumber();
const criminal  = criminals.find(c => c.day === dayNumber) || criminals[0];

console.log(`Day ${dayNumber}: ${criminal.name} (${criminal.country})`);

// ── Step 2: Generate article with Gemini ──────────────────────────────────────

async function generateArticle(criminal) {
  console.log('Calling Gemini Flash...');

  const systemPrompt = `You are a true crime writer with a literary noir style.
You write criminal profiles that read like the opening chapter of a crime novel — atmospheric, precise, cold.
Think Thomas Harris meets an Eastern European winter — or wherever this criminal is from.
Never use headers, bullet points, or lists. Only flowing prose.
Always write in English.`;

  const userPrompt = `Write a 5-paragraph literary noir profile of ${criminal.name}${criminal.alias ? `, known as "${criminal.alias}"` : ''}, a serial killer from ${criminal.country}.

Background context from Wikipedia:
${criminal.wiki_summary || 'No additional context available.'}

Known facts:
- Active period: ${criminal.period}
- Confirmed victims: ${criminal.victims}
- Country: ${criminal.country}

Include:
- Their origins and background
- The crimes in detail
- The investigation and how authorities responded
- Capture and sentence
- What they represent psychologically and socially

Style rules:
- Start with a cinematic first sentence, no preamble, no "Here is the profile" intro
- Atmospheric, literary, cold — not sensationalist
- 600–800 words total
- Pure flowing prose, no headers, no bullets`;

  const body = {
    contents: [
      { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }
    ],
    generationConfig: {
      temperature: 0.85,
      maxOutputTokens: 1200
    }
  };

  const { status, buffer } = await httpsPost(
    'generativelanguage.googleapis.com',
    `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
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
    console.error('No text in Gemini response');
    process.exit(1);
  }

  console.log(`Article generated (${text.length} chars)`);
  return text.trim();
}

// ── Step 3: Generate audio with ElevenLabs ────────────────────────────────────

async function generateAudio(text) {
  console.log('Calling ElevenLabs...');

  // Truncate to free tier limit
  const audioText = text.length > MAX_CHARS_FREE
    ? text.slice(0, MAX_CHARS_FREE)
    : text;

  if (text.length > MAX_CHARS_FREE) {
    console.warn(`Text truncated from ${text.length} to ${MAX_CHARS_FREE} chars for free tier`);
  }

  const body = JSON.stringify({
    text: audioText,
    model_id: ELEVENLABS_MODEL,
    voice_settings: {
      stability: 0.45,
      similarity_boost: 0.75,
      style: 0.35,
      use_speaker_boost: true
    }
  });

  const { status, buffer } = await httpsPost(
    'api.elevenlabs.io',
    `/v1/text-to-speech/${ELEVENLABS_VOICE}`,
    {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body
  );

  if (status !== 200) {
    console.error('ElevenLabs error:', buffer.toString());
    process.exit(1);
  }

  const audioDir = path.join(__dirname, 'audio');
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

  const outputPath = path.join(audioDir, 'current.mp3');
  fs.writeFileSync(outputPath, buffer);
  console.log(`Audio saved (${(buffer.length / 1024).toFixed(1)} KB)`);
}

// ── Step 4: Update index.html ─────────────────────────────────────────────────

function updateHtml(criminal, articleText) {
  console.log('Updating index.html...');

  let html = fs.readFileSync('index.html', 'utf8');

  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  const dayPadded = String(criminal.day).padStart(3, '0');

  // Tags
  const tags = (criminal.tags || [])
    .filter(t => t && t.length > 1)
    .map(t => `      <span class="tag">${escapeHtml(t)}</span>`)
    .join('\n');

  // Split name for display (first + last on separate lines if two words)
  const nameParts = criminal.name.trim().split(/\s+/);
  const displayName = nameParts.length >= 2
    ? `${nameParts.slice(0, -1).join(' ')}<br>${nameParts[nameParts.length - 1]}`
    : criminal.name;

  // Article paragraphs
  const articleHtml = wrapParagraphs(articleText);

  // Replacements
  const replacements = [
    // Page title
    [
      /<title>Criminal of the Day[^<]*<\/title>/,
      `<title>Criminal of the Day — ${criminal.name}</title>`
    ],
    // Masthead date
    [
      /(<div class="masthead-date">)[^<]*/,
      `$1${today} &nbsp;/&nbsp; Day ${dayPadded}`
    ],
    // Case number
    [
      /(<div class="case-number">Dosar \/ Case No\. )[^<]*/,
      `$1${new Date().getFullYear()}-${criminal.country.slice(0,2).toUpperCase()}-${dayPadded}</div`
    ],
    // Stats
    [
      /(<div class="stat-pill"><span>Confirmed Victims<\/span><span>)[^<]*/,
      `$1${escapeHtml(criminal.victims)}</span></div`
    ],
    [
      /(<div class="stat-pill"><span>Active Period<\/span><span>)[^<]*/,
      `$1${escapeHtml(criminal.period)}</span></div`
    ],
    [
      /(<div class="stat-pill"><span>(?:Sentence|Died in prison)<\/span><span>)[^<]*/,
      `$1${escapeHtml(criminal.sentence || '—')}</span></div`
    ],
    // Photo side label
    [
      /(<div class="photo-side-label">)[^<]*/,
      `$1${escapeHtml(criminal.country)} · ${criminal.period}</div`
    ],
    // Day label
    [
      /(<div class="day-label">Day \d+ — )[^<]*/,
      `$1${escapeHtml(criminal.country)}</div`
    ],
    // Criminal name
    [
      /(<h1 class="criminal-name">)[\s\S]*?(<\/h1>)/,
      `$1${displayName}$2`
    ],
    // Alias
    [
      /(<div class="criminal-alias">)[^<]*/,
      `$1${criminal.alias ? `"${escapeHtml(criminal.alias)}"` : '&nbsp;'}</div`
    ],
    // Article body
    [
      /(<div class="article-body" id="article-text">)[\s\S]*?(<\/div>)/,
      `$1\n${articleHtml}\n    $2`
    ],
    // Player title
    [
      /(<div class="player-title">)[^<]*/,
      `$1${escapeHtml(criminal.name)}${criminal.alias ? ` — ${escapeHtml(criminal.alias)}` : ''}</div`
    ],
    // Tags
    [
      /(<div class="tags">)[\s\S]*?(<\/div>)/,
      `$1\n${tags}\n    $2`
    ]
  ];

  for (const [pattern, replacement] of replacements) {
    html = html.replace(pattern, replacement);
  }

  fs.writeFileSync('index.html', html, 'utf8');
  console.log('index.html updated');
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const article = await generateArticle(criminal);
    await generateAudio(article);
    updateHtml(criminal, article);
    console.log('\nAll done!');
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
