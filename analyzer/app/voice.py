"""Spoken cue words ("Chorus", "Bridge"...) made with the computer's own voice.

The Live screen can say the name of the next part a bar before it starts.
The words are synthesised once, offline, with whatever voice the operating
system has:

- Windows: System.Speech (the voices in Settings > Time & language > Speech)
- macOS:   the `say` command
- Linux:   espeak-ng / espeak, if installed

Each word is trimmed, normalised and cached as a 48 kHz mono 16-bit WAV in
analyzer/voice-cache/<lang>/<voice>/<kind>.wav (VOICE_CACHE_DIR overrides).
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

import numpy as np

log = logging.getLogger("analyzer.voice")

SR = 48000
# section kind -> word, per language (kinds as in the web app's sections)
WORDS = {
    "en": {
        "intro": "Intro",
        "verse": "Verse",
        "pre-chorus": "Pre-chorus",
        "chorus": "Chorus",
        "bridge": "Bridge",
        "interlude": "Interlude",
        "tag": "Tag",
        "vamp": "Vamp",
        "solo": "Solo",
        "inst": "Instrumental",
        "break": "Break",
        "outro": "Outro",
    },
    "es": {
        "intro": "Intro",
        "verse": "Verso",
        "pre-chorus": "Pre coro",
        "chorus": "Coro",
        "bridge": "Puente",
        "interlude": "Interludio",
        "tag": "Tag",
        "vamp": "Vamp",
        "solo": "Solo",
        "inst": "Instrumental",
        "break": "Pausa",
        "outro": "Final",
    },
}
LANG_NAMES = {"en": "English", "es": "Spanish"}
DEFAULT_CACHE = Path(__file__).resolve().parents[1] / "voice-cache"
_lock = threading.Lock()


class VoiceUnavailable(Exception):
    """No voice on this computer for that language."""


class Synth(Protocol):
    name: str
    # file extension the voice writes (macOS `say` needs .aiff unless given a data format)
    ext: str

    def speak_many(self, items: list[tuple[str, Path]]) -> None:
        """Write each text to its file (any format soundfile reads)."""
        ...


def cache_dir() -> Path:
    return Path(os.environ.get("VOICE_CACHE_DIR") or DEFAULT_CACHE)


def _run(cmd: list[str], timeout: float = 120) -> str:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, creationflags=flags)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {(r.stderr or r.stdout).strip()[:300]}")
    return r.stdout


# ---------------------------------------------------------------- Windows


def _ps_quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def windows_list_cmd() -> list[str]:
    script = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "$s.GetInstalledVoices() | Where-Object { $_.Enabled } | "
        "ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }"
    )
    return ["powershell", "-NoProfile", "-NonInteractive", "-Command", script]


def windows_speak_cmd(voice: str, items: list[tuple[str, Path]]) -> list[str]:
    lines = [
        "Add-Type -AssemblyName System.Speech",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        f"$s.SelectVoice({_ps_quote(voice)})",
    ]
    for text, path in items:
        lines += [f"$s.SetOutputToWaveFile({_ps_quote(str(path))})", f"$s.Speak({_ps_quote(text)})"]
    lines += ["$s.SetOutputToNull()", "$s.Dispose()"]
    return ["powershell", "-NoProfile", "-NonInteractive", "-Command", "; ".join(lines)]


def parse_windows_voices(out: str) -> list[tuple[str, str]]:
    """(name, culture like 'en-US') per line 'Microsoft Zira Desktop|en-US'."""
    voices = []
    for line in out.splitlines():
        if "|" in line:
            name, culture = line.rsplit("|", 1)
            if name.strip():
                voices.append((name.strip(), culture.strip()))
    return voices


@dataclass
class WindowsSynth:
    name: str
    ext: str = ".wav"

    def speak_many(self, items: list[tuple[str, Path]]) -> None:
        _run(windows_speak_cmd(self.name, items))


# ---------------------------------------------------------------- macOS


def mac_speak_cmd(voice: str, text: str, path: Path) -> list[str]:
    return ["say", "-v", voice, "-o", str(path), text]


_MAC_LINE = re.compile(r"^(?P<name>.+?)\s+(?P<locale>[a-z]{2,3}[_-][A-Za-z0-9]+)\s+#")


def parse_mac_voices(out: str) -> list[tuple[str, str]]:
    """(name, locale like 'en_US') per line of `say -v '?'`."""
    voices = []
    for line in out.splitlines():
        m = _MAC_LINE.match(line.strip())
        if m:
            voices.append((m.group("name").strip(), m.group("locale").replace("-", "_")))
    return voices


@dataclass
class MacSynth:
    name: str
    ext: str = ".aiff"

    def speak_many(self, items: list[tuple[str, Path]]) -> None:
        for text, path in items:
            _run(mac_speak_cmd(self.name, text, path), timeout=30)


# ---------------------------------------------------------------- espeak


def espeak_cmd(binary: str, lang: str, text: str, path: Path) -> list[str]:
    return [binary, "-v", lang, "-s", "150", "-w", str(path), text]


@dataclass
class EspeakSynth:
    name: str
    binary: str
    lang: str
    ext: str = ".wav"

    def speak_many(self, items: list[tuple[str, Path]]) -> None:
        for text, path in items:
            _run(espeak_cmd(self.binary, self.lang, text, path), timeout=30)


# ---------------------------------------------------------------- choosing a voice

PREFERRED = {"en": ("Samantha", "Microsoft Zira", "Microsoft Aria", "Microsoft David"), "es": ("Paulina", "Monica", "Mónica", "Microsoft Sabina", "Microsoft Helena")}


def pick_voice(voices: list[tuple[str, str]], lang: str) -> str | None:
    """A voice for `lang` from (name, locale) pairs: a preferred one, then US/MX English/Spanish, then any."""
    mine = [(n, loc) for n, loc in voices if loc.lower().replace("-", "_").startswith(lang + "_")]
    if not mine:
        return None
    for pref in PREFERRED.get(lang, ()):
        for n, _ in mine:
            if n.startswith(pref):
                return n
    regional = {"en": ("en_us",), "es": ("es_mx", "es_us", "es_es")}.get(lang, ())
    for region in regional:
        for n, loc in mine:
            if loc.lower().replace("-", "_") == region:
                return n
    return mine[0][0]


_synths: dict[str, Synth | None] = {}


def find_synth(lang: str) -> Synth | None:
    """The computer's voice for `lang`, or None. Looked up once per run."""
    if lang in _synths:
        return _synths[lang]
    synth: Synth | None = None
    try:
        if sys.platform == "win32":
            name = pick_voice(parse_windows_voices(_run(windows_list_cmd(), timeout=60)), lang)
            synth = WindowsSynth(name) if name else None
        elif sys.platform == "darwin":
            name = pick_voice(parse_mac_voices(_run(["say", "-v", "?"], timeout=30)), lang)
            synth = MacSynth(name) if name else None
        else:
            binary = shutil.which("espeak-ng") or shutil.which("espeak")
            synth = EspeakSynth(f"espeak ({lang})", binary, lang) if binary else None
    except Exception as exc:  # noqa: BLE001 - no voice is not an error worth failing for
        log.warning("could not list voices: %s", exc)
    _synths[lang] = synth
    return synth


# ---------------------------------------------------------------- clips


def clean(y: np.ndarray, sr: int) -> np.ndarray:
    """Mono 48 kHz, silence trimmed, peak at -3 dBFS, 5 ms fades."""
    import librosa

    y = np.asarray(y, dtype=np.float32)
    if y.ndim > 1:
        y = y.mean(axis=1)
    if sr != SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    if len(y) and np.max(np.abs(y)) > 0:
        y, _ = librosa.effects.trim(y, top_db=45)
        y = y * (10 ** (-3 / 20) / np.max(np.abs(y)))
    fade = min(240, len(y) // 2)
    if fade:
        ramp = np.linspace(0, 1, fade, dtype=np.float32)
        y[:fade] *= ramp
        y[-fade:] *= ramp[::-1]
    return y.astype(np.float32)


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower() or "voice"


def clips_dir(lang: str, synth: Synth) -> Path:
    return cache_dir() / lang / _slug(synth.name)


def ensure_clips(lang: str, finder: Callable[[str], Synth | None] | None = None) -> tuple[Synth, Path]:
    """Make (once) every cue word for `lang`. Returns the voice and the folder of WAVs."""
    import soundfile as sf

    if lang not in WORDS:
        raise VoiceUnavailable(f"no cue words for language {lang!r}")
    synth = (finder or find_synth)(lang)
    if synth is None:
        raise VoiceUnavailable(f"this computer has no {LANG_NAMES[lang]} voice for spoken cues")
    out = clips_dir(lang, synth)
    with _lock:
        missing = [(kind, word) for kind, word in WORDS[lang].items() if not (out / f"{kind}.wav").is_file()]
        if missing:
            out.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=out, prefix=".tts-") as tmp:
                ext = getattr(synth, "ext", ".wav")
                raw = [(word, Path(tmp) / f"{kind}.raw{ext}") for kind, word in missing]
                synth.speak_many(raw)
                for (kind, _), (_, path) in zip(missing, raw):
                    y, sr = sf.read(path, dtype="float32", always_2d=False)
                    sf.write(out / f"{kind}.wav", clean(y, sr), SR, subtype="PCM_16")
            log.info("made %d %s cue words with %s", len(missing), lang, synth.name)
    return synth, out


def voice_info(lang: str, finder: Callable[[str], Synth | None] | None = None) -> dict:
    try:
        synth, _ = ensure_clips(lang, finder)
    except VoiceUnavailable as exc:
        return {"available": False, "message": str(exc), "kinds": []}
    except Exception as exc:  # noqa: BLE001 - e.g. the voice crashed
        log.exception("making cue words failed")
        return {"available": False, "message": f"the {LANG_NAMES.get(lang, lang)} voice failed: {exc}", "kinds": []}
    return {"available": True, "voice": synth.name, "kinds": list(WORDS[lang])}


def clip_path(lang: str, kind: str, finder: Callable[[str], Synth | None] | None = None) -> Path:
    if lang not in WORDS or kind not in WORDS[lang]:
        raise KeyError(kind)
    _, folder = ensure_clips(lang, finder)
    return folder / f"{kind}.wav"
