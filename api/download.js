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
    /* ── YouTube — vía Cobalt (gratis, sin API key) ───────────────────── */
    if (svc === 'youtube') {
      const ytId = extractYtId(url);
      if (!ytId) return res.status(400).json({ error: 'URL de YouTube inválida.' });

      const ytUrl      = `https://www.youtube.com/watch?v=${ytId}`;
      const COBALT_HDR = { 'Accept': 'application/json', 'Content-Type': 'application/json' };

      // Helper: intenta con endpoint nuevo (/) y si falla prueba el viejo (/api/json)
      const cobaltFetch = async (body) => {
        for (const endpoint of ['https://api.cobalt.tools/', 'https://api.cobalt.tools/api/json']) {
          try {
            const r = await fetch(endpoint, {
              method: 'POST', headers: COBALT_HDR,
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(20000)
            });
            if (r.ok) return r;
          } catch (_) {}
        }
        return null;
      };

      // Pedir MP4, MP3 y título en paralelo para máxima velocidad
      const [videoRes, audioRes, titleRes] = await Promise.allSettled([
        cobaltFetch({ url: ytUrl, downloadMode: 'auto',  videoQuality: '1080' }),
        cobaltFetch({ url: ytUrl, downloadMode: 'audio', audioFormat: 'mp3' }),
        fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(ytUrl)}&format=json`, {
          signal: AbortSignal.timeout(5000)
        })
      ]);

      const cobaltOk = (j) => j && j.url && ['redirect','tunnel','stream'].includes(j.status);

      const videos = [];

      if (videoRes.status === 'fulfilled' && videoRes.value) {
        const j = await videoRes.value.json().catch(() => ({}));
        if (cobaltOk(j))
          videos.push({ quality: 'MP4 · Video', url: j.url, extension: 'mp4', type: 'video' });
      }

      if (audioRes.status === 'fulfilled' && audioRes.value) {
        const j = await audioRes.value.json().catch(() => ({}));
        if (cobaltOk(j))
          videos.push({ quality: 'MP3 · Solo audio', url: j.url, extension: 'mp3', type: 'audio' });
      }

      // Fallback: servidor Railway con yt-dlp (si YT_SERVER_URL está configurado en Vercel)
      if (!videos.length && YT_SERVER) {
        try {
          const r = await fetch(`${YT_SERVER}/info?url=${encodeURIComponent(ytUrl)}`, { signal: AbortSignal.timeout(25000) });
          if (r.ok) {
            const data = await r.json();
            (data.formats || []).forEach(f => videos.push({
              quality: f.quality, url: f.stream_url, extension: f.ext,
              type: f.type === 'audio' ? 'audio' : 'video'
            }));
          }
        } catch (_) {}
      }

      if (!videos.length)
        return res.status(502).json({ error: 'YouTube no disponible en este momento. Intenta de nuevo en unos segundos.' });

      let title = 'Video de YouTube';
      if (titleRes.status === 'fulfilled' && titleRes.value.ok) {
        const tj = await titleRes.value.json().catch(() => ({}));
        if (tj.title) title = tj.title;
      }

      return res.status(200).json({
        title,
        thumbnail: `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`,
        platform:  'youtube',
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

      // Fallback 2: Cobalt (gratis, sin API key)
      if (!tikOk) {
        try {
          let cobaltRes = null;
          for (const ep of ['https://api.cobalt.tools/', 'https://api.cobalt.tools/api/json']) {
            try {
              const r = await fetch(ep, {
                method: 'POST',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, downloadMode: 'auto' }),
                signal: AbortSignal.timeout(12000)
              });
              if (r.ok) { cobaltRes = r; break; }
            } catch (_) {}
          }
          if (cobaltRes) {
            const cj = await cobaltRes.json();
            if (['redirect','tunnel','stream'].includes(cj.status) && cj.url) {
              title = 'Post de Instagram';
              videos.push({ quality: 'Descargar MP4', url: cj.url, extension: 'mp4' });
              tikOk = true;
            } else if (cj.status === 'picker' && cj.picker?.length) {
              title = 'Post de Instagram';
              cj.picker.forEach((item, i) => {
                videos.push({ quality: `Elemento ${i + 1}`, url: item.url, extension: item.type === 'photo' ? 'jpg' : 'mp4' });
              });
              tikOk = true;
            }
          }
        } catch (_) {}
      }

      if (!tikOk) {
        // Fallback 3: Instagram Reels Downloader API (RapidAPI)
        const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
        if (!RAPIDAPI_KEY) return res.status(503).json({ error: 'No se pudo descargar este post. Intenta con otro enlace.' });

        // RapidAPI — hasta 2 intentos si devuelve 5xx
        let rapRes, rapAttempt = 0;
        while (rapAttempt < 2) {
          rapRes = await fetch(
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
          if (rapRes.ok || rapRes.status < 500) break; // éxito o error cliente → no reintentar
          rapAttempt++;
          if (rapAttempt < 2) await new Promise(r => setTimeout(r, 1200)); // espera 1.2s antes de reintentar
        }
        if (!rapRes.ok) {
          const code = rapRes.status;
          if (code === 429) return res.status(502).json({ error: 'Límite de descargas alcanzado. Intenta en unos minutos.' });
          if (code >= 500) return res.status(502).json({ error: 'Instagram no está disponible en este momento. Intenta más tarde.' });
          return res.status(502).json({ error: `No se pudo descargar este post (${code}).` });
        }
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
    const msg = err?.message || 'Error interno.';
    // Evitar mensajes técnicos crudos al usuario
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('ECONNRESET')) {
      return res.status(500).json({ error: 'Error de conexión al descargar. Intenta de nuevo.' });
    }
    return res.status(500).json({ error: msg });
  }
}
