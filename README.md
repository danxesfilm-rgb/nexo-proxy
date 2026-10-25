# NEXO Proxy

Este directorio contiene el proxy backend para las descargas de `descargar-videos.html`.

## Objetivo

- Usar YTDLP / RapidAPI para procesar descargas de YouTube.
- Mantener el comportamiento actual para TikTok/Instagram mediante TikWM.

## Configuración

Copia `.env.example` a `.env` y completa las variables necesarias.

```env
YTDLP_API_URL=https://yt-dlp-api.p.rapidapi.com/
YTDLP_API_METHOD=GET
YTDLP_API_HEADERS=x-rapidapi-host: yt-dlp-api.p.rapidapi.com; x-rapidapi-key: TU_RAPIDAPI_KEY
```

Si tu servicio usa `Authorization` en vez de RapidAPI:

```env
YTDLP_API_KEY=TU_TOKEN
YTDLP_API_HEADER=Authorization
YTDLP_API_KEY_PREFIX=Bearer
```

## Uso local

```bash
cd "e:/NEXO/Web/files (1)/nexo-proxy"
npm install
npm run dev
```

## Despliegue en Vercel

```bash
cd "e:/NEXO/Web/files (1)/nexo-proxy"
npx vercel --prod
```

Asegúrate de tener el proyecto desplegado y opciones de entorno configuradas en Vercel:

- `YTDLP_API_URL`
- `YTDLP_API_METHOD`
- `YTDLP_API_HEADERS`
- o `YTDLP_API_KEY`, `YTDLP_API_HEADER`, `YTDLP_API_KEY_PREFIX`

## Frontend

En `descargar-videos.html`, el proxy por defecto es:

```js
const PROXY = 'https://nexo-proxy.vercel.app/api/download';
```

Puedes cambiarlo al dominio de tu propio proxy usando:

- query string: `?proxy=https://mi-proxy.vercel.app/api/download`
- o en la consola del navegador:

```js
localStorage.setItem('nexo_proxy_url', 'https://mi-proxy.vercel.app/api/download');
```
