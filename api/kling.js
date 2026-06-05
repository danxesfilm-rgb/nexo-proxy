import crypto from 'crypto';

/* ============================================================
   NEXO Proxy · Kling AI (Kuaishou) — Kling 2.5, 720p, sin audio
   - Firma JWT (HS256) en el servidor. Keys: env KLING_ACCESS_KEY / KLING_SECRET_KEY
   - POST  { prompt, aspectRatio, duration? }  → { taskId }
   - GET   ?taskId=...                          → { status, url? }
   Docs: https://app.klingai.com  ·  https://docs.qingque.cn (Kling API)
   ============================================================ */

const KLING_BASE  = process.env.KLING_BASE || 'https://api-singapore.klingai.com';
const ACCESS_KEY  = process.env.KLING_ACCESS_KEY;
const SECRET_KEY  = process.env.KLING_SECRET_KEY;
// Kling 2.5 (id oficial: kling-v2-5-turbo). Sobreescribible con env KLING_MODEL.
const KLING_MODEL = process.env.KLING_MODEL || 'kling-v2-5-turbo';

function b64url(buf){
  return Buffer.from(buf).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function signJWT(){
  const header  = { alg:'HS256', typ:'JWT' };
  const now     = Math.floor(Date.now()/1000);
  const payload = { iss: ACCESS_KEY, exp: now + 1800, nbf: now - 5 };
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(payload));
  const sig  = b64url(crypto.createHmac('sha256', SECRET_KEY).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(!ACCESS_KEY || !SECRET_KEY) return res.status(500).json({ error:'Faltan KLING_ACCESS_KEY / KLING_SECRET_KEY en el servidor' });

  try{
    /* ── POLLING ── (re-firma en el servidor; no se expone token) */
    if(req.method === 'GET'){
      const { taskId, kind } = req.query;
      if(!taskId) return res.status(400).json({ error:'Falta taskId' });
      const ep = kind === 'image2video' ? 'image2video' : 'text2video';
      const r = await fetch(`${KLING_BASE}/v1/videos/${ep}/${taskId}`, {
        headers:{ Authorization:`Bearer ${signJWT()}` }
      });
      const d = await r.json();
      if(!r.ok) return res.status(r.status).json({ error: d.message || 'Kling poll error' });
      const data = d.data || {};
      const st = data.task_status; // submitted | processing | succeed | failed
      if(st === 'succeed'){
        const url = data.task_result?.videos?.[0]?.url;
        return res.status(200).json({ status:'done', url, dur:'5s' });
      }
      if(st === 'failed') return res.status(200).json({ status:'failed', error: data.task_status_msg || 'Render fallido' });
      return res.status(200).json({ status:'processing' });
    }

    /* ── START ── */
    if(req.method === 'POST'){
      const { prompt, aspectRatio, duration, image } = req.body || {};
      if(!prompt) return res.status(400).json({ error:'Falta el prompt' });

      const useImg = !!image;
      const ep = useImg ? 'image2video' : 'text2video';
      const body = useImg
        // imagen-a-video: el formato lo marca la imagen (no se envía aspect_ratio)
        ? { model_name: KLING_MODEL, image, prompt, duration: String(duration || 5), mode: 'std' }
        : { model_name: KLING_MODEL, prompt, aspect_ratio: aspectRatio || '16:9', duration: String(duration || 5), mode: 'std' };

      const r = await fetch(`${KLING_BASE}/v1/videos/${ep}`, {
        method:'POST',
        headers:{ Authorization:`Bearer ${signJWT()}`, 'Content-Type':'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if(!r.ok) return res.status(r.status).json({ error: d.message || ('Kling '+r.status) });
      const taskId = d.data?.task_id;
      if(!taskId) return res.status(502).json({ error:'Kling no devolvió task_id' });
      return res.status(200).json({ taskId, kind: ep });
    }

    return res.status(405).json({ error:'Method not allowed' });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
