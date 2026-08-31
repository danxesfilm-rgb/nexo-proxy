/* ============================================================
   NEXO Proxy · Seedance (ByteDance) vía EvoLink.AI
   - POST  { prompt, model?, route?, aspectRatio?, duration?,
             resolution?, audio?, refs?[] , image?, image_tail? } → { taskId }
   - GET   ?taskId=...        → { status, url? }
   - GET   ?models=1          → catálogo y límites que aplica el servidor
   Key: env EVOLINK_KEY (o SEEDANCE_KEY). Nunca llega al navegador.
   Docs: https://evolink.ai/docs/en/api-manual/video-series/

   API:
     POST https://api.evolink.ai/v1/videos/generations   → { id, status }
     GET  https://api.evolink.ai/v1/tasks/{id}           → { status, results[] }

   IMPORTANTE: EvoLink recibe las referencias como URLs públicas
   (image_urls / video_urls / audio_urls), NO como base64. El navegador
   sube los archivos a nexoagency.pe/upload.php y manda aquí las URLs.
   ============================================================ */

const API_BASE = process.env.EVOLINK_BASE || 'https://api.evolink.ai';
const KEY      = process.env.EVOLINK_KEY || process.env.SEEDANCE_KEY;

/* Familias disponibles. El ID final se arma como `${familia}-${ruta}`,
   p. ej. seedance-2.0-reference-to-video */
const FAMILIES = {
  'seedance-2.5': {
    id:'seedance-2.5',
    maxImages:30, maxVideos:10, maxAudios:10, maxAssets:50,
    minDur:4, maxDur:30, autoDur:true,
    quality:['480p','720p'],
  },
  'seedance-2.0': {
    id:'seedance-2.0',
    maxImages:9, maxVideos:3, maxAudios:3, maxAssets:15,
    minDur:4, maxDur:15, autoDur:false,
    quality:['480p','720p','1080p'],
  },
  'seedance-2.0-fast': {
    id:'seedance-2.0-fast',
    maxImages:9, maxVideos:3, maxAudios:3, maxAssets:15,
    minDur:4, maxDur:15, autoDur:false,
    quality:['480p','720p'],
  },
  /* Generación anterior: más barata (~$0.059/s a 1080p sin audio). Solo texto
     e imagen → video, sin referencias de video/audio, y hasta 12s. */
  'seedance-1.5-pro': {
    id:'seedance-1.5-pro',
    maxImages:2, maxVideos:0, maxAudios:0, maxAssets:2,
    minDur:4, maxDur:12, autoDur:false,
    quality:['480p','720p','1080p'],
    routes:['text-to-video','image-to-video'],
    idFallback:true,
  },
  /* Wan 3.0 (Alibaba, ago-2026). Mismo endpoint y misma key de EvoLink que
     Seedance, pero nombra la ruta de referencias «reference-video» → routeIds.
     30s nativos, 1080p y audio en la misma pasada. No tiene video-edit. */
  'wan-3.0': {
    id:'wan3.0',
    maxImages:10, maxVideos:5, maxAudios:5, maxAssets:20,
    minDur:2, maxDur:30, autoDur:true,
    quality:['480p','720p','1080p'],
    routes:['text-to-video','image-to-video','reference-to-video'],
    routeIds:{ 'reference-to-video':'reference-video' },
  },
};
const DEFAULT_FAMILY = process.env.SEEDANCE_DEFAULT_MODEL || 'seedance-2.0';
const ROUTES = ['text-to-video','image-to-video','reference-to-video'];
const RATIOS = ['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'];

const isHttp = u => /^https?:\/\//i.test(String(u || ''));

function kindOf(u){
  const s = String(u || '').toLowerCase();
  if(/\.(mp4|mov|webm|m4v)(\?|$)/.test(s)) return 'video';
  if(/\.(mp3|wav|m4a|aac|ogg)(\?|$)/.test(s)) return 'audio';
  return 'image';
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();

  // Diagnóstico: qué familias y límites aplica el servidor (no expone la key)
  if(req.method === 'GET' && req.query && req.query.models){
    return res.status(200).json({ provider:'evolink', base:API_BASE,
                                  families:FAMILIES, routes:ROUTES, default:DEFAULT_FAMILY });
  }

  if(!KEY) return res.status(500).json({ error:'Falta EVOLINK_KEY en el servidor' });
  const auth = { Authorization:`Bearer ${KEY}` };

  try{
    /* ── POLLING ── */
    if(req.method === 'GET'){
      const { taskId } = req.query;
      if(!taskId) return res.status(400).json({ error:'Falta taskId' });
      const r = await fetch(`${API_BASE}/v1/tasks/${encodeURIComponent(taskId)}`, { headers:auth });
      const d = await r.json();
      if(!r.ok) return res.status(r.status).json({ error: d.error?.message || 'EvoLink poll error' });

      if(d.status === 'completed'){
        const url = Array.isArray(d.results) ? d.results[0] : (d.results || null);
        if(!url) return res.status(200).json({ status:'failed', error:'Tarea completada sin URL de video' });
        // La URL caduca a las 24 h
        const secs = d.task_info?.video_duration;
        return res.status(200).json({ status:'done', url, dur: secs ? `${secs}s` : undefined });
      }
      if(d.status === 'failed'){
        return res.status(200).json({ status:'failed', error: d.error?.message || 'Render fallido' });
      }
      return res.status(200).json({ status:'processing', progress: d.progress });
    }

    /* ── START ── */
    if(req.method === 'POST'){
      const b = req.body || {};
      const { prompt, aspectRatio, duration, resolution, audio, seed } = b;
      if(!prompt) return res.status(400).json({ error:'Falta el prompt' });

      const famKey = b.model || DEFAULT_FAMILY;
      const fam = FAMILIES[famKey];
      if(!fam){
        return res.status(400).json({
          error:`Modelo desconocido: ${famKey}. Disponibles: ${Object.keys(FAMILIES).join(', ')}`
        });
      }

      /* Referencias: se aceptan solo URLs públicas (EvoLink las descarga) */
      let refs = Array.isArray(b.refs) ? b.refs.filter(Boolean) : [];
      if(!refs.length && b.image) refs = [b.image];
      if(b.image_tail) refs.push(b.image_tail);

      const bad = refs.find(u => !isHttp(u));
      if(bad){
        return res.status(400).json({
          error:'Las referencias deben ser URLs públicas (http/https). EvoLink no acepta base64.'
        });
      }

      const image_urls = [], video_urls = [], audio_urls = [];
      for(const u of refs){
        const k = kindOf(u);
        if(k === 'video'){ if(video_urls.length < fam.maxVideos) video_urls.push(u); }
        else if(k === 'audio'){ if(audio_urls.length < fam.maxAudios) audio_urls.push(u); }
        else { if(image_urls.length < fam.maxImages) image_urls.push(u); }
      }
      const totalAssets = image_urls.length + video_urls.length + audio_urls.length;
      if(totalAssets > fam.maxAssets){
        return res.status(400).json({ error:`${famKey} admite como máximo ${fam.maxAssets} archivos por petición` });
      }

      /* Ruta: la elige el cliente o se deduce de las entradas.
         sin archivos → texto · 1 imagen → imagen · resto → referencia */
      const famRoutes = fam.routes || ROUTES;
      let route = famRoutes.includes(b.route) ? b.route : null;
      if(!route){
        if(video_urls.length || audio_urls.length || image_urls.length > 1) route = 'reference-to-video';
        else if(image_urls.length === 1) route = 'image-to-video';
        else route = 'text-to-video';
      }
      // video/audio de referencia solo existen en la ruta reference-to-video
      if(route !== 'reference-to-video' && (video_urls.length || audio_urls.length)){
        route = 'reference-to-video';
      }
      // familias sin reference-to-video (1.5 Pro): las imágenes van por image-to-video
      if(!famRoutes.includes(route)){
        route = image_urls.length ? 'image-to-video' : 'text-to-video';
      }
      const modelId = `${fam.id}-${(fam.routeIds && fam.routeIds[route]) || route}`;

      /* Parámetros */
      const ratio = RATIOS.includes(String(aspectRatio)) ? aspectRatio : 'adaptive';
      let dur;
      if((duration === -1 || duration === 'auto') && fam.autoDur){
        dur = -1;                                  // el modelo elige y se factura lo real
      }else{
        const maxDur = (fam.routeMaxDur && fam.routeMaxDur[route]) || fam.maxDur;
        dur = Math.min(maxDur, Math.max(fam.minDur, parseInt(duration) || 5));
      }
      const q = String(resolution || '720p').toLowerCase();
      const quality = fam.quality.includes(q) ? q : fam.quality[fam.quality.length-1];

      const body = {
        model: modelId,
        prompt,
        duration: dur,
        quality,
        aspect_ratio: ratio,
        generate_audio: audio !== false,
        content_filter: true,
      };
      if(image_urls.length) body.image_urls = image_urls;
      if(video_urls.length) body.video_urls = video_urls;
      if(audio_urls.length) body.audio_urls = audio_urls;
      if(seed !== undefined && seed !== null && seed !== '') body.seed = parseInt(seed);

      const send = async id => {
        const rr = await fetch(`${API_BASE}/v1/videos/generations`, {
          method:'POST',
          headers:{ ...auth, 'Content-Type':'application/json' },
          body: JSON.stringify({ ...body, model:id })
        });
        return { r:rr, d: await rr.json() };
      };

      /* EvoLink no documenta si 1.5 Pro lleva la ruta en el id (como 2.x) o si
         es un id único. Si el primero no existe, se reintenta con el id pelado. */
      let usedId = modelId;
      let { r, d } = await send(usedId);
      if(!r.ok && fam.idFallback && usedId !== fam.id &&
         /model|not found|unsupported|unknown|invalid/i.test(String(d.error?.message || d.message || ''))){
        usedId = fam.id;
        ({ r, d } = await send(usedId));
      }
      if(!r.ok){
        const msg = d.error?.message || d.message || ('EvoLink '+r.status);
        return res.status(r.status).json({ error: `${msg} (modelo: ${usedId})` });
      }
      const taskId = d.id;
      if(!taskId) return res.status(502).json({ error:'EvoLink no devolvió id de tarea' });
      return res.status(200).json({ taskId, model:usedId });
    }

    return res.status(405).json({ error:'Method not allowed' });
  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
