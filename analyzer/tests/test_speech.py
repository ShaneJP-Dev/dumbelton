"""Speech plumbing, with a fake recogniser standing in for Vosk.

The fake "hears" a word from the pitch of a tone: guide audio for the tests is
made of short tone bursts, one per spoken word.
"""

import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app import speech
from app.speech import SR, Transcript, read_guide, recognize, speech_regions, transcribe

# pitch (Hz) -> word, per language
TONES = {
    "en": {400: "verse", 500: "chorus", 600: "bridge", 700: "ending", 900: "three"},
    "es": {400: "verso", 500: "coro", 600: "puente", 700: "final", 900: "tres"},
}


def burst(freq: float, dur: float = 0.4, sr: int = SR) -> np.ndarray:
    t = np.arange(int(dur * sr)) / sr
    return (0.5 * np.sin(2 * np.pi * freq * t) * np.hanning(len(t))).astype(np.float32)


def guide_audio(events: list[tuple[float, float]], duration: float, sr: int = SR) -> np.ndarray:
    y = np.zeros(int(duration * sr), dtype=np.float32)
    for t, f in events:
        b = burst(f, sr=sr)
        i = int(t * sr)
        y[i : i + len(b)] += b
    return y


class FakeRecognizer:
    def __init__(self, lang: str, conf: float):
        self.lang = lang
        self.conf = conf
        self.buf: list[np.ndarray] = []
        self.words = False

    def SetWords(self, on):  # noqa: N802
        self.words = on

    def AcceptWaveform(self, data):  # noqa: N802
        self.buf.append(np.frombuffer(data, dtype="<i2").astype(np.float32) / 32767)
        return False

    def Result(self):  # noqa: N802
        return "{}"

    def FinalResult(self):  # noqa: N802
        y = np.concatenate(self.buf) if self.buf else np.zeros(0, np.float32)
        loud = np.flatnonzero(np.abs(y) > 0.05)
        if len(loud) == 0:
            return json.dumps({"text": ""})
        seg = y[loud[0] : loud[-1] + 1]
        spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
        freq = np.fft.rfftfreq(len(seg), 1 / SR)[np.argmax(spec)]
        tone = min(TONES[self.lang], key=lambda f: abs(f - freq))
        word = TONES[self.lang][tone] if abs(tone - freq) < 30 else "[unk]"
        start = loud[0] / SR
        return json.dumps({"result": [{"word": word, "start": start, "end": loud[-1] / SR, "conf": self.conf}], "text": word})


def fake_factory(conf: dict[str, float]):
    def factory(lang, _path):
        return lambda grammar_json: (json.loads(grammar_json), FakeRecognizer(lang, conf[lang]))[1]

    return factory


def test_speech_regions_finds_bursts_and_skips_silence():
    y = guide_audio([(1.0, 400), (5.0, 500), (5.6, 900), (12.0, 600)], 15.0)
    regions = speech_regions(y)
    assert len(regions) == 3  # 5.0 and 5.6 are less than half a second apart: one region
    (a0, a1), (b0, b1), (c0, c1) = regions
    assert a0 == pytest.approx(0.75, abs=0.05) and a1 == pytest.approx(1.65, abs=0.05)
    assert b0 == pytest.approx(4.75, abs=0.05) and b1 == pytest.approx(6.25, abs=0.05)
    assert c0 == pytest.approx(11.75, abs=0.05)


def test_speech_regions_of_silence_is_empty():
    assert speech_regions(np.zeros(SR * 3, np.float32)) == []
    assert speech_regions(np.zeros(0, np.float32)) == []


def test_recognize_reports_times_in_the_whole_track():
    y = guide_audio([(3.0, 400), (9.0, 500)], 12.0)
    make = fake_factory({"en": 0.9})("en", Path("x"))
    words = recognize(y, speech_regions(y), make, "en")
    assert [w.word for w in words] == ["verse", "chorus"]
    assert words[0].start == pytest.approx(3.0, abs=0.05)
    assert words[1].start == pytest.approx(9.0, abs=0.05)


def _wav(tmp_path: Path, y: np.ndarray, sr: int = SR) -> str:
    p = tmp_path / "guide.wav"
    sf.write(p, y, sr, subtype="PCM_16")
    return str(p)


def test_transcribe_picks_the_language_with_better_cues(tmp_path):
    path = _wav(tmp_path, guide_audio([(1.0, 400), (4.0, 900), (8.0, 500)], 12.0))
    models = {"en": Path("en"), "es": Path("es")}
    t = transcribe(path, models, fake_factory({"en": 0.6, "es": 0.9}))
    assert t.language == "es"
    assert [c.kind for c in t.cues] == ["verse", "chorus"]  # "tres" is a count, not a cue
    assert t.scores == {"en": 1.2, "es": 1.8}
    # a tie goes to English
    assert transcribe(path, models, fake_factory({"en": 0.9, "es": 0.9})).language == "en"
    # only the English model available
    assert transcribe(path, {"en": Path("en")}, fake_factory({"en": 0.9})).language == "en"


def test_read_guide_without_models_is_unavailable(tmp_path, monkeypatch):
    monkeypatch.setenv("VOSK_MODELS_DIR", str(tmp_path / "none"))
    monkeypatch.setenv("ANALYZER_SPEECH_DOWNLOAD", "0")
    res = read_guide(_wav(tmp_path, guide_audio([(1.0, 400)], 3.0)))
    assert res["status"] == "unavailable"
    assert "pnpm models" in res["message"]


def test_read_guide_reports_transcriber_errors(tmp_path, monkeypatch):
    monkeypatch.setattr(speech, "ensure_models", lambda download=None: {"en": Path("en")})

    def boom(_path, _models):
        raise RuntimeError("bad model")

    res = read_guide("x.wav", boom)
    assert res["status"] == "error" and "bad model" in res["message"]


def test_read_guide_ok_and_few_cues(monkeypatch):
    from app.cues import Cue

    monkeypatch.setattr(speech, "ensure_models", lambda download=None: {"en": Path("en")})
    two = [Cue(1, 1.4, "verse", "verse", 1), Cue(9, 9.4, "chorus", "chorus", 1)]
    assert read_guide("x", lambda p, m: Transcript("en", [], two))["status"] == "ok"
    assert read_guide("x", lambda p, m: Transcript("en", [], two[:1]))["status"] == "few-cues"


def test_read_guide_can_be_turned_off(monkeypatch):
    monkeypatch.setenv("ANALYZER_SPEECH", "0")
    assert read_guide("x")["status"] == "off"


def test_download_unpacks_a_model_and_rejects_unsafe_zips(tmp_path, monkeypatch):
    monkeypatch.setenv("VOSK_MODELS_DIR", str(tmp_path))
    name = speech.MODELS["en"][0]

    def zip_bytes(entries: dict[str, bytes]) -> bytes:
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z:
            for n, data in entries.items():
                z.writestr(n, data)
        return b.getvalue()

    payload = {"data": zip_bytes({f"{name}/conf/model.conf": b"x", f"{name}/am/final.mdl": b"y"})}
    monkeypatch.setattr(speech.urllib.request, "urlopen", lambda url, context=None, timeout=None: io.BytesIO(payload["data"]))
    assert speech.model_path("en") is None
    p = speech.download_model("en", lambda _m: None)
    assert p == tmp_path / name and speech.model_path("en") == p
    assert (p / "am" / "final.mdl").read_bytes() == b"y"

    payload["data"] = zip_bytes({"../evil.txt": b"x"})
    with pytest.raises(ValueError):
        speech.download_model("es", lambda _m: None)
    assert not (tmp_path.parent / "evil.txt").exists()


def test_failed_download_is_not_retried_on_every_song(tmp_path, monkeypatch):
    monkeypatch.setenv("VOSK_MODELS_DIR", str(tmp_path))
    monkeypatch.setattr(speech, "_failed_at", {})
    calls = []

    def offline(lang, report=None):
        calls.append(lang)
        raise OSError("no internet")

    monkeypatch.setattr(speech, "download_model", offline)
    for _ in range(3):
        with pytest.raises(speech.SpeechUnavailable):
            speech.ensure_models(download=True)
    assert calls == ["en", "es"]


@pytest.mark.skipif(not speech.models_status()["en"], reason="English Vosk model not downloaded (pnpm models)")
def test_real_vosk_model_loads_with_the_cue_grammar():
    make = speech.vosk_factory("en", speech.model_path("en"))
    y = np.zeros(SR * 2, np.float32)
    assert recognize(y, [(0.0, 2.0)], make, "en") == []
