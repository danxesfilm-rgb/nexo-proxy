export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { prompt, width, height, steps } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Falta el prompt' });
    }

    const HF_TOKEN = process.env.HF_TOKEN;
    const HF_MODEL = 'black-forest-labs/FLUX.1-dev';

    const hfResp = await fetch(
      `https://api-inference.huggingface.co/models/${HF_MODEL}/v1/images/generate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            width: width || 1024,
            height: height || 576,
            num_inference_steps: steps || 28,
            guidance_scale: 3.5,
            num_images_per_prompt: 1,
          },
        }),
      }
    );

    if (hfResp.status === 503) {
      return res.status(503).json({ error: 'modelo_cargando' });
    }

    if (!hfResp.ok) {
      const err = await hfResp.json().catch(() => ({}));
      return res.status(hfResp.status).json({ error: err.error || 'HF error ' + hfResp.status });
    }

    const imgBuffer = await hfResp.arrayBuffer();
    const base64 = Buffer.from(imgBuffer).toString('base64');

    return res.status(200).json({ image: base64, mimeType: 'image/jpeg' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
