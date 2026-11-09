"""HTTP API for song structure analysis.

POST /api/jobs        multipart field `audio` (the mix), optional `guide`
                      (the guide track alone: its spoken cues place sections) -> {"id": ...}
GET  /api/jobs/{id}   -> {"id", "status", "progress", "result"?, "error"?}
GET  /api/health      -> {"ok": true, "backend": ..., "speech": {"en": bool, "es": bool}}
POST /api/key         multipart field `audio` -> {"key": {"tonic", "mode", "name", "confidence"} | null}
GET  /api/voice/{lang} -> {"available", "voice"?, "message"?, "kinds"}: spoken cue words
                      made with the computer's voice (see voice.py)
GET  /api/voice/{lang}/{kind}.wav -> one cue word, 48 kHz mono WAV

The built web app (web/dist, from `pnpm build`) is served from the same
process when it exists, so one server on one port runs everything.
WEB_DIST overrides its location.
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .jobs import JobManager
from .key import detect_key
from .pipeline import analyze_file, backend_name, get_backend
from . import voice
from .speech import models_status

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("analyzer")

MAX_UPLOAD_BYTES = int(os.environ.get("ANALYZER_MAX_UPLOAD_MB", "200")) * 1024 * 1024
BACKEND = backend_name()


def _warm_up() -> None:
    """librosa/numba compile on first use (~30 s); do it at boot, not on the first song."""
    try:
        import soundfile as sf

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            path = f.name
        sr = 22050
        t = np.arange(sr * 12) / sr
        clicks = (np.sin(2 * np.pi * 220 * t) * (np.mod(t, 0.5) < 0.05)).astype(np.float32)
        sf.write(path, clicks, sr)
        analyze_file(path, "librosa")
        os.unlink(path)
        log.info("warm-up done")
    except Exception:  # noqa: BLE001
        log.exception("warm-up failed (analysis will still work, first job is slower)")


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_backend(BACKEND)  # fail fast on a bad ANALYZER_BACKEND
    jobs.start()
    if os.environ.get("ANALYZER_WARMUP", "1") == "1":
        threading.Thread(target=_warm_up, daemon=True).start()
    yield
    jobs.shutdown()


jobs = JobManager(lambda path, progress, guide: analyze_file(path, BACKEND, progress, guide))
app = FastAPI(title="musical-app analyzer", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("ANALYZER_CORS_ORIGINS", "*").split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "backend": BACKEND, "speech": models_status()}


async def _save_upload(upload: UploadFile, prefix: str) -> str | None:
    """Write an upload to a temp file; None if it is empty. Raises 413 when too large."""
    suffix = os.path.splitext(upload.filename or "")[1] or ".wav"
    fd, path = tempfile.mkstemp(prefix=prefix, suffix=suffix)
    size = 0
    with os.fdopen(fd, "wb") as out:
        while chunk := await upload.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                out.close()
                os.unlink(path)
                raise HTTPException(413, f"audio larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
            out.write(chunk)
    if size == 0:
        os.unlink(path)
        return None
    return path


@app.post("/api/jobs", status_code=202)
async def create_job(audio: UploadFile = File(...), guide: UploadFile | None = File(None)) -> dict:
    path = await _save_upload(audio, "analyze-")
    if path is None:
        raise HTTPException(400, "empty audio upload")
    try:
        guide_path = await _save_upload(guide, "guide-") if guide is not None else None
    except HTTPException:
        os.unlink(path)
        raise
    job = jobs.submit(path, guide_path)
    return {"id": job.id}


@app.post("/api/key")
async def find_key(audio: UploadFile = File(...)) -> dict:
    """The key of a mix (for songs analysed before keys were detected)."""
    path = await _save_upload(audio, "key-")
    if path is None:
        raise HTTPException(400, "empty audio upload")
    try:
        from starlette.concurrency import run_in_threadpool

        try:
            key = await run_in_threadpool(detect_key, path)
        except ValueError:
            key = None
    finally:
        os.unlink(path)
    return {"key": key}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    return job.to_dict()


@app.get("/api/voice/{lang}")
def api_voice_info(lang: str) -> dict:
    if lang not in voice.WORDS:
        raise HTTPException(404, "unknown language")
    return voice.voice_info(lang)


@app.get("/api/voice/{lang}/{kind}.wav")
def api_voice_clip(lang: str, kind: str) -> FileResponse:
    try:
        path = voice.clip_path(lang, kind)
    except KeyError:
        raise HTTPException(404, "unknown cue word") from None
    except voice.VoiceUnavailable as exc:
        raise HTTPException(503, str(exc)) from None
    return FileResponse(path, media_type="audio/wav")


DEFAULT_WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"


def resolve_web_dist(env_value: str | None, default: Path = DEFAULT_WEB_DIST) -> Path | None:
    """The built web app to serve: WEB_DIST if set, else the repo's web/dist. None if missing."""
    path = Path(env_value) if env_value else default
    return path if (path / "index.html").is_file() else None


_web_dist = resolve_web_dist(os.environ.get("WEB_DIST"))
if _web_dist is not None:
    # mounted last so /api routes win
    app.mount("/", StaticFiles(directory=_web_dist, html=True), name="web")
    log.info("serving the web app from %s", _web_dist)
