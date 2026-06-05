/* ============================================================
   NEXO Proxy · Descarga forzada con nombre personalizado
   GET ?url=<url>&name=<archivo>  → stream con Content-Disposition
   Evita que el navegador abra el video en otra pestaña y permite
   renombrar el archivo (p.ej. "...-nexo.mp4").
   ============================================================ */
export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();

  const url  = req.query.url;
  const name = String(req.query.name || 'nexo').replace(/[^a-zA-Z0-9._-]/g, '_');
  if(!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error:'url inválida' });

  try{
    const r = await fetch(url);
    if(!r.ok) return res.status(r.status).json({ error:'fetch ' + r.status });
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const buf = Buffer.from(await r.arrayBuffer());
    return res.status(200).send(buf);
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
