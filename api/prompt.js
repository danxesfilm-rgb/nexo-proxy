/* ============================================================
   NEXO Proxy · Mejora de prompts con Gemini (capa gratuita)
   POST { prompt, type:'image'|'video' } → { prompt: '<mejorado>' }
   Key: env GEMINI_TEXT_KEY, y si no existe cae a GEMINI_API_KEY.
        Se admite una key aparte porque la de Veo puede estar restringida
        al método predictLongRunning y rechazar generateContent.
   Modelo: env GEMINI_TEXT_MODEL (opcional) · por defecto Flash-Lite

   Los system prompts viven aquí y no en el navegador: así el endpoint
   solo sabe hacer una cosa y no queda como un LLM abierto a cualquiera.
   ============================================================ */
const GEMINI_KEY = process.env.GEMINI_TEXT_KEY || process.env.GEMINI_API_KEY;

// Si Google retira un ID de modelo, se prueba el siguiente de la lista
const MODELS = [
  process.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
].filter((m, i, a) => m && a.indexOf(m) === i);

const SYSTEM = {
  video: `Eres un director de fotografía y experto en prompts para generadores de video IA (Kling, Veo, Seedance).
Tu tarea: reescribir el prompt del usuario para obtener el mejor resultado visual posible.
Reglas:
- Añade descripción de movimiento de cámara (ej: "slow zoom in", "cinematic dolly shot", "static shot").
- Añade iluminación y atmósfera ("golden hour light", "soft studio lighting", "dramatic shadows").
- Añade detalle de la acción y velocidad del movimiento.
- Mantén la idea original del usuario, solo enriquécela.
- Máximo 2 oraciones. Solo en inglés. Devuelve únicamente el prompt mejorado, sin explicaciones ni comillas.`,
  image: `Eres un experto en prompts para generadores de imagen IA (Flux, Stable Diffusion, Midjourney).
Tu tarea: reescribir el prompt del usuario para obtener el mejor resultado visual posible.
Reglas:
- Añade estilo artístico, iluminación, composición y calidad ("8K", "photorealistic", "studio lighting").
- Mantén la idea original del usuario, solo enriquécela.
- Máximo 2 oraciones. Solo en inglés. Devuelve únicamente el prompt mejorado, sin explicaciones ni comillas.`,
};

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

async function askGemini(model, system, prompt){
  const r = await fetch(`${API}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role:'user', parts:[{ text: prompt }] }],
      // holgado a propósito: los modelos 3.x razonan antes de responder y un
      // tope corto se consume en el razonamiento, devolviendo texto vacío
      generationConfig: { maxOutputTokens: 1024, temperature: 0.9 },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){
    let msg = d?.error?.message || `Gemini ${r.status}`;
    // Google devuelve esto cuando la key está restringida y no admite generateContent
    if(/are blocked|API_KEY_SERVICE_BLOCKED|SERVICE_DISABLED/i.test(msg)){
      msg = 'La key de Gemini no tiene permitido generar texto. Revisa las restricciones de la key o usa una nueva de AI Studio en GEMINI_TEXT_KEY.';
    }
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  const cand  = d?.candidates?.[0];
  // se descartan las partes de razonamiento (thought) y se une el texto real
  const parts = cand?.content?.parts || [];
  const text  = parts.filter(p => p && p.text && !p.thought).map(p => p.text).join('').trim();
  if(!text){
    const why = cand?.finishReason || d?.promptFeedback?.blockReason || 'respuesta vacía';
    throw new Error(`Gemini no devolvió texto (${why})`);
  }
  return text;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST')    return res.status(405).json({ error:'Method not allowed' });
  if(!GEMINI_KEY)              return res.status(500).json({ error:'Falta GEMINI_API_KEY en el servidor' });

  try{
    const { prompt, type } = req.body || {};
    if(!prompt || typeof prompt !== 'string') return res.status(400).json({ error:'Falta el prompt' });
    if(prompt.length > 4000)                  return res.status(400).json({ error:'Prompt demasiado largo' });

    const system = SYSTEM[type === 'video' ? 'video' : 'image'];

    let lastErr;
    for(const model of MODELS){
      try{
        const text = await askGemini(model, system, prompt);
        return res.status(200).json({ prompt: text, model });
      }catch(e){
        lastErr = e;
        // 404 = ese ID de modelo ya no existe → probar el siguiente
        if(e.status !== 404) break;
      }
    }
    // 429 = cuota gratuita agotada por hoy; el cliente sigue con el prompt original
    const status = lastErr?.status === 429 ? 429 : 500;
    return res.status(status).json({ error: lastErr?.message || 'No se pudo mejorar el prompt' });

  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
