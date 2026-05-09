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

// RapidAPI HD Video Downloader — configurar RAPIDAPI_KEY en Vercel env vars
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'f48daf9398msh4ce08625e70d25fp18f844jsneef269b8a045';
const RAPIDAPI_HOST = 'hd-video-downloader.p.rapidapi.com';

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
    /* ── YouTube ─────────────────────────────────────────────────────── */
    if (svc === 'youtube') {
      const ytId = extractYtId(url);
      if (!ytId) return res.status(400).json({ error: 'URL de YouTube inválida.' });

      const ytUrl = `https://www.youtube.com/watch?v=${ytId}`;
      const videos = [];
      let title     = 'Video de YouTube';
      let thumbnail = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;

      const rapidHeaders = {
        'x-rapidapi-key':  RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST,
        'Content-Type':    'application/json'
      };

      /* ── 1. RapidAPI HD Video Downloader — info + 1080p + 720p en paralelo ── */
      try {
        const qualityMap = [
          { q: '1080', label: 'MP4 · 1080p HD', ext: 'mp4', type: 'video', badge: 'good' },
          { q: '720',  label: 'MP4 · 720p HD',  ext: 'mp4', type: 'video', badge: 'info' },
        ];

        // info + descargas todo en paralelo para minimizar tiempo total
        const [infoResult, ...dlResults] = await Promise.allSettled([
          fetch(`https://${RAPIDAPI_HOST}/info?url=${encodeURIComponent(ytUrl)}`,
            { headers: rapidHeaders, signal: AbortSignal.timeout(12000) }
          ).then(r => r.ok ? r.json() : null),
          ...qualityMap.map(({ q }) =>
            fetch(`https://${RAPIDAPI_HOST}/download?url=${encodeURIComponent(ytUrl)}&quality=${q}`,
              { headers: rapidHeaders, signal: AbortSignal.timeout(20000) }
            ).then(r => r.ok ? r.json() : null)
          )
        ]);

        // Título desde /info
        const info = infoResult.status === 'fulfilled' ? infoResult.value : null;
        if (info?.success && info?.data?.title) title = info.data.title;

        // URLs de descarga
        dlResults.forEach((res, i) => {
          const d = res.status === 'fulfilled' ? res.value : null;
          if (d?.success && d?.data?.download_url) {
            const qm = qualityMap[i];
            videos.push({
              quality:   qm.label,
              url:       d.data.download_url,
              extension: qm.ext,
              type:      qm.type,
              size:      d.data.filesize || 0,
              badges:    [{ text: qm.label.split(' · ')[1], type: qm.badge }]
            });
          }
        });
      } catch (_) {}

      /* ── 2. Invidious fallback ── */
      if (!videos.length) {
        let invInstances = ['https://inv.nadeko.net', 'https://invidious.nerdvpn.de'];
        try {
          const listRes = await fetch('https://api.invidious.io/instances.json?sort_by=health', { signal: AbortSignal.timeout(5000) });
          if (listRes.ok) {
            const list = await listRes.json();
            invInstances = list.filter(([, d]) => d.type === 'https' && d.api === true && d.uri).slice(0, 4).map(([, d]) => d.uri.replace(/\/$/, ''));
          }
        } catch (_) {}

        for (const instance of invInstances) {
          try {
            const r = await fetch(`${instance}/api/v1/videos/${ytId}?local=true`, { signal: AbortSignal.timeout(10000) });
            if (!r.ok) continue;
            const d = await r.json();
            if (!d || d.error) continue;
            if (d.title) title = d.title;
            const hqThumb = (d.videoThumbnails || []).find(t => t.quality === 'maxresdefault' || t.quality === 'high');
            if (hqThumb?.url) thumbnail = hqThumb.url.startsWith('/') ? instance + hqThumb.url : hqThumb.url;
            const mp4 = (d.formatStreams || []).filter(s => s.container === 'mp4' || (s.type || '').includes('video/mp4')).sort((a, b) => parseInt(b.resolution) - parseInt(a.resolution))[0];
            if (mp4?.url) videos.push({ quality: `MP4 · ${mp4.qualityLabel || '720p'}`, url: mp4.url, extension: 'mp4', type: 'video' });
            const audio = (d.adaptiveFormats || []).filter(s => (s.type || '').startsWith('audio/') && s.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
            if (audio?.url) videos.push({ quality: 'MP3 · Solo audio', url: audio.url, extension: 'mp3', type: 'audio' });
            if (videos.length) break;
          } catch (_) {}
        }
      }

      /* ── 3. Cobalt fallback ── */
      if (!videos.length) {
        const COBALT_HDR = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
        const cobaltFetch = async (body) => {
          for (const ep of ['https://api.cobalt.tools/', 'https://api.cobalt.tools/api/json']) {
            try { const r = await fetch(ep, { method: 'POST', headers: COBALT_HDR, body: JSON.stringify(body), signal: AbortSignal.timeout(18000) }); if (r.ok) return r; } catch (_) {}
          }
          return null;
        };
        const cobaltOk = (j) => j?.url && ['redirect','tunnel','stream'].includes(j.status);
        const [vr, ar] = await Promise.allSettled([
          cobaltFetch({ url: ytUrl, downloadMode: 'auto',  videoQuality: '1080' }),
          cobaltFetch({ url: ytUrl, downloadMode: 'audio', audioFormat: 'mp3'  }),
        ]);
        if (vr.status === 'fulfilled' && vr.value) { const j = await vr.value.json().catch(() => ({})); if (cobaltOk(j)) videos.push({ quality: 'MP4 · Video', url: j.url, extension: 'mp4', type: 'video' }); }
        if (ar.status === 'fulfilled' && ar.value) { const j = await ar.value.json().catch(() => ({})); if (cobaltOk(j)) videos.push({ quality: 'MP3 · Solo audio', url: j.url, extension: 'mp3', type: 'audio' }); }
      }

      /* ── 4. Railway fallback ── */
      if (!videos.length && YT_SERVER) {
        try {
          const r = await fetch(`${YT_SERVER}/info?url=${encodeURIComponent(ytUrl)}`, { signal: AbortSignal.timeout(25000) });
          if (r.ok) { const data = await r.json(); (data.formats || []).forEach(f => videos.push({ quality: f.quality, url: f.stream_url, extension: f.ext, type: f.type === 'audio' ? 'audio' : 'video' })); }
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
      // Instagram — RapidAPI primero, luego múltiples fallbacks
      let tikOk = false;

      // ── PRIMARIO: RapidAPI HD Video Downloader ──────────────────────
      try {
        const igShortcodeMain = url.match(/\/(p|reel|tv|reels)\/([A-Za-z0-9_-]+)/)?.[2];
        const igUrlMain = igShortcodeMain ? `https://www.instagram.com/reel/${igShortcodeMain}/` : url;
        const rapidHeaders = {
          'x-rapidapi-key':  RAPIDAPI_KEY,
          'x-rapidapi-host': RAPIDAPI_HOST,
          'Content-Type':    'application/json'
        };

        // 1. /info — obtiene metadatos y lista de formatos
        const infoRes = await fetch(
          `https://${RAPIDAPI_HOST}/info?url=${encodeURIComponent(igUrlMain)}`,
          { headers: rapidHeaders, signal: AbortSignal.timeout(12000) }
        );
        if (infoRes.ok) {
          const info = await infoRes.json();
          if (info.success && info.data) {
            title     = info.data.title || 'Post de Instagram';
            thumbnail = info.data.thumbnail || '';
            // Si tiene formatos, descargar el mejor
            const formats = info.data.formats || [];
            if (formats.length) {
              const best = formats.find(f => f.ext === 'mp4') || formats[0];
              if (best?.format_id) {
                const dlRes = await fetch(
                  `https://${RAPIDAPI_HOST}/download?url=${encodeURIComponent(igUrlMain)}&format_id=${best.format_id}`,
                  { headers: rapidHeaders, signal: AbortSignal.timeout(12000) }
                );
                if (dlRes.ok) {
                  const dlData = await dlRes.json();
                  if (dlData.success && dlData.data?.download_url) {
                    videos.push({ quality: 'Calidad original', url: dlData.data.download_url, extension: 'mp4' });
                    tikOk = true;
                  }
                }
              }
            }
          }
        }

        // 2. /download directo + embed metadata en paralelo
        if (!tikOk) {
          const [dlRes, embedRes] = await Promise.allSettled([
            fetch(
              `https://${RAPIDAPI_HOST}/download?url=${encodeURIComponent(igUrlMain)}&quality=720`,
              { headers: rapidHeaders, signal: AbortSignal.timeout(12000) }
            ).then(r => r.ok ? r.json() : null),
            // Embed de Instagram para obtener título y miniatura reales
            igShortcodeMain ? fetch(
              `https://www.instagram.com/p/${igShortcodeMain}/embed/captioned/`,
              {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                  'Accept': 'text/html,application/xhtml+xml',
                  'Accept-Language': 'es-ES,es;q=0.9',
                },
                signal: AbortSignal.timeout(8000)
              }
            ).then(r => r.ok ? r.text() : null) : Promise.resolve(null)
          ]);

          // Procesar metadatos del embed
          const embedHtml = embedRes.status === 'fulfilled' ? embedRes.value : null;
          if (embedHtml) {
            const thumbMatch = embedHtml.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
              || embedHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
            if (thumbMatch) thumbnail = thumbMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');

            const descMatch = embedHtml.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
              || embedHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
            if (descMatch) {
              const cleanTitle = descMatch[1].replace(/ on Instagram.*$/i,'').replace(/["']/g,'').trim();
              if (cleanTitle) title = cleanTitle;
            } else {
              const titleMatch = embedHtml.match(/<title>([^<]+)<\/title>/);
              if (titleMatch) title = titleMatch[1].replace(/ [•·|].* Instagram.*/i,'').trim();
            }
          }

          // Procesar URL de descarga
          const dlData = dlRes.status === 'fulfilled' ? dlRes.value : null;
          if (dlData?.success && dlData?.data?.download_url) {
            // Limpiar título basura tipo "instagram_SHORTCODE"
            if (!title || /^instagram_[A-Za-z0-9_-]+$/i.test(title)) {
              title = 'Post de Instagram';
            }
            // No confiar en la calidad reportada por la API (suele ser incorrecta para Instagram)
            videos.push({ quality: 'Calidad original', url: dlData.data.download_url, extension: dlData.data.ext || 'mp4' });
            tikOk = true;
          }
        }
      } catch (_) {}

      // ── FALLBACK: resto de métodos ────────────────────────────────────
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

      // Normalizar URL de Instagram para mayor compatibilidad con los servicios
      const igShortcode = url.match(/\/(p|reel|tv|reels)\/([A-Za-z0-9_-]+)/)?.[2];
      const igUrl = igShortcode ? `https://www.instagram.com/reel/${igShortcode}/` : url;

      // Fallback 2b: ddInstagram — proxy público que expone la URL del CDN de Instagram
      if (!tikOk && igShortcode) {
        try {
          // ddInstagram redirige instagram.com/reel/X → ddinstagram.com/reel/X y muestra el video
          const ddRes = await fetch(
            `https://www.ddinstagram.com/reel/${igShortcode}/`,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                'Accept': 'text/html,application/xhtml+xml',
              },
              signal: AbortSignal.timeout(10000),
              redirect: 'follow'
            }
          );
          if (ddRes.ok) {
            const html = await ddRes.text();
            const videoMatch = html.match(/<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i)
              || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video["']/i)
              || html.match(/content=["'](https:\/\/[^"']+\.mp4[^"']*)/i);
            if (videoMatch) {
              const videoUrl = videoMatch[1].replace(/&amp;/g, '&');
              const thumbMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
              if (thumbMatch && !thumbnail) thumbnail = thumbMatch[1].replace(/&amp;/g, '&');
              title = title || 'Reel de Instagram';
              videos.push({ quality: 'MP4 Original', url: videoUrl, extension: 'mp4' });
              tikOk = true;
            }
          }
        } catch (_) {}
      }

      // Fallback 2c: Cobalt — instancias múltiples (oficial + comunitarias, IPs distintas)
      if (!tikOk) {
        try {
          // Obtener instancias comunitarias activas en tiempo real
          let cobaltInstances = [
            'https://api.cobalt.tools',
            'https://cobalt.imput.net',
            'https://cobalt.api.timelessnesses.me',
          ];
          try {
            const listRes = await fetch('https://instances.cobalt.best/api/instances.json', {
              signal: AbortSignal.timeout(4000)
            });
            if (listRes.ok) {
              const list = await listRes.json();
              const live = (Array.isArray(list) ? list : [])
                .filter(i => i.api && i.protocol === 'https' && (i.score ?? 100) > 50)
                .slice(0, 6)
                .map(i => i.api.replace(/\/$/, ''));
              if (live.length) cobaltInstances = [...live, 'https://api.cobalt.tools'];
            }
          } catch (_) {}

          let cobaltRes = null;
          for (const base of cobaltInstances) {
            for (const ep of [`${base}/`, `${base}/api/json`]) {
              try {
                const r = await fetch(ep, {
                  method: 'POST',
                  headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                  },
                  body: JSON.stringify({ url: igUrl, downloadMode: 'auto' }),
                  signal: AbortSignal.timeout(8000)
                });
                if (r.ok) { cobaltRes = r; break; }
              } catch (_) {}
            }
            if (cobaltRes) break;
          }
          if (cobaltRes) {
            const cj = await cobaltRes.json();
            if (['redirect','tunnel','stream'].includes(cj.status) && cj.url) {
              title = title || 'Post de Instagram';
              videos.push({ quality: 'Descargar MP4', url: cj.url, extension: 'mp4' });
              tikOk = true;
            } else if (cj.status === 'picker' && cj.picker?.length) {
              title = title || 'Post de Instagram';
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
              const videoMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/)
                || html.match(/"contentUrl"\s*:\s*"([^"]+)"/)
                || html.match(/<meta[^>]+property=["']og:video:secure_url["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video:secure_url["']/i)
                || html.match(/<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video["']/i)
                || html.match(/<meta[^>]+property=["']og:video:url["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video:url["']/i);
              if (videoMatch) {
                const videoUrl = videoMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
                const thumbMatch = html.match(/"thumbnail_src"\s*:\s*"([^"]+)"/)
                  || html.match(/"display_url"\s*:\s*"([^"]+)"/)
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

      // Fallback 4: embed via allorigins proxy (ruta de red diferente a Vercel)
      if (!tikOk && igShortcode) {
        try {
          const embedUrl = `https://www.instagram.com/p/${igShortcode}/embed/captioned/`;
          const proxyRes = await fetch(
            `https://api.allorigins.win/raw?url=${encodeURIComponent(embedUrl)}`,
            { signal: AbortSignal.timeout(15000) }
          );
          if (proxyRes.ok) {
            const html = await proxyRes.text();
            const videoMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/)
              || html.match(/"contentUrl"\s*:\s*"([^"]+)"/)
              || html.match(/<meta[^>]+property=["']og:video[^"']*["'][^>]+content=["']([^"']+)["']/i)
              || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video[^"']*["']/i);
            if (videoMatch) {
              const videoUrl = videoMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
              const thumbMatch = html.match(/"thumbnail_src"\s*:\s*"([^"]+)"/)
                || html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
              if (thumbMatch && !thumbnail) thumbnail = thumbMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
              title = title || 'Post de Instagram';
              videos.push({ quality: 'Descargar MP4', url: videoUrl, extension: 'mp4' });
              tikOk = true;
            }
          }
        } catch (_) {}
      }

      // Fallback 5: Render /embed — URL directa del CDN de Instagram (sin proxying por servidor)
      if (!tikOk && YT_SERVER && igShortcode) {
        try {
          const r = await fetch(`${YT_SERVER}/embed?url=${encodeURIComponent(igUrl)}`, { signal: AbortSignal.timeout(20000) });
          if (r.ok) {
            const data = await r.json();
            if (data.video_url) {
              videos.push({ quality: 'MP4 Original', url: data.video_url, extension: 'mp4', type: 'video' });
              tikOk = true;
              if (!title && data.title) title = data.title;
              if (!thumbnail && data.thumbnail) thumbnail = data.thumbnail;
            }
          }
        } catch (_) {}
      }

      // Fallback 6: servidor yt-dlp (Render) — soporta Instagram nativamente
      if (!tikOk && YT_SERVER) {
        try {
          const r = await fetch(`${YT_SERVER}/info?url=${encodeURIComponent(igUrl)}`, { signal: AbortSignal.timeout(25000) });
          if (r.ok) {
            const data = await r.json();
            const fmts = (data.formats || []).filter(f => f.stream_url);
            // Tomar el mejor formato de video (el servidor /stream muxea video+audio con ffmpeg)
            const audioExts = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'weba'];
            const best = fmts.find(f => {
              const q = (f.quality || '').toLowerCase();
              const ext = (f.ext || '').toLowerCase();
              return f.type !== 'audio'
                && !audioExts.includes(ext)
                && !q.includes('audio');
            });
            if (best) {
              videos.push({ quality: best.quality || 'MP4', url: best.stream_url, extension: 'mp4', type: 'video' });
              tikOk = true;
              if (!title && data.title) title = data.title;
              if (!thumbnail && data.thumbnail) thumbnail = data.thumbnail;
            }
          }
        } catch (_) {}
      }

      // Sin más fallbacks disponibles — Instagram bloquea activamente la descarga
      if (!tikOk) {
        return res.status(503).json({ error: 'Instagram no permite descargar este post en este momento. Prueba con otro enlace o intenta más tarde.' });
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
