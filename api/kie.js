/* ============================================================
   NEXO Proxy · KIE (kie.ai) — todas las imágenes
   La key nunca llega al navegador: env KIE_API_KEY.

   API KIE (asíncrona, endpoint unificado):
     POST https://api.kie.ai/api/v1/jobs/createTask
       body: { model, callBackUrl?, input:{ prompt, image_urls?[] } }
       resp: { code, msg, data:{ taskId } }
     GET  https://api.kie.ai/api/v1/jobs/recordInfo?taskId=<id>
       resp: { code, msg, data:{ taskId, state, resultJson } }
       state: waiting|queuing|generating|success|fail
       resultJson: string JSON con { resultUrls:[url] }
   Auth: header  Authorization: Bearer <key>

   POST body (desde el navegador):
     { model, prompt, refs?[], aspectRatio?, resolution? }
   GET  ?taskId=..   -> { status:'done'|'processing'|'failed', url? }

   NOTA: los ids de modelo (google/nano-banana, grok-imagine/…, etc.) hay que
   confirmarlos con la key real; por eso queda `_raw`/`modelOverride` de debug.
   ============================================================ */

const BASE = process.env.KIE_BASE || 'https://api.kie.ai/api/v1/jobs';
const KEY  = process.env.KIE_API_KEY;
const ALLOWED_MODELS = new Set([
  'google/nano-banana',
  'google/nano-banana-pro',
  'gpt-image-2/text-to-image',
  'grok-imagine/text-to-image'
]);

const isHttp = u => /^https?:\/\//i.test(String(u || ''));

/* Extrae la URL del resultado tolerando el resultJson stringificado. */
function resultUrl(data){
  if(!data) return null;
  let rj = data.resultJson;
  if(typeof rj === 'string'){ try{ rj = JSON.parse(rj); }catch(_){ rj = null; } }
  const urls = rj?.resultUrls || data.resultUrls || data.results || rj?.urls;
  if(Array.isArray(urls) && urls.length) return typeof urls[0] === 'string' ? urls[0] : (urls[0]?.url || null);
  if(typeof urls === 'string') return urls;
  return null;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();

  if(!KEY) return res.status(500).json({ error:'Falta KIE_API_KEY en el servidor' });
  const auth = { Authorization:`Bearer ${KEY}` };

  try{
    /* ── POLLING ── */
    if(req.method === 'GET'){
      const { taskId } = req.query;
      if(!taskId) return res.status(400).json({ error:'Falta taskId' });
      const r = await fetch(`${BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers: auth });
      const d = await r.json().catch(() => ({}));
      if(req.query._raw) return res.status(200).json({ _httpStatus:r.status, raw:d });
      if(!r.ok) return res.status(r.status).json({ error: d.msg || d.message || `KIE poll ${r.status}` });

      const data = d.data || {};
      const st = String(data.state || data.status || '').toLowerCase();
      if(st === 'success' || st === 'succeeded' || st === 'completed'){
        const url = resultUrl(data);
        if(!url) return res.status(200).json({ status:'failed', error:'Tarea completada sin URL de resultado' });
        return res.status(200).json({ status:'done', url });
      }
      if(st === 'fail' || st === 'failed' || st === 'error'){
        return res.status(200).json({ status:'failed', error: data.failMsg || data.error || d.msg || 'Generación fallida' });
      }
      return res.status(200).json({ status:'processing' });
    }

    /* ── START ── */
    if(req.method === 'POST'){
      const b = req.body || {};
      const model = b.modelOverride || b.model;
      const { prompt } = b;
      if(!model)  return res.status(400).json({ error:'Falta el modelo (kie id)' });
      if(!ALLOWED_MODELS.has(model)) return res.status(400).json({ error:'KIE solo está habilitado para Google, GPT y Grok en este studio.' });
      if(!prompt) return res.status(400).json({ error:'Falta el prompt' });

      let refs = Array.isArray(b.refs) ? b.refs.filter(Boolean) : [];
      if(!refs.length && b.image) refs = [b.image];
      const image_urls = refs.filter(isHttp);   // KIE requiere URLs públicas

      const input = { prompt };
      if(image_urls.length) input.image_urls = image_urls;

      const r = await fetch(`${BASE}/createTask`, {
        method:'POST',
        headers:{ ...auth, 'Content-Type':'application/json' },
        body: JSON.stringify({ model, input })
      });
      const d = await r.json().catch(() => ({}));
      if(b._raw) return res.status(200).json({ _httpStatus:r.status, raw:d });
      if(!r.ok || (d.code && d.code !== 200)){
        return res.status(r.ok ? 400 : r.status).json({ error: d.msg || d.message || `KIE ${r.status} (${model})` });
      }

      const taskId = d.data?.taskId || d.data?.task_id || d.taskId;
      if(!taskId) return res.status(502).json({ error:'KIE no devolvió taskId' });
      return res.status(200).json({ taskId });
    }

    return res.status(405).json({ error:'Method not allowed' });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
