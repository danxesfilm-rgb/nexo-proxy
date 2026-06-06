/* ============================================================
   NEXO Proxy · Borrado de objetos
   POST { image: dataURI, mask: dataURI, engine? }  → { url }
   - mask: blanco = zona a borrar, negro = conservar
   - engine 'bria' (Bria DIRECTO · calidad · key BRIA_API_KEY)
            'lama' (Replicate · rápido/barato · key REPLICATE_API_TOKEN)
   ============================================================ */
const BRIA_KEY        = process.env.BRIA_API_KEY;
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const LAMA_VERSION    = process.env.REPLICATE_LAMA_VERSION || '0e3a841c913f597c1e4c321560aa69e2bc1f15c65f8c366caafc379240efd8ba';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rawB64 = s => (typeof s === 'string' && s.includes(',')) ? s.split(',')[1] : s;

/* ── Bria DIRECTO (engine.prod.bria-api.com) ── */
async function runBria(image, mask){
  if(!BRIA_KEY) throw new Error('Falta BRIA_API_KEY en el servidor');
  const r = await fetch('https://engine.prod.bria-api.com/v2/image/edit/erase', {
    method:'POST',
    headers:{ 'api_token': BRIA_KEY, 'Content-Type':'application/json' },
    body: JSON.stringify({ image: rawB64(image), mask: rawB64(mask), sync: true })
  });
  let d = {};
  try{ d = await r.json(); }catch(e){}
  if(!r.ok && r.status !== 202) throw new Error(d.message || d.error || ('Bria ' + r.status));
  let url = d.result?.image_url || d.result_url || d.image_url;
  // fallback asíncrono
  if(!url && d.status_url){
    for(let i=0;i<30;i++){
      await sleep(2000);
      const pr = await fetch(d.status_url, { headers:{ 'api_token': BRIA_KEY } });
      const pd = await pr.json().catch(() => ({}));
      url = pd.result?.image_url || pd.result_url || pd.image_url;
      if(url) break;
      if(['FAILED','ERROR','CANCELED'].includes(pd.status)) throw new Error('Bria: render fallido');
    }
  }
  if(!url) throw new Error('Bria no devolvió imagen');
  return url;
}

/* ── LaMa vía Replicate ── */
async function runLama(image, mask){
  if(!REPLICATE_TOKEN) throw new Error('Falta REPLICATE_API_TOKEN en el servidor');
  const r = await fetch('https://api.replicate.com/v1/predictions', {
    method:'POST',
    headers:{ Authorization:`Bearer ${REPLICATE_TOKEN}`, 'Content-Type':'application/json', 'Prefer':'wait' },
    body: JSON.stringify({ version: LAMA_VERSION, input: { image, mask } })
  });
  let d = await r.json();
  if(!r.ok) throw new Error(d.detail || d.title || ('Replicate ' + r.status));
  if(d.status && d.status !== 'succeeded' && d.urls && d.urls.get){
    for(let i=0;i<30;i++){
      if(d.status === 'failed' || d.status === 'canceled') break;
      await sleep(2000);
      const pr = await fetch(d.urls.get, { headers:{ Authorization:`Bearer ${REPLICATE_TOKEN}` } });
      d = await pr.json();
      if(d.status === 'succeeded') break;
    }
  }
  if(d.status === 'failed') throw new Error(d.error || 'Render fallido');
  let out = d.output;
  if(Array.isArray(out)) out = out[out.length - 1];
  if(!out) throw new Error('Replicate no devolvió imagen');
  return out;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });

  try{
    const { image, mask, engine } = req.body || {};
    if(!image || !mask) return res.status(400).json({ error:'Faltan image o mask' });

    const out = (engine === 'lama') ? await runLama(image, mask) : await runBria(image, mask);

    // Envolver por /api/dl (CORS + el cliente compone sobre el original)
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const url = `${proto}://${req.headers.host}/api/dl?url=${encodeURIComponent(out)}&name=clean-nexo.png`;
    return res.status(200).json({ url });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
