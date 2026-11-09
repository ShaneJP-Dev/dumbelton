import os

import numpy as np
import pytest
import soundfile as sf

os.environ["ANALYZER_WARMUP"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

from app.key import detect_key, key_from_chroma  # noqa: E402
from app.main import app  # noqa: E402

SR = 22050


def chords_wav(path, chords: list[list[int]], seconds_each=1.5):
    """Organ-like triads (MIDI notes) with a bass note, one after another."""
    out = []
    for notes in chords:
        t = np.arange(int(seconds_each * SR)) / SR
        y = sum(0.2 * np.sin(2 * np.pi * 440 * 2 ** ((n - 69) / 12) * t) for n in notes + [notes[0] - 12])
        out.append(y * np.minimum(1, np.minimum(t / 0.02, (seconds_each - t) / 0.05)))
    sf.write(path, np.concatenate(out * 3).astype(np.float32), SR)


G, C, D = [67, 71, 74], [60, 64, 67], [62, 66, 69]
EM, AM, B = [64, 67, 71], [57, 60, 64], [59, 63, 66]


def test_a_major_progression(tmp_path):
    p = tmp_path / "g.wav"
    chords_wav(p, [G, C, D, G])
    k = detect_key(str(p))
    assert (k["name"], k["tonic"], k["mode"]) == ("G", 7, "major")
    assert k["confidence"] > 0


def test_a_minor_progression(tmp_path):
    p = tmp_path / "em.wav"
    chords_wav(p, [EM, AM, B, EM])
    assert detect_key(str(p))["name"] == "Em"


def test_flat_keys_are_named_as_musicians_write_them():
    profile = np.roll(np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]), 10)
    assert key_from_chroma(profile)["name"] == "Bb"


def test_silence_has_no_key(tmp_path):
    p = tmp_path / "s.wav"
    sf.write(p, np.zeros(SR), SR)
    with pytest.raises(ValueError):
        detect_key(str(p))


def test_api_finds_the_key(tmp_path):
    p = tmp_path / "g.wav"
    chords_wav(p, [G, C, D, G])
    with TestClient(app) as client, open(p, "rb") as f:
        r = client.post("/api/key", files={"audio": ("mix.wav", f, "audio/wav")})
        assert r.status_code == 200
        assert r.json()["key"]["name"] == "G"
        s = tmp_path / "s.wav"
        sf.write(s, np.zeros(SR), SR)
        with open(s, "rb") as f2:
            assert client.post("/api/key", files={"audio": ("mix.wav", f2, "audio/wav")}).json() == {"key": None}
