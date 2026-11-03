"""All-In-One music structure analyzer (Kim & Nam, 2023), github.com/mir-aidj/all-in-one.

Gives labelled sections, beats and downbeats in one model pass. It separates
the mix with HTDemucs first, so expect 1-3 minutes per song on CPU.

Requires the `allin1` extra (see Dockerfile): torch, natten (built for that
torch version), madmom from git, allin1.
"""

from __future__ import annotations

import tempfile

from ..types import RawAnalysis, RawSection


def analyze(path: str) -> RawAnalysis:
    import allin1  # heavy import, only when this backend is used
    import soundfile as sf

    duration = float(sf.info(path).duration)
    with tempfile.TemporaryDirectory(prefix="allin1-") as tmp:
        result = allin1.analyze(
            path,
            demix_dir=f"{tmp}/demix",
            spec_dir=f"{tmp}/spec",
            keep_byproducts=False,
            multiprocess=False,
        )
    if isinstance(result, list):
        result = result[0]
    sections = [RawSection(float(s.start), float(s.end), str(s.label)) for s in result.segments]
    return RawAnalysis(
        duration=duration,
        bpm=float(result.bpm or 0.0),
        beats=[float(t) for t in result.beats],
        downbeats=[float(t) for t in result.downbeats],
        sections=sections,
        backend="allin1",
    )
