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
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

app = FastAPI(title="NEXO yt-dlp Server", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "OPTIONS"],
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

# ─── Cookies de Instagram (base64 de un cookies.txt de Netscape) ───────────
# Render env var: IG_COOKIES_B64
_IG_COOKIES_FILE: str | None = None

def _init_cookies():
    global _IG_COOKIES_FILE
    b64 = os.environ.get("IG_COOKIES_B64", "").strip()
    if not b64:
        return
    try:
        content = base64.b64decode(b64).decode("utf-8")
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False, prefix="ig_cookies_"
        )
        tmp.write(content)
        tmp.flush()
        tmp.close()
        _IG_COOKIES_FILE = tmp.name
        print(f"[cookies] Instagram cookies cargadas desde IG_COOKIES_B64 → {tmp.name}")
    except Exception as e:
        print(f"[cookies] Error al cargar IG_COOKIES_B64: {e}")

_init_cookies()

def _cleanup():
    if _IG_COOKIES_FILE and os.path.exists(_IG_COOKIES_FILE):
        os.unlink(_IG_COOKIES_FILE)

atexit.register(_cleanup)

# ───────────────────────────────────────────────────────────────────────────
# HEALTH / WARM-UP
# ───────────────────────────────────────────────────────────────────────────
@app.get("/")
@app.get("/health")
def health():
    return {"status": "ok", "engine": "yt-dlp"}


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
# YOUTUBE
# ───────────────────────────────────────────────────────────────────────────
_YT_HEIGHTS  = [2160, 1440, 1080, 720, 480, 360]
_YT_LABELS   = {2160: "4K 2160p", 1440: "1440p 2K", 1080: "1080p",
                720: "720p", 480: "480p", 360: "360p"}

def _yt_info(url: str) -> dict:
    opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    info = _extract(url, opts)

    title     = info.get("title", "Video de YouTube")
    thumbnail = _best_thumb(info)
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
                "quality":    _YT_LABELS.get(h, f"{h}p"),
                "stream_url": f["url"],
                "ext":        "mp4",
                "type":       "video",
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

    if not result:
        raise HTTPException(status_code=422, detail="No se encontraron formatos de descarga.")

    return {"title": title, "thumbnail": thumbnail, "formats": result}


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
