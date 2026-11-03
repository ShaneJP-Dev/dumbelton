"""In-memory job queue. One worker thread: analysis is CPU-heavy and models are large."""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

log = logging.getLogger("analyzer.jobs")


@dataclass
class Job:
    id: str
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    result: dict | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        d = {"id": self.id, "status": self.status, "progress": round(self.progress, 3)}
        if self.result is not None:
            d["result"] = self.result
        if self.error is not None:
            d["error"] = self.error
        return d


class JobManager:
    def __init__(self, run: Callable[[str, Callable[[float], None]], dict], max_jobs: int = 100):
        self._run = run
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._pool: ThreadPoolExecutor | None = None
        self._max_jobs = max_jobs

    def start(self) -> None:
        if self._pool is None:
            self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="analyze")

    def submit(self, audio_path: str) -> Job:
        job = Job(id=uuid.uuid4().hex)
        with self._lock:
            self._jobs[job.id] = job
            self._prune()
        self.start()
        assert self._pool is not None
        self._pool.submit(self._work, job, audio_path)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def _work(self, job: Job, audio_path: str) -> None:
        job.status = "running"

        def progress(p: float) -> None:
            job.progress = max(job.progress, min(1.0, p))

        try:
            job.result = self._run(audio_path, progress)
            job.progress = 1.0
            job.status = "done"
        except Exception as exc:  # noqa: BLE001 - report any failure to the client
            log.exception("analysis failed")
            job.error = f"{type(exc).__name__}: {exc}"
            job.status = "error"
        finally:
            try:
                os.unlink(audio_path)
            except OSError:
                pass

    def _prune(self) -> None:
        if len(self._jobs) <= self._max_jobs:
            return
        finished = sorted(
            (j for j in self._jobs.values() if j.status in ("done", "error")), key=lambda j: j.created
        )
        for j in finished[: len(self._jobs) - self._max_jobs]:
            del self._jobs[j.id]

    def shutdown(self) -> None:
        if self._pool is not None:
            self._pool.shutdown(wait=False, cancel_futures=True)
            self._pool = None
