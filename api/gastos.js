/* ============================================================
   NEXO Proxy · Reporte de gastos de eventos — tarea extra de /api/agent
   Comparte la key, los modelos y la protección de /api/agent.
     task = 'gasto' { archivo:{ mime, data(base64) }, hoy:'YYYY-MM-DD' }
            → { fecha, comercio, concepto, categoria, tipo, numero, monto, moneda }
   Lee un comprobante (boleta, factura, ticket, Yape, Plin, transferencia,
   recibo; imagen o PDF) para la página /reporte de nexoagency.pe.
   ============================================================ */

const MIME_OK = /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i;
const MAX_B64 = 13 * 1024 * 1024;   // ~9 MB

export const CATEGORIAS = ['Alimentos', 'Transporte', 'Hospedaje', 'Equipos', 'Decoración', 'Personal', 'Publicidad', 'Servicios', 'Otros'];
export const TIPOS = ['Boleta', 'Factura', 'Ticket', 'Yape', 'Plin', 'Transferencia', 'Recibo', 'Otro'];

export function makeGastoTasks({ badReq }){
  function buildGasto(b){
    const a = b.archivo || {};
    const mime = String(a.mime || '').toLowerCase().replace(/^image\/jpg$/, 'image/jpeg');
    if(!MIME_OK.test(mime) || typeof a.data !== 'string' || !a.data) throw badReq('Sube una imagen o un PDF del comprobante');
    if(a.data.length > MAX_B64) throw badReq('El archivo es demasiado grande (máx. ~9 MB)');
    const hoy = /^\d{4}-\d{2}-\d{2}$/.test(b.hoy) ? b.hoy : new Date().toISOString().slice(0, 10);

    const system = `Eres un asistente contable en Perú. Lees comprobantes de pago de los gastos de un evento: boletas, facturas, tickets, recibos, capturas de Yape o Plin y constancias de transferencia bancaria (BCP, Interbank, BBVA, Scotiabank…).

Reglas:
- NO inventes datos. Si un dato no se ve con claridad, devuelve "" (o 0 en "monto").
- "fecha": la de la operación, en formato YYYY-MM-DD. Las fechas peruanas van día/mes/año ("12/11/26" = 2026-11-12). Si no se ve el año, usa el que deje la fecha más cercana a hoy (${hoy}) sin pasarse al futuro.
- "comercio": quien RECIBE el pago (razón social o nombre comercial en boletas y facturas; el destinatario en Yape, Plin y transferencias).
- "concepto": qué se compró o pagó, máximo 60 caracteres (productos, servicio, glosa o mensaje del pago). Si no se ve nada, "".
- "categoria": exactamente una de: ${CATEGORIAS.join(', ')}. Si dudas, "Otros".
- "tipo": exactamente uno de: ${TIPOS.join(', ')}.
- "numero": serie-correlativo del comprobante (p. ej. B001-00012345, F001-889) o el número de operación.
- "monto": el TOTAL final pagado (con IGV, no subtotales), como número sin símbolo de moneda.
- "moneda": "PEN" por defecto; "USD" solo si se ve $, US$ o USD.`;

    const prompt = `Se adjunta el comprobante arriba. Responde SOLO este JSON:
{"fecha":"YYYY-MM-DD","comercio":"","concepto":"","categoria":"${CATEGORIAS[0]}","tipo":"${TIPOS[0]}","numero":"","monto":0,"moneda":"PEN"}`;

    const media = [{ inline_data: { mime_type: mime, data: a.data } }];
    // holgado: los modelos 3.x razonan antes de responder
    return { system, prompt, media, json: true, maxTokens: 4096, temperature: 0 };
  }

  return { gasto: buildGasto };
}
