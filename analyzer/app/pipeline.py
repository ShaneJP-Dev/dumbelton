"""Run a backend and the shared post-processing on one audio file."""

from __future__ import annotations

import os
from typing import Callable

import librosa
import numpy as np

from .key import detect_key
from .postprocess import postprocess
from .speech import read_guide
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


def analyze_file(
    path: str,
    backend: str | None = None,
    progress: Callable[[float], None] | None = None,
    guide_path: str | None = None,
    transcriber=None,
) -> dict:
    """Analyse a mix. With `guide_path` (the guide track alone), its spoken cues place the sections."""
    report = progress or (lambda _p: None)
    report(0.05)
    raw = get_backend(backend)(path)
    report(0.7 if guide_path else 0.85)
    guide = read_guide(guide_path, transcriber) if guide_path else None
    report(0.9)
    onsets = detect_onsets(path)
    report(0.95)
    cues = guide["cues"] if guide and guide["status"] == "ok" else None
    result = postprocess(raw, onsets, cues)
    try:
        result["key"] = detect_key(path)
    except Exception:  # noqa: BLE001 - a song with no clear pitch still gets its sections
        result["key"] = None
    if guide is not None:
        if guide["status"] == "ok" and result["sectionsFrom"] != "guide":
            guide["status"] = "few-cues"
        guide["cues"] = [c.to_dict() for c in guide["cues"]]
        result["guide"] = guide
    return result
