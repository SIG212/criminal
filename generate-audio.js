const fs = require('fs');
const path = require('path');
const https = require('https');

const VOICE_ID = 'pNInz6obpgDQGcFmaJgB'; // Adam
const MODEL_ID = 'eleven_multilingual_v2';
const API_KEY  = process.env.ELEVENLABS_API_KEY;

if (!API_KEY) {
  console.error('Missing ELEVENLABS_API_KEY');
  process.exit(1);
}

// ── 1. Extrage textul din index.html ─────────────────────────────────────────

const html = fs.readFileSync('index.html', 'utf8');

// Preia tot ce e între <div ... id="article-text"> și </div> următor
const match = html.match(/id="article-text">([\s\S]*?)<\/div>/);
if (!match) {
  console.error('Could not find #article-text in index.html');
  process.exit(1);
}

const rawText = match[1]
  .replace(/<[^>]+>/g, ' ')   // scoate tag-urile HTML
  .replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ')
  .replace(/&mdash;/g, '—')
  .replace(/&rsquo;/g, "'")
  .replace(/&ldquo;/g, '"')
  .replace(/&rdquo;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

console.log(`Extracted ${rawText.length} characters from article.`);

if (rawText.length === 0) {
  console.error('Extracted text is empty.');
  process.exit(1);
}

// ElevenLabs free tier: max 2500 chars per request
// Dacă articolul e mai lung, tăiem la 2500 (ajustează dacă ai plan paid)
const text = rawText.length > 2500 ? rawText.slice(0, 2500) : rawText;
if (rawText.length > 2500) {
  console.warn(`Article is ${rawText.length} chars — truncated to 2500 for free tier.`);
}

// ── 2. Apelează ElevenLabs TTS ───────────────────────────────────────────────

const body = JSON.stringify({
  text,
  model_id: MODEL_ID,
  voice_settings: {
    stability: 0.45,
    similarity_boost: 0.75,
    style: 0.35,
    use_speaker_boost: true
  }
});

const options = {
  hostname: 'api.elevenlabs.io',
  path: `/v1/text-to-speech/${VOICE_ID}`,
  method: 'POST',
  headers: {
    'xi-api-key': API_KEY,
    'Content-Type': 'application/json',
    'Accept': 'audio/mpeg',
    'Content-Length': Buffer.byteLength(body)
  }
};

console.log('Calling ElevenLabs API...');

const req = https.request(options, (res) => {
  if (res.statusCode !== 200) {
    let errData = '';
    res.on('data', chunk => errData += chunk);
    res.on('end', () => {
      console.error(`ElevenLabs error ${res.statusCode}:`, errData);
      process.exit(1);
    });
    return;
  }

  // ── 3. Salvează MP3 ─────────────────────────────────────────────────────────
  const audioDir = path.join(__dirname, 'audio');
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

  const outputPath = path.join(audioDir, 'current.mp3');
  const fileStream = fs.createWriteStream(outputPath);

  res.pipe(fileStream);

  fileStream.on('finish', () => {
    const size = fs.statSync(outputPath).size;
    console.log(`Audio saved to audio/current.mp3 (${(size / 1024).toFixed(1)} KB)`);
  });

  fileStream.on('error', (err) => {
    console.error('Error writing file:', err);
    process.exit(1);
  });
});

req.on('error', (err) => {
  console.error('Request error:', err);
  process.exit(1);
});

req.write(body);
req.end();
