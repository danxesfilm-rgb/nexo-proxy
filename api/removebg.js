/* ============================================================
   NEXO Proxy · Quitar fondo (segmentación)
   POST { image: dataURI }  → { url }
   Motor: 851-labs/background-remover (InSPyReNet) vía Replicate.
   Se eligió por tener bordes más limpios que las alternativas rápidas,
   que es lo que importa en retrato y producto.
   Devuelve un PNG con transparencia.
   ============================================================ */
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const BG_MODEL = process.env.REPLICATE_BG_MODEL || '851-labs/background-remover';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Igual que en upscale.js: la versión se resuelve contra la API y se cachea,
   para no tener que ir actualizando un hash a mano. */
let cachedVersion = null;
async function bgVersion(){
  if(process.env.REPLICATE_BG_VERSION) return process.env.REPLICATE_BG_VERSION;
  if(cachedVersion) return cachedVersion;
  const r = await fetch(`https://api.replicate.com/v1/models/${BG_MODEL}`, {
    headers:{ Authorization:`Bearer ${REPLICATE_TOKEN}` }
  });
  const d = await r.json().catch(() => ({}));
  const v = d && d.latest_version && d.latest_version.id;
  if(!r.ok || !v) throw new Error(d.detail || d.title || 'No se pudo resolver la versión del modelo de recorte');
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
    const { image } = req.body || {};
    if(!image) return res.status(400).json({ error:'Falta la imagen' });

    const version = await bgVersion();
    const r = await fetch('https://api.replicate.com/v1/predictions', {
      method:'POST',
      headers:{ Authorization:`Bearer ${REPLICATE_TOKEN}`, 'Content-Type':'application/json', 'Prefer':'wait' },
      body: JSON.stringify({ version, input:{ image } })
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
    if(d.status === 'failed' || d.status === 'canceled') return res.status(500).json({ error: d.error || 'Recorte fallido' });

    const out = Array.isArray(d.output) ? d.output[0] : d.output;
    if(!out) return res.status(502).json({ error:'El modelo no devolvió imagen' });
    return res.status(200).json({ url: out });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
