export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text } = req.body;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'No text provided' });
  }

  if (text.length > 5000) {
    return res.status(400).json({ error: 'Text too long (max 5000 chars)' });
  }

  try {
    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: {
            languageCode: 'en-US',
            name: 'en-US-Wavenet-D'
          },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: 0.88,
            pitch: -2.0,
            effectsProfileId: ['headphone-class-device']
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Google TTS error:', data);
      return res.status(500).json({ error: data.error?.message || 'TTS request failed' });
    }

    return res.status(200).json({ audioContent: data.audioContent });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
