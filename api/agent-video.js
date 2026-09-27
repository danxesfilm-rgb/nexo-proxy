/* ============================================================
   NEXO Proxy · Agente IA — "Replicar video"
   Prepara un video para que Gemini lo vea y construye las dos tareas:
     analizar  { video:{ url } | { link } , lang }
               → ficha: resumen, por qué funciona, gancho, ritmo, elementos
                 (personaje, ambiente, estilo, objeto, tema) y escenas con tiempos
     replicar  { analisis, cambios:{personaje,ambiente,estilo,objeto,tema}, conFoto, lang }
               → mismo tipo de escenas con los elementos cambiados + prompts por escena

   Origen del video:
     - YouTube → Gemini lo lee directo por URL (no se descarga)
     - TikTok / Instagram → se pide el enlace al servicio yt-dlp (nexo-proxy.onrender.com)
     - Archivo subido → URL pública (R2) que da el Worker de subida
   Hasta ~12 MB va inline; más grande se sube a la Files API de Gemini.
   ============================================================ */
const GEMINI_KEY = process.env.GEMINI_TEXT_KEY || process.env.GEMINI_API_KEY;
const API_ROOT   = 'https://generativelanguage.googleapis.com';
const YTDLP      = process.env.YT_SERVER_URL || 'https://nexo-proxy.onrender.com';

const MAX_BYTES    = 100 * 1024 * 1024;   // mismo tope que el Worker de subida
const INLINE_BYTES = 12 * 1024 * 1024;    // inline admite ~20 MB por petición y base64 engorda un 33%

const LANG = { 'es-LA':'español latinoamericano neutro', 'es-ES':'español de España', 'en':'inglés (English)' };
const str  = (v, max) => String(v == null ? '' : v).slice(0, max);
const err  = (msg, status) => { const e = new Error(msg); e.status = status || 400; return e; };

const isYouTube = u => /(^|\.)youtube\.com\/|youtu\.be\//i.test(u);
const plataforma = u => /tiktok\.com/i.test(u) ? 'tiktok' : /instagram\.com/i.test(u) ? 'instagram' : null;

/* Enlace directo de un TikTok/Instagram vía el servicio yt-dlp */
async function linkDirecto(url, service){
  const r = await fetch(`${YTDLP}/api/download`, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ url, service, quality:'720' }),
  });
  const d = await r.json().catch(() => ({}));
  const v = (d.videos || []).find(x => (x.type || x.mediaType) === 'video') || null;
  if(!r.ok || !(v || d.downloadUrl)) throw err(d.detail || 'No se pudo obtener el video de ese enlace. Prueba a subir el archivo.', 422);
  return (v && v.url) || d.downloadUrl;
}

async function descargar(url){
  const r = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0 (compatible; NexoBot/1.0)' } });
  if(!r.ok) throw err(`No se pudo leer el video (${r.status})`, 422);
  const len = +r.headers.get('content-length') || 0;
  if(len > MAX_BYTES) throw err('El video pesa más de 100 MB. Recórtalo o bájale la calidad.', 413);
  const buf = Buffer.from(await r.arrayBuffer());
  if(buf.length > MAX_BYTES) throw err('El video pesa más de 100 MB. Recórtalo o bájale la calidad.', 413);
  let mime = (r.headers.get('content-type') || '').split(';')[0].trim();
  if(!/^video\//.test(mime)) mime = /\.webm(\?|$)/i.test(url) ? 'video/webm' : /\.mov(\?|$)/i.test(url) ? 'video/quicktime' : 'video/mp4';
  return { buf, mime };
}

/* Files API de Gemini: subida reanudable en un solo envío + espera a que quede ACTIVE */
async function subirAGemini(buf, mime){
  const start = await fetch(`${API_ROOT}/upload/v1beta/files`, {
    method:'POST',
    headers:{
      'x-goog-api-key': GEMINI_KEY,
      'X-Goog-Upload-Protocol':'resumable', 'X-Goog-Upload-Command':'start',
      'X-Goog-Upload-Header-Content-Length': String(buf.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type':'application/json',
    },
    body: JSON.stringify({ file:{ display_name:'nexo-replicar' } }),
  });
  const upUrl = start.headers.get('x-goog-upload-url');
  if(!start.ok || !upUrl) throw err(`Gemini no aceptó la subida del video (${start.status})`, 502);
  const up = await fetch(upUrl, {
    method:'POST',
    headers:{ 'Content-Length': String(buf.length), 'X-Goog-Upload-Offset':'0', 'X-Goog-Upload-Command':'upload, finalize' },
    body: buf,
  });
  const d = await up.json().catch(() => ({}));
  let f = d.file;
  if(!f || !f.uri) throw err('Gemini no devolvió el archivo subido', 502);
  // el video se procesa unos segundos antes de poder usarse
  for(let i = 0; i < 60 && f.state === 'PROCESSING'; i++){
    await new Promise(r => setTimeout(r, 2000));
    const g = await fetch(`${API_ROOT}/v1beta/${f.name}`, { headers:{ 'x-goog-api-key': GEMINI_KEY } });
    f = await g.json().catch(() => f);
  }
  if(f.state !== 'ACTIVE') throw err('Gemini no terminó de procesar el video. Prueba con uno más corto.', 502);
  return { file_data:{ mime_type: f.mimeType || mime, file_uri: f.uri } };
}

/* Devuelve la "parte" de contenido con el video, lista para generateContent */
export async function prepararVideo(v){
  v = v || {};
  const link = str(v.link, 1000).trim();
  const url  = str(v.url, 1000).trim();
  if(link){
    if(!/^https?:\/\//i.test(link)) throw err('El enlace no es válido');
    if(isYouTube(link)) return { file_data:{ file_uri: link } };
    const svc = plataforma(link);
    if(!svc) throw err('Pega un enlace de YouTube, TikTok o Instagram, o sube el archivo.');
    const { buf, mime } = await descargar(await linkDirecto(link, svc));
    return buf.length <= INLINE_BYTES
      ? { inline_data:{ mime_type: mime, data: buf.toString('base64') } }
      : await subirAGemini(buf, mime);
  }
  if(!/^https?:\/\//i.test(url)) throw err('Falta el video');
  const { buf, mime } = await descargar(url);
  return buf.length <= INLINE_BYTES
    ? { inline_data:{ mime_type: mime, data: buf.toString('base64') } }
    : await subirAGemini(buf, mime);
}

/* ── analizar ──────────────────────────────────────── */
export function buildAnalizar(b, media){
  const lang = LANG[b.lang] ? b.lang : 'es-LA';
  const system = `Eres un analista de video viral y director de fotografía. Desmontas un video en su "receta": qué pasa, cómo está grabado y por qué funciona, con el detalle suficiente para volver a grabar las MISMAS escenas con otro personaje, ambiente o estilo.
Escribes en ${LANG[lang]}. Respondes SOLO con JSON válido.`;
  const prompt = `Analiza el video adjunto.
- Divide en ESCENAS por cada corte o cambio claro de plano (máximo 30). Tiempos en segundos.
- Para cada escena: tipo de plano (general, medio, primer plano, detalle, cenital, POV...), movimiento de cámara (fija, paneo, travelling, zoom, cámara en mano...), la acción concreta, el texto en pantalla si lo hay y lo que se dice (voz o diálogo).
- "elementos": lo que se podría cambiar para replicarlo. Deja "" si no existe (por ejemplo, si no hay producto).
Responde SOLO este JSON:
{"titulo":"nombre corto que describa el video",
"duracion":0,
"formato":"vertical|horizontal",
"resumen":"2-3 frases",
"por_que_funciona":["3 a 5 razones concretas"],
"gancho":"qué pasa en los primeros 3 segundos y por qué engancha",
"ritmo":"duración media de los planos, cortes, transiciones",
"audio":"voz en off / diálogo / música / sonido de tendencia",
"texto_pantalla":"cómo usa los textos en pantalla ('' si no usa)",
"elementos":{"personaje":"quién sale: aspecto, ropa, edad aproximada, actitud","ambiente":"dónde ocurre: locación, momento del día, atmósfera","estilo":"estética: realista/animado, luz, colores, lente","objeto":"producto u objeto protagonista","tema":"de qué trata el contenido o el mensaje"},
"escenas":[{"n":1,"inicio":0,"fin":2.5,"plano":"...","camara":"...","accion":"...","texto_pantalla":"","voz":""}]}`;
  return { system, prompt, media:[media], json:true, maxTokens: 16384, temperature: 0.3 };
}

/* ── replicar ──────────────────────────────────────── */
const CAMBIOS = [
  ['personaje', 'PERSONAJE'], ['ambiente', 'AMBIENTE'], ['estilo', 'ESTILO VISUAL'],
  ['objeto', 'PRODUCTO / OBJETO'], ['tema', 'TEMA / MENSAJE'],
];

export function buildReplicar(b){
  const a = b.analisis;
  if(!a || !Array.isArray(a.escenas) || !a.escenas.length) throw err('Falta el análisis del video');
  const lang = LANG[b.lang] ? b.lang : 'es-LA';
  const c = b.cambios || {};
  const lineas = CAMBIOS.map(([k, lbl]) => {
    const nuevo = str(c[k], 600).trim();
    const orig  = str(a.elementos && a.elementos[k], 400);
    return nuevo ? `- ${lbl}: CAMBIAR a → ${nuevo}   (original: ${orig || '—'})`
                 : `- ${lbl}: mantener como el original → ${orig || '—'}`;
  }).join('\n');
  const vertical = a.formato !== 'horizontal';
  const foto = b.conFoto
    ? 'El usuario tiene una FOTO de referencia del personaje: en los prompts de imagen escribe "the character from the reference photo" y añade ropa/pose, sin inventar rasgos de la cara.'
    : 'No hay foto del personaje: descríbelo con rasgos físicos y ropa MUY concretos y repite esa misma descripción literal en cada prompt.';

  const system = `Eres director de producción de video viral. Reconstruyes un video escena por escena manteniendo su receta (tipo de planos, movimientos de cámara, acciones, ritmo, gancho y estructura) y cambiando SOLO los elementos que pide el usuario.
Prompts visuales en INGLÉS, encuadre ${vertical ? '9:16 vertical' : '16:9 horizontal'}, calidad cine. Textos para el usuario (acción, voz, guion, texto en pantalla) en ${LANG[lang]}.
Respondes SOLO con JSON válido.`;

  const prompt = `RECETA DEL VIDEO ORIGINAL
Título: ${str(a.titulo, 200)}
Resumen: ${str(a.resumen, 1000)}
Gancho: ${str(a.gancho, 500)}
Ritmo: ${str(a.ritmo, 400)}
Audio: ${str(a.audio, 300)}
Texto en pantalla: ${str(a.texto_pantalla, 300)}
Escenas:
${a.escenas.slice(0, 30).map(e => `${e.n}. [${e.inicio}-${e.fin}s] plano: ${str(e.plano,80)} · cámara: ${str(e.camara,80)} · acción: ${str(e.accion,300)}${e.texto_pantalla ? ' · texto: ' + str(e.texto_pantalla,120) : ''}${e.voz ? ' · voz: ' + str(e.voz,300) : ''}`).join('\n')}

CAMBIOS DEL USUARIO
${lineas}
${foto}

Reglas:
- Mismo número y orden de escenas, mismo plano, mismo movimiento de cámara y misma duración (cada clip entre 3 y 10 s; si una escena original dura más de 10 s, divídela).
- Adapta cada acción a los elementos nuevos con sentido (si cambia el producto, la acción gira en torno al nuevo producto).
- Si cambia el tema, reescribe la voz y los textos en pantalla con la misma estructura, longitud y tono que el original.
- No escribas relaciones de aspecto (4:3, 16:9, 9:16…) en el ancla ni en los prompts: el formato lo fija Studio.
- "ancla": descripción fija en inglés de personaje, ambiente y estilo que se repite en TODOS los prompts para que las escenas se vean coherentes.
- "prompt_imagen": el primer fotograma de la escena (composición, sujeto, ambiente, luz, estilo).
- "prompt_video": qué se mueve durante el clip (acción + movimiento de cámara), pensado para animar ese primer fotograma en Kling / Seedance.
Responde SOLO este JSON:
{"titulo":"título del nuevo video","concepto":"2 frases",
"ancla":{"personaje":"...","ambiente":"...","estilo":"..."},
"guion":"voz completa del nuevo video, con saltos de línea por escena ('' si el original no tiene voz)",
"escenas":[{"n":1,"dur":3,"plano":"...","camara":"...","accion":"...","voz":"","texto_pantalla":"","prompt_imagen":"...","prompt_video":"..."}]}`;

  return { system, prompt, json:true, maxTokens: 24576, temperature: 0.6 };
}
