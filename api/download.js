export const config = { maxDuration: 60 };

// Caché simple en memoria para resultados (5 minutos)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCacheKey(url, service) {
  return `${service}:${url}`;
}

function getCache(url, service) {
  const key = getCacheKey(url, service);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  cache.delete(key);
  return null;
}

function setCache(url, service, data) {
  const key = getCacheKey(url, service);
  cache.set(key, { data, timestamp: Date.now() });
}

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

  // Verificar caché
  const cached = getCache(url, svc);
  if (cached) {
    return res.status(200).json(cached);
  }

  try {
    /* ── YouTube — vía Cobalt (gratis, sin API key) ───────────────────── */
    if (svc === 'youtube') {
      const ytId = extractYtId(url);
      if (!ytId) return res.status(400).json({ error: 'URL de YouTube inválida.' });

      const ytUrl = `https://www.youtube.com/watch?v=${ytId}`;
      const videos = [];
      let title     = 'Video de YouTube';
      let thumbnail = `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`;

      /* ── 1. Invidious — obtiene instancias activas en tiempo real ── */
      let invInstances = ['https://inv.nadeko.net', 'https://invidious.nerdvpn.de']; // fallback hardcoded
      try {
        const listRes = await fetch('https://api.invidious.io/instances.json?sort_by=health', {
          signal: AbortSignal.timeout(5000)
        });
        if (listRes.ok) {
          const list = await listRes.json();
          // Tomar hasta 5 instancias HTTPS con API habilitada y mayor salud
          invInstances = list
            .filter(([, d]) => d.type === 'https' && d.api === true && d.uri)
            .slice(0, 5)
            .map(([, d]) => d.uri.replace(/\/$/, ''));
        }
      } catch (_) {}

      for (const instance of invInstances) {
        try {
          const r = await fetch(`${instance}/api/v1/videos/${ytId}?local=true`, {
            signal: AbortSignal.timeout(10000)
          });
          if (!r.ok) continue;
          const d = await r.json();
          if (!d || d.error) continue;

          if (d.title) title = d.title;

          // Thumbnail de mayor resolución disponible
          const hqThumb = (d.videoThumbnails || []).find(t => t.quality === 'maxresdefault' || t.quality === 'high');
          if (hqThumb?.url) thumbnail = hqThumb.url.startsWith('/') ? instance + hqThumb.url : hqThumb.url;

          // MP4 combinado (video+audio) — hasta 720p
          const mp4 = (d.formatStreams || [])
            .filter(s => s.container === 'mp4' || (s.type || '').includes('video/mp4'))
            .sort((a, b) => parseInt(b.resolution) - parseInt(a.resolution))[0];
          if (mp4?.url) videos.push({
            quality: `MP4 · ${mp4.qualityLabel || mp4.resolution || '720p'}`,
            url: mp4.url, extension: 'mp4', type: 'video'
          });

          // Mejor stream de solo audio
          const audio = (d.adaptiveFormats || [])
            .filter(s => (s.type || '').startsWith('audio/') && s.url)
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
          if (audio?.url) videos.push({
            quality: 'MP3 · Solo audio',
            url: audio.url, extension: 'mp3', type: 'audio'
          });

          if (videos.length) break; // instancia funcionó, no seguir
        } catch (_) {}
      }

      /* ── 2. Cobalt fallback ── */
      if (!videos.length) {
        const COBALT_HDR = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
        const cobaltFetch = async (body) => {
          for (const ep of ['https://api.cobalt.tools/', 'https://api.cobalt.tools/api/json']) {
            try {
              const r = await fetch(ep, { method: 'POST', headers: COBALT_HDR, body: JSON.stringify(body), signal: AbortSignal.timeout(18000) });
              if (r.ok) return r;
            } catch (_) {}
          }
          return null;
        };
        const cobaltOk = (j) => j?.url && ['redirect','tunnel','stream'].includes(j.status);
        const [vr, ar] = await Promise.allSettled([
          cobaltFetch({ url: ytUrl, downloadMode: 'auto',  videoQuality: '1080' }),
          cobaltFetch({ url: ytUrl, downloadMode: 'audio', audioFormat: 'mp3'  }),
        ]);
        if (vr.status === 'fulfilled' && vr.value) { const j = await vr.value.json().catch(() => ({})); if (cobaltOk(j)) videos.push({ quality: 'MP4 · Video',      url: j.url, extension: 'mp4', type: 'video' }); }
        if (ar.status === 'fulfilled' && ar.value) { const j = await ar.value.json().catch(() => ({})); if (cobaltOk(j)) videos.push({ quality: 'MP3 · Solo audio', url: j.url, extension: 'mp3', type: 'audio' }); }
      }

      /* ── 3. Railway fallback (si YT_SERVER_URL configurado en Vercel) ── */
      if (!videos.length && YT_SERVER) {
        try {
          const r = await fetch(`${YT_SERVER}/info?url=${encodeURIComponent(ytUrl)}`, { signal: AbortSignal.timeout(25000) });
          if (r.ok) {
            const data = await r.json();
            (data.formats || []).forEach(f => videos.push({ quality: f.quality, url: f.stream_url, extension: f.ext, type: f.type === 'audio' ? 'audio' : 'video' }));
          }
        } catch (_) {}
      }

      if (!videos.length)
        return res.status(502).json({ error: 'YouTube no disponible en este momento. Intenta de nuevo en unos segundos.' });

      const resultYT = { title, thumbnail, platform: 'youtube', downloadUrl: videos[0].url, videos };
      setCache(url, svc, resultYT);
      return res.status(200).json(resultYT);
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
                headers: {
                  'Accept': 'application/json',
                  'Content-Type': 'application/json',
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                },
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

      // Fallback 3: Instagram embed page scraping (sin API key, público)
      if (!tikOk) {
        try {
          const shortcode = url.match(/\/(p|reel|tv|reels)\/([A-Za-z0-9_-]+)/)?.[2];
          if (shortcode) {
            const embedRes = await fetch(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'es-ES,es;q=0.9',
                'Referer': 'https://www.instagram.com/',
              },
              signal: AbortSignal.timeout(10000)
            });
            if (embedRes.ok) {
              const html = await embedRes.text();
              // Buscar video_url en JSON embebido, o etiqueta OG video como fallback
              const videoMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/)
                || html.match(/<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video["']/i)
                || html.match(/<meta[^>]+property=["']og:video:url["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video:url["']/i);
              if (videoMatch) {
                const videoUrl = videoMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
                const thumbMatch = html.match(/"thumbnail_src"\s*:\s*"([^"]+)"/)
                  || html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                  || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
                const titleMatch = html.match(/<title>([^<]+)<\/title>/);
                if (thumbMatch) thumbnail = thumbMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
                if (titleMatch) title = titleMatch[1].replace(/ • Instagram$/i, '').trim();
                videos.push({ quality: 'Descargar MP4', url: videoUrl, extension: 'mp4' });
                tikOk = true;
              }
            }
          }
        } catch (_) {}
      }

      // Fallback 4: servidor yt-dlp (Railway) — soporta Instagram nativamente
      if (!tikOk && YT_SERVER) {
        try {
          const r = await fetch(`${YT_SERVER}/info?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(25000) });
          if (r.ok) {
            const data = await r.json();
            const fmts = (data.formats || []).filter(f => f.stream_url);
            // Preferir formatos combinados (no DASH puro) con video+audio
            const combined = fmts.filter(f =>
              f.type !== 'audio' &&
              !(f.quality || '').toLowerCase().includes('dash') &&
              !(f.quality || '').toLowerCase().includes('video only')
            );
            const toAdd = combined.length ? combined.slice(0, 2) : fmts.filter(f => f.type !== 'audio').slice(0, 1);
            toAdd.forEach(f => videos.push({
              quality: 'Descargar MP4',
              url: f.stream_url,
              extension: f.ext || 'mp4',
              type: 'video'
            }));
            if (videos.length) {
              tikOk = true;
              if (!title && data.title) title = data.title;
              if (!thumbnail && data.thumbnail) thumbnail = data.thumbnail;
            }
          }
        } catch (_) {}
      }

      // Fallback 5: Instagram Reels Downloader API (RapidAPI) — último recurso
      if (!tikOk) {
        const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
        if (!RAPIDAPI_KEY) {
          return res.status(503).json({ error: 'Este post no está disponible para descargar en este momento. Prueba con otro enlace o intenta más tarde.' });
        }

        let rapRes;
        let rapAttempt = 0;
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
          if (rapRes.ok || rapRes.status < 500) break;
          rapAttempt++;
          if (rapAttempt < 2) await new Promise(r => setTimeout(r, 1200));
        }

        if (!rapRes.ok) {
          const code = rapRes.status;
          if (code === 429) {
            return res.status(502).json({ error: 'Límite de descargas alcanzado. Intenta en unos minutos.' });
          }
          if (code >= 500) {
            return res.status(502).json({ error: 'Instagram no está disponible en este momento. Intenta más tarde.' });
          }
          return res.status(502).json({ error: `No se pudo descargar este post (${code}).` });
        }

        const rapJson = await rapRes.json();
        if (!rapJson.success || !rapJson.data) {
          return res.status(502).json({ error: rapJson.message || 'Sin datos.' });
        }

        const d = rapJson.data;
        title     = d.title     || 'Post de Instagram';
        thumbnail = d.thumbnail || '';
        (d.medias || []).filter(m => m.type === 'video' || m.type === 'image').forEach(m => {
          videos.push({
            quality:   m.quality || m.resolution || (m.type === 'image' ? 'Foto' : 'MP4'),
            url:       m.url,
            extension: m.extension || (m.type === 'image' ? 'jpg' : 'mp4'),
            mediaType: m.type
          });
        });
      }
    }

    if (!videos.length) return res.status(502).json({ error: 'No se encontró URL de descarga.' });

    const result = {
      title,
      thumbnail,
      platform: svc,
      downloadUrl: videos[0].url,
      videos
    };
    setCache(url, svc, result);
    return res.status(200).json(result);

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
