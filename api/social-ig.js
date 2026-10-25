/* ============================================================
   NEXO Proxy · Instagram (API de Instagram con inicio de sesión de Instagram)
   Cuenta profesional (empresa o creador). El token lo genera el dueño en su
   app de Meta (Instagram → "Generar token") y lo pega en Viral Lab; aquí
   NO se guarda: llega en cada petición y solo se reenvía a graph.instagram.com.

   POST { action, token, ... }
     action = 'perfil'   → { perfil:{id,username,name,foto,seguidores,siguiendo,posts,tipo} }
     action = 'media'    { limite } → { media:[{id,tipo,producto,fecha,caption,link,thumb,likes,comentarios,alcance,vistas,guardados,compartidos,interacciones}] }
     action = 'refresh'  → { token, expira_en }   (alarga el token 60 días; debe tener > 24 h)
     action = 'publicar' { imagenes:[url jpg], caption } → { id, permalink }
                         1 imagen = post normal · 2-10 = carrusel
   ============================================================ */
const GRAPH = 'https://graph.instagram.com';
const V = process.env.IG_GRAPH_VERSION || 'v23.0';

const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const isHttp = u => /^https:\/\//i.test(String(u || ''));

async function ig(path, token, params = {}, method = 'GET'){
  const qs = new URLSearchParams({ ...params, access_token: token });
  // refresh_access_token no lleva versión en la ruta
  const base = path === 'refresh_access_token' ? `${GRAPH}/${path}` : `${GRAPH}/${V}/${path}`;
  const r = await fetch(method === 'GET' ? `${base}?${qs}` : base, method === 'GET' ? {} : {
    method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs,
  });
  const d = await r.json().catch(() => ({}));
  if(!r.ok || d.error){
    const e = new Error(traducir(d.error) || `Instagram ${r.status}`);
    e.status = d.error?.code === 190 ? 401 : (r.status >= 400 && r.status < 500 ? 400 : 502);
    throw e;
  }
  return d;
}
function traducir(err){
  if(!err) return '';
  if(err.code === 190) return 'El token de Instagram no es válido o caducó. Genera uno nuevo en tu app de Meta.';
  if(err.code === 10 || err.code === 200) return 'Al token le faltan permisos (instagram_business_basic, _manage_insights, _content_publish).';
  if(err.code === 4 || err.code === 17 || err.code === 32) return 'Instagram limitó las consultas por ahora. Prueba en unos minutos.';
  return err.error_user_msg || err.message || '';
}

/* Métricas de una publicación: se piden juntas y, si alguna no aplica al tipo, una a una */
const METRICAS = ['reach', 'views', 'saved', 'shares', 'total_interactions'];
async function insights(id, token){
  const out = {};
  const leer = d => (d.data || []).forEach(m => { out[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0; });
  try{ leer(await ig(`${id}/insights`, token, { metric: METRICAS.join(',') })); }
  catch(e){
    if(e.status === 401) throw e;
    for(const m of METRICAS){ try{ leer(await ig(`${id}/insights`, token, { metric: m })); }catch(_){} }
  }
  return out;
}

async function perfil(token){
  const p = await ig('me', token, { fields: 'user_id,username,name,profile_picture_url,followers_count,follows_count,media_count,account_type' });
  return { perfil: { id: p.user_id || p.id, username: p.username, name: p.name || '', foto: p.profile_picture_url || '',
    seguidores: p.followers_count || 0, siguiendo: p.follows_count || 0, posts: p.media_count || 0, tipo: p.account_type || '' } };
}

async function media(token, limite){
  const lim = Math.min(50, Math.max(1, parseInt(limite, 10) || 25));
  const d = await ig('me/media', token, { fields: 'id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count', limit: lim });
  const items = d.data || [];
  const res = [];
  // de 5 en 5 para no disparar el límite de Instagram
  for(let i = 0; i < items.length; i += 5){
    const lote = await Promise.all(items.slice(i, i + 5).map(async m => {
      const s = await insights(m.id, token).catch(e => { if(e.status === 401) throw e; return {}; });
      return {
        id: m.id, tipo: m.media_type, producto: m.media_product_type, fecha: m.timestamp,
        caption: str(m.caption, 2200), link: m.permalink,
        thumb: m.thumbnail_url || (m.media_type === 'VIDEO' ? '' : m.media_url) || '',
        likes: m.like_count || 0, comentarios: m.comments_count || 0,
        alcance: s.reach || 0, vistas: s.views || 0, guardados: s.saved || 0, compartidos: s.shares || 0,
        interacciones: s.total_interactions || 0,
      };
    }));
    res.push(...lote);
  }
  return { media: res };
}

async function refresh(token){
  const d = await ig('refresh_access_token', token, { grant_type: 'ig_refresh_token' });
  return { token: d.access_token, expira_en: d.expires_in };
}

/* El contenedor de un carrusel tarda en procesarse: se espera a FINISHED */
async function esperarListo(id, token){
  for(let i = 0; i < 20; i++){
    const s = await ig(id, token, { fields: 'status_code' });
    if(s.status_code === 'FINISHED' || !s.status_code) return;
    if(s.status_code === 'ERROR' || s.status_code === 'EXPIRED')
      throw Object.assign(new Error('Instagram no pudo procesar las imágenes (deben ser JPG públicos, de 4:5 a 1.91:1).'), { status: 400 });
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function publicar(token, b){
  const imgs = (Array.isArray(b.imagenes) ? b.imagenes : []).filter(isHttp).slice(0, 10);
  if(!imgs.length) throw Object.assign(new Error('No hay imágenes públicas para publicar'), { status: 400 });
  const caption = str(b.caption, 2200);
  let creation;
  if(imgs.length === 1){
    creation = (await ig('me/media', token, { image_url: imgs[0], caption }, 'POST')).id;
  }else{
    const hijos = [];
    for(const u of imgs) hijos.push((await ig('me/media', token, { image_url: u, is_carousel_item: 'true' }, 'POST')).id);
    creation = (await ig('me/media', token, { media_type: 'CAROUSEL', children: hijos.join(','), caption }, 'POST')).id;
  }
  await esperarListo(creation, token);
  const pub = await ig('me/media_publish', token, { creation_id: creation }, 'POST');
  const info = await ig(pub.id, token, { fields: 'permalink' }).catch(() => ({}));
  return { id: pub.id, permalink: info.permalink || '' };
}

export default async function handler(req, res){
  if(!res.getHeader('Access-Control-Allow-Origin')) res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const b = req.body || {};
  const token = str(b.token, 600).trim();
  if(!token) return res.status(400).json({ error: 'Falta el token de Instagram' });
  try{
    if(b.action === 'perfil')   return res.status(200).json(await perfil(token));
    if(b.action === 'media')    return res.status(200).json(await media(token, b.limite));
    if(b.action === 'refresh')  return res.status(200).json(await refresh(token));
    if(b.action === 'publicar') return res.status(200).json(await publicar(token, b));
    return res.status(400).json({ error: 'Acción desconocida' });
  }catch(e){
    return res.status(e.status || 500).json({ error: e.message || 'Error con Instagram' });
  }
}
