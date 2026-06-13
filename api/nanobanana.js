/* ============================================================
   NEXO Proxy · Nano Banana (Gemini 2.5 Flash Image)
   POST { prompt, aspectRatio, refs[] } → { image: dataURL }
   Key: env GEMINI_API_KEY (nunca llega al navegador)
   ============================================================ */
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  if(!GEMINI_KEY) return res.status(500).json({ error:'Falta GEMINI_API_KEY en el servidor' });

  try{
    const { prompt, aspectRatio, refs } = req.body || {};
    if(!prompt) return res.status(400).json({ error:'Falta el prompt' });

    const parts = [{ text: prompt }];
    (refs || []).forEach(r => {
      const [meta, b64] = String(r).split(',');
      if(!b64) return;
      const mime = (meta.match(/data:(.*?);/) || [])[1] || 'image/png';
      parts.push({ inline_data: { mime_type: mime, data: b64 } });
    });

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities:['IMAGE'], imageConfig:{ aspectRatio: aspectRatio || '1:1' } }
      })
    });
    const data = await r.json();
    if(!r.ok) return res.status(r.status).json({ error: data?.error?.message || ('Gemini '+r.status) });

    const cand = data.candidates?.[0]?.content?.parts || [];
    const img = cand.find(p => p.inlineData || p.inline_data);
    if(!img) return res.status(502).json({ error:'Sin imagen en la respuesta de Gemini' });
    const inl = img.inlineData || img.inline_data;
    return res.status(200).json({ image: `data:${inl.mimeType || inl.mime_type || 'image/png'};base64,${inl.data}` });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
