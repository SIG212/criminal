/**
 * generate-daily.js
 * -----------------
 * Runs daily via GitHub Actions.
 * 1. Reads criminals.json → picks today's criminal
 * 2. Calls Gemini 2.5 Pro to generate a literary noir article
 * 3. Calls ElevenLabs to generate audio/current.mp3
 * 4. Reads template.html, replaces placeholders → writes index.html
 *
 * Env vars required:
 *   GEMINI_API_KEY
 *   ELEVENLABS_API_KEY
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────

const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE   = 'fjnwTZkKtQOJaYzGLa6n';
const ELEVENLABS_MODEL   = 'eleven_multilingual_v2';
const MAX_CHARS_FREE     = 2500;

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path: urlPath,
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
  const launch = new Date('2026-03-31T00:00:00Z');
  const now    = new Date();
  const diff   = Math.floor((now - launch) / (1000 * 60 * 60 * 24));
  return (diff % 365) + 1;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textToParagraphs(text) {
  return text
    .split(/\n\n+/)
    .map(p => p.trim().replace(/\n/g, ' '))
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
  console.log('Calling Gemini...');

  const systemPrompt = `You are a true crime writer with a literary noir style.
You write criminal profiles that read like the opening chapter of a crime novel — atmospheric, precise, cold.
Think Thomas Harris. Never use headers, bullet points, or lists. Only flowing prose. Write in English.`;

  const userPrompt = `Write a 5-paragraph literary noir profile of ${criminal.name}${criminal.alias ? `, known as "${criminal.alias}"` : ''}, from ${criminal.country}.

Wikipedia context:
${criminal.wiki_summary || 'No additional context available.'}

Facts: active ${criminal.period}, ${criminal.victims} victims, ${criminal.country}.

Rules:
- Start with a cinematic first sentence, no preamble
- Cover: origins, crimes, investigation, capture, psychological and social meaning
- 600-800 words, pure flowing prose`;

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
    console.error('No text in Gemini response');
    console.error('Full response:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(`Article generated (${text.length} chars)`);
  return text.trim();
}

// ── Step 3: Generate audio with ElevenLabs ────────────────────────────────────

async function generateAudio(text) {
  console.log('Calling ElevenLabs...');

  const audioText = text.length > MAX_CHARS_FREE ? text.slice(0, MAX_CHARS_FREE) : text;
  if (text.length > MAX_CHARS_FREE) {
    console.warn(`Text truncated to ${MAX_CHARS_FREE} chars for free tier`);
  }

  const body = JSON.stringify({
    text: audioText,
    model_id: ELEVENLABS_MODEL,
    voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.35, use_speaker_boost: true }
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
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);
  fs.writeFileSync(path.join(audioDir, 'current.mp3'), buffer);
  console.log(`Audio saved (${(buffer.length / 1024).toFixed(1)} KB)`);
}

// ── Step 4: Build index.html from template ────────────────────────────────────

function buildHtml(criminal, articleText) {
  console.log('Building index.html from template...');

  const template = fs.readFileSync('template.html', 'utf8');

  const today       = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const dayPadded   = String(criminal.day).padStart(3, '0');
  const year        = new Date().getFullYear();
  const countryCode = criminal.country.slice(0, 2).toUpperCase();

  const nameParts   = criminal.name.trim().split(/\s+/);
  const nameDisplay = nameParts.length >= 2
    ? `${nameParts.slice(0, -1).join(' ')}<br>${nameParts[nameParts.length - 1]}`
    : criminal.name;

  const aliasDisplay = criminal.alias ? `"${escapeHtml(criminal.alias)}"` : '&nbsp;';

  const tagsHtml = (criminal.tags || [])
    .filter(t => t && t.length > 1)
    .map(t => `      <span class="tag">${escapeHtml(t)}</span>`)
    .join('\n');

  const articleHtml = textToParagraphs(articleText);

  const html = template
    .replace(/\{\{NAME\}\}/g,          escapeHtml(criminal.name))
    .replace(/\{\{NAME_DISPLAY\}\}/g,  nameDisplay)
    .replace(/\{\{ALIAS_DISPLAY\}\}/g, aliasDisplay)
    .replace(/\{\{ALIAS\}\}/g,         escapeHtml(criminal.alias || criminal.name))
    .replace(/\{\{COUNTRY\}\}/g,       escapeHtml(criminal.country))
    .replace(/\{\{COUNTRY_CODE\}\}/g,  countryCode)
    .replace(/\{\{PERIOD\}\}/g,        escapeHtml(criminal.period))
    .replace(/\{\{VICTIMS\}\}/g,       escapeHtml(criminal.victims))
    .replace(/\{\{SENTENCE\}\}/g,      escapeHtml(criminal.sentence || '—'))
    .replace(/\{\{DATE\}\}/g,          today)
    .replace(/\{\{DAY_PADDED\}\}/g,    dayPadded)
    .replace(/\{\{YEAR\}\}/g,          String(year))
    .replace(/\{\{ARTICLE\}\}/g,       articleHtml)
    .replace(/\{\{TAGS\}\}/g,          tagsHtml);

  fs.writeFileSync('index.html', html, 'utf8');
  console.log('index.html built successfully');
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const article = await generateArticle(criminal);
    await generateAudio(article);
    buildHtml(criminal, article);
    console.log('\nAll done!');
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
