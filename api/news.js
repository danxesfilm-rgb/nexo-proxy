// Proxy para GNews API — oculta la API key del cliente
// Variable de entorno necesaria en Vercel: GNEWS_API_KEY

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { q, lang, max } = req.query;

    if (!q) return res.status(400).json({ error: 'Falta parámetro q' });

    // Validación básica para evitar abuso del proxy
    const safeQ = String(q).slice(0, 200);
    const safeLang = ['es', 'pt', 'en'].includes(lang) ? lang : 'es';
    const safeMax = Math.min(parseInt(max || '8', 10) || 8, 20);

    const KEY = process.env.GNEWS_API_KEY;
    if (!KEY) return res.status(500).json({ error: 'API key no configurada en el servidor' });

    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(safeQ)}&lang=${safeLang}&max=${safeMax}&token=${KEY}`;

    const resp = await fetch(url);
    const data = await resp.json();

    // Cache 10 min en CDN para reducir consumo de cuota
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
    return res.status(200).json(data);
  } catch (err) {
    console.error('GNews proxy error:', err);
    return res.status(500).json({ error: 'Error al consultar noticias', detail: String(err) });
  }
}
