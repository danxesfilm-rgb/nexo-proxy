export const config = { maxDuration: 30 };

// Servidor Render con yt-dlp — configurar YT_SERVER_URL en Vercel env vars
const YT_SERVER = process.env.YT_SERVER_URL || '';

function extractYtId(url) {
  const m = url.match(/(?:v=|youtu\.be\/)([^&?/\s]{8,})/);
  return m ? m[1] : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, service, mode } = req.body || {};
  if (!url)     return res.status(400).json({ error: 'url requerido' });
  if (!service) return res.status(400).json({ error: 'service requerido' });
  if (!mode)    return res.status(400).json({ error: 'mode requerido' });

  const svc = String(service).toLowerCase();
  if (!['instagram', 'tiktok', 'youtube'].includes(svc)) {
    return res.status(400).json({ error: 'Servicio no reconocido.' });
  }

  try {
    /* ── YouTube — vía servidor Railway con yt-dlp ────────────────────── */
    if (svc === 'youtube') {
      const ytId = extractYtId(url);
      if (!ytId) return res.status(400).json({ error: 'URL de YouTube inválida.' });

      if (!YT_SERVER) {
        return res.status(503).json({ error: 'Servidor YT no configurado. Agrega YT_SERVER_URL en Vercel.' });
      }

      const ytUrl = `https://www.youtube.com/watch?v=${ytId}`;

      let data;
      try {
        const r = await fetch(
          `${YT_SERVER}/info?url=${encodeURIComponent(ytUrl)}`,
          { signal: AbortSignal.timeout(25000) }
        );
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          return res.status(r.status).json({ error: err.detail || `YT Server error ${r.status}` });
        }
        data = await r.json();
      } catch (e) {
        return res.status(502).json({ error: `No se pudo conectar al servidor YT: ${e.message}` });
      }

      const videos = (data.formats || []).map(f => ({
        quality:   f.quality,
        url:       f.stream_url,   // URL del /stream del servidor Render
        extension: f.ext,
        type:      f.type === 'audio' ? 'audio' : 'video',
      }));

      if (!videos.length) {
        return res.status(502).json({ error: 'No se encontraron formatos de descarga.' });
      }

      return res.status(200).json({
        title:       data.title,
        thumbnail:   data.thumbnail,
        platform:    'youtube',
        downloadUrl: videos[0].url,
        videos,
      });
    }

    /* ── TikTok / Instagram ─────────────────────────────────────────── */
    let title = '', thumbnail = '', videos = [];

    if (svc === 'tiktok') {
      const tikRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, { signal: AbortSignal.timeout(8000) });
      if (!tikRes.ok) return res.status(502).json({ error: `TikWM ${tikRes.status}` });
      const payload = await tikRes.json();
      if (payload.code !== 0 || !payload.data) return res.status(502).json({ error: payload.msg || 'Sin datos.' });
      const d = payload.data;
      title     = d.title || 'Video de TikTok';
      thumbnail = d.cover || d.origin_cover || '';
      if (d.hdplay) videos.push({ quality: 'HD sin marca', url: d.hdplay, extension: 'mp4' });
      if (d.play)   videos.push({ quality: 'Sin marca',    url: d.play,   extension: 'mp4' });
      if (d.wmplay) videos.push({ quality: 'Con marca',    url: d.wmplay, extension: 'mp4' });
    } else {
      // Instagram — TikWM primero, luego meta-scraping como fallback
      let tikOk = false;
      try {
        const tikRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, { signal: AbortSignal.timeout(7000) });
        if (tikRes.ok) {
          const payload = await tikRes.json();
          if (payload.code === 0 && payload.data) {
            const d = payload.data;
            const dlUrl = d.play || d.wmplay || d.durl || '';
            if (dlUrl) {
              title     = d.title || 'Reel de Instagram';
              thumbnail = d.cover || d.origin_cover || '';
              videos.push({ quality: 'Descargar MP4', url: dlUrl, extension: 'mp4' });
              tikOk = true;
            }
          }
        }
      } catch (_) {}

      if (!tikOk) {
        // Fallback: Instagram Reels Downloader API (RapidAPI)
        const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
        if (!RAPIDAPI_KEY) return res.status(500).json({ error: 'RAPIDAPI_KEY no configurada.' });

        const rapRes = await fetch(
          `https://instagram-reels-downloader-api.p.rapidapi.com/download?url=${encodeURIComponent(url)}`,
          {
            headers: {
              'x-rapidapi-key': RAPIDAPI_KEY,
              'x-rapidapi-host': 'instagram-reels-downloader-api.p.rapidapi.com',
              'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
          }
        );
        if (!rapRes.ok) return res.status(502).json({ error: `RapidAPI ${rapRes.status}` });
        const rapJson = await rapRes.json();
        if (!rapJson.success || !rapJson.data) return res.status(502).json({ error: rapJson.message || 'Sin datos.' });

        const d = rapJson.data;
        title     = d.title     || 'Post de Instagram';
        thumbnail = d.thumbnail || '';
        (d.medias || []).filter(m => m.type === 'video' || m.type === 'image').forEach(m => {
          videos.push({
            quality:   m.quality || m.resolution || (m.type === 'image' ? 'Foto' : 'MP4'),
            url:       m.url,
            extension: m.extension || (m.type === 'image' ? 'jpg' : 'mp4'),
            mediaType: m.type   // 'video' | 'image'
          });
        });
      }
    }

    if (!videos.length) return res.status(502).json({ error: 'No se encontró URL de descarga.' });

    return res.status(200).json({
      title,
      thumbnail,
      platform: svc,
      downloadUrl: videos[0].url,
      videos
    });

  } catch (err) {
    console.error('[download]', err?.message);
    return res.status(500).json({ error: err?.message || 'Error interno.' });
  }
}
