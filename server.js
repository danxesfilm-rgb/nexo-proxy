/**
 * NEXO Proxy — Express server para Render.com
 * Envuelve las funciones serverless de Vercel como rutas Express.
 * Las funciones usan req/res estándar → compatibles sin cambios.
 */
import express from 'express';
import klingHandler      from './api/kling.js';
import seedanceHandler   from './api/seedance.js';
import veoHandler        from './api/veo.js';
import nanobanaHandler   from './api/nanobanana.js';
import statusHandler     from './api/status.js';
import pingHandler       from './api/ping.js';
import dlHandler         from './api/dl.js';
import downloadHandler   from './api/download.js';
import transcribeHandler from './api/transcribe.js';

const app = express();
app.use(express.json({ limit: '20mb' }));

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
app.all('/api/veo',        route(veoHandler));
app.all('/api/nanobanana', route(nanobanaHandler));
app.all('/api/status',     route(statusHandler));
app.all('/api/ping',       route(pingHandler));
app.all('/api/dl',         route(dlHandler));
app.all('/api/download',   route(downloadHandler));
app.all('/api/transcribe', route(transcribeHandler));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'nexo-proxy', host: 'render' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NEXO Proxy activo en puerto ${PORT}`));
