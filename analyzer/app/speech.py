"""Read the spoken cues on a guide track with Vosk (offline speech recognition).

Small models (about 40 MB each) for English and Spanish live in
analyzer/models/ (or VOSK_MODELS_DIR). They download on first use, or ahead
of time with:

    uv run --directory analyzer python -m app.speech download      (pnpm models)

Other commands, handy for checking a guide track by hand:

    python -m app.speech status
    python -m app.speech transcribe guide.wav

The recogniser is limited to section words (see cues.grammar), and only the
parts of the guide that have sound are decoded, so a song takes seconds.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import ssl
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

import numpy as np

from .cues import Cue, Word, cues_from_words, grammar, score

log = logging.getLogger("analyzer.speech")

SR = 16000
MODELS = {
    "en": ("vosk-model-small-en-us-0.15", "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"),
    "es": ("vosk-model-small-es-0.42", "https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip"),
}
LANG_NAMES = {"en": "English", "es": "Spanish"}
DEFAULT_MODELS_DIR = Path(__file__).resolve().parents[1] / "models"
RETRY_DOWNLOAD_AFTER = 600.0  # seconds: don't retry a failed download on every song

_lock = threading.Lock()
_failed_at: dict[str, float] = {}


class SpeechUnavailable(Exception):
    """Speech recognition can't run (vosk missing, or no model downloaded)."""


def models_dir() -> Path:
    return Path(os.environ.get("VOSK_MODELS_DIR") or DEFAULT_MODELS_DIR)


def model_path(lang: str) -> Path | None:
    p = models_dir() / MODELS[lang][0]
    return p if (p / "conf").is_dir() or (p / "am").is_dir() else None


def models_status() -> dict[str, bool]:
    return {lang: model_path(lang) is not None for lang in MODELS}


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001
        return ssl.create_default_context()


def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> None:
    root = dest.resolve()
    for m in zf.infolist():
        target = (dest / m.filename).resolve()
        if target != root and root not in target.parents:
            raise ValueError(f"unsafe path in model zip: {m.filename}")
    zf.extractall(dest)


def download_model(lang: str, report: Callable[[str], None] | None = None) -> Path:
    """Download and unpack one model into models_dir(). Returns its folder."""
    name, url = MODELS[lang]
    out = models_dir()
    out.mkdir(parents=True, exist_ok=True)
    say = report or (lambda m: log.info(m))
    say(f"Downloading the {LANG_NAMES[lang]} speech model ({name}) from {url}")
    with tempfile.TemporaryDirectory(dir=out, prefix=".download-") as tmp:
        zpath = Path(tmp) / f"{name}.zip"
        with urllib.request.urlopen(url, context=_ssl_context(), timeout=30) as r, open(zpath, "wb") as f:
            shutil.copyfileobj(r, f, 1 << 20)
        unpack = Path(tmp) / "unpacked"
        with zipfile.ZipFile(zpath) as zf:
            _safe_extract(zf, unpack)
        inner = unpack / name
        if not inner.is_dir():
            dirs = [d for d in unpack.iterdir() if d.is_dir()]
            if len(dirs) != 1:
                raise ValueError("unexpected model zip layout")
            inner = dirs[0]
        final = out / name
        if final.exists():
            shutil.rmtree(final)
        inner.rename(final)
    say(f"Saved {final}")
    return final


def ensure_models(download: bool | None = None) -> dict[str, Path]:
    """Models ready to use, downloading missing ones when allowed. Raises SpeechUnavailable if none."""
    try:
        import vosk  # noqa: F401
    except ImportError as exc:
        raise SpeechUnavailable("the speech recogniser (vosk) is not installed: run `uv sync` in the analyzer folder") from exc
    if download is None:
        download = os.environ.get("ANALYZER_SPEECH_DOWNLOAD", "1") != "0"
    found: dict[str, Path] = {}
    errors: list[str] = []
    with _lock:
        for lang in MODELS:
            p = model_path(lang)
            recently_failed = time.time() - _failed_at.get(lang, -1e9) < RETRY_DOWNLOAD_AFTER
            if p is None and download and not recently_failed:
                try:
                    p = download_model(lang)
                except Exception as exc:  # noqa: BLE001 - offline, blocked, disk full...
                    _failed_at[lang] = time.time()
                    errors.append(f"{LANG_NAMES[lang]}: {exc}")
                    log.warning("could not download the %s speech model: %s", lang, exc)
            if p is not None:
                found[lang] = p
    if not found:
        detail = f" ({'; '.join(errors)})" if errors else ""
        raise SpeechUnavailable(
            "speech models aren't downloaded yet. Run `pnpm models` once with internet" + detail
        )
    return found


def speech_regions(
    y: np.ndarray,
    sr: int = SR,
    frame: float = 0.02,
    rel_db: float = -40.0,
    floor: float = 1e-4,
    min_gap: float = 0.5,
    pad: float = 0.25,
    min_len: float = 0.1,
) -> list[tuple[float, float]]:
    """(start, end) seconds of the parts with sound. A guide track is mostly silence."""
    hop = max(1, int(sr * frame))
    n = len(y) // hop
    if n == 0:
        return []
    rms = np.sqrt(np.mean(np.square(y[: n * hop].reshape(n, hop), dtype=np.float64), axis=1))
    peak = float(rms.max())
    if peak < floor:
        return []
    active = rms > max(peak * 10 ** (rel_db / 20), floor)
    runs: list[list[float]] = []
    i = 0
    while i < n:
        if active[i]:
            j = i
            while j < n and active[j]:
                j += 1
            if runs and i * frame - runs[-1][1] < min_gap:
                runs[-1][1] = j * frame
            else:
                runs.append([i * frame, j * frame])
            i = j
        else:
            i += 1
    dur = len(y) / sr
    out: list[tuple[float, float]] = []
    for s, e in runs:
        if e - s < min_len:
            continue
        s, e = max(0.0, s - pad), min(dur, e + pad)
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], e)
        else:
            out.append((s, e))
    return out


class Recognizer(Protocol):
    """The part of vosk.KaldiRecognizer used here."""

    def SetWords(self, on: bool) -> None: ...  # noqa: N802
    def AcceptWaveform(self, data: bytes) -> bool: ...  # noqa: N802
    def Result(self) -> str: ...  # noqa: N802
    def FinalResult(self) -> str: ...  # noqa: N802


# (lang, model folder) -> function making a fresh recogniser for a grammar
RecognizerFactory = Callable[[str, Path], Callable[[str], Recognizer]]


def vosk_factory(lang: str, path: Path) -> Callable[[str], Recognizer]:
    import vosk

    vosk.SetLogLevel(-1)
    model = vosk.Model(str(path))
    return lambda grammar_json: vosk.KaldiRecognizer(model, SR, grammar_json)


def _words(result_json: str, offset: float) -> list[Word]:
    res = json.loads(result_json or "{}")
    return [
        Word(w["word"], float(w["start"]) + offset, float(w["end"]) + offset, float(w.get("conf", 1.0)))
        for w in res.get("result", [])
        if w.get("word") and w["word"] != "[unk]"
    ]


def recognize(y: np.ndarray, regions: list[tuple[float, float]], make: Callable[[str], Recognizer], lang: str) -> list[Word]:
    """Words (with times in the whole track) spoken in `regions` of 16 kHz mono audio."""
    g = json.dumps(grammar(lang), ensure_ascii=False)
    pcm = (np.clip(y, -1.0, 1.0) * 32767).astype("<i2")
    words: list[Word] = []
    step = 4000  # samples per call (0.25 s)
    for s, e in regions:
        rec = make(g)  # a fresh recogniser per region: its word times start at the region
        rec.SetWords(True)
        chunk = pcm[int(s * SR) : int(e * SR)]
        for k in range(0, len(chunk), step):
            if rec.AcceptWaveform(chunk[k : k + step].tobytes()):
                words += _words(rec.Result(), s)
        words += _words(rec.FinalResult(), s)
    return words


@dataclass
class Transcript:
    language: str
    words: list[Word]
    cues: list[Cue]
    scores: dict[str, float] = field(default_factory=dict)


def load_16k(path: str) -> np.ndarray:
    import librosa

    y, _ = librosa.load(path, sr=SR, mono=True)
    return y.astype(np.float32)


def transcribe(path: str, models: dict[str, Path], factory: RecognizerFactory = vosk_factory) -> Transcript:
    """Transcribe a guide track in each available language and keep the one with the most convincing cues."""
    y = load_16k(path)
    regions = speech_regions(y)
    best: Transcript | None = None
    scores: dict[str, float] = {}
    for lang in ("en", "es"):  # English first: it wins ties
        if lang not in models:
            continue
        words = recognize(y, regions, factory(lang, models[lang]), lang)
        cues = cues_from_words(words)
        scores[lang] = round(score(cues), 3)
        if best is None or scores[lang] > scores[best.language]:
            best = Transcript(lang, words, cues)
    if best is None:
        raise SpeechUnavailable("no speech model")
    best.scores = scores
    return best


def read_guide(path: str, transcriber: Callable[[str, dict[str, Path]], Transcript] | None = None) -> dict:
    """Cues on a guide track, as the job result's `guide` block. Never raises."""
    if os.environ.get("ANALYZER_SPEECH", "1") == "0":
        return {"status": "off", "message": "guide transcription is turned off (ANALYZER_SPEECH=0)", "cues": []}
    try:
        models = ensure_models()
    except SpeechUnavailable as exc:
        return {"status": "unavailable", "message": str(exc), "cues": []}
    try:
        t = (transcriber or transcribe)(path, models)
    except Exception as exc:  # noqa: BLE001 - the audio analysis still stands
        log.exception("guide transcription failed")
        return {"status": "error", "message": f"{type(exc).__name__}: {exc}", "cues": []}
    return {
        "status": "ok" if len(t.cues) >= 2 else "few-cues",
        "language": t.language,
        "cues": t.cues,
        "words": len(t.words),
        "scores": t.scores,
    }


def _main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    cmd = argv[0] if argv else "status"
    if cmd == "download":
        failed = False
        for lang in MODELS:
            if model_path(lang):
                print(f"{LANG_NAMES[lang]}: already downloaded ({model_path(lang)})")
                continue
            try:
                download_model(lang, print)
            except Exception as exc:  # noqa: BLE001
                failed = True
                print(f"{LANG_NAMES[lang]}: download failed: {exc}")
                print(f"  You can also download {MODELS[lang][1]} yourself and unzip it into {models_dir()}")
        return 1 if failed else 0
    if cmd == "status":
        for lang, ok in models_status().items():
            print(f"{LANG_NAMES[lang]}: {'ready' if ok else 'not downloaded'} ({models_dir() / MODELS[lang][0]})")
        return 0
    if cmd == "transcribe" and len(argv) > 1:
        t = transcribe(argv[1], ensure_models())
        print(f"language: {LANG_NAMES[t.language]} (scores {t.scores})")
        for w in t.words:
            print(f"  {w.start:7.2f}s  {w.word:<14} conf {w.conf:.2f}")
        print("cues:")
        for c in t.cues:
            print(f"  {c.time:7.2f}s  {c.kind:<11} ({c.word})")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
