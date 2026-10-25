/* ============================================================
   NEXO Proxy · Acuerdos con clientes — tarea extra de /api/agent
   Comparte la key, los modelos y la protección de /api/agent.
     task = 'acuerdo' { texto, archivos:[{mime,data(base64)}], hoy, cliente,
                        clientes:[nombres], abiertos:[{id,cliente,titulo,saldo,pendientes}], equipo:[nombres] }
            → { detectado, resumen, cliente, contacto, titulo, tipo, estado, moneda, total, fecha, vigencia,
                incluye[], notas, cobros[], tareas[], pago{}, acuerdoId, cobroId, dudas[] }
   Lee capturas de Yape/Plin/transferencias, proformas en PDF o imagen y chats
   con el cliente, y devuelve un borrador que el usuario revisa antes de guardar.
   ============================================================ */

const MIME_OK = /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i;
const MAX_ARCH = 6, MAX_B64 = 13 * 1024 * 1024;   // ~9 MB por archivo

export function makeAcuerdoTasks({ str, badReq }){
  function buildAcuerdo(b){
    const texto = str(b.texto, 12000).trim();
    const archivos = (Array.isArray(b.archivos) ? b.archivos : []).slice(0, MAX_ARCH)
      .filter(a => a && MIME_OK.test(String(a.mime || '')) && typeof a.data === 'string' && a.data.length < MAX_B64);
    if(!texto && !archivos.length) throw badReq('Sube una captura o pega el texto');

    const hoy = /^\d{4}-\d{2}-\d{2}$/.test(b.hoy) ? b.hoy : new Date().toISOString().slice(0, 10);
    const lista = (v, n, m) => (Array.isArray(v) ? v : []).slice(0, n).map(x => str(x, m)).filter(Boolean);
    const clientes = lista(b.clientes, 80, 60);
    const equipo   = lista(b.equipo, 30, 40);
    const abiertos = (Array.isArray(b.abiertos) ? b.abiertos : []).slice(0, 60).map(a => ({
      id: str(a.id, 40), cliente: str(a.cliente, 60), titulo: str(a.titulo, 120), moneda: str(a.moneda, 3), saldo: Number(a.saldo) || 0,
      pendientes: (Array.isArray(a.pendientes) ? a.pendientes : []).slice(0, 12).map(c => ({ id: str(c.id, 40), concepto: str(c.concepto, 80), monto: Number(c.monto) || 0, vence: str(c.vence, 10) })),
    }));

    const system = `Eres el asistente administrativo de NEXO Agency, una agencia creativa en Perú (redes sociales, video, diseño, fotografía).
Tu trabajo: leer capturas, PDFs y textos sobre acuerdos con clientes y ordenarlos para que el equipo cumpla todo a tiempo y cobre lo que corresponde.

Puede llegarte:
- Un COMPROBANTE DE PAGO (Yape, Plin, transferencia BCP/Interbank/BBVA/Scotiabank, depósito): lee monto, fecha, hora, número de operación, quién pagó y a quién.
- Una PROFORMA o COTIZACIÓN (a menudo hecha por NEXO): lee cliente, servicios, precios, total, IGV, validez, forma de pago y plazos.
- Un CHAT u OFERTA (WhatsApp, correo, nota): lo que se le ofreció al cliente, lo que aceptó, adelantos, fechas de entrega, reuniones y pendientes de cada lado.

Reglas:
- Hoy es ${hoy}. Convierte toda fecha a YYYY-MM-DD. Fechas sin año: el año que deje la fecha más cercana a hoy (sin irte más de 2 meses al pasado). "El viernes", "en 15 días", "fin de mes" → calcúlalas desde hoy o desde la fecha del mensaje si se ve.
- Moneda: "PEN" (S/, soles) por defecto; "USD" solo si dice $, US$ o dólares.
- Montos como número sin símbolos (1500.5). Si hay IGV, el total es el monto final a pagar.
- No inventes. Si algo no se ve, déjalo vacío y explícalo en "dudas" (máximo 4, cortas).
- "cobros" es el PLAN DE PAGOS completo: cada cuota con su monto y fecha de vencimiento; marca pagado=true solo las que tienen prueba de pago o el chat dice claramente que ya se pagaron. Si dice "50% de adelanto y 50% al entregar", son 2 cuotas (la segunda vence en la fecha de entrega). La suma de cobros debe ser el total.
- "tareas" son compromisos con fecha: entregas, reuniones, revisiones, envíos de material del cliente. Usa verbos claros ("Entregar 8 posts de noviembre", "Cliente envía logo en vectores"). Responsable solo si se entiende (nombres del equipo: ${equipo.join(', ') || 'desconocidos'}).
- "incluye": lo que se ofreció, un punto por elemento, breve y concreto (cantidades, duraciones).
- Cliente: si coincide con uno de la lista, escribe EXACTAMENTE ese nombre. Lista: ${clientes.join(', ') || '(vacía)'}.${b.cliente ? ` El usuario indicó que el cliente es "${str(b.cliente, 60)}".` : ''}
- Si es un comprobante de pago y encaja con uno de los acuerdos abiertos (mismo cliente o monto igual a una cuota pendiente), pon su "acuerdoId" y el "cobroId" de la cuota. Acuerdos abiertos: ${abiertos.length ? JSON.stringify(abiertos) : '(ninguno)'}.
- "resumen": una frase de qué es y lo más importante (ej. "Yape de S/ 750 de Ondo, adelanto del pack de noviembre").`;

    const prompt = `${texto ? `Texto del usuario:\n"""\n${texto}\n"""\n\n` : ''}${archivos.length ? `Se adjuntan ${archivos.length} archivo(s) arriba.\n\n` : ''}Responde SOLO este JSON:
{"detectado":"pago|proforma|oferta|acuerdo|otro",
"resumen":"...",
"cliente":"nombre del cliente o vacío","contacto":"persona o teléfono si aparece",
"titulo":"nombre corto del trabajo (ej. Pack redes noviembre)",
"tipo":"proforma|oferta|contrato|servicio",
"estado":"propuesta|aprobado|en_curso|entregado",
"moneda":"PEN|USD","total":0,"fecha":"YYYY-MM-DD del acuerdo o propuesta","vigencia":"YYYY-MM-DD hasta cuándo vale la proforma u oferta, o vacío",
"incluye":["..."],
"notas":"condiciones importantes: revisiones, lo que no incluye, forma de pago, cuentas",
"cobros":[{"concepto":"Adelanto 50%","monto":0,"vence":"YYYY-MM-DD","pagado":false,"pagadoEl":"YYYY-MM-DD o vacío","metodo":"yape|plin|transferencia|deposito|efectivo|tarjeta|otro|","operacion":"n.º de operación o vacío"}],
"tareas":[{"texto":"...","fecha":"YYYY-MM-DD o vacío","tipo":"entrega|reunion|revision|tarea","resp":"nombre del equipo o vacío"}],
"pago":{"monto":0,"moneda":"PEN","fecha":"YYYY-MM-DD","metodo":"yape|plin|transferencia|deposito|efectivo|tarjeta|otro","operacion":"","pagador":""},
"acuerdoId":"","cobroId":"",
"dudas":["..."]}
"pago" solo si detectado es "pago"; si no, déjalo en null.`;

    const media = archivos.map(a => ({ inline_data: { mime_type: a.mime.toLowerCase().replace(/^image\/jpg$/, 'image/jpeg'), data: a.data } }));
    // holgado: los modelos 3.x razonan antes de responder
    return { system, prompt, media, json: true, maxTokens: 12288, temperature: 0.1 };
  }

  return { acuerdo: buildAcuerdo };
}
