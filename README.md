# Criminal of the Day

A daily true crime site. Every day, one criminal, one country, one literary noir profile + audio.

## Stack
- **Frontend**: Static HTML/CSS/JS
- **Hosting**: Vercel
- **Article generation**: Gemini Flash 2.0 (free)
- **Audio**: ElevenLabs (free tier)
- **Automation**: GitHub Actions (daily cron)

## Setup

### 1. Scrape criminals list (run once locally)
```bash
pip install requests beautifulsoup4
python scrape_criminals.py
# → produces criminals.json, upload it to repo
```

### 2. Add GitHub Secrets
Go to Repo → Settings → Secrets → Actions:
- `GEMINI_API_KEY` — from aistudio.google.com (free)
- `ELEVENLABS_API_KEY` — from elevenlabs.io

### 3. Deploy to Vercel
Connect GitHub repo to Vercel. No build config needed — pure static.

### 4. Test the workflow
GitHub → Actions → "Generate Daily Criminal" → Run workflow

## File structure
```
/
├── index.html                          ← main page (auto-updated daily)
├── generate-daily.js                   ← daily automation script
├── generate-audio.js                   ← legacy: manual audio generation
├── scrape_criminals.py                 ← run once to build criminals.json
├── criminals.json                      ← populated by scraper, uploaded manually
├── audio/
│   └── current.mp3                     ← auto-generated daily
├── api/
│   └── tts.js                          ← legacy Vercel serverless function
└── .github/
    └── workflows/
        └── generate-audio.yml          ← daily cron job
```

## How it works daily
1. GitHub Actions triggers at 06:00 UTC
2. `generate-daily.js` picks today's criminal from `criminals.json`
3. Gemini Flash generates a 600-800 word literary noir article
4. ElevenLabs generates `audio/current.mp3`
5. `index.html` is updated with new content
6. Changes committed back to repo → Vercel redeploys automatically
