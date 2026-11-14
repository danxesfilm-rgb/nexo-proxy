/* ============================================================
   NEXO Proxy · Editor de video (/editor) — tareas extra de /api/agent
   Comparten la key, los modelos y la protección de /api/agent.
     ed_montaje    { brief, dur, formato, lang, clips:[{ i, nombre, tipo, dur, frame(base64 jpg) }] }
                   → { titulo, musica, clips:[{ i, desde, dur }], textos:[{ desde, hasta, texto }], estilo }
     ed_tendencias { nicho, red, formato, lang }      (con búsqueda de Google; plan B: titulares)
                   → { tendencias:[{ titulo, por_que, gancho, estructura:[{ desde, hasta, que, texto }], estilo, musica }] }
     ed_referencia { frames:[base64 jpg], dur, plano_seg, vertical, medido:{…}, lang }
                   → { resumen, claves:[…], estilo }
     ed_subtitulos { audio:{ mime, data(base64) }, dur, lang }
                   → { segmentos:[{ inicio, fin, texto }] }
   "estilo" es siempre el mismo objeto: el editor lo valida y lo aplica tal cual.
   ============================================================ */

const FONTS = ['Inter', 'Montserrat', 'Poppins', 'Anton', 'Bebas Neue', 'Archivo Black', 'Oswald', 'Playfair Display', 'DM Serif Display', 'Space Mono', 'Permanent Marker', 'Caveat'];
const TRANS = ['none', 'fade', 'slideL', 'slideR', 'slideU', 'slideD', 'zoom', 'wipe', 'circle', 'flash', 'black', 'whip', 'glitch', 'spin', 'blur'];
const REDES = { reels: 'Instagram Reels', tiktok: 'TikTok', shorts: 'YouTube Shorts', fbreels: 'Facebook Reels' };
const IDIOMA = { es: 'español latinoamericano neutro', en: 'inglés', pt: 'portugués de Brasil' };
const MAX_B64 = 13 * 1024 * 1024;

const ESTILO = `"estilo" describe cómo se ve y se monta el video. Usa EXACTAMENTE estas claves:
{"look":{"exp":0,"con":0,"sat":0,"vib":0,"temp":0,"tint":0,"hi":0,"sh":0,"fade":0,"film":0,"shHue":210,"shAmt":0,"hiHue":35,"hiAmt":0,"vig":0,"grain":0},
 "texto":{"font":"Montserrat","weight":800,"size":80,"color":"#ffffff","stroke":"#000000","strokeW":0,"bg":"","upper":false,"karaoke":false,"hl":"#ffe600","pos":"abajo","anim":"pop"},
 "transicion":{"type":"fade","dur":0.3},"plano_seg":2,"movimiento":"none"}
Significado y rangos:
- look: corrección de color. exp (exposición), con (contraste), sat (saturación), vib, temp (+ cálido / − frío), tint, hi (luces), sh (sombras): de -0.6 a 0.6, 0 = sin cambio. fade (negros lavados), film (curva de cine), vig (viñeta), grain (grano): de 0 a 0.8. shHue/hiHue: tono de 0 a 360 con que se tiñen sombras y luces (teal ≈ 195, azul ≈ 215, naranja ≈ 32, magenta ≈ 320, verde ≈ 150); shAmt/hiAmt: de 0 a 0.8. Sé sutil: un look de cine rara vez pasa de 0.3 en exp/con/sat.
- texto.font: una de ${FONTS.join(', ')}. weight: 400, 500, 700, 800 o 900. size: 40 a 160 (para un cuadro de 1080 px de ancho). color, stroke, hl: hex #rrggbb. strokeW: 0 a 14. bg: "" o un hex si el texto va dentro de una caja. pos: "arriba", "centro" o "abajo". anim: none, fade, pop, zoom, slideUp, blur, typewriter o words. karaoke: true si se resalta la palabra que se va diciendo (hl = color del resaltado).
- transicion.type: una de ${TRANS.join(', ')} ("none" = corte seco). dur: 0.15 a 1.
- plano_seg: duración media de cada plano en segundos.
- movimiento: none, zoomIn, zoomOut, panL, panR, shake, pulse o float.`;

export function makeEditorTasks({ str, badReq }){
  const idioma = b => IDIOMA[b.lang] || IDIOMA.es;
  const jpg = (data, what) => {
    if(typeof data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 200)) || data.length > 900000) throw badReq(what + ' no es válida');
    return { inline_data: { mime_type: 'image/jpeg', data } };
  };

  function buildMontaje(b){
    const clips = Array.isArray(b.clips) ? b.clips.slice(0, 14) : [];
    if(!clips.length) throw badReq('Faltan los clips');
    const dur = Math.min(120, Math.max(6, Number(b.dur) || 30)), media = [], lista = [];
    clips.forEach((c, n) => {
      const d = Math.max(0, Number(c.dur) || 0), tipo = c.tipo === 'image' ? 'foto' : 'video';
      lista.push(`Clip ${n}: "${str(c.nombre, 60)}" · ${tipo}${tipo === 'video' ? ` de ${d.toFixed(1)} s` : ''}${c.frame ? ' · su fotograma es la imagen nº ' + (media.length + 1) : ''}`);
      if(c.frame) media.push(jpg(c.frame, 'El fotograma del clip'));
    });
    const system = `Eres un editor de video profesional de contenido corto para redes (Reels, TikTok, Shorts). Con el material disponible armas un montaje que retiene: gancho en los primeros 2 segundos, ritmo, y cierre con llamada a la acción.
Reglas:
- Usa SOLO los clips de la lista, por su número. Puedes repetir un clip con otro tramo, y dejar fuera los que no aporten.
- "desde" + "dur" nunca puede pasar de la duración del clip. En fotos, "desde" = 0 y "dur" entre 1.2 y 4.
- La suma de "dur" debe quedar cerca de ${dur} s (si el material no alcanza, haz un video más corto; no lo estires).
- Los primeros planos van más cortos (1 a 2 s) para enganchar.
- "textos": frases cortas en pantalla (máximo 7 palabras cada una), en ${idioma(b)}, con tiempos en segundos del video final, sin solaparse. La primera es el gancho. No inventes datos, precios ni promesas que el brief no diga.
- "musica": una línea con el tipo de música o audio que le va.
${ESTILO}`;
    const prompt = `Idea del video: ${str(b.brief, 600) || '(no la dieron: decide tú el mejor ángulo según el material)'}
Formato: ${str(b.formato, 8) || '9:16'} · duración objetivo: ${dur} s
Material:
${lista.join('\n')}

Responde SOLO este JSON:
{"titulo":"nombre corto del video","musica":"...","clips":[{"i":0,"desde":0,"dur":1.5}],"textos":[{"desde":0,"hasta":1.5,"texto":"..."}],"estilo":{...}}`;
    return { system, prompt, media, json: true, maxTokens: 6144, temperature: 0.7 };
  }

  /* news = undefined → con búsqueda de Google · array → sin búsqueda, con esos titulares de contexto */
  function buildTendencias(b, news){
    const nicho = str(b.nicho, 160).trim();
    if(nicho.length < 3) throw badReq('Escribe el nicho o tema');
    const red = REDES[b.red] || REDES.reels, buscar = news === undefined;
    const system = `Eres estratega de contenido corto para ${red} en el mercado hispano (Perú y Latinoamérica). Detectas qué FORMATOS de video están funcionando ahora en un nicho y los conviertes en una plantilla que un editor puede montar hoy.
Reglas:
- Devuelve 3 tendencias distintas entre sí (por ejemplo: una de gancho hablado, una visual sin voz, una de lista o antes/después).
- "por_que": una frase concreta sobre por qué retiene o se comparte. Nada de generalidades.
- "gancho": el texto exacto en pantalla del primer segundo, máximo 8 palabras, en ${idioma(b)}.
- "estructura": de 3 a 6 bloques que cubran de 0 hasta el final (15 a 45 s en total), sin huecos. "que" = qué se muestra o se dice; "texto" = el texto en pantalla de ese bloque (máximo 7 palabras, "" si ninguno).
- "musica": tipo de audio que le va (no inventes nombres de canciones ni de cuentas).
- No inventes cifras de vistas ni atribuyas videos a cuentas concretas.${buscar ? '\n- Apóyate en lo que encuentres en la búsqueda sobre tendencias recientes del nicho y de la plataforma.' : ''}
${ESTILO}`;
    const contexto = Array.isArray(news) && news.length ? `\nTitulares recientes sobre el tema (contexto):\n${news.slice(0, 10).map(n => '- ' + str(n.title, 160)).join('\n')}\n` : '';
    const prompt = `Nicho: ${nicho}
Plataforma: ${red} · formato ${str(b.formato, 8) || '9:16'}${contexto}
Responde SOLO este JSON:
{"tendencias":[{"titulo":"nombre del formato","por_que":"...","gancho":"...","estructura":[{"desde":0,"hasta":2,"que":"...","texto":"..."}],"estilo":{...},"musica":"..."}]}`;
    return { system, prompt, json: !buscar, search: buscar, maxTokens: 8192, temperature: 0.8 };
  }

  function buildReferencia(b){
    const frames = Array.isArray(b.frames) ? b.frames.slice(0, 10) : [];
    if(!frames.length) throw badReq('Faltan los fotogramas de la referencia');
    const media = frames.map(f => jpg(f, 'Un fotograma'));
    const m = b.medido && typeof b.medido === 'object' ? b.medido : {};
    const medido = ['exp', 'con', 'sat', 'temp', 'tint', 'fade', 'shHue', 'shAmt', 'hiHue', 'hiAmt'].map(k => `${k}=${Number(m[k]) || 0}`).join(', ');
    const system = `Eres colorista y editor de video. Te dan fotogramas de un video de referencia (en orden) y debes describir su ESTILO para reproducirlo en otro video con otro contenido: color, tipografía del texto en pantalla, ritmo y transiciones. No describas qué pasa en el video ni a las personas: solo el estilo.
Reglas:
- "look": parte de los valores medidos por el editor y corrígelos con lo que ves (tono de sombras y luces, contraste, grano, viñeta). Sé sutil.
- "texto": si en los fotogramas hay texto sobreimpreso, imita su tipografía (la más parecida de la lista), grosor, color, contorno, caja, mayúsculas y posición. Si no hay texto, propone uno que combine con el look.
- "plano_seg": usa el ritmo medido si es mayor que 0; si es 0 (imagen fija o no medible), estima uno acorde al estilo.
- "resumen": 1 o 2 frases en ${idioma(b)}. "claves": de 3 a 5 rasgos concretos del estilo, cortos.
${ESTILO}`;
    const prompt = `Referencia: ${frames.length} fotograma(s) · ${b.vertical ? 'vertical' : 'horizontal'} · duración ${Number(b.dur) || 0} s · ritmo medido: ${Number(b.plano_seg) || 0} s por plano.
Valores de color medidos por el editor: ${medido}

Responde SOLO este JSON:
{"resumen":"...","claves":["..."],"estilo":{...}}`;
    return { system, prompt, media, json: true, maxTokens: 4096, temperature: 0.4 };
  }

  function buildSubtitulos(b){
    const a = b.audio || {};
    if(!/^audio\/(wav|x-wav|mpeg|mp3|mp4|aac|ogg|webm)$/i.test(a.mime || '') || typeof a.data !== 'string' || !a.data) throw badReq('Falta el audio');
    if(a.data.length > MAX_B64) throw badReq('El audio es demasiado largo (máx. ~5 minutos)');
    const dur = Math.max(1, Number(b.dur) || 0);
    const system = `Transcribes la voz de un video para subtitularlo. El audio dura ${dur.toFixed(1)} s.
Reglas:
- Transcribe lo que se dice, en su idioma original (se espera ${idioma(b)}), con ortografía correcta. No traduzcas, no resumas, no añadas nada.
- Divide en segmentos cortos de 2 a 6 palabras, como subtítulos de Reels: uno por golpe de voz.
- "inicio" y "fin" en segundos con un decimal, medidos sobre el audio; los segmentos no se solapan y "fin" nunca pasa de ${dur.toFixed(1)}.
- Ignora la música y los ruidos. Si no hay voz, devuelve "segmentos": [].`;
    const prompt = `Se adjunta el audio. Responde SOLO este JSON:
{"segmentos":[{"inicio":0.0,"fin":1.2,"texto":"..."}]}`;
    return { system, prompt, media: [{ inline_data: { mime_type: a.mime.replace('x-wav', 'wav').replace('mp3', 'mpeg'), data: a.data } }], json: true, maxTokens: 8192, temperature: 0 };
  }

  return { ed_montaje: buildMontaje, ed_tendencias: buildTendencias, ed_referencia: buildReferencia, ed_subtitulos: buildSubtitulos };
}
