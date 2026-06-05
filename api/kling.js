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
      const { taskId } = req.query;
      if(!taskId) return res.status(400).json({ error:'Falta taskId' });
      const r = await fetch(`${KLING_BASE}/v1/videos/text2video/${taskId}`, {
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
      const { prompt, aspectRatio, duration } = req.body || {};
      if(!prompt) return res.status(400).json({ error:'Falta el prompt' });

      const r = await fetch(`${KLING_BASE}/v1/videos/text2video`, {
        method:'POST',
        headers:{ Authorization:`Bearer ${signJWT()}`, 'Content-Type':'application/json' },
        body: JSON.stringify({
          model_name: KLING_MODEL,                 // Kling 2.5 fijo
          prompt,
          aspect_ratio: aspectRatio || '16:9',
          duration: String(duration || 5),
          mode: 'std',                             // std = 720p
          sound: false                             // sonido desactivado
        })
      });
      const d = await r.json();
      if(!r.ok) return res.status(r.status).json({ error: d.message || ('Kling '+r.status) });
      const taskId = d.data?.task_id;
      if(!taskId) return res.status(502).json({ error:'Kling no devolvió task_id' });
      return res.status(200).json({ taskId });
    }

    return res.status(405).json({ error:'Method not allowed' });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
