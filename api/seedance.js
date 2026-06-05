/* ============================================================
   NEXO Proxy · Seedance (ByteDance) vía BytePlus ModelArk
   - POST  { prompt, aspectRatio, duration? }  → { taskId }
   - GET   ?taskId=...                          → { status, url? }
   Key: env SEEDANCE_KEY (nunca llega al navegador)
   Docs: https://docs.byteplus.com/en/docs/ModelArk
   Nota: confirma el ID exacto del modelo y el endpoint de tu región
         en la consola de BytePlus (puede variar: ap-southeast, etc.)
   ============================================================ */

const ARK_BASE = process.env.SEEDANCE_BASE || 'https://ark.ap-southeast.bytepluses.com/api/v3';
const DEFAULT_MODEL = process.env.SEEDANCE_MODEL || 'seedance-1-0-pro-250528'; // ajusta a tu modelo
const KEY = process.env.SEEDANCE_KEY;

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(!KEY) return res.status(500).json({ error:'Falta SEEDANCE_KEY en el servidor' });

  try{
    /* ── POLLING ── */
    if(req.method === 'GET'){
      const { taskId } = req.query;
      if(!taskId) return res.status(400).json({ error:'Falta taskId' });
      const r = await fetch(`${ARK_BASE}/contents/generations/tasks/${taskId}`, {
        headers:{ Authorization:`Bearer ${KEY}` }
      });
      const d = await r.json();
      if(!r.ok) return res.status(r.status).json({ error: d.error?.message || 'Seedance poll error' });
      const st = d.status; // queued | running | succeeded | failed | cancelled
      if(st === 'succeeded'){
        const url = d.content?.video_url || d.content?.[0]?.video_url;
        return res.status(200).json({ status:'done', url, dur:'5s' });
      }
      if(st === 'failed' || st === 'cancelled'){
        return res.status(200).json({ status:'failed', error: d.error?.message || 'Render fallido' });
      }
      return res.status(200).json({ status:'processing' });
    }

    /* ── START ── */
    if(req.method === 'POST'){
      const { prompt, aspectRatio, duration } = req.body || {};
      if(!prompt) return res.status(400).json({ error:'Falta el prompt' });

      // Parámetros embebidos en el texto (formato ModelArk: "--ratio 16:9 --dur 5")
      const text = `${prompt} --ratio ${aspectRatio || '16:9'} --dur ${duration || 5}`;
      const r = await fetch(`${ARK_BASE}/contents/generations/tasks`, {
        method:'POST',
        headers:{ Authorization:`Bearer ${KEY}`, 'Content-Type':'application/json' },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          content: [{ type:'text', text }]
        })
      });
      const d = await r.json();
      if(!r.ok) return res.status(r.status).json({ error: d.error?.message || ('Seedance '+r.status) });
      const taskId = d.id;
      if(!taskId) return res.status(502).json({ error:'Seedance no devolvió id de tarea' });
      return res.status(200).json({ taskId });
    }

    return res.status(405).json({ error:'Method not allowed' });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
