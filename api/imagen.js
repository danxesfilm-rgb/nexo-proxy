export const config = { runtime: 'edge' };

export default async function handler(req) {
  // CORS — permite peticiones desde cualquier origen
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: cors });
  }

  try {
    const { prompt, width, height, steps } = await req.json();

    if (!prompt) {
      return new Response(JSON.stringify({ error: 'Falta el prompt' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
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

    // Modelo cargando
    if (hfResp.status === 503) {
      return new Response(JSON.stringify({ error: 'modelo_cargando' }), {
        status: 503,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (!hfResp.ok) {
      const err = await hfResp.json().catch(() => ({}));
      return new Response(JSON.stringify({ error: err.error || 'HF error ' + hfResp.status }), {
        status: hfResp.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Devolver la imagen como base64 para que el browser la muestre
    const imgBuffer = await hfResp.arrayBuffer();
    const base64 = Buffer.from(imgBuffer).toString('base64');

    return new Response(JSON.stringify({ image: base64, mimeType: 'image/jpeg' }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
}
