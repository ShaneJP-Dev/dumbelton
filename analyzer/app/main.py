"""HTTP API for song structure analysis.

POST /api/jobs        multipart field `audio` -> {"id": ...}
GET  /api/jobs/{id}   -> {"id", "status", "progress", "result"?, "error"?}
GET  /api/health      -> {"ok": true, "backend": ...}
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .jobs import JobManager
from .pipeline import analyze_file, backend_name, get_backend

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


jobs = JobManager(lambda path, progress: analyze_file(path, BACKEND, progress))
app = FastAPI(title="musical-app analyzer", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("ANALYZER_CORS_ORIGINS", "*").split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "backend": BACKEND}


@app.post("/api/jobs", status_code=202)
async def create_job(audio: UploadFile = File(...)) -> dict:
    suffix = os.path.splitext(audio.filename or "")[1] or ".wav"
    fd, path = tempfile.mkstemp(prefix="analyze-", suffix=suffix)
    size = 0
    with os.fdopen(fd, "wb") as out:
        while chunk := await audio.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                out.close()
                os.unlink(path)
                raise HTTPException(413, f"audio larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
            out.write(chunk)
    if size == 0:
        os.unlink(path)
        raise HTTPException(400, "empty audio upload")
    job = jobs.submit(path)
    return {"id": job.id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    return job.to_dict()
