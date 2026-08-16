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
import tempfile
import atexit
import httpx
import yt_dlp
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

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


def _cobalt_youtube(url: str, quality: str = "1080") -> list:
    """Formatos de YouTube (video muxeado + audio mp3) vía cobalt."""
    out = []
    v = _cobalt({"url": url, "downloadMode": "auto", "videoQuality": quality})
    if v:
        out.append({
            "quality":    f"MP4 · {quality}p",
            "stream_url": v["url"],
            "ext":        "mp4",
            "type":       "video",
            "filename":   v.get("filename", ""),
        })
    a = _cobalt({"url": url, "downloadMode": "audio", "audioFormat": "mp3"})
    if a:
        out.append({
            "quality":    "MP3 Audio",
            "stream_url": a["url"],
            "ext":        "mp3",
            "type":       "audio",
            "filename":   a.get("filename", ""),
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
    } for f in data.get("formats", []) if f.get("stream_url")]

    if not videos:
        raise HTTPException(422, "No se encontró contenido descargable.")

    return {
        "title":       data.get("title", ""),
        "thumbnail":   data.get("thumbnail", ""),
        "platform":    service,
        "downloadUrl": videos[0]["url"],
        "videos":      videos,
    }


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
    result    = []

    # ── Video por calidad ──────────────────────────────────────────────────
    for h in _YT_HEIGHTS:
        # Progresivo (video + audio) primero
        prog = [
            f for f in formats
            if f.get("height") == h
            and f.get("ext") == "mp4"
            and f.get("acodec") not in (None, "none")
            and f.get("vcodec") not in (None, "none")
            and f.get("url")
        ]
        # Video-only como alternativa
        vonly = [
            f for f in formats
            if f.get("height") == h
            and f.get("ext") == "mp4"
            and f.get("vcodec") not in (None, "none")
            and f.get("url")
        ] if not prog else []

        chosen = prog or vonly
        if chosen:
            chosen.sort(key=lambda f: f.get("filesize") or f.get("filesize_approx") or 0, reverse=True)
            f = chosen[0]
            result.append({
                "quality":    _YT_LABELS.get(h, f"{h}p") + ("" if prog else " (sin audio)"),
                "stream_url": f["url"],
                "ext":        "mp4",
                "type":       "video",
                "muxed":      bool(prog),
                "height":     h,
            })

    # ── Audio ──────────────────────────────────────────────────────────────
    audio = [
        f for f in formats
        if f.get("vcodec") in (None, "none")
        and f.get("acodec") not in (None, "none")
        and f.get("url")
    ]
    if audio:
        audio.sort(key=lambda f: f.get("abr") or 0, reverse=True)
        a = audio[0]
        result.append({
            "quality":    "MP3 Audio",
            "stream_url": a["url"],
            "ext":        a.get("ext", "m4a"),
            "type":       "audio",
        })

    # ── Cobalt manda ───────────────────────────────────────────────────────
    # Lo muxeado que da yt-dlp rara vez pasa de 360p, y sus URLs de googlevideo
    # llevan ?ip=<IP del servidor>: el navegador del usuario recibe 403 al
    # abrirlas. Cobalt entrega HD con audio por un túnel que sí funciona desde
    # cualquier IP, así que cuando responde se descarta el resto — mostrar
    # botones que van a fallar es peor que no mostrarlos.
    # Solo se conserva lo de yt-dlp si ya trae un progresivo de 720p o más
    # (que casi nunca pasa) o si cobalt no respondió.
    has_hd_muxed = any(f.get("muxed") and (f.get("height") or 0) >= 720 for f in result)
    if not has_hd_muxed:
        cobalt_fmts = _cobalt_youtube(url)
        result = cobalt_fmts if cobalt_fmts else result

    if not result:
        raise HTTPException(status_code=422, detail="No se encontraron formatos de descarga.")

    for f in result:
        f.pop("muxed", None)
        f.pop("height", None)
    return {"title": title, "thumbnail": thumbnail, "formats": result}


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
