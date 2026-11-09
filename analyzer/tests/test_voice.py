"""Spoken cue words. A fake voice (a tone per word) stands in for the computer's voice."""

import os
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

os.environ["ANALYZER_WARMUP"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

from app import voice  # noqa: E402
from app.main import app  # noqa: E402


class FakeSynth:
    def __init__(self, name="Fake Voice", ext=".wav"):
        self.name = name
        self.ext = ext
        self.calls: list[list[str]] = []

    def speak_many(self, items):
        self.calls.append([t for t, _ in items])
        for text, path in items:
            sr = 22050
            t = np.arange(int(0.4 * sr)) / sr
            y = 0.2 * np.sin(2 * np.pi * (200 + 10 * len(text)) * t)
            # silence around the word, as real voices produce
            y = np.concatenate([np.zeros(sr // 5), y, np.zeros(sr // 5)]).astype(np.float32)
            assert path.suffix == self.ext
            sf.write(path, y, sr)


@pytest.fixture
def fake(tmp_path, monkeypatch):
    monkeypatch.setenv("VOICE_CACHE_DIR", str(tmp_path / "cache"))
    synth = FakeSynth()
    monkeypatch.setattr(voice, "find_synth", lambda lang: synth if lang == "en" else None)
    return synth


def test_clips_are_made_once_trimmed_and_normalised(fake):
    synth, folder = voice.ensure_clips("en")
    assert synth is fake
    assert sorted(p.stem for p in folder.glob("*.wav")) == sorted(voice.WORDS["en"])
    assert fake.calls == [list(voice.WORDS["en"].values())]  # all words in one go
    y, sr = sf.read(folder / "chorus.wav")
    assert sr == 48000 and y.ndim == 1
    assert len(y) < 0.5 * 48000  # the silence around the word is trimmed
    assert np.max(np.abs(y)) == pytest.approx(10 ** (-3 / 20), abs=0.01)
    assert abs(y[0]) < 0.01 and abs(y[-1]) < 0.01  # faded
    voice.ensure_clips("en")
    assert len(fake.calls) == 1  # cached


def test_a_new_voice_gets_its_own_cache(fake, monkeypatch):
    voice.ensure_clips("en")
    other = FakeSynth("Other Voice")
    monkeypatch.setattr(voice, "find_synth", lambda lang: other)
    _, folder = voice.ensure_clips("en")
    assert folder.name == "other-voice" and len(other.calls) == 1


def test_a_voice_writing_aiff_like_macos_say(tmp_path, monkeypatch):
    monkeypatch.setenv("VOICE_CACHE_DIR", str(tmp_path))
    mac_like = FakeSynth("Samantha", ext=".aiff")
    monkeypatch.setattr(voice, "find_synth", lambda lang: mac_like)
    _, folder = voice.ensure_clips("en")
    y, sr = sf.read(folder / "bridge.wav")
    assert sr == 48000 and len(y) > 0
    assert voice.MacSynth("Samantha").ext == ".aiff"


def test_voice_info_when_there_is_no_voice(fake):
    info = voice.voice_info("es")
    assert info["available"] is False and "Spanish voice" in info["message"]
    assert voice.voice_info("en") == {"available": True, "voice": "Fake Voice", "kinds": list(voice.WORDS["en"])}


def test_api_serves_cue_words(fake):
    with TestClient(app) as client:
        assert client.get("/api/voice/en").json()["available"] is True
        r = client.get("/api/voice/en/pre-chorus.wav")
        assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
        assert r.content[:4] == b"RIFF"
        assert client.get("/api/voice/en/nonsense.wav").status_code == 404
        assert client.get("/api/voice/fr").status_code == 404
        assert client.get("/api/voice/es").json()["available"] is False
        assert client.get("/api/voice/es/chorus.wav").status_code == 503


def test_windows_command_quotes_safely():
    cmd = voice.windows_speak_cmd("Microsoft Zira Desktop", [("Pre-chorus", Path("C:/x/it's.wav"))])
    assert cmd[:2] == ["powershell", "-NoProfile"]
    script = cmd[-1]
    assert "SelectVoice('Microsoft Zira Desktop')" in script
    assert "SetOutputToWaveFile('C:/x/it''s.wav')" in script or "SetOutputToWaveFile('C:\\x\\it''s.wav')" in script
    assert "Speak('Pre-chorus')" in script


def test_parse_and_pick_voices():
    win = "Microsoft David Desktop|en-US\nMicrosoft Zira Desktop|en-US\nMicrosoft Sabina Desktop|es-MX\n"
    wv = voice.parse_windows_voices(win)
    assert voice.pick_voice(wv, "en") == "Microsoft Zira Desktop"
    assert voice.pick_voice(wv, "es") == "Microsoft Sabina Desktop"
    assert voice.pick_voice(wv[:2], "es") is None
    mac = (
        "Alex                en_US    # Most people recognize me by my voice.\n"
        "Eddy (English (UK)) en_GB    # Hello! My name is Eddy.\n"
        "Paulina             es_MX    # Hola, me llamo Paulina.\n"
        "Samantha            en_US    # Hello, my name is Samantha.\n"
    )
    mv = voice.parse_mac_voices(mac)
    assert ("Eddy (English (UK))", "en_GB") in mv
    assert voice.pick_voice(mv, "en") == "Samantha"
    assert voice.pick_voice(mv, "es") == "Paulina"
    assert voice.mac_speak_cmd("Samantha", "Chorus", Path("/t/c.aiff")) == ["say", "-v", "Samantha", "-o", "/t/c.aiff", "Chorus"]
    assert voice.espeak_cmd("espeak-ng", "es", "Coro", Path("/t/c.wav"))[-3:] == ["-w", "/t/c.wav", "Coro"]


@pytest.mark.skipif(voice.find_synth("en") is None, reason="no system voice on this computer")
def test_real_voice_makes_a_word(tmp_path, monkeypatch):
    monkeypatch.setenv("VOICE_CACHE_DIR", str(tmp_path))
    _, folder = voice.ensure_clips("en")
    y, sr = sf.read(folder / "chorus.wav")
    assert sr == 48000 and 0.15 * sr < len(y) < 2 * sr
