"""
NEXO yt-dlp Server v2
Actúa como fallback para nexo-proxy.vercel.app.
Vercel lo llama como YT_SERVER cuando RapidAPI / Cobalt / ddInstagram fallan.

Endpoints que usa el proxy de Vercel:
  GET /health              → warm-up check
  GET /info?url=...        → YouTube + Instagram: lista de formatos
  GET /embed?url=...       → Instagram: URL directa del video

Deploy: Render.com free tier
  Build:  pip install -r requirements.txt
  Start:  uvicorn main:app --host 0.0.0.0 --port $PORT
"""
import os
import re
import base64
import subprocess
import tempfile
import atexit
import httpx
import yt_dlp
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

# ffmpeg es imprescindible para /stream: yt-dlp lo usa para juntar el video y
# el audio, que YouTube entrega por separado. Render no trae ffmpeg y el build
# no puede hacer apt-get, así que static_ffmpeg pone un binario en el PATH.
try:
    import static_ffmpeg
    static_ffmpeg.add_paths()
    _FFMPEG_OK = True
except Exception as e:      # sin ffmpeg /stream solo puede servir sin muxear
    print(f"[ffmpeg] no disponible: {e}")
    _FFMPEG_OK = False

app = FastAPI(title="NEXO yt-dlp Server", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ─── User-Agent móvil para Instagram ───────────────────────────────────────
_MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/17.0 Mobile/15E148 Safari/604.1"
)

# ─── Regex para limpiar títulos autogenerados de Instagram ─────────────────
_IG_TITLE_RE = re.compile(r'^instagram_[A-Za-z0-9_\-]+$', re.IGNORECASE)

# ─── Cookies (base64 de cookies.txt Netscape) ─────────────────────────────
# Render env vars: IG_COOKIES_B64  y  YT_COOKIES_B64

def _load_cookies(env_var: str) -> str | None:
    b64 = os.environ.get(env_var, "").strip()
    if not b64:
        return None
    try:
        content = base64.b64decode(b64).decode("utf-8")
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False, prefix=f"{env_var.lower()}_"
        )
        content = content.replace('\r\n', '\n')  # Windows → Unix line endings
        tmp.write(content); tmp.flush(); tmp.close()
        print(f"[cookies] {env_var} cargado → {tmp.name}")
        return tmp.name
    except Exception as e:
        print(f"[cookies] Error cargando {env_var}: {e}")
        return None

_IG_COOKIES_FILE: str | None = _load_cookies("IG_COOKIES_B64")
_YT_COOKIES_FILE: str | None = _load_cookies("YT_COOKIES_B64")

def _cleanup():
    for f in [_IG_COOKIES_FILE, _YT_COOKIES_FILE]:
        if f and os.path.exists(f):
            try: os.unlink(f)
            except: pass

atexit.register(_cleanup)

# ───────────────────────────────────────────────────────────────────────────
# COBALT — motor externo para YouTube
#
# YouTube ya no entrega formatos progresivos (video+audio) a IPs de datacenter
# sin PO token, y las URLs de googlevideo que devuelve yt-dlp quedan ligadas a
# la IP del servidor → el navegador del usuario recibe 403 al descargarlas.
# Cobalt resuelve las dos cosas: muxea video+audio y sirve el archivo por su
# propio túnel, así que el enlace funciona desde cualquier IP.
#
# Se puede sobrescribir la lista con la env var COBALT_INSTANCES (separadas por
# coma). Lo ideal a medio plazo es alojar una instancia propia de cobalt y
# ponerla primera en la lista.
# ───────────────────────────────────────────────────────────────────────────
_COBALT_DEFAULT = [
    "https://co.otomir23.me",
    "https://cobalt-api.kwiatekmiki.com",
    "https://cobalt-backend.canine.tools",
    "https://api.cobalt.tools",
]
_COBALT_INSTANCES = [
    i.strip().rstrip("/")
    for i in os.environ.get("COBALT_INSTANCES", ",".join(_COBALT_DEFAULT)).split(",")
    if i.strip()
]
_COBALT_HEADERS = {
    "Accept": "application/json",   # obligatorio: sin esto responde error.api.header.accept
    "Content-Type": "application/json",
    "User-Agent": "NEXO-Proxy/2.1",
}


def _cobalt(payload: dict, timeout: float = 15.0) -> dict | None:
    """Consulta las instancias de cobalt en orden y devuelve la primera respuesta útil."""
    for base in _COBALT_INSTANCES:
        try:
            with httpx.Client(timeout=timeout, follow_redirects=True) as client:
                r = client.post(f"{base}/", headers=_COBALT_HEADERS, json=payload)
            if r.status_code != 200:
                continue
            j = r.json()
            if j.get("status") in ("tunnel", "redirect", "stream") and j.get("url"):
                return j
            if j.get("status") == "picker" and j.get("picker"):
                return j
        except Exception:
            continue
    return None


def _cobalt_link(url: str, kind: str = "video", quality: str = "1080") -> dict | None:
    """Pide a cobalt un enlace de descarga recién generado."""
    if kind == "audio":
        return _cobalt({"url": url, "downloadMode": "audio", "audioFormat": "mp3"})
    return _cobalt({"url": url, "downloadMode": "auto", "videoQuality": quality})


def _cobalt_youtube(url: str, quality: str = "1080") -> list:
    """Formatos de YouTube (video muxeado + audio mp3) vía cobalt.

    Los túneles caducan a los ~90 s de generarse, mucho antes de que el usuario
    termine de mirar el resultado y decidir. Por eso se marcan como ephemeral:
    el front no debe usar este stream_url, sino pedir uno nuevo a /api/link
    justo al hacer clic. El stream_url va igual como respaldo.
    """
    out = []
    v = _cobalt_link(url, "video", quality)
    if v:
        out.append({
            "quality":    f"MP4 · {quality}p",
            "stream_url": v["url"],
            "ext":        "mp4",
            "type":       "video",
            "filename":   v.get("filename", ""),
            "ephemeral":  True,
            "kind":       "video",
        })
    a = _cobalt_link(url, "audio")
    if a:
        out.append({
            "quality":    "MP3 Audio",
            "stream_url": a["url"],
            "ext":        "mp3",
            "type":       "audio",
            "filename":   a.get("filename", ""),
            "ephemeral":  True,
            "kind":       "audio",
        })
    return out

# ───────────────────────────────────────────────────────────────────────────
# HEALTH / WARM-UP
# ───────────────────────────────────────────────────────────────────────────
@app.get("/")
@app.get("/health")
def health():
    return {
        "status": "ok",
        "engine": "yt-dlp",
        "yt_dlp_version": getattr(yt_dlp.version, "__version__", "?"),
        "ffmpeg": _FFMPEG_OK,
        "ig_cookies": bool(_IG_COOKIES_FILE),
        "yt_cookies": bool(_YT_COOKIES_FILE),
        "cobalt_instances": len(_COBALT_INSTANCES),
    }


# ───────────────────────────────────────────────────────────────────────────
# /thumb  — Proxy de miniaturas con headers de Instagram
# Uso: /thumb?url=https://scontent.cdninstagram.com/...
# ───────────────────────────────────────────────────────────────────────────
@app.get("/thumb")
async def proxy_thumb(url: str = Query(...)):
    headers = {
        "User-Agent":      _MOBILE_UA,
        "Referer":         "https://www.instagram.com/",
        "Accept":          "image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9",
    }
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=12) as client:
            r = await client.get(url, headers=headers)
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail="Imagen no disponible")
            ctype = r.headers.get("content-type", "image/jpeg")
            return Response(
                content=r.content,
                media_type=ctype,
                headers={"Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*"},
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"No se pudo obtener la imagen: {e}")


# ───────────────────────────────────────────────────────────────────────────
# /info  — YouTube + Instagram
# Devuelve: {title, thumbnail, formats:[{quality, stream_url, ext, type}]}
# ───────────────────────────────────────────────────────────────────────────
@app.get("/info")
def info(url: str = Query(...)):
    raw = url.strip()
    is_yt = "youtube.com" in raw or "youtu.be" in raw
    return _yt_info(raw) if is_yt else _ig_info(raw)


# ───────────────────────────────────────────────────────────────────────────
# /embed  — Instagram: URL directa del video (sin lista de formatos)
# Devuelve: {video_url, title, thumbnail}
# ───────────────────────────────────────────────────────────────────────────
@app.get("/embed")
def embed(url: str = Query(...)):
    result = _ig_info(url.strip())
    # Tomar el primer formato de video disponible
    fmts = result.get("formats", [])
    video_fmt = next(
        (f for f in fmts if f.get("type") == "video" and f.get("stream_url")),
        fmts[0] if fmts else None
    )
    if not video_fmt:
        raise HTTPException(status_code=422, detail="No se encontró video descargable.")
    return {
        "video_url": video_fmt["stream_url"],
        "title":     result.get("title", "Post de Instagram"),
        "thumbnail": result.get("thumbnail", ""),
    }


# ───────────────────────────────────────────────────────────────────────────
# /api/download  — contrato compatible con el antiguo proxy de Vercel
# POST {url, service, mode, quality} → {title, thumbnail, platform, videos[]}
#
# La página /descargar apuntaba a nexo-proxy.vercel.app, que devuelve 402
# (deployment deshabilitado). Este endpoint replica ese contrato para que el
# front solo tenga que cambiar la URL base.
# ───────────────────────────────────────────────────────────────────────────
@app.post("/api/download")
def api_download(payload: dict = Body(...)):
    url     = (payload.get("url") or "").strip()
    service = (payload.get("service") or "").strip().lower()
    quality = str(payload.get("quality") or "1080").replace("p", "") or "1080"

    if not url:
        raise HTTPException(400, "url requerido")
    if service not in ("instagram", "tiktok", "youtube"):
        raise HTTPException(400, "Servicio no reconocido.")

    if service == "tiktok":
        data = _tiktok_info(url)
    elif service == "youtube":
        data = _yt_info(url) if not payload.get("force_cobalt") else {
            "title": "Video de YouTube",
            "thumbnail": _yt_thumb_from_url(url),
            "formats": _cobalt_youtube(url, quality),
        }
    else:
        data = _ig_info(url)

    videos = [{
        "quality":   f.get("quality", "original"),
        "url":       f["stream_url"],
        "extension": f.get("ext", "mp4"),
        "type":      f.get("type", "video"),
        "mediaType": f.get("type", "video"),
        # ephemeral → el front debe pedir un enlace nuevo a /api/link al hacer clic
        "ephemeral": bool(f.get("ephemeral")),
        "kind":      f.get("kind", f.get("type", "video")),
    } for f in data.get("formats", []) if f.get("stream_url")]

    if not videos:
        raise HTTPException(422, "No se encontró contenido descargable.")

    return {
        "title":       data.get("title", ""),
        "thumbnail":   data.get("thumbnail", ""),
        "platform":    service,
        "sourceUrl":   url,
        "downloadUrl": videos[0]["url"],
        "videos":      videos,
    }


# ───────────────────────────────────────────────────────────────────────────
# /api/link  — enlace de descarga recién generado
#
# Los túneles de cobalt caducan a los ~90 s. Si se entregan al analizar, para
# cuando el usuario hace clic ya no sirven y el navegador guarda 0 bytes.
# El front llama aquí en el momento del clic.
# ───────────────────────────────────────────────────────────────────────────
@app.post("/api/link")
def api_link(payload: dict = Body(...)):
    url     = (payload.get("url") or "").strip()
    kind    = (payload.get("kind") or "video").strip().lower()
    quality = str(payload.get("quality") or "1080").replace("p", "") or "1080"

    if not url:
        raise HTTPException(400, "url requerido")

    j = _cobalt_link(url, kind, quality)
    if not j or not j.get("url"):
        raise HTTPException(502, "No se pudo generar el enlace de descarga.")

    return {"url": j["url"], "filename": j.get("filename", "")}


# ───────────────────────────────────────────────────────────────────────────
# TIKTOK
# ───────────────────────────────────────────────────────────────────────────
def _tiktok_info(url: str) -> dict:
    # TikWM suele bloquear las IPs de datacenter y responder HTML en vez de JSON.
    # La página resuelve TikTok desde el navegador, así que este camino es solo
    # respaldo; si falla, que el mensaje lo diga claro.
    try:
        with httpx.Client(timeout=12, follow_redirects=True) as client:
            r = client.get(
                "https://www.tikwm.com/api/",
                params={"url": url, "hd": 1},
                headers={"User-Agent": _MOBILE_UA, "Accept": "application/json"},
            )
        payload = r.json()
    except Exception:
        raise HTTPException(502, "TikWM rechazó la petición desde el servidor.")

    if payload.get("code") != 0 or not payload.get("data"):
        raise HTTPException(502, payload.get("msg") or "Sin datos.")

    d = payload["data"]
    fmts = []
    for key, label in (("hdplay", "HD sin marca"), ("play", "Sin marca"), ("wmplay", "Con marca")):
        if d.get(key):
            fmts.append({"quality": label, "stream_url": d[key], "ext": "mp4", "type": "video"})
    if not fmts:
        raise HTTPException(422, "No se encontró URL de descarga.")

    return {
        "title":     d.get("title") or "Video de TikTok",
        "thumbnail": d.get("cover") or d.get("origin_cover") or "",
        "formats":   fmts,
    }


# ───────────────────────────────────────────────────────────────────────────
# YOUTUBE
# ───────────────────────────────────────────────────────────────────────────
_YT_HEIGHTS  = [2160, 1440, 1080, 720, 480, 360]
_YT_LABELS   = {2160: "4K 2160p", 1440: "1440p 2K", 1080: "1080p",
                720: "720p", 480: "480p", 360: "360p"}

def _yt_info(url: str) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        # Sin esto yt-dlp lanza "Requested format is not available" cuando YouTube
        # devuelve solo formatos SABR/sin URL, y perdemos también los metadatos.
        "ignore_no_formats_error": True,
        # ios quedó bloqueado en 2025. tv / web_safari / mweb / android_vr son los
        # clientes que siguen entregando URLs sin PO token desde datacenter.
        "extractor_args": {
            "youtube": {"player_client": ["tv", "web_safari", "mweb", "android_vr", "web"]}
        },
    }
    if _YT_COOKIES_FILE:
        opts["cookiefile"] = _YT_COOKIES_FILE

    try:
        info = _extract(url, opts)
    except HTTPException:
        info = None

    # Sin extracción posible → cobalt directo
    if not info:
        fmts = _cobalt_youtube(url)
        if not fmts:
            raise HTTPException(422, "No se encontraron formatos de descarga.")
        return {"title": "Video de YouTube", "thumbnail": _yt_thumb_from_url(url), "formats": fmts}

    title     = info.get("title", "Video de YouTube")
    thumbnail = _best_thumb(info) or _yt_thumb_from_url(url)
    formats   = info.get("formats") or []

    # ── Alturas realmente disponibles ──────────────────────────────────────
    # No se usan las URLs de yt-dlp: googlevideo las firma con ?ip=<IP de este
    # servidor> y el navegador del usuario recibe 403. Además casi todas son
    # video-only. Solo interesa saber qué calidades existen; el archivo lo
    # arma y lo sirve /stream desde aquí.
    disponibles = {
        f.get("height") for f in formats
        if f.get("height") and f.get("vcodec") not in (None, "none")
    }

    result = []
    for h in _YT_HEIGHTS:
        if h not in disponibles:
            continue
        result.append({
            "quality":    _YT_LABELS.get(h, f"{h}p"),
            "stream_url": _stream_url(url, quality=str(h), mode="video", title=title),
            "ext":        "mp4",
            "type":       "video",
        })

    tiene_audio = any(
        f.get("acodec") not in (None, "none") for f in formats
    )
    if tiene_audio or result:
        result.append({
            "quality":    "MP3 Audio",
            "stream_url": _stream_url(url, quality="0", mode="audio", title=title),
            "ext":        "mp3",
            "type":       "audio",
        })

    # ── Último recurso: cobalt ─────────────────────────────────────────────
    # Solo si yt-dlp no vio ni un formato. Ojo: las instancias públicas de
    # cobalt responden 200 con cuerpo vacío en bastantes videos, así que esto
    # es una red de seguridad, no el camino principal.
    if not result:
        result = _cobalt_youtube(url)

    if not result:
        raise HTTPException(status_code=422, detail="No se encontraron formatos de descarga.")

    return {"title": title, "thumbnail": thumbnail, "formats": result}


# ───────────────────────────────────────────────────────────────────────────
# /stream  — el archivo se arma y se sirve desde este servidor
#
# Por qué no se entregan URLs de terceros:
#  · googlevideo firma las suyas con la IP de este servidor → 403 en el
#    navegador del usuario, y ademas casi todas son video sin audio.
#  · las instancias publicas de cobalt responden 200 con cuerpo vacio en
#    bastantes videos (medido: 3 de 5), y el navegador guarda 0 bytes sin
#    ningun aviso.
# Aqui yt-dlp baja video y audio, ffmpeg los junta, y el resultado sale por
# esta respuesta en trozos. Cuesta ancho de banda de Render pero es el unico
# camino que no depende de que un tercero se porte bien.
# ───────────────────────────────────────────────────────────────────────────
_BASE_URL = (os.environ.get("RENDER_EXTERNAL_URL")
             or os.environ.get("BASE_URL")
             or "https://nexo-proxy.onrender.com").rstrip("/")


def _safe_filename(title: str) -> str:
    limpio = re.sub(r'[\\/:*?"<>|\r\n]+', "", title or "").strip()
    return (limpio or "video")[:120]


def _stream_url(url: str, quality: str, mode: str, title: str) -> str:
    from urllib.parse import urlencode
    return f"{_BASE_URL}/stream?" + urlencode({
        "url": url, "quality": quality, "mode": mode, "title": _safe_filename(title),
    })


def _pick_streams(url: str, quality: str, solo_audio: bool) -> tuple:
    """Saca de yt-dlp las URLs directas de video y audio para pasárselas a ffmpeg.

    Que vayan firmadas para la IP de este servidor da igual: quien las abre es
    ffmpeg, aquí dentro. Lo que nunca debe salir al navegador son esas URLs.
    """
    opts = {
        "quiet": True, "no_warnings": True, "skip_download": True,
        "ignore_no_formats_error": True,
        "extractor_args": {
            "youtube": {"player_client": ["tv", "web_safari", "mweb", "android_vr", "web"]}
        },
    }
    es_yt = "youtube.com" in url or "youtu.be" in url
    ck = _YT_COOKIES_FILE if es_yt else _IG_COOKIES_FILE
    if ck:
        opts["cookiefile"] = ck

    info = _extract(url, opts)
    formats = (info or {}).get("formats") or []
    if not formats:
        raise HTTPException(502, "YouTube no entregó formatos a este servidor.")

    ua = (formats[0].get("http_headers") or {}).get("User-Agent") or _MOBILE_UA

    audios = [f for f in formats
              if f.get("acodec") not in (None, "none") and f.get("url")
              and f.get("vcodec") in (None, "none")]
    audios.sort(key=lambda f: f.get("abr") or 0, reverse=True)
    a_url = audios[0]["url"] if audios else None

    if solo_audio:
        if not a_url:
            # sin pista de audio suelta, sirve cualquier formato con audio
            conaudio = [f for f in formats
                        if f.get("acodec") not in (None, "none") and f.get("url")]
            if not conaudio:
                raise HTTPException(502, "Este video no tiene pista de audio disponible.")
            a_url = conaudio[0]["url"]
        return None, a_url, ua

    tope = int(quality) if quality.isdigit() and quality != "0" else 1080
    videos = [f for f in formats
              if f.get("vcodec") not in (None, "none") and f.get("url")
              and (f.get("height") or 0) <= tope]
    if not videos:
        raise HTTPException(502, "No hay video en esa calidad.")
    videos.sort(key=lambda f: ((f.get("height") or 0),
                               f.get("tbr") or 0), reverse=True)
    mejor = videos[0]

    # Si ya trae audio incorporado no hace falta segunda entrada
    if mejor.get("acodec") not in (None, "none"):
        return mejor["url"], None, ua
    return mejor["url"], a_url, ua


@app.get("/stream")
def stream(
    url:     str = Query(...),
    quality: str = Query("1080"),
    mode:    str = Query("video"),
    title:   str = Query("video"),
):
    es_audio = mode == "audio"
    nombre   = _safe_filename(title)
    ext, ctype = ("mp3", "audio/mpeg") if es_audio else ("mp4", "video/mp4")

    v_url, a_url, ua = _pick_streams(url, quality, es_audio)

    # Se muxea aquí en vez de dejárselo a `yt-dlp -o -`: al escribir en una
    # tubería no se puede rebobinar para colocar el átomo moov, así que yt-dlp
    # cambia de formato a MPEG-TS por su cuenta. El archivo salía con extensión
    # .mp4 pero no era un MP4 (empezaba en 0x47), y editores y reproductores
    # pueden rechazarlo. Con MP4 fragmentado sí se puede escribir en streaming.
    cmd = ["ffmpeg", "-loglevel", "error", "-nostdin"]
    for entrada in ([a_url] if es_audio else [u for u in (v_url, a_url) if u]):
        cmd += ["-user_agent", ua, "-i", entrada]

    if es_audio:
        cmd += ["-vn", "-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"]
    else:
        cmd += ["-c", "copy", "-movflags",
                "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4"]
    cmd.append("pipe:1")

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    # Se lee el primer trozo antes de responder. Si yt-dlp no produce nada, se
    # devuelve un 502 con el motivo en vez de un 200 con el cuerpo vacío: un
    # archivo de 0 bytes sin explicación es el peor resultado posible.
    primero = proc.stdout.read(65536)
    if not primero:
        proc.wait(timeout=10)
        err = (proc.stderr.read() or b"")[-400:].decode("utf-8", "ignore").strip()
        print(f"[stream] yt-dlp sin salida ({proc.returncode}): {err}")
        raise HTTPException(502, f"No se pudo preparar la descarga. {err[-160:]}".strip())

    def generar():
        try:
            yield primero
            while True:
                trozo = proc.stdout.read(65536)
                if not trozo:
                    break
                yield trozo
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()

    return StreamingResponse(
        generar(),
        media_type=ctype,
        headers={
            "Content-Disposition": f'attachment; filename="{nombre}.{ext}"',
            "Cache-Control":       "no-cache",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


def _yt_thumb_from_url(url: str) -> str:
    m = re.search(r"(?:v=|youtu\.be/|shorts/)([A-Za-z0-9_-]{8,})", url)
    return f"https://img.youtube.com/vi/{m.group(1)}/hqdefault.jpg" if m else ""


# ───────────────────────────────────────────────────────────────────────────
# INSTAGRAM
# ───────────────────────────────────────────────────────────────────────────
def _ig_info(url: str) -> dict:
    opts = {
        "quiet":         True,
        "no_warnings":   True,
        "skip_download": True,
        "http_headers":  {"User-Agent": _MOBILE_UA},
    }
    if _IG_COOKIES_FILE:
        opts["cookiefile"] = _IG_COOKIES_FILE
    info = _extract(url, opts)

    # Título limpio
    title = (info.get("title") or "").strip()
    if not title or _IG_TITLE_RE.match(title):
        title = "Post de Instagram"

    thumbnail = info.get("thumbnail", "")
    formats   = []

    # Carrusel → _type = "playlist"
    entries = [info]
    if info.get("_type") == "playlist":
        entries = [e for e in (info.get("entries") or []) if e]

    for entry in entries:
        formats.extend(_ig_entry_formats(entry))

    if not formats:
        raise HTTPException(status_code=422, detail="No se encontró contenido descargable.")

    return {"title": title, "thumbnail": thumbnail, "formats": formats}


def _ig_entry_formats(entry: dict) -> list:
    """Extrae formatos de video o imagen de una entrada de yt-dlp."""
    fmts = entry.get("formats") or []

    # ── Video ──────────────────────────────────────────────────────────────
    vid_fmts = [
        f for f in fmts
        if f.get("ext") == "mp4"
        and f.get("vcodec") not in (None, "none")
        and f.get("url")
    ]
    if vid_fmts:
        vid_fmts.sort(key=lambda f: f.get("height") or 0, reverse=True)
        b = vid_fmts[0]
        h = b.get("height")
        return [{
            "quality":    f"{h}p" if h else "original",
            "stream_url": b["url"],
            "ext":        "mp4",
            "type":       "video",
        }]

    # ── Imagen ─────────────────────────────────────────────────────────────
    img_fmts = [
        f for f in fmts
        if f.get("ext") in ("jpg", "jpeg", "png", "webp") and f.get("url")
    ]
    if img_fmts:
        img_fmts.sort(
            key=lambda f: (f.get("width") or 0) * (f.get("height") or 0),
            reverse=True,
        )
        b = img_fmts[0]
        w, h = b.get("width", 0), b.get("height", 0)
        res = f"{w}x{h}" if w and h else ""
        return [{
            "quality":    f"image {res}".strip(),
            "stream_url": b["url"],
            "ext":        b["ext"],
            "type":       "image",
        }]

    # ── Fallback: URL directa de la entrada ────────────────────────────────
    direct = entry.get("url", "")
    ext    = entry.get("ext", "")
    if direct:
        if ext in ("jpg", "jpeg", "png", "webp"):
            return [{"quality": "image", "stream_url": direct, "ext": ext, "type": "image"}]
        return [{"quality": "original", "stream_url": direct, "ext": "mp4", "type": "video"}]

    return []


# ───────────────────────────────────────────────────────────────────────────
# HELPERS
# ───────────────────────────────────────────────────────────────────────────
def _extract(url: str, opts: dict) -> dict:
    """Llama yt-dlp y convierte errores a HTTPException."""
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as e:
        msg = str(e).lower()
        if "login" in msg or "private" in msg:
            raise HTTPException(403, "Contenido privado o requiere inicio de sesión.")
        if "unavailable" in msg or "removed" in msg:
            raise HTTPException(404, "Contenido no disponible o eliminado.")
        raise HTTPException(422, f"No se pudo obtener: {str(e)[:200]}")
    except Exception as e:
        raise HTTPException(500, f"Error interno: {str(e)[:200]}")


def _best_thumb(info: dict) -> str:
    for t in reversed(info.get("thumbnails") or []):
        if t.get("url"):
            return t["url"]
    return info.get("thumbnail", "")


# ───────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
