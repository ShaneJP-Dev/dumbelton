"""Run a backend and the shared post-processing on one audio file."""

from __future__ import annotations

import os
from typing import Callable

import librosa
import numpy as np

from .postprocess import postprocess
from .types import RawAnalysis

ONSET_SR = 22050
ONSET_HOP = 128  # ~5.8 ms resolution for boundary refinement


def backend_name() -> str:
    return os.environ.get("ANALYZER_BACKEND", "librosa").strip().lower()


def get_backend(name: str | None = None) -> Callable[[str], RawAnalysis]:
    name = name or backend_name()
    if name == "librosa":
        from .backends import librosa_backend

        return librosa_backend.analyze
    if name == "allin1":
        from .backends import allin1_backend

        return allin1_backend.analyze
    raise ValueError(f"unknown ANALYZER_BACKEND {name!r} (expected 'librosa' or 'allin1')")


def detect_onsets(path: str) -> np.ndarray:
    y, sr = librosa.load(path, sr=ONSET_SR, mono=True)
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=ONSET_HOP)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=ONSET_HOP, units="frames")
    return librosa.frames_to_time(frames, sr=sr, hop_length=ONSET_HOP)


def analyze_file(path: str, backend: str | None = None, progress: Callable[[float], None] | None = None) -> dict:
    report = progress or (lambda _p: None)
    report(0.05)
    raw = get_backend(backend)(path)
    report(0.85)
    onsets = detect_onsets(path)
    report(0.95)
    return postprocess(raw, onsets)
