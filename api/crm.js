/* ============================================================
   NEXO Proxy · IA del CRM (/crm) — tareas extra de /api/agent
   Comparte la key, los modelos y la protección de /api/agent.
     task = 'pf_obs'   { cliente, rubro, paquetes:[{titulo,items[],total}], moneda, adelanto, igv, validez, entrega, obs[] }
            → { obs[], nota }
     task = 'plan'     { titulo, cliente, rubro, items[], hoy, inicio, entrega, notas }
            → { modalidad:'mensual'|'proyecto', razon, unidades:[{texto,grupo}], porSemana, porDia, revisionDias, dudas[] }
     task = 'crm_chat' { pregunta, historial:[{rol,texto}], contexto, hoy, usuario, rol }
            → { respuesta }
   ============================================================ */

export function makeCrmTasks({ str, badReq }){
  const lista = (v, n, m) => (Array.isArray(v) ? v : []).slice(0, n).map(x => str(x, m)).filter(Boolean);
  const fecha = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '';

  const AGENCIA = `NEXO Agency es una agencia creativa en Trujillo, Perú: redes sociales, flyers, reels, video, diseño gráfico, fotografía e impresión.`;

  /* Observaciones / condiciones de la proforma */
  function buildPfObs(b){
    const paquetes = (Array.isArray(b.paquetes) ? b.paquetes : []).slice(0, 8).map(p => ({
      titulo: str(p.titulo, 120), items: lista(p.items, 40, 160), total: Number(p.total) || 0,
    }));
    if(!paquetes.some(p => p.items.length || p.titulo)) throw badReq('Agrega primero los ítems de la proforma');
    const obsActuales = lista(b.obs, 15, 240);
    const system = `${AGENCIA}
Redactas las OBSERVACIONES (condiciones) que van al pie de las proformas de NEXO. Son líneas cortas, claras y profesionales, en español de Perú, sin emojis.
Ejemplos del estilo de NEXO:
- Paquete único para una campaña o evento específico; no es un servicio mensual.
- El cliente deberá proporcionar los textos, logotipos y recursos necesarios.
- Incluye hasta 02 rondas de ajustes por pieza. Cambios adicionales tendrán un costo extra.
- El material para impresión se entrega en formato digital; no incluye impresión física.
- Las fechas de entrega se coordinan según el cronograma de la campaña.
- Forma de pago: 50% al inicio y 50% contra entrega final.
Reglas:
- Adapta las condiciones a lo que realmente incluye la proforma (si hay reels: duración y música; si hay fotos: sesión, locación, edición; si hay impresión o no; si es mensual o por campaña; derechos de uso; plazos de respuesta del cliente; validez).
- Entre 5 y 8 líneas. Cada una de máximo 140 caracteres. Sin numerar, sin guiones al inicio.
- La línea de forma de pago debe respetar el % de adelanto indicado.
- No inventes precios ni promesas que no estén en la proforma.`;
    const prompt = `Proforma para: ${str(b.cliente, 80) || 'cliente'}${b.rubro ? ` (rubro: ${str(b.rubro, 80)})` : ''}
Moneda: ${b.moneda === 'USD' ? 'dólares' : 'soles'} · Adelanto: ${Number(b.adelanto) || 0}% · IGV: ${str(b.igv, 20) || 'no aplica'}${b.validez ? ` · Validez: ${Number(b.validez)} días` : ''}${fecha(b.entrega) ? ` · Entrega prevista: ${b.entrega}` : ''}
Paquetes:
${paquetes.map((p, i) => `${i + 1}. ${p.titulo || 'Paquete'}${p.total ? ` (total ${p.total})` : ''}\n${p.items.map(x => `   - ${x}`).join('\n')}`).join('\n')}
${obsActuales.length ? `Observaciones actuales (mejóralas o complétalas, no las repitas tal cual si no aplican):\n${obsActuales.map(o => `- ${o}`).join('\n')}` : ''}

Responde SOLO este JSON:
{"obs":["línea 1","línea 2"],"nota":"una frase para el equipo explicando qué agregaste o cambiaste"}`;
    return { system, prompt, json: true, maxTokens: 4096, temperature: 0.4 };
  }

  /* Plan de trabajo al aprobar: ¿mensual o por proyecto? y qué piezas producir */
  function buildPlan(b){
    const items = lista(b.items, 60, 200);
    if(!items.length) throw badReq('El proyecto no tiene ítems para planificar');
    const hoy = fecha(b.hoy) || new Date().toISOString().slice(0, 10);
    const system = `${AGENCIA}
Planificas la producción de un trabajo aprobado. Decides si es un servicio MENSUAL (contenido repartido durante el mes) o un trabajo POR PROYECTO (se produce seguido hasta terminarlo) y desglosas las piezas.
Cómo decidir la modalidad:
- "mensual": pack de redes de un mes, contenido recurrente, la proforma dice mensual/mes/noviembre, o piezas que se publican a lo largo del mes.
- "proyecto": campaña o evento con fecha, lanzamiento, piezas que deben estar listas antes de una fecha, la proforma dice "paquete único" o "campaña".
Ritmo de producción de NEXO (úsalo como referencia):
- Mensual: repartir las piezas parejas en 4 semanas (ej. 8 flyers → 2 por semana).
- Por proyecto: unas 2 piezas por día hábil y dejar 1 día al final para revisión y entrega (ej. 8 flyers → 4 días de producción + 1 de revisión). Si hay fecha de entrega, el ritmo debe alcanzar para terminar antes.
- Videos/reels cuentan como pieza más pesada: 1 por día.
Reglas para "unidades":
- Una unidad = una pieza a producir. Expande cantidades: "08 flyers" → 8 unidades ("Flyer 1 de 8", …). "Estáticos: faltan 7, 5, 3 días" → 3 unidades ("Estático cuenta regresiva: faltan 7 días", …).
- "grupo": tipo de pieza corto (Flyer, Reel, Estático, Video, Fotos, Impresión, Otro).
- No agregues piezas que no estén en los ítems. Ítems que no son piezas (ej. "material extra de impresión") van como una unidad del grupo "Otro".
- Máximo 60 unidades.`;
    const prompt = `Trabajo: ${str(b.titulo, 120) || 'Proyecto'} · Cliente: ${str(b.cliente, 80) || '—'}${b.rubro ? ` (${str(b.rubro, 80)})` : ''}
Hoy: ${hoy}${fecha(b.inicio) ? ` · Inicio: ${b.inicio}` : ''}${fecha(b.entrega) ? ` · Entrega pedida: ${b.entrega}` : ' · Sin fecha de entrega'}
${b.notas ? `Notas / condiciones: ${str(b.notas, 1500)}\n` : ''}Ítems aprobados:
${items.map(x => `- ${x}`).join('\n')}

Responde SOLO este JSON:
{"modalidad":"mensual|proyecto","razon":"una frase de por qué","unidades":[{"texto":"Flyer 1 de 8","grupo":"Flyer"}],"porSemana":2,"porDia":2,"revisionDias":1,"dudas":["máximo 2, cortas"]}`;
    return { system, prompt, json: true, maxTokens: 6144, temperature: 0.2 };
  }

  /* Asistente del CRM: responde sobre clientes, proyectos, agenda y (si es superadmin) dinero */
  function buildChat(b){
    const pregunta = str(b.pregunta, 2000).trim();
    if(!pregunta) throw badReq('Escribe tu pregunta');
    const hist = (Array.isArray(b.historial) ? b.historial : []).slice(-8)
      .map(m => `${m && m.rol === 'ia' ? 'Asistente' : 'Usuario'}: ${str(m && m.texto, 1500)}`).join('\n');
    const ctx = typeof b.contexto === 'string' ? str(b.contexto, 60000) : str(JSON.stringify(b.contexto || {}), 60000);
    const superadmin = b.rol === 'superadmin';
    const system = `${AGENCIA}
Eres el asistente del CRM interno de NEXO. Hablas con ${str(b.usuario, 40) || 'alguien del equipo'} (rol: ${superadmin ? 'superadmin' : 'admin'}). Hoy es ${fecha(b.hoy) || new Date().toISOString().slice(0, 10)}.
Tienes abajo un resumen en JSON de los datos actuales del CRM (clientes, proyectos con estado, avance, fechas, tareas pendientes, agenda del calendario${superadmin ? ', pagos y saldos' : ''}).
Reglas:
- Responde en español de Perú, directo y breve (máximo ~12 líneas). Usa listas con "- " cuando ayuden y **negritas** para lo importante.
- Usa SOLO los datos del contexto; si algo no está, dilo. No inventes montos, fechas ni nombres.
- Si te piden redactar un mensaje (cobro, seguimiento, recordatorio a un cliente), escríbelo listo para WhatsApp, cordial y profesional.
- Si te piden prioridades o qué hacer hoy, ordena por urgencia: atrasados, entregas de hoy y mañana, luego lo demás${superadmin ? ', y al final cobros pendientes' : ''}.
${superadmin ? '' : '- Este usuario NO es superadmin: nunca menciones montos, precios ni saldos.'}

CONTEXTO DEL CRM:
${ctx}`;
    const prompt = `${hist ? `Conversación previa:\n${hist}\n\n` : ''}Usuario: ${pregunta}

Responde SOLO este JSON: {"respuesta":"tu respuesta con saltos de línea \\n"}`;
    return { system, prompt, json: true, maxTokens: 6144, temperature: 0.4 };
  }

  return { pf_obs: buildPfObs, plan: buildPlan, crm_chat: buildChat };
}
