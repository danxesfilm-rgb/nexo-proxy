/* ============================================================
   NEXO Proxy · Flux via Replicate
   - Sin ref  → Flux Schnell  ($0.003)  generación rápida
   - Con ref  → Flux Kontext Pro ($0.04) edición real con instrucciones
   POST { prompt, aspectRatio, refs[] } → { image: dataURL }
   Key: env REPLICATE_API_TOKEN
   ============================================================ */
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;

// Flux Schnell: aspect_ratio como string
const SCHNELL_ASPECTS = ['1:1','16:9','9:16','3:2','2:3','4:5','5:4','21:9'];
// Normaliza el aspecto al más cercano que soporta Schnell
function normalizeAspect(a){
  const map = { '4:3':'3:2', '3:4':'2:3' };
  return map[a] || (SCHNELL_ASPECTS.includes(a) ? a : '1:1');
}

// Flux Kontext: aspect_ratio también como string
const KONTEXT_ASPECTS = ['1:1','16:9','9:16','3:2','2:3','4:5','5:4','21:9'];
function normalizeKontext(a){
  const map = { '4:3':'3:2', '3:4':'2:3' };
  return map[a] || (KONTEXT_ASPECTS.includes(a) ? a : '1:1');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function poll(url){
  for(let i=0; i<40; i++){
    await sleep(1500);
    const pr = await fetch(url, { headers:{ Authorization:`Bearer ${REPLICATE_TOKEN}` } });
    const d  = await pr.json();
    if(d.status === 'succeeded') return d;
    if(d.status === 'failed' || d.status === 'canceled') throw new Error(d.error || 'Render fallido');
  }
  throw new Error('Tiempo de espera agotado');
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  if(!REPLICATE_TOKEN) return res.status(500).json({ error:'Falta REPLICATE_API_TOKEN en el servidor' });

  try{
    const { prompt, aspectRatio, refs } = req.body || {};
    if(!prompt) return res.status(400).json({ error:'Falta el prompt' });

    const hasRef = Array.isArray(refs) && refs.length > 0 && refs[0];
    let input, model;

    if(hasRef){
      // Flux Kontext Pro — edición real con imagen de referencia
      model = 'black-forest-labs/flux-kontext-pro';
      input = {
        prompt,
        input_image: `data:image/jpeg;base64,${refs[0]}`,
        aspect_ratio: normalizeKontext(aspectRatio),
        output_format: 'jpg',
        safety_tolerance: 2,
      };
    } else {
      // Flux Schnell — generación rápida
      model = 'black-forest-labs/flux-schnell';
      input = {
        prompt,
        aspect_ratio: normalizeAspect(aspectRatio),
        output_format: 'jpg',
        num_outputs: 1,
      };
    }

    const r = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: 'POST',
      headers: { Authorization:`Bearer ${REPLICATE_TOKEN}`, 'Content-Type':'application/json', 'Prefer':'wait=60' },
      body: JSON.stringify({ input })
    });
    let d = await r.json();
    if(!r.ok) return res.status(r.status).json({ error: d.detail || d.title || ('Replicate '+r.status) });

    if(d.status && d.status !== 'succeeded' && d.urls?.get){
      d = await poll(d.urls.get);
    }
    if(d.status === 'failed') return res.status(500).json({ error: d.error || 'Render fallido' });

    let url = Array.isArray(d.output) ? d.output[0] : d.output;
    if(!url) return res.status(502).json({ error:'Replicate no devolvió imagen' });

    // Convertir a dataURL
    const imgRes = await fetch(url);
    const buf    = await imgRes.arrayBuffer();
    const b64    = Buffer.from(buf).toString('base64');
    const mime   = imgRes.headers.get('content-type') || 'image/webp';
    return res.status(200).json({ image: `data:${mime};base64,${b64}` });

  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
