/**
 * NEXO Proxy — Express server para Render.com
 * Envuelve las funciones serverless de Vercel como rutas Express.
 * Las funciones usan req/res estándar → compatibles sin cambios.
 */
import express from 'express';
import klingHandler      from './api/kling.js';
import seedanceHandler   from './api/seedance.js';
import freepikHandler    from './api/freepik.js';
import kieHandler        from './api/kie.js';
import veoHandler        from './api/veo.js';
import nanobanaHandler   from './api/nanobanana.js';
import statusHandler     from './api/status.js';
import pingHandler       from './api/ping.js';
import dlHandler         from './api/dl.js';
import downloadHandler   from './api/download.js';
import transcribeHandler from './api/transcribe.js';
import trendsHandler     from './api/trends.js';
import promptHandler     from './api/prompt.js';
import agentHandler      from './api/agent.js';
import socialIgHandler   from './api/social-ig.js';
import cleanupHandler    from './api/cleanup.js';
import upscaleHandler    from './api/upscale.js';
import removebgHandler   from './api/removebg.js';

const app = express();
app.use(express.json({ limit: '20mb' }));

/* ── Protección de /api/agent (gasta la key de Gemini) ─────────────────
   · Solo responde a navegadores que vengan de la web de NEXO (o localhost para pruebas).
   · Límite por IP: 30 puntos/min y 400/hora; 'analizar' (descarga un video) cuenta 10.
   Quien llame sin cabecera Origin (curl, scripts) no pasa el filtro de origen pero sí el límite. */
app.set('trust proxy', 1);   // Render va detrás de un proxy: sin esto todos los clientes parecen la misma IP
const ORIGENES_OK = [
  /^https:\/\/(www\.)?nexoagency\.pe$/,
  /^https:\/\/[a-z0-9-]+\.nexostudiope\.workers\.dev$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];
const LIMITE_MIN = 30, LIMITE_HORA = 400;
const usos = new Map();   // ip → [{ t, c }]
setInterval(() => {
  const corte = Date.now() - 3600e3;
  for (const [ip, a] of usos) { const v = a.filter(x => x.t > corte); v.length ? usos.set(ip, v) : usos.delete(ip); }
}, 5 * 60e3).unref();

function guardAgent(req, res, next) {
  const o = req.headers.origin;
  if (o) {
    if (!ORIGENES_OK.some(r => r.test(o))) return res.status(403).json({ error: 'Origen no permitido' });
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  const ahora = Date.now(), ip = req.ip || 'sin-ip';
  const costo = req.body && req.body.task === 'analizar' ? 10 : 1;
  if (usos.size > 5000) usos.clear();   // tope de memoria
  const a = (usos.get(ip) || []).filter(x => x.t > ahora - 3600e3);
  const suma = arr => arr.reduce((n, x) => n + x.c, 0);
  if (suma(a.filter(x => x.t > ahora - 60e3)) + costo > LIMITE_MIN || suma(a) + costo > LIMITE_HORA) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Demasiadas solicitudes seguidas. Espera un minuto e inténtalo de nuevo.' });
  }
  a.push({ t: ahora, c: costo });
  usos.set(ip, a);
  next();
}
app.options('/api/agent', guardAgent);
app.options('/api/social-ig', guardAgent);   // antes del OPTIONS genérico, que respondería con '*'

function route(handler) {
  return (req, res) => handler(req, res);
}

app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

app.all('/api/kling',      route(klingHandler));
app.all('/api/seedance',   route(seedanceHandler));
app.all('/api/freepik',    route(freepikHandler));
app.all('/api/kie',        route(kieHandler));
app.all('/api/veo',        route(veoHandler));
app.all('/api/nanobanana', route(nanobanaHandler));
app.all('/api/status',     route(statusHandler));
app.all('/api/ping',       route(pingHandler));
app.all('/api/dl',         route(dlHandler));
app.all('/api/download',   route(downloadHandler));
app.all('/api/transcribe', route(transcribeHandler));
app.all('/api/trends',     route(trendsHandler));
app.all('/api/prompt',     route(promptHandler));
app.all('/api/agent',      guardAgent, route(agentHandler));
app.all('/api/social-ig',  guardAgent, route(socialIgHandler));   // Viral Lab · Instagram (el token no se guarda)
app.all('/api/cleanup',    route(cleanupHandler));
app.all('/api/upscale',    route(upscaleHandler));
app.all('/api/removebg',   route(removebgHandler));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'nexo-proxy', host: 'render' }));

// 404 con CORS: sin esta cabecera el navegador lo reporta como fallo de red
// y el cliente no puede distinguir 'ruta no desplegada' de 'servidor caído'
app.use((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(404).json({ error: 'Ruta no encontrada en el proxy: ' + req.path });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NEXO Proxy activo en puerto ${PORT}`));
