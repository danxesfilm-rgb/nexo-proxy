export const config = { maxDuration: 60 };

import ytdl from '@distube/ytdl-core';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { yturl, itag, ext, mode } = req.query || {};
  if (!yturl) return res.status(400).json({ error: 'yturl requerido' });

  const decodedUrl = decodeURIComponent(yturl);
  const fileExt    = ext || 'mp4';
  const isAudio    = mode === 'audio';

  try {
    // Obtenemos info fresca desde esta IP del servidor → URLs firmadas para nosotros
    const info = await ytdl.getInfo(decodedUrl);

    const safeTitle = (info.videoDetails.title || 'video')
      .replace(/[^\w\s\-áéíóúñü]/gi, '')
      .trim()
      .slice(0, 80) || 'video';

    // Seleccionamos el formato por itag (preferido) o por calidad
    let format;
    if (itag) {
      format = info.formats.find(f => String(f.itag) === String(itag));
    }
    if (!format) {
      format = ytdl.chooseFormat(info.formats, {
        quality: isAudio ? 'highestaudio' : 'highest',
        filter:  isAudio ? 'audioonly'    : 'videoandaudio',
      });
    }
    if (!format) {
      return res.status(502).json({ error: 'Formato no encontrado.' });
    }

    const mimeType = format.mimeType?.split(';')[0]
      || (isAudio ? 'audio/mpeg' : 'video/mp4');

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition',
      `attachment; filename="${safeTitle}.${fileExt}"`);
    if (format.contentLength) {
      res.setHeader('Content-Length', format.contentLength);
    }

    // Pipe del stream directo al response — el servidor actúa de proxy
    ytdl.downloadFromInfo(info, { format }).pipe(res);

  } catch (err) {
    console.error('[yt-stream]', err?.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || 'Error de stream.' });
    } else {
      res.end();
    }
  }
}
