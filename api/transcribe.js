// api/transcribe.js — Vercel serverless endpoint
// Descarga el audio de TikTok y lo manda a Whisper para transcribir

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { videoUrl, apiKey } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl requerido' });
  if (!apiKey)   return res.status(400).json({ error: 'apiKey requerido' });

  try {
    // 1. Descargar el video desde tikwm
    const videoRes = await fetch(videoUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30000),
    });
    if (!videoRes.ok) throw new Error('No se pudo descargar el video');

    const videoBuffer = await videoRes.arrayBuffer();
    const videoBlob   = new Blob([videoBuffer], { type: 'video/mp4' });

    // 2. Mandar a Whisper
    const form = new FormData();
    form.append('file', new File([videoBlob], 'audio.mp4', { type: 'video/mp4' }));
    form.append('model', 'whisper-1');
    form.append('language', 'es');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(55000),
    });

    const whisperJson = await whisperRes.json();
    if (!whisperRes.ok) throw new Error(whisperJson.error?.message || 'Error Whisper');

    return res.status(200).json({ text: whisperJson.text });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
