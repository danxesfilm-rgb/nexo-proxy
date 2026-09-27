/* ============================================================
   NEXO Proxy · Tendencias (Google News RSS)
   - Sin API key. Devuelve titulares actuales sobre un tema
     para alimentar ideas de video basadas en tendencias.
   GET /api/trends?q=tema&lang=es  → { titles:[...] }
   ============================================================ */

const REGION = {
  es:    { hl:'es-419', gl:'PE', ceid:'PE:es-419' },
  'es-LA':{ hl:'es-419', gl:'PE', ceid:'PE:es-419' },
  'es-ES':{ hl:'es',     gl:'ES', ceid:'ES:es' },
  en:    { hl:'en-US',   gl:'US', ceid:'US:en' },
};

function decode(s){
  return String(s||'')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&nbsp;/g,' ')
    .trim();
}

/* Titulares de Google News sobre q. También lo usa agent.js como plan B
   cuando la búsqueda de Google de Gemini no tiene cuota. */
export async function fetchNews(q, lang, max = 12){
  const r = REGION[lang] || REGION.es;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${r.hl}&gl=${r.gl}&ceid=${r.ceid}`;
  const resp = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0 (compatible; NexoBot/1.0)' } });
  const xml = await resp.text();
  const out = [];
  for(const it of xml.split('<item>').slice(1)){
    const m = it.match(/<title>([\s\S]*?)<\/title>/);
    const t = m ? decode(m[1]) : '';
    // Google News añade " - Fuente" al final; lo dejamos, da contexto de medio
    if(t) out.push({
      title:  t,
      link:   decode((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1]),
      source: decode((it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]),
      date:   decode((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]),
    });
    if(out.length >= max) break;
  }
  return out;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'GET') return res.status(405).json({ error:'Method not allowed' });

  try{
    const q = String(req.query.q || '').slice(0, 200).trim();
    if(!q) return res.status(400).json({ error:'Falta parámetro q' });
    const max = Math.min(parseInt(req.query.max || '12', 10) || 12, 20);
    const titles = (await fetchNews(q, req.query.lang, max)).map(n => n.title);

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
    return res.status(200).json({ q, titles });
  }catch(err){
    console.error('trends proxy error:', err);
    return res.status(500).json({ error:'Error al consultar tendencias', detail:String(err) });
  }
}
