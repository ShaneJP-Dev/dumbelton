"""Generate a synthetic multitrack song with a known structure.

The stems are simple synthesised parts (drums, bass, keys, lead, click) at
120 BPM in 4/4. Each section type has its own chord progression and
instrumentation, so structure analysis has something real to find.

Usage:
    python scripts/make_test_song.py OUT_DIR [--sr 44100]

Writes OUT_DIR/{drums,bass,keys,lead,click}.wav and OUT_DIR/structure.json
(the ground truth: bpm, bar length and section boundaries in seconds).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf

BPM = 120.0
BEATS_PER_BAR = 4
BEAT = 60.0 / BPM
BAR = BEAT * BEATS_PER_BAR

# (kind, bars)
FORM = [
    ("intro", 4),
    ("verse", 8),
    ("chorus", 8),
    ("verse", 8),
    ("chorus", 8),
    ("bridge", 4),
    ("chorus", 8),
    ("outro", 4),
]

# One chord per bar, cycling. Chords are lists of MIDI notes.
CHORDS = {
    "Am": [57, 60, 64],
    "F": [53, 57, 60],
    "C": [48, 52, 55, 60],
    "G": [55, 59, 62],
    "Dm": [50, 53, 57],
    "Em": [52, 55, 59],
    "E": [52, 56, 59],
}
PROGRESSIONS = {
    "intro": ["Am", "F", "Am", "F"],
    "verse": ["Am", "F", "C", "G"],
    "chorus": ["C", "G", "Am", "F"],
    "bridge": ["Dm", "Em", "F", "E"],
    "outro": ["C", "C", "F", "C"],
}
# Lead melody (MIDI note per beat, None = rest) for the chorus, one bar per chord.
CHORUS_MELODY = {
    "C": [72, 74, 76, 79],
    "G": [79, 77, 74, 71],
    "Am": [72, 76, 81, 76],
    "F": [77, 76, 72, None],
}


def midi_hz(n: float) -> float:
    return 440.0 * 2 ** ((n - 69) / 12)


def env(n: int, sr: int, attack: float = 0.005, release: float = 0.05) -> np.ndarray:
    e = np.ones(n)
    a = max(1, int(attack * sr))
    r = max(1, min(n - a, int(release * sr)))
    e[:a] = np.linspace(0, 1, a)
    e[n - r :] *= np.linspace(1, 0, r)
    return e


def tone(freq: float, dur: float, sr: int, kind: str = "saw", decay: float = 0.0) -> np.ndarray:
    n = int(dur * sr)
    t = np.arange(n) / sr
    if kind == "sine":
        x = np.sin(2 * np.pi * freq * t)
    elif kind == "square":
        x = np.sign(np.sin(2 * np.pi * freq * t)) * 0.6
    else:  # band-limited-ish saw from a few harmonics
        x = sum(np.sin(2 * np.pi * freq * k * t) / k for k in range(1, 8)) * 0.6
    if decay > 0:
        x *= np.exp(-t / decay)
    return x * env(n, sr)


def kick(sr: int) -> np.ndarray:
    n = int(0.25 * sr)
    t = np.arange(n) / sr
    f = 50 + 100 * np.exp(-t / 0.03)
    return np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t / 0.12)


def snare(sr: int, rng: np.random.Generator) -> np.ndarray:
    n = int(0.2 * sr)
    t = np.arange(n) / sr
    return (rng.standard_normal(n) * 0.6 + np.sin(2 * np.pi * 190 * t) * 0.4) * np.exp(-t / 0.06)


def hat(sr: int, rng: np.random.Generator, length: float = 0.05) -> np.ndarray:
    n = int(length * sr)
    noise = rng.standard_normal(n)
    noise = np.diff(noise, prepend=0)  # crude high-pass
    return noise * np.exp(-np.arange(n) / sr / (length / 4)) * 0.4


def add(buf: np.ndarray, x: np.ndarray, at: float, sr: int, gain: float = 1.0) -> None:
    i = int(round(at * sr))
    j = min(len(buf), i + len(x))
    if j > i:
        buf[i:j] += x[: j - i] * gain


def render(sr: int) -> tuple[dict[str, np.ndarray], list[dict]]:
    rng = np.random.default_rng(7)
    total_bars = sum(b for _, b in FORM)
    n = int(total_bars * BAR * sr) + sr  # one second tail
    stems = {k: np.zeros(n) for k in ("drums", "bass", "keys", "lead", "click")}
    k_s, s_s = kick(sr), snare(sr, rng)
    sections = []
    bar_i = 0
    for kind, bars in FORM:
        start = bar_i * BAR
        sections.append({"kind": kind, "start": start, "end": start + bars * BAR, "bars": bars})
        prog = PROGRESSIONS[kind]
        for b in range(bars):
            t0 = (bar_i + b) * BAR
            chord = prog[b % len(prog)]
            notes = CHORDS[chord]
            # click: every beat, accent on downbeat
            for beat in range(BEATS_PER_BAR):
                f = 1500 if beat == 0 else 1000
                add(stems["click"], tone(f, 0.03, sr, "sine"), t0 + beat * BEAT, sr, 0.5)
            # keys
            keys_gain = {"intro": 0.25, "verse": 0.3, "chorus": 0.45, "bridge": 0.4, "outro": 0.25}[kind]
            if kind == "chorus":
                # stabs on every beat
                for beat in range(BEATS_PER_BAR):
                    for m in notes:
                        add(stems["keys"], tone(midi_hz(m), BEAT * 0.9, sr, "saw"), t0 + beat * BEAT, sr, keys_gain / len(notes))
            elif kind == "bridge":
                # arpeggio, eighth notes
                for e8 in range(8):
                    m = notes[e8 % len(notes)] + 12
                    add(stems["keys"], tone(midi_hz(m), BEAT / 2 * 0.9, sr, "square", decay=0.2), t0 + e8 * BEAT / 2, sr, keys_gain)
            else:
                # sustained pad
                for m in notes:
                    add(stems["keys"], tone(midi_hz(m), BAR * 0.98, sr, "sine"), t0, sr, keys_gain / len(notes) * 2)
            # bass (not in intro/outro)
            root = notes[0] - 24
            if kind in ("verse", "chorus", "bridge"):
                pattern = [0, 2] if kind == "verse" else [0, 1, 2, 3]
                if kind == "bridge":
                    pattern = [0, 1.5, 3]
                for p in pattern:
                    add(stems["bass"], tone(midi_hz(root), BEAT * 0.8, sr, "saw", decay=0.4), t0 + p * BEAT, sr, 0.5)
            # drums
            if kind == "verse":
                add(stems["drums"], k_s, t0, sr, 0.8)
                add(stems["drums"], k_s, t0 + 2 * BEAT, sr, 0.8)
                for e8 in range(8):
                    add(stems["drums"], hat(sr, rng), t0 + e8 * BEAT / 2, sr, 0.3)
            elif kind == "chorus":
                for beat in range(4):
                    add(stems["drums"], k_s, t0 + beat * BEAT, sr, 1.0)
                add(stems["drums"], s_s, t0 + BEAT, sr, 0.8)
                add(stems["drums"], s_s, t0 + 3 * BEAT, sr, 0.8)
                for e8 in range(8):
                    add(stems["drums"], hat(sr, rng, 0.08), t0 + e8 * BEAT / 2, sr, 0.5)
                if b == 0:
                    add(stems["drums"], hat(sr, rng, 1.0), t0, sr, 0.8)  # crash
            elif kind == "bridge":
                add(stems["drums"], k_s, t0, sr, 0.7)
                add(stems["drums"], s_s, t0 + 2 * BEAT, sr, 0.5)
            # lead: chorus only
            if kind == "chorus":
                for beat, m in enumerate(CHORUS_MELODY[chord]):
                    if m is not None:
                        add(stems["lead"], tone(midi_hz(m), BEAT * 0.95, sr, "square"), t0 + beat * BEAT, sr, 0.3)
        bar_i += bars
    # normalise each stem to a sensible peak, and make keys stereo-ish later
    for k, x in stems.items():
        peak = np.max(np.abs(x)) or 1.0
        stems[k] = x / peak * 0.7
    return stems, sections


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--sr", type=int, default=44100)
    args = ap.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    stems, sections = render(args.sr)
    for name, x in stems.items():
        if name == "keys":
            # make keys genuinely stereo (slightly different L/R) to exercise stereo handling
            st = np.stack([x, np.roll(x, int(0.004 * args.sr)) * 0.9], axis=1)
            sf.write(args.out_dir / f"{name}.wav", st, args.sr, subtype="PCM_16")
        else:
            # write as stereo with identical channels to exercise mono detection
            sf.write(args.out_dir / f"{name}.wav", np.stack([x, x], axis=1), args.sr, subtype="PCM_16")
    mix = sum(x for n, x in stems.items() if n != "click")
    mix = mix / (np.max(np.abs(mix)) or 1.0) * 0.8
    sf.write(args.out_dir / "mix.wav", mix, args.sr, subtype="PCM_16")
    truth = {"bpm": BPM, "bar": BAR, "duration": len(mix) / args.sr, "sections": sections}
    (args.out_dir / "structure.json").write_text(json.dumps(truth, indent=2))
    print(f"wrote {len(stems)} stems + mix.wav to {args.out_dir} ({truth['duration']:.1f}s)")


if __name__ == "__main__":
    main()
