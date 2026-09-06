/* ============================================================
   NEXO Proxy · Magnific (Freepik) — Kling y Nano Banana Pro
   La key nunca llega al navegador: vive en env FREEPIK_API_KEY.
   (Seedance NO está disponible en el API de Freepik → sigue en EvoLink.)

   API Freepik (asíncrona):
     POST https://api.freepik.com/v1/ai/<postPath>          -> { data:{ task_id, status } }
     GET  https://api.freepik.com/v1/ai/<statusPath>/<id>   -> { data:{ status, generated:[url] } }
   Auth: header  x-freepik-api-key: <key>
   status: CREATED · IN_PROGRESS · COMPLETED · FAILED

   OJO (quirks confirmados con la key real):
     · Kling 2.6: POST usa "kling-v2-6-pro" pero el ESTADO usa "kling-v2-6".
     · Kling 2.5: POST y ESTADO comparten "kling-v2-5-pro" (ambos CON "-pro").
     · Kling exige "duration".
     · Kling 2.5/2.6 Pro admiten texto→video E imagen→video.
     · Nano Banana Pro: POST y estado comparten "nano-banana-pro".
     · Las URLs del resultado son temporales (token) → rehospedar en el front.

   POST body (desde el navegador):
     { family:'kling-2.5'|'kling-2.6'|'nano-banana', prompt, image?, refs?[], aspectRatio?, duration?, seed? }
   GET  ?taskId=..&family=..    -> { status:'done'|'processing'|'failed', url? }
   ============================================================ */

const API = process.env.FREEPIK_BASE || 'https://api.freepik.com/v1/ai';
const KEY = process.env.FREEPIK_API_KEY;

/* Ruta del POST y del estado por familia (Kling difiere en el estado). */
const POST_PATH = {
  'kling-2.5':   'image-to-video/kling-v2-5-pro',
  'kling-2.6':   'image-to-video/kling-v2-6-pro',
  'kling':       'image-to-video/kling-v2-6-pro',  // alias antiguo → 2.6 (compatibilidad)
  'nano-banana': 'text-to-image/nano-banana-pro',
};
const STATUS_PATH = {
  'kling-2.5':   'image-to-video/kling-v2-5-pro',  // 2.5: el estado va CON "-pro"
  'kling-2.6':   'image-to-video/kling-v2-6',      // 2.6: el estado va SIN "-pro"
  'kling':       'image-to-video/kling-v2-6',      // alias antiguo → 2.6
  'nano-banana': 'text-to-image/nano-banana-pro',
};

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
      const { taskId, family } = req.query;
      if(!taskId) return res.status(400).json({ error:'Falta taskId' });
      const path = STATUS_PATH[family];
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
      const { family, prompt, aspectRatio, duration, seed } = b;
      const path = POST_PATH[family];
      if(!path) return res.status(400).json({ error:`Familia desconocida: ${family}. Use kling-2.5 | kling-2.6 | nano-banana` });
      if(!prompt) return res.status(400).json({ error:'Falta el prompt' });

      // imagen(es) de entrada: base64 (con o sin prefijo) o URL pública
      let refs = Array.isArray(b.refs) ? b.refs.filter(Boolean) : [];
      if(!refs.length && b.image) refs = [b.image];
      const asAsset = u => isHttp(u) ? u : stripData(u);

      const body = { prompt };

      if(family === 'nano-banana'){
        // Nano Banana Pro (Gemini image): prompt + hasta 3 imágenes de referencia
        if(refs.length) body.reference_images = refs.slice(0, 3).map(asAsset);
      }else if(family && family.startsWith('kling')){
        // Kling (2.5 Pro / 2.6 Pro): texto→video o imagen→video. duration es obligatorio.
        body.duration = String(parseInt(duration) || 5);
        const ratio = RATIO[String(aspectRatio)];
        if(ratio) body.aspect_ratio = ratio;
        if(refs[0]) body.image = asAsset(refs[0]);
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
      return res.status(200).json({ taskId, family });
    }

    return res.status(405).json({ error:'Method not allowed' });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
