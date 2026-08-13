/* ============================================================
   NEXO Proxy · Kling AI (Kuaishou)
   Auth: Bearer token simple (KLING_API_KEY)
   - POST  { prompt, aspectRatio, duration, image?, image_tail?, mode, model }
   - GET   ?taskId=...&kind=...  → { status, url? }
   ============================================================ */

const KLING_BASE     = process.env.KLING_BASE || 'https://api-singapore.klingai.com';
const KLING_API_KEY  = process.env.KLING_API_KEY;

const ALLOWED_MODELS = ['kling-v2-5-turbo', 'kling-v2-6'];
const DEFAULT_MODEL  = process.env.KLING_MODEL || 'kling-v2-5-turbo';

function klingHeaders(){
  return { Authorization: `Bearer ${KLING_API_KEY}`, 'Content-Type': 'application/json' };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(!KLING_API_KEY) return res.status(500).json({ error:'Falta KLING_API_KEY en el servidor' });

  try{
    /* ── POLLING ── */
    if(req.method === 'GET'){
      const { taskId, kind } = req.query;
      if(!taskId) return res.status(400).json({ error:'Falta taskId' });
      const ep = kind === 'image2video' ? 'image2video' : 'text2video';
      const r = await fetch(`${KLING_BASE}/v1/videos/${ep}/${taskId}`, {
        headers: klingHeaders()
      });
      const d = await r.json();
      if(!r.ok) return res.status(r.status).json({ error: d.message || 'Kling poll error' });
      const data = d.data || {};
      const st = data.task_status;
      if(st === 'succeed'){
        const url = data.task_result?.videos?.[0]?.url;
        if(!url) return res.status(200).json({ status:'failed', error:'Sin URL de video en la respuesta' });
        return res.status(200).json({ status:'done', url, dur:'5s' });
      }
      if(st === 'failed') return res.status(200).json({ status:'failed', error: data.task_status_msg || 'Render fallido' });
      return res.status(200).json({ status:'processing' });
    }

    /* ── START ── */
    if(req.method === 'POST'){
      const { prompt, aspectRatio, duration, image, image_tail, mode, model } = req.body || {};
      if(!prompt) return res.status(400).json({ error:'Falta el prompt' });

      const modelName  = ALLOWED_MODELS.includes(model) ? model : DEFAULT_MODEL;
      const useImg     = !!image;
      // image_tail solo está disponible en modelos que soporten First/Last Frame (ej. kling-v2-6)
      const useTail    = useImg && !!image_tail;
      // Kling exige modo 'pro' para First/Last Frame (image_tail no está soportado en std)
      const klingMode  = (useTail || mode === 'pro') ? 'pro' : 'std';
      const ep         = useImg ? 'image2video' : 'text2video';

      let body;
      if(useImg){
        body = { model_name: modelName, image, prompt, duration: String(duration || 5), mode: klingMode };
        if(useTail) body.image_tail = image_tail;
      } else {
        body = { model_name: modelName, prompt, aspect_ratio: aspectRatio || '16:9', duration: String(duration || 5), mode: klingMode };
      }

      const r = await fetch(`${KLING_BASE}/v1/videos/${ep}`, {
        method: 'POST',
        headers: klingHeaders(),
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if(!r.ok) return res.status(r.status).json({ error: d.message || ('Kling ' + r.status) });
      const taskId = d.data?.task_id;
      if(!taskId) return res.status(502).json({ error:'Kling no devolvió task_id' });
      return res.status(200).json({ taskId, kind: ep });
    }

    return res.status(405).json({ error:'Method not allowed' });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
