"""Shared clean-up applied to every backend's raw output.

Steps (in order):
1. Refine beats/downbeats to the nearest onset (within 30 ms), minus 3 ms, so
   cuts land just before the transient instead of on it.
2. Normalise labels and drop allin1's `start`/`end` silence segments by merging
   them into their neighbours, so sections cover the whole song [0, duration].
3. Snap internal section boundaries to the nearest downbeat.
4. Merge sections shorter than 2 bars into a neighbour.
5. Number repeated labels ("Verse 1", "Verse 2").
"""

from __future__ import annotations

from collections import Counter

import numpy as np

from .types import RawAnalysis, RawSection, Section

KINDS = ("intro", "verse", "pre-chorus", "chorus", "bridge", "solo", "inst", "break", "outro")

DISPLAY = {
    "intro": "Intro",
    "verse": "Verse",
    "pre-chorus": "Pre-Chorus",
    "chorus": "Chorus",
    "bridge": "Bridge",
    "solo": "Solo",
    "inst": "Instrumental",
    "break": "Break",
    "outro": "Outro",
}

_ALIASES = {
    "start": None,
    "end": None,
    "silence": None,
    "prechorus": "pre-chorus",
    "pre_chorus": "pre-chorus",
    "instrumental": "inst",
}

ONSET_WINDOW = 0.03
PRE_ROLL = 0.003
MIN_BARS = 2


def normalize_label(label: str) -> str | None:
    lab = label.strip().lower()
    if lab in _ALIASES:
        return _ALIASES[lab]
    if lab in KINDS:
        return lab
    return "inst"


def refine_to_onsets(
    times: list[float], onsets: np.ndarray | None, window: float = ONSET_WINDOW, pre: float = PRE_ROLL
) -> list[float]:
    """Move each time to (nearest onset within `window`) - `pre`. Times with no nearby onset are kept."""
    if onsets is None or len(onsets) == 0 or len(times) == 0:
        return [float(t) for t in times]
    onsets = np.sort(np.asarray(onsets, dtype=float))
    out: list[float] = []
    for t in times:
        i = int(np.searchsorted(onsets, t))
        best = None
        for j in (i - 1, i):
            if 0 <= j < len(onsets):
                d = abs(onsets[j] - t)
                if d <= window and (best is None or d < abs(best - t)):
                    best = onsets[j]
        out.append(float(max(0.0, best - pre)) if best is not None else float(t))
    # keep strictly increasing
    for k in range(1, len(out)):
        if out[k] <= out[k - 1]:
            out[k] = out[k - 1] + 1e-3
    return out


def drop_silence(sections: list[RawSection], duration: float) -> list[RawSection]:
    """Normalise labels; merge unlabelled (start/end/silence) segments into neighbours."""
    secs = sorted(sections, key=lambda s: s.start)
    kept: list[RawSection] = []
    pending_start: float | None = None
    for s in secs:
        lab = normalize_label(s.label)
        if lab is None:
            if kept:
                kept[-1].end = max(kept[-1].end, s.end)
            elif pending_start is None:
                pending_start = s.start
            continue
        start = pending_start if pending_start is not None else s.start
        pending_start = None
        kept.append(RawSection(start, s.end, lab))
    if not kept:
        return [RawSection(0.0, duration, "inst")]
    # make contiguous and cover [0, duration]
    kept[0].start = 0.0
    for a, b in zip(kept, kept[1:]):
        a.end = b.start
    kept[-1].end = duration
    return kept


def bar_length(downbeats: list[float], default: float = 2.0) -> float:
    if len(downbeats) < 2:
        return default
    return float(np.median(np.diff(downbeats)))


def snap_to_downbeats(sections: list[RawSection], downbeats: list[float]) -> list[RawSection]:
    if len(downbeats) == 0 or len(sections) < 2:
        return sections
    db = np.asarray(downbeats, dtype=float)
    out = [RawSection(s.start, s.end, s.label) for s in sections]
    for a, b in zip(out, out[1:]):
        t = b.start
        snapped = float(db[np.argmin(np.abs(db - t))])
        a.end = b.start = snapped
    # drop sections that collapsed to zero (or negative) length
    cleaned: list[RawSection] = []
    for s in out:
        if s.end - s.start <= 1e-6:
            continue
        if cleaned and abs(cleaned[-1].end - s.start) > 1e-6:
            s.start = cleaned[-1].end
        cleaned.append(s)
    if cleaned:
        cleaned[0].start = sections[0].start
        cleaned[-1].end = sections[-1].end
    return cleaned


def merge_short(sections: list[RawSection], min_len: float) -> list[RawSection]:
    secs = [RawSection(s.start, s.end, s.label) for s in sections]
    changed = True
    while changed and len(secs) > 1:
        changed = False
        for i, s in enumerate(secs):
            if s.end - s.start < min_len - 1e-6:
                if i == 0:
                    secs[1].start = s.start
                else:
                    secs[i - 1].end = s.end
                del secs[i]
                changed = True
                break
    return secs


def name_sections(sections: list[RawSection]) -> list[Section]:
    totals = Counter(s.label for s in sections)
    seen: Counter[str] = Counter()
    out = []
    for s in sections:
        seen[s.label] += 1
        base = DISPLAY.get(s.label, s.label.title())
        name = f"{base} {seen[s.label]}" if totals[s.label] > 1 else base
        out.append(Section(round(s.start, 4), round(s.end, 4), s.label, name))
    return out


def postprocess(raw: RawAnalysis, onsets: np.ndarray | None = None) -> dict:
    beats = refine_to_onsets(raw.beats, onsets)
    downbeats = refine_to_onsets(raw.downbeats, onsets)
    secs = drop_silence(raw.sections, raw.duration)
    secs = snap_to_downbeats(secs, downbeats)
    secs = merge_short(secs, MIN_BARS * bar_length(downbeats))
    named = name_sections(secs)
    return {
        "backend": raw.backend,
        "duration": round(raw.duration, 4),
        "bpm": round(float(raw.bpm), 2),
        "beats": [round(t, 4) for t in beats],
        "downbeats": [round(t, 4) for t in downbeats],
        "sections": [s.to_dict() for s in named],
    }
