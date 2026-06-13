/* ============================================================
   NEXO Proxy · Nano Banana (Flux Schnell via Replicate)
   POST { prompt, aspectRatio, refs[] } → { image: dataURL }
   Key: env REPLICATE_API_TOKEN
   ============================================================ */
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const FLUX_MODEL      = 'black-forest-labs/flux-schnell';

const ASPECT_MAP = {
  '1:1':  { width:1024, height:1024 },
  '16:9': { width:1344, height:768  },
  '9:16': { width:768,  height:1344 },
  '4:3':  { width:1152, height:896  },
  '3:4':  { width:896,  height:1152 },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

    const dims = ASPECT_MAP[aspectRatio] || ASPECT_MAP['1:1'];

    // Si hay imagen de referencia, usar flux-dev con image_prompt
    const hasRef = refs && refs.length > 0;
    const model  = hasRef ? 'black-forest-labs/flux-dev' : FLUX_MODEL;

    const input = {
      prompt,
      width:  dims.width,
      height: dims.height,
      output_format: 'webp',
      num_outputs: 1,
    };
    if(hasRef) input.image_prompt = refs[0];

    const r = await fetch('https://api.replicate.com/v1/models/' + model + '/predictions', {
      method: 'POST',
      headers: { Authorization:`Bearer ${REPLICATE_TOKEN}`, 'Content-Type':'application/json', 'Prefer':'wait' },
      body: JSON.stringify({ input })
    });
    let d = await r.json();
    if(!r.ok) return res.status(r.status).json({ error: d.detail || d.title || ('Replicate '+r.status) });

    // Polling si no vino en el Prefer:wait
    if(d.status && d.status !== 'succeeded' && d.urls?.get){
      for(let i=0; i<30; i++){
        if(d.status === 'failed' || d.status === 'canceled') break;
        await sleep(1500);
        const pr = await fetch(d.urls.get, { headers:{ Authorization:`Bearer ${REPLICATE_TOKEN}` } });
        d = await pr.json();
        if(d.status === 'succeeded') break;
      }
    }
    if(d.status === 'failed') return res.status(500).json({ error: d.error || 'Render fallido' });

    let url = Array.isArray(d.output) ? d.output[0] : d.output;
    if(!url) return res.status(502).json({ error:'Replicate no devolvió imagen' });

    // Convertir URL a dataURL para devolverla igual que antes
    const imgRes = await fetch(url);
    const buf    = await imgRes.arrayBuffer();
    const b64    = Buffer.from(buf).toString('base64');
    const mime   = imgRes.headers.get('content-type') || 'image/webp';
    return res.status(200).json({ image: `data:${mime};base64,${b64}` });

  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
