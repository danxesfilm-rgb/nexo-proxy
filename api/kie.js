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

   Modelos habilitados: google/nano-banana · nano-banana-pro ·
   gpt-image-2-text-to-image · grok-imagine/text-to-image ·
   seedream/5-pro-text-to-image (lista blanca).
   ============================================================ */

const BASE = process.env.KIE_BASE || 'https://api.kie.ai/api/v1/jobs';
const KEY  = process.env.KIE_API_KEY;
const ALLOWED_MODELS = new Set([
  'google/nano-banana',
  'google/nano-banana-edit',          // Nano Banana Lite con referencias
  'nano-banana-pro',
  'gpt-image-2-text-to-image',
  'gpt-image-2-image-to-image',      // edición
  'grok-imagine/text-to-image',
  'grok-imagine/image-to-image',      // edición
  'seedream/5-pro-text-to-image',     // ByteDance Seedream 5.0 Pro
  'seedream/5-pro-image-to-image'     // edición (hasta 10 refs)
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
      let model = b.model;
      const { prompt } = b;
      if(!model)  return res.status(400).json({ error:'Falta el modelo (kie id)' });
      if(!ALLOWED_MODELS.has(model)) return res.status(400).json({ error:'KIE solo está habilitado para Google, GPT y Grok en este studio.' });
      if(!prompt) return res.status(400).json({ error:'Falta el prompt' });

      let refs = Array.isArray(b.refs) ? b.refs.filter(Boolean) : [];
      if(!refs.length && b.image) refs = [b.image];
      const image_urls = refs.filter(isHttp);   // KIE requiere URLs públicas
      // google/nano-banana es solo texto→imagen (no tiene campo de imágenes): con
      // referencias hay que usar su modelo de edición o KIE las descarta en silencio.
      if(model === 'google/nano-banana' && image_urls.length) model = 'google/nano-banana-edit';

      const input = { prompt };
      // aspect_ratio: obligatorio en algunos modelos (Grok), opcional en otros
      const AR = ['auto','1:1','3:2','2:3','4:3','3:4','5:4','4:5','16:9','9:16','21:9','9:21','2:1','1:2','3:1','1:3'];
      if(b.aspectRatio && AR.includes(String(b.aspectRatio))) input.aspect_ratio = String(b.aspectRatio);

      // OJO: cada modelo nombra distinto el campo de imágenes de referencia.
      //  · GPT Image 2 (image-to-image) → input_urls (hasta 16)
      //  · Nano Banana Pro (Nano Banana 2) → image_input (hasta 8) — docs KIE
      //  · Nano Banana edit / Grok         → image_urls
      // Enviar el nombre equivocado hace que el modelo IGNORE las referencias.
      const useInputUrls = /^gpt-image-2/.test(model);
      const isNBPro = model === 'nano-banana-pro';
      if(image_urls.length){
        if(useInputUrls)  input.input_urls  = image_urls;
        else if(isNBPro)  input.image_input = image_urls.slice(0, 8);
        else              input.image_urls  = image_urls;
      }
      // resolution: GPT Image 2 y Nano Banana Pro la admiten (1K/2K/4K)
      const RES = ['1K','2K','4K'];
      if((useInputUrls || isNBPro) && b.resolution && RES.includes(String(b.resolution))) input.resolution = String(b.resolution);

      // Seedream 5.0 Pro: aspect_ratio y quality son OBLIGATORIOS y la lista de
      // proporciones es más corta (sin 4:5/5:4/auto) → se acerca a la más parecida.
      if(model.startsWith('seedream/')){
        const SD_AR = ['1:1','4:3','3:4','16:9','9:16','2:3','3:2','21:9'];
        const near = { '4:5':'3:4', '5:4':'4:3', '9:21':'9:16', '2:1':'16:9', '1:2':'9:16' };
        const ar = String(b.aspectRatio || '');
        input.aspect_ratio = SD_AR.includes(ar) ? ar : (near[ar] || '1:1');
        input.quality = String(b.resolution) === '2K' ? 'high' : 'basic';   // basic=1K · high=2K
        if(input.image_urls) input.image_urls = input.image_urls.slice(0, 10);
        if(/text-to-image$/.test(model)) delete input.image_urls;          // t2i no lleva imágenes
      }

      const r = await fetch(`${BASE}/createTask`, {
        method:'POST',
        headers:{ ...auth, 'Content-Type':'application/json' },
        body: JSON.stringify({ model, input })
      });
      const d = await r.json().catch(() => ({}));
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
