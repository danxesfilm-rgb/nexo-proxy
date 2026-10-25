/* ============================================================
   NEXO Proxy · Viral Lab (redes sociales) — tareas extra de /api/agent
   Comparte la key, los modelos y la protección de /api/agent.
     task = 'carrusel'  { tema, red, n, lang, tono, objetivo, marca }
                        → { titulo, slides:[{tipo,titulo,texto,enfasis,visual}], caption, hashtags, hora, score, mejoras }
     task = 'motion'    { tema, red, lang, estilo, segundos }
                        → { lineas:[{t,enfasis}], cierre, caption, hashtags, score }
     task = 'puntuar'   { red, tipo, texto, lang }
                        → { score, veredicto, problemas, ganchos, reescritura, mejoras }
     task = 'auditoria' { red, handle, nicho, publico, objetivo, stats, posts:[...], lang }
                        → { diagnostico, fortalezas, debilidades, pilares, formatos, horarios, plan, metas }
     task = 'semana'    { red, nicho, publico, porSemana, dias, lang }
                        → { plan:[{dia,hora,formato,idea,gancho,pilar}] }
   Los helpers (manual de viralidad, reglas de puntuación…) llegan de agent.js
   para no duplicarlos ni crear una importación circular.
   ============================================================ */

/* Qué premia cada algoritmo hoy (se inyecta en todas las tareas) */
const RED = {
  instagram: { n:'Instagram', carr:'carrusel 4:5 (1080×1350), hasta 20 diapositivas',
    algo:'Instagram premia sobre todo los ENVÍOS por mensaje privado y los GUARDADOS, luego el tiempo de visualización. Los carruseles se vuelven a mostrar con la 2ª diapositiva a quien no deslizó: la 2ª debe re-enganchar sola. Caption con primera línea gancho, palabras clave (el SEO de Instagram pesa más que los hashtags) y máx. 5 hashtags.' },
  tiktok:    { n:'TikTok', carr:'modo foto 9:16 (1080×1920), hasta 35 fotos, con música en tendencia',
    algo:'TikTok premia la retención y las re-visualizaciones; en modo foto cuenta cuántas diapositivas se deslizan. Texto grande y corto en cada foto, gancho que obligue a deslizar, búsqueda interna por palabras clave en el texto y la descripción, 3-5 hashtags de nicho.' },
  facebook:  { n:'Facebook', carr:'carrusel/álbum 4:5, hasta 10 imágenes',
    algo:'Facebook premia los comentarios largos, compartir en grupos y el contenido emocional o útil; público algo mayor. Texto claro, pregunta final para comentar, 2-3 hashtags.' },
  linkedin:  { n:'LinkedIn', carr:'documento PDF 4:5 (1080×1350), 8-12 páginas',
    algo:'LinkedIn premia el tiempo de permanencia (dwell time) y los comentarios de valor en la primera hora; los carruseles PDF tienen el mayor alcance. Tono profesional pero humano, aprendizaje concreto, datos, máx. 3 hashtags.' },
  youtube:   { n:'YouTube', carr:'publicación de comunidad con imágenes / Shorts 9:16',
    algo:'YouTube premia el CTR y la retención; en Shorts, el bucle y que no se deslice en los primeros 2 segundos.' },
};
const redOf = r => RED[r] ? r : 'instagram';

const OBJETIVOS = {
  alcance:   'ALCANCE: maximizar envíos y compartidos (identidad, sorpresa, polémica sana)',
  guardados: 'GUARDADOS: contenido tan útil que se guarda para después (pasos, plantillas, listas, cifras)',
  seguidores:'SEGUIDORES: mostrar autoridad y prometer más de lo mismo (serie, "sígueme para la parte 2")',
  ventas:    'VENTAS: problema → agitación → solución → prueba → oferta, sin sonar a anuncio',
};

const CARRUSEL_RULES = `
REGLAS DEL CARRUSEL VIRAL:
- Diapositiva 1 (PORTADA): gancho de máx. 8-9 palabras que obligue a deslizar (promesa concreta, número, contradicción, "nadie te dice esto"). Nada de títulos genéricos.
- Diapositiva 2: RE-GANCHO autónomo (el algoritmo la enseña como portada a quien no deslizó). Debe funcionar sola.
- Desarrollo: UNA idea por diapositiva, máx. ~25 palabras de texto, frases cortas, cifras concretas. Cada diapositiva termina dejando ganas de la siguiente.
- Penúltima: el "pago" más fuerte (el mejor dato, el giro, el resumen guardable).
- Última (CTA): una sola acción concreta orientada al objetivo (guárdalo, envíaselo a…, comenta la palabra X, sígueme para la parte 2).
- "enfasis": 1-3 palabras exactas del título que se resaltan en color (deben aparecer tal cual en el título).
- "visual": prompt corto EN INGLÉS para generar una imagen/fondo que acompañe la diapositiva (sin texto dentro de la imagen), o "" si es mejor solo tipografía.`;

export function makeSocialTasks(h){
  const { PLAYBOOK, SCORE_RULES, SCORE_JSON, LANG, tonoLine, fechaHoy, str, int, badReq } = h;
  const langOf = l => LANG[l] ? l : 'es-LA';
  const sys = (rol, lang, extra) => `${rol} Hoy es ${fechaHoy()} (no cites años ni datos viejos).
${PLAYBOOK}
${extra || ''}
${SCORE_RULES}
Escribes en ${LANG[lang]}. Respondes SOLO con JSON válido, sin markdown.`;

  function carrusel(b){
    const tema = str(b.tema, 800).trim();
    if(!tema) throw badReq('Falta el tema del carrusel');
    const red = redOf(b.red), R = RED[red], lang = langOf(b.lang);
    const n = int(b.n, 4, 15, 7);
    const obj = OBJETIVOS[b.objetivo] || OBJETIVOS.alcance;
    const prompt = `Tema del carrusel: "${tema}"
Red: ${R.n} — ${R.carr}.
Cómo funciona el algoritmo: ${R.algo}
Objetivo principal: ${obj}.
${tonoLine(b.tono)}
${b.marca ? `Marca/cuenta: ${str(b.marca, 80)} (no la repitas en cada diapositiva; el diseño ya la muestra).\n` : ''}Número EXACTO de diapositivas: ${n} (1 portada + desarrollo + 1 CTA).
Responde SOLO este JSON:
{"titulo":"nombre interno corto","slides":[{"tipo":"portada|contenido|cta","titulo":"...","texto":"... (en portada puede ser un subtítulo corto o vacío)","enfasis":["..."],"visual":"..."}],
"caption":"caption completo para ${R.n}, con saltos de línea, primera línea gancho y pregunta o CTA final","hashtags":["sin #"],
"hora":"mejor día y franja para publicarlo en ${R.n} para público hispano, con el porqué en una frase",
"score":${SCORE_JSON},"mejoras":["2-3 cambios concretos que subirían la puntuación"]}`;
    return { system: sys('Eres el mejor estratega de carruseles virales para redes sociales.', lang, CARRUSEL_RULES), prompt, json: true, maxTokens: 8192, temperature: 0.85 };
  }

  function motion(b){
    const tema = str(b.tema, 800).trim();
    if(!tema) throw badReq('Escribe el tema o el mensaje');
    const red = redOf(b.red), lang = langOf(b.lang);
    const seg = int(b.segundos, 4, 60, 12);
    const nl = Math.max(2, Math.min(12, Math.round(seg / 2.2)));
    const prompt = `Mensaje/tema: "${tema}"
Pieza de MOTION GRAPHICS de tipografía cinética para ${RED[red].n}, ${seg} segundos, estilo de animación "${str(b.estilo, 40) || 'pop'}".
Escribe el texto en pantalla: ${nl} líneas MUY cortas (2-7 palabras cada una), que se leen solas sin voz, con un gancho brutal en la 1ª línea y un remate o giro en la última.
Para cada línea marca en "enfasis" la palabra (exacta, tal cual aparece) que debe animarse resaltada.
Responde SOLO este JSON:
{"lineas":[{"t":"...","enfasis":"..."}],"cierre":"texto final corto para la pantalla de cierre (CTA o firma)","caption":"caption para publicarlo","hashtags":["sin #"],"score":${SCORE_JSON}}`;
    return { system: sys('Eres director creativo de motion graphics y contenido viral de texto en pantalla.', lang), prompt, json: true, maxTokens: 4096, temperature: 0.9 };
  }

  function puntuar(b){
    const texto = str(b.texto, 6000).trim();
    if(!texto) throw badReq('Pega el texto a analizar');
    const red = redOf(b.red), lang = langOf(b.lang);
    const TIPOS = { gancho:'el gancho/primera frase', caption:'el caption de una publicación', idea:'una idea de contenido', guion:'el guion de un video corto', carrusel:'el texto de un carrusel (diapositivas separadas por líneas)' };
    const tipo = TIPOS[b.tipo] || TIPOS.idea;
    const prompt = `Analiza ${tipo} para ${RED[red].n} como lo haría el algoritmo y una audiencia real.
Cómo funciona el algoritmo: ${RED[red].algo}
TEXTO:
"""${texto}"""
Responde SOLO este JSON:
{"score":${SCORE_JSON},"veredicto":"1-2 frases honestas: ¿se viraliza o no y por qué?","problemas":["lo que frena el alcance, concreto"],
"ganchos":[{"tipo":"...","texto":"3 aperturas alternativas más fuertes"}],"reescritura":"versión mejorada completa, mismo formato que el original","mejoras":["cambios accionables"]}`;
    return { system: sys('Eres un auditor implacable de contenido viral: dices la verdad aunque duela.', lang), prompt, json: true, maxTokens: 6144, temperature: 0.6 };
  }

  function auditoria(b){
    const red = redOf(b.red), lang = langOf(b.lang);
    const nicho = str(b.nicho, 300).trim();
    if(!nicho) throw badReq('Indica el nicho de la cuenta');
    const posts = Array.isArray(b.posts) ? b.posts.slice(0, 60) : [];
    const num = v => int(v, 0, 1e10, 0);
    const lista = posts.map(p => `- ${str(p.fecha, 20)} ${str(p.formato, 20)} "${str(p.tema, 120)}" · vistas ${num(p.vistas)} · likes ${num(p.likes)} · coment ${num(p.comentarios)} · compart ${num(p.compartidos)} · guard ${num(p.guardados)}`).join('\n');
    const prompt = `Cuenta de ${RED[red].n}${b.handle ? ` (${str(b.handle, 60)})` : ''}. Nicho: "${nicho}". Público: "${str(b.publico, 300) || 'no indicado'}". Objetivo: ${OBJETIVOS[b.objetivo] || OBJETIVOS.alcance}.
Cómo funciona el algoritmo: ${RED[red].algo}
${b.stats ? `Métricas calculadas: ${str(JSON.stringify(b.stats), 1500)}\n` : ''}${lista ? `Publicaciones recientes:\n${lista}` : 'Aún no hay publicaciones cargadas: basa el análisis en el nicho y en lo que funciona hoy en esa red.'}
Haz una auditoría de crecimiento como un consultor top. Basa cada conclusión en los datos si los hay (cita qué publicación lo demuestra).
Responde SOLO este JSON:
{"diagnostico":"3-4 frases","fortalezas":["..."],"debilidades":["..."],
"pilares":[{"nombre":"pilar de contenido","porque":"...","ejemplo":"idea concreta"}],
"formatos":[{"formato":"carrusel|reel|motion|foto|historia|live","peso":"% recomendado del calendario","porque":"..."}],
"horarios":[{"dia":"...","hora":"HH:MM","porque":"..."}],
"plan":[{"dia":"Lunes...","hora":"HH:MM","formato":"carrusel|reel|motion|foto","idea":"...","gancho":"primera frase exacta","pilar":"..."}],
"metas":"metas realistas a 30 días (no prometas cifras imposibles)"}
El plan cubre 7 días.`;
    return { system: sys('Eres consultor senior de crecimiento orgánico en redes sociales para marcas hispanas.', lang), prompt, json: true, maxTokens: 8192, temperature: 0.6 };
  }

  function semana(b){
    const red = redOf(b.red), lang = langOf(b.lang);
    const nicho = str(b.nicho, 300).trim();
    if(!nicho) throw badReq('Indica el nicho o tema de la cuenta');
    const porSemana = int(b.porSemana, 1, 21, 5);
    const dias = Array.isArray(b.dias) && b.dias.length ? b.dias.map(d => str(d, 12)).join(', ') : 'los mejores días';
    const prompt = `Planifica ${porSemana} publicaciones para la próxima semana en ${RED[red].n}. Nicho: "${nicho}". Público: "${str(b.publico, 300) || 'hispano general'}".
Días disponibles: ${dias}. Mezcla formatos (carrusel, reel, motion de texto) según lo que mejor rinde hoy en esa red.
Cómo funciona el algoritmo: ${RED[red].algo}
Cada idea debe ser distinta, concreta y con gancho potente; aprovecha tendencias de estas fechas.
Responde SOLO este JSON:
{"plan":[{"dia":"Lunes|Martes|...","hora":"HH:MM","formato":"carrusel|reel|motion|foto","idea":"...","gancho":"primera frase exacta","pilar":"..."}]}`;
    return { system: sys('Eres planificador editorial de redes sociales orientado a crecimiento.', lang), prompt, json: true, maxTokens: 6144, temperature: 0.85 };
  }

  return { carrusel, motion, puntuar, auditoria, semana };
}
