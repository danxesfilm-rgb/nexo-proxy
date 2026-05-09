// Endpoint de warm-up: despierta el servidor Render antes de que el usuario analice un video
export const config = { maxDuration: 10 };

const YT_SERVER = process.env.YT_SERVER_URL || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!YT_SERVER) return res.status(200).json({ ok: false, msg: 'no server' });

  try {
    const start = Date.now();
    const r = await fetch(`${YT_SERVER}/health`, { signal: AbortSignal.timeout(8000) });
    return res.status(200).json({ ok: r.ok, ms: Date.now() - start });
  } catch (_) {
    // Si /health no existe, probar raíz
    try {
      const r = await fetch(YT_SERVER, { signal: AbortSignal.timeout(8000) });
      return res.status(200).json({ ok: r.ok });
    } catch (_) {
      return res.status(200).json({ ok: false });
    }
  }
}
