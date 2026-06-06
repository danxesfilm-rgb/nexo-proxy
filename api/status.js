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
    seedance: !!process.env.SEEDANCE_KEY,
    kling:    !!(process.env.KLING_ACCESS_KEY && process.env.KLING_SECRET_KEY),
    cleanup:  !!process.env.REPLICATE_API_TOKEN,
  });
}
