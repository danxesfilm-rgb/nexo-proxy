/* ============================================================
   NEXO Proxy · Borrado de objetos (LaMa vía Replicate)
   POST { image: dataURI, mask: dataURI }  → { url }
   - mask: blanco = zona a borrar, negro = conservar
   - Key: env REPLICATE_API_TOKEN
   - Modelo configurable con env REPLICATE_LAMA_MODEL (owner/name)
   ============================================================ */
const TOKEN = process.env.REPLICATE_API_TOKEN;
// Versión del modelo LaMa (zylim0702/remove-object). Sobreescribible con env REPLICATE_LAMA_VERSION.
const VERSION = process.env.REPLICATE_LAMA_VERSION || '0e3a841c913f597c1e4c321560aa69e2bc1f15c65f8c366caafc379240efd8ba';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  if(!TOKEN) return res.status(500).json({ error:'Falta REPLICATE_API_TOKEN en el servidor' });

  try{
    const { image, mask } = req.body || {};
    if(!image || !mask) return res.status(400).json({ error:'Faltan image o mask' });

    // Lanza la predicción con la versión del modelo (Prefer: wait → espera hasta ~60s)
    const r = await fetch('https://api.replicate.com/v1/predictions', {
      method:'POST',
      headers:{ Authorization:`Bearer ${TOKEN}`, 'Content-Type':'application/json', 'Prefer':'wait' },
      body: JSON.stringify({ version: VERSION, input: { image, mask } })
    });
    let d = await r.json();
    if(!r.ok) return res.status(r.status).json({ error: d.detail || d.title || ('Replicate ' + r.status) });

    // Si no terminó con Prefer:wait, hacer polling
    if(d.status && d.status !== 'succeeded' && d.urls && d.urls.get){
      for(let i=0;i<30;i++){
        if(d.status === 'failed' || d.status === 'canceled') break;
        await sleep(2000);
        const pr = await fetch(d.urls.get, { headers:{ Authorization:`Bearer ${TOKEN}` } });
        d = await pr.json();
        if(d.status === 'succeeded') break;
      }
    }
    if(d.status === 'failed') return res.status(200).json({ error: d.error || 'Render fallido' });

    let out = d.output;
    if(Array.isArray(out)) out = out[out.length - 1];
    if(!out) return res.status(502).json({ error:'Replicate no devolvió imagen' });

    // Envolver por /api/dl para CORS (el cliente compone sobre el original)
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const url = `${proto}://${req.headers.host}/api/dl?url=${encodeURIComponent(out)}&name=clean-nexo.png`;
    return res.status(200).json({ url });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
