/* ============================================================
   NEXO Proxy · Passthrough de media (reproducir y/o descargar)
   GET ?url=<url>              → stream INLINE (reproducible en <video>)
   GET ?url=<url>&dl=1&name=x  → fuerza descarga con ese nombre
   Resuelve CORS y URLs expiradas (el proxy las busca en el momento).
   ============================================================ */
export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if(req.method === 'OPTIONS') return res.status(204).end();

  const url  = req.query.url;
  const name = String(req.query.name || 'nexo').replace(/[^a-zA-Z0-9._-]/g, '_');
  const asDownload = req.query.dl === '1';
  if(!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error:'url inválida' });

  try{
    // Reenviar Range para que el <video> pueda hacer seek
    const fwd = {};
    if(req.headers.range) fwd['Range'] = req.headers.range;
    const r = await fetch(url, { headers: fwd });
    if(!(r.ok || r.status === 206)) return res.status(r.status).json({ error:'fetch ' + r.status });

    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    if(r.headers.get('content-range')) res.setHeader('Content-Range', r.headers.get('content-range'));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Disposition', asDownload ? `attachment; filename="${name}"` : 'inline');

    const buf = Buffer.from(await r.arrayBuffer());
    return res.status(r.status === 206 ? 206 : 200).send(buf);
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
