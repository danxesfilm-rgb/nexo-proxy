/* ============================================================
   NEXO Proxy · Estado de keys (booleanos, nunca revela las keys)
   GET → { gemini, seedance, kling }
   ============================================================ */
export default function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();

  return res.status(200).json({
    gemini:   !!process.env.GEMINI_API_KEY,
    seedance: !!(process.env.EVOLINK_KEY || process.env.SEEDANCE_KEY),
    kling:    !!process.env.KLING_API_KEY,
    freepik:  !!process.env.FREEPIK_API_KEY,   // Magnific (Nano Banana · Kling · Seedance)
    cleanup:  !!(process.env.BRIA_API_KEY || process.env.REPLICATE_API_TOKEN),
    bria:     !!process.env.BRIA_API_KEY,
    replicate:!!process.env.REPLICATE_API_TOKEN,
    vertex:   !!(process.env.GCP_PROJECT_ID && (process.env.GCP_SA_KEY || (process.env.GCP_CLIENT_EMAIL && process.env.GCP_PRIVATE_KEY))),
  });
}
