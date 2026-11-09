"""Estimate a song's key from its audio.

The average pitch-class profile (chroma) of the mix is compared with the
Krumhansl-Kessler key profiles in all 24 keys; the best correlation wins.
Good enough as a first guess (the app lets you correct it); the usual
mistake is a closely related key, such as the relative minor.
"""

from __future__ import annotations

import numpy as np

SR = 22050
HOP = 4096  # ~0.19 s: plenty for a whole-song average, and fast

MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]


def key_from_chroma(chroma: np.ndarray) -> dict:
    """Best key for a 12-bin pitch-class profile (C first)."""
    c = np.asarray(chroma, dtype=float)
    if c.shape != (12,) or not np.any(c > 0):
        raise ValueError("no pitched content")
    scores = []
    for mode, profile in (("major", MAJOR), ("minor", MINOR)):
        for tonic in range(12):
            r = float(np.corrcoef(c, np.roll(profile, tonic))[0, 1])
            scores.append((r, tonic, mode))
    scores.sort(reverse=True)
    best, second = scores[0], scores[1]
    return {
        "tonic": best[1],
        "mode": best[2],
        "name": NAMES[best[1]] + ("m" if best[2] == "minor" else ""),
        # how clearly the best key beat the runner-up (0 = a toss-up)
        "confidence": round(max(0.0, best[0] - second[0]), 3),
    }


def detect_key(path: str) -> dict:
    import librosa

    y, sr = librosa.load(path, sr=SR, mono=True)
    if len(y) == 0 or float(np.max(np.abs(y))) < 1e-4:
        raise ValueError("silent audio")
    # harmonic part only: drums smear the pitch profile
    y = librosa.effects.harmonic(y, margin=2.0)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
    return key_from_chroma(chroma.mean(axis=1))
