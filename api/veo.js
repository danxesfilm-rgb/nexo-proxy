/* ============================================================
   NEXO Proxy · Veo 3.1 (Gemini long-running)
   - POST  { prompt, aspectRatio }      → { taskId }
   - GET   ?op=<operation>              → { status, url? }
   - GET   ?download=<fileUri>          → stream del video (key oculta)
   Key: env GEMINI_API_KEY (nunca llega al navegador). El video se sirve
   a través de este mismo endpoint para no exponer la key en la URL.
   ============================================================ */
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const BASE  = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'veo-3.1-generate-preview';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(!GEMINI_KEY) return res.status(500).json({ error:'Falta GEMINI_API_KEY en el servidor' });

  try{
    /* ── DESCARGA (passthrough del video con la key del servidor) ── */
    if(req.method === 'GET' && req.query.download){
      const uri = String(req.query.download);
      const sep = uri.includes('?') ? '&' : '?';
      const r = await fetch(uri + sep + 'key=' + GEMINI_KEY);
      if(!r.ok) return res.status(r.status).json({ error:'download '+r.status });
      res.setHeader('Content-Type', r.headers.get('content-type') || 'video/mp4');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const buf = Buffer.from(await r.arrayBuffer());
      return res.status(200).send(buf);
    }

    /* ── POLLING ── */
    if(req.method === 'GET' && req.query.op){
      const name = String(req.query.op);
      const pr = await fetch(`${BASE}/${name}?key=${GEMINI_KEY}`);
      const op = await pr.json();
      if(!pr.ok) return res.status(pr.status).json({ error: op?.error?.message || 'poll error' });
      if(!op.done) return res.status(200).json({ status:'processing' });
      if(op.error) return res.status(200).json({ status:'failed', error: op.error.message });
      const sample = op.response?.generateVideoResponse?.generatedSamples?.[0]
                  || op.response?.generatedSamples?.[0];
      const uri = sample?.video?.uri || sample?.video?.url;
      if(!uri) return res.status(200).json({ status:'failed', error:'Sin video en la respuesta' });
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const self  = `${proto}://${req.headers.host}/api/veo`;
      return res.status(200).json({ status:'done', url: `${self}?download=${encodeURIComponent(uri)}` });
    }

    /* ── START ── */
    if(req.method === 'POST'){
      const { prompt, aspectRatio } = req.body || {};
      if(!prompt) return res.status(400).json({ error:'Falta el prompt' });
      const r = await fetch(`${BASE}/models/${MODEL}:predictLongRunning?key=${GEMINI_KEY}`, {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ instances:[{ prompt }], parameters:{ aspectRatio: aspectRatio || '16:9', personGeneration:'allow_adult' } })
      });
      const sd = await r.json();
      if(!r.ok) return res.status(r.status).json({ error: sd?.error?.message || ('Veo '+r.status) });
      if(!sd.name) return res.status(502).json({ error:'Veo no devolvió operación' });
      return res.status(200).json({ taskId: sd.name });
    }

    return res.status(405).json({ error:'Method not allowed' });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
