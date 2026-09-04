/* ============================================================
   NEXO Proxy · Magnific (Freepik) — Nano Banana · Kling · Seedance
   Un solo endpoint para las tres familias. La key nunca llega al
   navegador: vive en env FREEPIK_API_KEY.

   API Freepik (asíncrona):
     POST https://api.freepik.com/v1/ai/<path>        -> { data:{ task_id, status } }
     GET  https://api.freepik.com/v1/ai/<path>/<id>   -> { data:{ status, generated:[url] } }
   Auth: header  x-freepik-api-key: <key>
   status: CREATED · IN_PROGRESS · COMPLETED · FAILED

   Rutas por familia (la de status = ruta POST + "/<task_id>"):
     nano-banana → text-to-image/gemini-2-5-flash-image-preview
     kling       → image-to-video/kling-v2
     seedance    → image-to-video/seedance-pro-{480p|720p|1080p}

   POST body (desde el navegador):
     { family, prompt, image?, refs?[], aspectRatio?, resolution?, duration?, seed? }
   GET  ?taskId=..&family=..&resolution=..   -> { status:'done'|'processing'|'failed', url? }

   NOTA: los endpoints de video de Freepik son image-to-video (requieren una
   imagen de entrada). Si llega sin imagen, se rechaza con un aviso claro.
   ============================================================ */

const API = process.env.FREEPIK_BASE || 'https://api.freepik.com/v1/ai';
const KEY = process.env.FREEPIK_API_KEY;

/* Ruta del modelo por familia (+ resolución para Seedance). */
function endpointFor(family, resolution){
  if(family === 'nano-banana') return 'text-to-image/gemini-2-5-flash-image-preview';
  // Kling 2.6 Pro acepta texto→video E imagen→video (un solo endpoint)
  if(family === 'kling')       return 'image-to-video/kling-v2-6-pro';
  if(family === 'seedance'){
    const r = String(resolution || '1080p').replace(/[^0-9]/g, '');
    const q = ['480','720','1080'].includes(r) ? r : '1080';
    return `image-to-video/seedance-pro-${q}p`;
  }
  return null;
}

/* La UI manda 9:16 / 16:9 / 3:4 / 1:1; Freepik usa nombres propios. */
const RATIO = {
  '9:16':'social_story_9_16',
  '16:9':'widescreen_16_9',
  '3:4' :'traditional_3_4',
  '4:3' :'classic_4_3',
  '1:1' :'square_1_1',
};

const isHttp = u => /^https?:\/\//i.test(String(u || ''));
/* Freepik acepta imágenes como URL pública o base64 SIN el prefijo data: */
const stripData = s => String(s || '').replace(/^data:[^,]+,/, '');

/* Extrae la URL del resultado tolerando variaciones del esquema. */
function resultUrl(data){
  if(!data) return null;
  const g = data.generated;
  if(Array.isArray(g) && g.length) return typeof g[0] === 'string' ? g[0] : (g[0]?.url || null);
  if(typeof g === 'string') return g;
  if(Array.isArray(data.result) && data.result.length) return data.result[0]?.url || data.result[0];
  return data.url || null;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();

  if(!KEY) return res.status(500).json({ error:'Falta FREEPIK_API_KEY en el servidor' });
  const auth = { 'x-freepik-api-key': KEY };

  try{
    /* ── POLLING ── */
    if(req.method === 'GET'){
      const { taskId, family, resolution } = req.query;
      if(!taskId) return res.status(400).json({ error:'Falta taskId' });
      const path = endpointFor(family, resolution);
      if(!path) return res.status(400).json({ error:`Familia desconocida: ${family}` });

      const r = await fetch(`${API}/${path}/${encodeURIComponent(taskId)}`, { headers: auth });
      const d = await r.json().catch(() => ({}));
      if(!r.ok) return res.status(r.status).json({ error: d.message || d.error || `Freepik poll ${r.status}` });

      const st = String(d.data?.status || d.status || '').toUpperCase();
      if(st === 'COMPLETED' || st === 'DONE' || st === 'SUCCESS'){
        const url = resultUrl(d.data || d);
        if(!url) return res.status(200).json({ status:'failed', error:'Tarea completada sin URL de resultado' });
        return res.status(200).json({ status:'done', url });
      }
      if(st === 'FAILED' || st === 'ERROR'){
        return res.status(200).json({ status:'failed', error: d.data?.error || d.message || 'Generación fallida' });
      }
      return res.status(200).json({ status:'processing' });
    }

    /* ── START ── */
    if(req.method === 'POST'){
      const b = req.body || {};
      const { family, prompt, aspectRatio, resolution, duration, seed } = b;
      const path = endpointFor(family, resolution);
      if(!path) return res.status(400).json({ error:`Familia desconocida: ${family}. Use nano-banana | kling | seedance` });
      if(!prompt) return res.status(400).json({ error:'Falta el prompt' });

      // imagen de entrada (base64 con o sin prefijo, o URL pública)
      let refs = Array.isArray(b.refs) ? b.refs.filter(Boolean) : [];
      if(!refs.length && b.image) refs = [b.image];
      const firstImg = refs[0];

      const body = { prompt };
      const ratio = RATIO[String(aspectRatio)] || undefined;

      if(family === 'nano-banana'){
        // gemini-2-5-flash-image: prompt (+ hasta 3 imágenes de referencia)
        if(refs.length){
          body.reference_images = refs.slice(0, 3).map(u => isHttp(u) ? u : stripData(u));
        }
      }else{
        // video (Kling 2.6 Pro / Seedance): texto→video o imagen→video.
        // La imagen es opcional: se manda solo si el usuario subió una.
        if(firstImg) body.image = isHttp(firstImg) ? firstImg : stripData(firstImg);
        if(ratio) body.aspect_ratio = ratio;
        if(duration) body.duration = String(parseInt(duration) || 5);
      }
      if(seed !== undefined && seed !== null && seed !== '') body.seed = parseInt(seed);

      const r = await fetch(`${API}/${path}`, {
        method:'POST',
        headers:{ ...auth, 'Content-Type':'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json().catch(() => ({}));
      if(!r.ok) return res.status(r.status).json({ error: d.message || d.error || `Freepik ${r.status} (${path})` });

      const taskId = d.data?.task_id || d.data?.id || d.task_id || d.id;
      if(!taskId) return res.status(502).json({ error:'Freepik no devolvió task_id' });
      return res.status(200).json({ taskId, family, resolution: resolution || '', path });
    }

    return res.status(405).json({ error:'Method not allowed' });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
