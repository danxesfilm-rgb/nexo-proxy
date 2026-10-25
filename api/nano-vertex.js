import crypto from 'crypto';

/* ============================================================
   NEXO Proxy · Nano Banana (gemini-2.5-flash-image) vía VERTEX AI
   - Autenticación con CUENTA DE SERVICIO (ADC) — NO usa API key.
     La organización bloquea las API keys, así que firmamos un JWT
     RS256 con la private key de la SA y lo canjeamos por un token
     OAuth2 (jwt-bearer). El token se cachea mientras dura el lambda.
   - POST { prompt, aspectRatio?, refs[]? } → { image: dataURL }
     refs[0] = base64 (sin cabecera) de una imagen para editar.
   Env vars:
     GCP_SA_KEY        JSON completo de la cuenta de servicio (stringify), o:
     GCP_CLIENT_EMAIL  +  GCP_PRIVATE_KEY   (alternativa partida)
     GCP_PROJECT_ID    id del proyecto (ej. nexoagency-xxxxx)
     GCP_LOCATION      región (default 'global'; o 'us-central1', etc.)
   ============================================================ */

const PROJECT  = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || 'global';
const MODEL    = 'gemini-2.5-flash-image';

function b64url(input){
  return Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function getServiceAccount(){
  if(process.env.GCP_SA_KEY){
    const sa = JSON.parse(process.env.GCP_SA_KEY);
    return { client_email: sa.client_email, private_key: sa.private_key };
  }
  return {
    client_email: process.env.GCP_CLIENT_EMAIL,
    private_key:  process.env.GCP_PRIVATE_KEY,
  };
}

let cachedToken = null; // { token, exp }

async function getAccessToken(){
  const now = Math.floor(Date.now() / 1000);
  if(cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const sa = getServiceAccount();
  const key = (sa.private_key || '').replace(/\\n/g, '\n'); // las env vars suelen escapar los saltos
  if(!sa.client_email || !key) throw new Error('Falta la cuenta de servicio (GCP_SA_KEY o GCP_CLIENT_EMAIL/GCP_PRIVATE_KEY)');

  const header = { alg:'RS256', typ:'JWT' };
  const claim  = {
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };
  const unsigned  = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key)
    .toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${unsigned}.${signature}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });
  const d = await r.json();
  if(!r.ok) throw new Error(d.error_description || d.error || 'Fallo al obtener token OAuth2');

  cachedToken = { token: d.access_token, exp: now + (d.expires_in || 3600) };
  return cachedToken.token;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST')    return res.status(405).json({ error:'Method not allowed' });
  if(!PROJECT)                 return res.status(500).json({ error:'Falta GCP_PROJECT_ID en el servidor' });

  try{
    const { prompt, aspectRatio, refs } = req.body || {};
    if(!prompt) return res.status(400).json({ error:'Falta el prompt' });

    const parts = [{ text: aspectRatio ? `${prompt}\n(relación de aspecto: ${aspectRatio})` : prompt }];
    const hasRef = Array.isArray(refs) && refs.length > 0 && refs[0];
    if(hasRef) parts.push({ inlineData: { mimeType:'image/jpeg', data: refs[0] } });

    const token = await getAccessToken();
    const host  = LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`;
    const url   = `https://${host}/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

    const r = await fetch(url, {
      method:'POST',
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        contents: [{ role:'user', parts }],
        generationConfig: { responseModalities: ['TEXT','IMAGE'] },
      }),
    });
    const d = await r.json();
    if(!r.ok) return res.status(r.status).json({ error: d.error?.message || ('Vertex '+r.status) });

    const imgPart = d.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
    if(!imgPart) return res.status(502).json({ error:'Vertex no devolvió imagen' });

    const mime = imgPart.inlineData.mimeType || 'image/png';
    return res.status(200).json({ image: `data:${mime};base64,${imgPart.inlineData.data}` });

  }catch(e){
    return res.status(500).json({ error: e.message });
  }
}
