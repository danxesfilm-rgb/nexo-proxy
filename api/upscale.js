/* ============================================================
   NEXO Proxy · Escalado de imagen (super-resolución)
   POST { image: dataURI, scale?: 2|4, faceEnhance?: bool } → { url, scale }
   Motor: nightmareai/real-esrgan vía Replicate (REPLICATE_API_TOKEN)
   ============================================================ */
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const ESRGAN_MODEL    = process.env.REPLICATE_ESRGAN_MODEL || 'nightmareai/real-esrgan';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* La versión del modelo se resuelve sola contra la API y se cachea en caliente,
   así no hay que ir actualizando un hash a mano cuando Replicate publica una
   nueva. Se puede fijar a dedo con REPLICATE_ESRGAN_VERSION. */
let cachedVersion = null;
async function esrganVersion(){
  if(process.env.REPLICATE_ESRGAN_VERSION) return process.env.REPLICATE_ESRGAN_VERSION;
  if(cachedVersion) return cachedVersion;
  const r = await fetch(`https://api.replicate.com/v1/models/${ESRGAN_MODEL}`, {
    headers:{ Authorization:`Bearer ${REPLICATE_TOKEN}` }
  });
  const d = await r.json().catch(() => ({}));
  const v = d && d.latest_version && d.latest_version.id;
  if(!r.ok || !v) throw new Error(d.detail || d.title || 'No se pudo resolver la versión del modelo de escalado');
  cachedVersion = v;
  return v;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  if(!REPLICATE_TOKEN) return res.status(500).json({ error:'Falta REPLICATE_API_TOKEN en el servidor' });

  try{
    const { image, scale, faceEnhance } = req.body || {};
    if(!image) return res.status(400).json({ error:'Falta la imagen' });
    const sc = (Number(scale) === 4) ? 4 : 2;

    const version = await esrganVersion();
    const r = await fetch('https://api.replicate.com/v1/predictions', {
      method:'POST',
      headers:{ Authorization:`Bearer ${REPLICATE_TOKEN}`, 'Content-Type':'application/json', 'Prefer':'wait' },
      body: JSON.stringify({ version, input:{ image, scale: sc, face_enhance: !!faceEnhance } })
    });
    let d = await r.json();
    if(!r.ok) return res.status(r.status).json({ error: d.detail || d.title || ('Replicate ' + r.status) });

    if(d.status && d.status !== 'succeeded' && d.urls && d.urls.get){
      for(let i=0;i<40;i++){
        if(d.status === 'failed' || d.status === 'canceled') break;
        await sleep(2000);
        const pr = await fetch(d.urls.get, { headers:{ Authorization:`Bearer ${REPLICATE_TOKEN}` } });
        d = await pr.json();
        if(d.status === 'succeeded') break;
      }
    }
    if(d.status === 'failed' || d.status === 'canceled') return res.status(500).json({ error: d.error || 'Escalado fallido' });

    let out = d.output;
    if(Array.isArray(out)) out = out[out.length - 1];
    if(!out) return res.status(502).json({ error:'Replicate no devolvió imagen' });

    // URL directa — Replicate es accesible desde el navegador sin proxy
    return res.status(200).json({ url: out, scale: sc });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
