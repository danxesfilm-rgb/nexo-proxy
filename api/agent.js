/* ============================================================
   NEXO Proxy · Agente IA de video viral (Gemini)
   POST { task, ...datos } → JSON según la tarea
     Todas aceptan { fmt:'vertical'|'horizontal', redes:[...] } (o 'plat' del historial viejo)
     task = 'ideas'   { tema, dur, lang, tono, investigar }
                      → { ideas:[{tema,gancho,apertura,formato,score,angulos}], fuentes, busquedas }
     task = 'guion'   { idea:{titulo,tema,gancho,apertura}, lang, tono, dur }
                      → { concepto, guion, ganchos, score, mejoras }
     task = 'refinar' { titulo, concepto, guion, instr, lang, tono, dur }
                      → igual que 'guion'
     task = 'prompts' { titulo, guion, nImgs, nClips }
                      → { estilo_visual, imgs, vids }
     task = 'extras'  { titulo, concepto, lang }
                      → { prompt_miniatura, texto_portada, por_red:[{red,titulo,descripcion,hashtags,hora}] }

   'ideas' con investigar=true usa Google Search grounding: Gemini busca
   de verdad y devuelve las fuentes consultadas.

   Key: env GEMINI_TEXT_KEY, y si no existe cae a GEMINI_API_KEY (igual que prompt.js).
   Modelo: env GEMINI_AGENT_MODEL (opcional) · por defecto Flash, Flash-Lite de respaldo.

   Los system prompts viven aquí y no en el navegador: el endpoint solo
   sabe hacer estas tareas y no queda como un LLM abierto a cualquiera.
   ============================================================ */
import { fetchNews } from './trends.js';

const GEMINI_KEY = process.env.GEMINI_TEXT_KEY || process.env.GEMINI_API_KEY;

// La búsqueda de Google de Gemini tiene cuota propia (en la capa gratuita se agota o no existe).
// Tras un 429 se deja de intentar un rato y se usan titulares de Google News (plan B).
const SEARCH_PAUSE_MS = 15 * 60 * 1000;
let searchBlockedUntil = 0;

// Si un modelo no existe (404), se queda sin cuota (429) o está saturado (5xx), se prueba el siguiente
const MODELS = [
  process.env.GEMINI_AGENT_MODEL || 'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
].filter((m, i, a) => m && a.indexOf(m) === i);

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

/* Redes de destino. 'pub' = cómo se publica en cada una (para el paquete de publicación) */
const REDES = {
  tiktok:  { n:'TikTok', d:'TikTok (tono nativo y directo, gancho en el primer segundo)',
             pub:'descripción corta y directa (máx. 150 caracteres) con 3-5 hashtags de nicho + 1 amplio; sin título aparte (titulo = texto sobre el video)' },
  shorts:  { n:'YouTube Shorts', d:'YouTube Shorts (ritmo muy rápido, bucle, máx. 3 min)',
             pub:'título de menos de 70 caracteres con palabra clave al inicio, descripción de 1-2 frases, hashtags incluyendo #shorts' },
  reels:   { n:'Instagram Reels', d:'Instagram Reels (estético, compartible por mensaje privado, máx. 3 min)',
             pub:'caption con una primera línea gancho, 2-4 líneas con saltos, pregunta final y máx. 5 hashtags; titulo = texto sobre el video' },
  fbreels: { n:'Facebook Reels', d:'Facebook Reels (público algo mayor, emocional y claro)',
             pub:'texto cercano de 1-3 frases con pregunta para comentar y 2-3 hashtags; titulo = texto sobre el video' },
  youtube: { n:'YouTube', d:'YouTube horizontal (16:9, desarrollo amplio con re-enganches y buena retención)',
             pub:'título SEO de menos de 70 caracteres, descripción larga (primeras 2 líneas con gancho y palabra clave, resumen, capítulos con marcas de tiempo aproximadas, CTA) y 10-15 tags' },
};
const REDES_VERT = ['tiktok', 'shorts', 'reels', 'fbreels'];
const PLAT_OLD = { youtube:'youtube', shorts:'shorts', tiktok:'tiktok', reels:'reels' };

/* Formato + redes de la petición. Acepta el 'plat' único del historial viejo. */
function platInfo(b){
  let fmt = b.fmt, redes = Array.isArray(b.redes) ? b.redes.filter(r => REDES[r]) : [];
  if(fmt !== 'vertical' && fmt !== 'horizontal'){
    const p = PLAT_OLD[b.plat] || 'youtube';
    fmt = p === 'youtube' ? 'horizontal' : 'vertical';
    redes = [p];
  }
  if(fmt === 'horizontal') redes = ['youtube'];
  else{
    redes = REDES_VERT.filter(r => redes.includes(r));
    if(!redes.length) redes = ['tiktok', 'shorts', 'reels'];
  }
  const long = fmt === 'horizontal';
  const desc = long ? REDES.youtube.d
    : `video VERTICAL 9:16 que se publicará igual en: ${redes.map(r => REDES[r].d).join('; ')}${redes.length > 1 ? '. Debe funcionar en todas a la vez' : ''}`;
  return { long, redes, desc, ratio: long ? '16:9 horizontal' : '9:16 vertical' };
}
const LANG = {
  'es-LA': 'español latinoamericano neutro',
  'es-ES': 'español de España',
  'en':    'inglés (English)',
};

const TONOS = {
  educativo:    'educativo: claro, con datos concretos y sensación de "aprendí algo"',
  humor:        'humor: ligero, con remates y situaciones reconocibles',
  misterio:     'misterio: intriga, suspenso, preguntas sin resolver hasta el final',
  polemico:     'polémico: opinión fuerte que divide y provoca comentarios, sin desinformar ni ofender a colectivos',
  inspirador:   'inspirador: emotivo, de superación, que deje con ganas de actuar',
  storytelling: 'storytelling: una historia con personaje, conflicto y desenlace',
};
// Línea para el prompt; 'auto' o desconocido = el agente elige el tono que mejor funcione
const tonoLine = t => TONOS[t] ? `Tono obligatorio: ${TONOS[t]}.` : 'Tono: elige el que mejor funcione para este nicho y plataforma.';

/* Lo que sabe el agente sobre viralidad. Se inyecta en todas las tareas creativas. */
const PLAYBOOK = `
MANUAL DE VIRALIDAD (aplícalo siempre):
- GANCHO en los primeros 1-3 segundos: rompe el patrón (afirmación audaz, pregunta que duele, resultado final primero, dato imposible, conflicto). Nada de saludos ni "en este video...".
- BUCLE ABIERTO: plantea una pregunta o promesa al inicio y no la resuelvas hasta el final.
- UNA sola idea por video. Cada frase empuja a la siguiente; corta todo relleno.
- RITMO: en formato corto, un cambio visual o de idea cada 2-4 s. En largo, re-enganches cada 45-60 s ("pero lo peor viene ahora").
- PAGO: el final entrega lo prometido con un giro o dato extra. En cortos, si se puede, el final enlaza con el inicio (bucle perfecto) para que se vuelva a ver.
- COMPARTIBLE: identidad ("esto es tan de…"), utilidad (guardar para después), emoción fuerte (sorpresa, indignación, ternura) o polémica sana.
- CTA que provoque comentarios (pregunta concreta, elegir bando), no "suscríbete" genérico.
- FORMATOS que funcionan: POV, "X cosas que no sabías", antes/después, storytime, mito vs realidad, reto, tutorial exprés, ranking, "qué pasaría si", reacción a dato.`;

/* Puntuación: el modelo tiende a inflar, así que se le pide calibración explícita. */
const SCORE_RULES = `
PUNTUACIÓN VIRAL (0-100, sé crítico y calibrado: la media real ronda 55-70, más de 85 es excepcional y raro):
- gancho: fuerza de los primeros 3 segundos.
- retencion: probabilidad de que lo vean hasta el final.
- compartible: ganas de enviarlo, guardarlo o comentarlo.
- encaje: cuánto encaja con la plataforma y el momento actual.
- total: media ponderada (gancho 35%, retencion 30%, compartible 20%, encaje 15%).`;

const SCORE_JSON = `{"total":0,"gancho":0,"retencion":0,"compartible":0,"encaje":0}`;

const fechaHoy = () => new Date().toLocaleDateString('es-ES', { day:'numeric', month:'long', year:'numeric' });

// Recorta y sanea las cadenas que llegan del navegador
const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const int = (v, min, max, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const durLabel = s => s >= 60 ? `${Math.round(s / 60)} min` : `${s}s`;

/* ── Construcción de cada tarea ─────────────────────── */
// news = titulares de Google News (plan B); si viene, se usan en lugar de la búsqueda de Gemini
function buildIdeas(b, news){
  const tema = str(b.tema, 600).trim();
  if(!tema) throw badReq('Falta el tema');
  const P    = platInfo(b);
  const lang = LANG[b.lang] ? b.lang : 'es-LA';
  const dur  = int(b.dur, 5, 1800, P.long ? 480 : 30);
  const web  = b.investigar !== false && !news;
  const titulares = news && news.length
    ? '\nTITULARES REALES DE ESTOS DÍAS sobre el nicho (Google News). Úsalos como base de las tendencias; no inventes otras:\n'
      + news.map(n => '- ' + n.title).join('\n') + '\n'
    : '';

  const system = `Eres un estratega de contenido viral que optimiza la producción diaria para YouTube y redes sociales. Hoy es ${fechaHoy()}.
${web
  ? 'USA LA BÚSQUEDA DE GOOGLE para descubrir qué es tendencia ESTOS DÍAS en el nicho (noticias, conversaciones, videos que están explotando). Básate en resultados reales y recientes; no inventes tendencias.'
  : news ? 'Basa las ideas en los titulares reales que te paso: son lo que es tendencia hoy.' : 'Usa tu conocimiento; genera ideas frescas y no cites años viejos.'}
${PLAYBOOK}
${SCORE_RULES}
Escribes en ${LANG[lang]}. Respondes SOLO con JSON válido, sin texto extra, sin markdown, sin enlaces ni marcas de cita.`;

  const prompt = `Tema/nicho: "${tema}"
Formato: ${P.desc}.
Duración del video: ${durLabel(dur)}. Las ideas deben poder contarse bien en ese tiempo (en poco tiempo, una sola idea potente; en mucho, temas con desarrollo).
${tonoLine(b.tono)}
${titulares}${web || news ? 'A partir de lo que es TENDENCIA HOY en este nicho, dame' : 'Dame'} 5 TEMAS distintos con alto potencial viral. Por cada tema:
- "gancho": por qué es viral AHORA, en una frase (menciona la tendencia real si la hay).
- "apertura": la frase exacta de los primeros 3 segundos del video.
- "formato": el formato viral que mejor le va (POV, ranking, mito vs realidad, storytime...).
- "score": puntuación viral según las reglas.
- "angulos": 3 títulos concretos listos para grabar.
Responde SOLO este JSON:
{"ideas":[{"tema":"nombre corto","gancho":"...","apertura":"...","formato":"...","score":${SCORE_JSON},"angulos":["...","...","..."]}]}`;

  return { system, prompt, search: web, json: !web, maxTokens: 8192, temperature: 0.9 };
}

function guionOut(lang){
  return `Además del guion, como agente evaluador:
- "ganchos": 3 aperturas ALTERNATIVAS (primeros 3 s) de estilos distintos, cada una con su "tipo" (pregunta, afirmación audaz, resultado primero, dato impactante, conflicto...).
- "score": puntuación viral HONESTA del guion resultante según las reglas.
- "mejoras": 2 a 4 cambios concretos y accionables que subirían la puntuación (en ${LANG[lang]}).
Responde SOLO este JSON:
{"concepto":"2-3 frases: de qué va y por qué funciona","guion":"guion completo para voz IA con saltos de línea entre bloques","ganchos":[{"tipo":"...","texto":"..."}],"score":${SCORE_JSON},"mejoras":["..."]}`;
}

function guionSystem(lang){
  return `Eres un guionista experto en video viral y producción diaria. Hoy es ${fechaHoy()} (no cites años ni datos viejos).
Escribes el guion en ${LANG[lang]} para una VOZ IA: texto limpio, listo para leer, sin acotaciones de cámara, sin nombres de escena, sin emojis.
${PLAYBOOK}
${SCORE_RULES}
Respondes SOLO con JSON válido.`;
}

function buildGuion(b){
  const idea = b.idea || {};
  const titulo = str(idea.titulo, 300).trim();
  if(!titulo) throw badReq('Falta la idea');
  const P    = platInfo(b);
  const lang = LANG[b.lang] ? b.lang : 'es-LA';
  const dur  = int(b.dur, 5, 1800, 60);
  const palabras = Math.round(dur * 2.4); // ~145 palabras por minuto de voz IA

  const prompt = `Título del video: "${titulo}"
Tema: "${str(idea.tema, 300)}". Por qué es viral: "${str(idea.gancho, 400)}"
${idea.apertura ? `Apertura sugerida (mejórala si puedes): "${str(idea.apertura, 300)}"\n` : ''}Formato: ${P.desc}.
${tonoLine(b.tono)}
Duración objetivo: ${durLabel(dur)} (${dur} s ≈ ${palabras} palabras de narración).
${P.long
  ? 'Formato LARGO: guion extenso que cubra toda la duración, estructurado por bloques con re-enganches.'
  : 'Formato CORTO: ritmo rápido, gancho fortísimo en los primeros 3 segundos, final que invite a volver a verlo.'}
${guionOut(lang)}`;

  return { system: guionSystem(lang), prompt, json: true,
           maxTokens: P.long ? 16384 : 6144, temperature: 0.85 };
}

function buildRefinar(b){
  const guion = str(b.guion, 30000).trim();
  const instr = str(b.instr, 2000).trim();
  if(!guion) throw badReq('Falta el guion');
  if(!instr) throw badReq('Falta la instrucción');
  const P    = platInfo(b);
  const lang = LANG[b.lang] ? b.lang : 'es-LA';
  const dur  = int(b.dur, 5, 1800, 60);

  const prompt = `Título: "${str(b.titulo, 300)}"
Formato: ${P.desc}. Duración objetivo: ${durLabel(dur)}.
${tonoLine(b.tono)}
Concepto actual: ${str(b.concepto, 2000)}
Guion actual:
${guion}

Instrucción del usuario: "${instr}"
Aplica la instrucción manteniendo la duración objetivo y todo lo que no se pide cambiar.
${guionOut(lang)}`;

  return { system: guionSystem(lang), prompt, json: true,
           maxTokens: P.long ? 16384 : 6144, temperature: 0.7 };
}

function buildPrompts(b){
  const guion = str(b.guion, 30000).trim();
  if(!guion) throw badReq('Falta el guion');
  const P      = platInfo(b);
  const nImgs  = int(b.nImgs, 0, 120, 0);
  const nClips = int(b.nClips, 0, 150, 0);
  if(!nImgs && !nClips) throw badReq('Pide imágenes o videos');
  const ratio = P.ratio;
  const QUALITY = 'cinematic, 4K, ultra-detailed, professional color grading, dramatic lighting, sharp focus, high production value';

  const want = [];
  if(nImgs)  want.push(`"imgs": EXACTAMENTE ${nImgs} prompts de IMAGEN. Cada item {"n":1,"prompt":"...","necesita_ref":false,"ref_nota":""}. Marca necesita_ref=true SOLO si la escena requiere una foto real del usuario (producto, persona concreta, logo) y explica cuál en ref_nota (en español).`);
  if(nClips) want.push(`"vids": EXACTAMENTE ${nClips} prompts de VIDEO para clips de máximo 8 s (Veo 3.1 / Kling / Seedance), con movimiento de cámara y acción concreta. Cada item {"n":1,"prompt":"..."}.`);

  const system = `Eres director de producción audiovisual para video viral. Conviertes un guion en prompts visuales en INGLÉS, siempre con calidad cine (${QUALITY}), encuadre ${ratio}.
Reglas:
- Primero define un "estilo_visual": personaje(s) con rasgos físicos y ropa precisos, paleta y estética. REPITE esa descripción del personaje literalmente en cada prompt donde aparezca, para que se vea igual en todas las escenas.
- La escena 1 debe ser el GANCHO visual más potente (movimiento, contraste o sorpresa).
- Varía planos (general, medio, detalle, cenital) para mantener el ritmo.
- Nada de texto escrito dentro de la imagen salvo que el guion lo exija.
Respondes SOLO con JSON válido que contenga únicamente las claves pedidas.`;

  const prompt = `Título: "${str(b.titulo, 300)}"
Guion:
${guion}

Cubre el guion completo en orden y genera:
- "estilo_visual": una o dos frases en inglés (personaje + estética).
- ${want.join('\n- ')}
Cada prompt termina incorporando los descriptores de calidad.
Responde SOLO este JSON: {"estilo_visual":"..."${nImgs ? ',"imgs":[...]' : ''}${nClips ? ',"vids":[...]' : ''}}`;

  // ~90 tokens por prompt + margen para el razonamiento
  const maxTokens = Math.min(65536, 4096 + (nImgs + nClips) * 160);
  return { system, prompt, json: true, maxTokens, temperature: 0.7 };
}

function buildExtras(b){
  const titulo = str(b.titulo, 300).trim();
  if(!titulo) throw badReq('Falta el título');
  const P    = platInfo(b);
  const lang = LANG[b.lang] ? b.lang : 'es-LA';
  const reglas = P.redes.map(r => `- "${r}" (${REDES[r].n}): ${REDES[r].pub}`).join('\n');

  const system = `Eres experto en SEO y crecimiento en redes sociales. Hoy es ${fechaHoy()}. Generas el paquete de publicación de un video, adaptado a CADA red donde se publica (no copies el mismo texto en todas).
Textos en ${LANG[lang]}; el prompt de miniatura en inglés. Respondes SOLO con JSON válido.`;
  const prompt = `Video: "${titulo}"
Concepto: ${str(b.concepto, 2000)}
Formato: ${P.desc}.
Se publica en estas redes, con estas reglas:
${reglas}
Responde SOLO este JSON, con un elemento en "por_red" por cada red y en ese orden:
{"prompt_miniatura":"prompt en inglés para una portada impactante: rostro con emoción fuerte o contraste, composición simple, ${P.long ? '16:9' : '9:16'}",
"texto_portada":"3 a 5 palabras grandes para poner encima de la portada",
"por_red":[{"red":"${P.redes[0]}","titulo":"...","descripcion":"...","hashtags":["..."],"hora":"mejor día y franja horaria para publicar en esa red para público hispano, con una frase de por qué"}]}`;

  return { system, prompt, json: true, maxTokens: 4096 + P.redes.length * 1024, temperature: 0.7 };
}

const TASKS = { ideas: buildIdeas, guion: buildGuion, refinar: buildRefinar, prompts: buildPrompts, extras: buildExtras };

function badReq(msg){ const e = new Error(msg); e.status = 400; return e; }

/* ── Llamada a Gemini ───────────────────────────────── */
async function askGemini(model, t){
  const body = {
    system_instruction: { parts: [{ text: t.system }] },
    contents: [{ role: 'user', parts: [{ text: t.prompt }] }],
    // holgado: los modelos 3.x razonan antes de responder y un tope corto devuelve texto vacío
    generationConfig: { maxOutputTokens: t.maxTokens, temperature: t.temperature },
  };
  // Con búsqueda no se fuerza el modo JSON (no todos los modelos combinan ambas cosas)
  if(t.json)   body.generationConfig.responseMimeType = 'application/json';
  if(t.search) body.tools = [{ google_search: {} }];

  const r = await fetch(`${API}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){
    let msg = d?.error?.message || `Gemini ${r.status}`;
    if(/are blocked|API_KEY_SERVICE_BLOCKED|SERVICE_DISABLED/i.test(msg)){
      msg = 'La key de Gemini no tiene permitido generar texto. Revisa las restricciones de la key o usa una nueva de AI Studio en GEMINI_TEXT_KEY.';
    }
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  const cand  = d?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const text  = parts.filter(p => p && p.text && !p.thought).map(p => p.text).join('').trim();
  if(!text){
    const why = cand?.finishReason || d?.promptFeedback?.blockReason || 'respuesta vacía';
    throw new Error(`Gemini no devolvió texto (${why})`);
  }
  if(cand?.finishReason === 'MAX_TOKENS'){
    const err = new Error('La respuesta salió cortada por ser demasiado larga. Prueba con menos escenas o una duración menor.');
    err.status = 502;
    throw err;
  }
  const gm = cand?.groundingMetadata || {};
  const fuentes = (gm.groundingChunks || [])
    .map(c => c.web).filter(w => w && w.uri)
    .map(w => ({ title: w.title || '', uri: w.uri }))
    .filter((w, i, a) => a.findIndex(x => x.title === w.title) === i)
    .slice(0, 8);
  return { text, fuentes, busquedas: (gm.webSearchQueries || []).slice(0, 6) };
}

function parseJSON(raw){
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); if(fence) s = fence[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if(a !== -1 && b !== -1) s = s.slice(a, b + 1);
  // el grounding a veces cuela marcas de cita tipo [1] o [1, 2] fuera de las cadenas
  try{ return JSON.parse(s); }
  catch(e){ return JSON.parse(s.replace(/\s*\[\d+(?:,\s*\d+)*\](?=\s*[,}\]])/g, '')); }
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if(!GEMINI_KEY)              return res.status(500).json({ error: 'Falta GEMINI_TEXT_KEY / GEMINI_API_KEY en el servidor' });

  const body  = req.body || {};
  const build = TASKS[body.task];
  if(!build) return res.status(400).json({ error: 'Tarea desconocida' });

  let t;
  try{ t = build(body); }
  catch(e){ return res.status(e.status || 400).json({ error: e.message }); }

  try{
    // Ideas con investigación: primero la búsqueda de Gemini; si no hay cuota, plan B con Google News
    if(body.task === 'ideas' && t.search){
      if(Date.now() >= searchBlockedUntil){
        try{
          const { data, g } = await runModels(t);
          return res.status(200).json({ ...data, fuentes: g.fuentes, busquedas: g.busquedas, investigacion: 'google' });
        }catch(e){
          if(e.status !== 429) throw e;
          searchBlockedUntil = Date.now() + SEARCH_PAUSE_MS;
        }
      }
      const tema = str(body.tema, 200).trim();
      const news = await fetchNews(tema, body.lang, 12).catch(() => []);
      const { data } = await runModels(buildIdeas(body, news.length ? news : null));
      return res.status(200).json({ ...data,
        fuentes: news.slice(0, 8).map(n => ({ title: n.source || 'Google News', uri: n.link })),
        busquedas: news.length ? [`Google News: ${tema}`] : [],
        investigacion: news.length ? 'noticias' : 'ninguna' });
    }
    const { data } = await runModels(t);
    return res.status(200).json(data);
  }catch(lastErr){
    return sendError(res, lastErr);
  }
}

/* Prueba los modelos en orden y devuelve el JSON ya parseado */
async function runModels(t){
  let lastErr;
  for(const model of MODELS){
    try{
      const g = await askGemini(model, t);
      let data;
      try{ data = parseJSON(g.text); }
      catch(e){ const err = new Error('El agente devolvió un formato inválido, reintenta.'); err.status = 502; throw err; }
      data.model = model;
      return { data, g };
    }catch(e){
      lastErr = e;
      // 404 = modelo retirado · 429 = sin cuota · 5xx = saturado → probar el siguiente
      if(!(e.status === 404 || e.status === 429 || (e.status >= 500 && e.status !== 502))) break;
    }
  }
  throw lastErr;
}

function sendError(res, lastErr){
  const status = lastErr?.status === 429 ? 429 : (lastErr?.status === 502 ? 502 : 500);
  const msg = lastErr?.status === 429
    ? 'Se agotó la cuota de Gemini por ahora. Prueba en unos minutos.'
    : (lastErr?.message || 'El agente no pudo responder');
  return res.status(status).json({ error: msg });
}
