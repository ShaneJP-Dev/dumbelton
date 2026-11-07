import os
import time

os.environ["ANALYZER_WARMUP"] = "0"
os.environ["ANALYZER_BACKEND"] = "librosa"

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def _run_job(client: TestClient, path, guide=None) -> dict:
    files = {"audio": ("mix.wav", open(path, "rb"), "audio/wav")}
    if guide is not None:
        files["guide"] = ("guide.wav", open(guide, "rb"), "audio/wav")
    try:
        r = client.post("/api/jobs", files=files)
    finally:
        for _, f, _ in files.values():
            f.close()
    assert r.status_code == 202, r.text
    job_id = r.json()["id"]
    deadline = time.time() + 240
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.5)
    raise AssertionError("analysis timed out")


def test_health():
    with TestClient(app) as client:
        h = client.get("/api/health").json()
        assert h["ok"] is True and h["backend"] == "librosa"
        assert set(h["speech"]) == {"en", "es"}


def test_unknown_job_404():
    with TestClient(app) as client:
        assert client.get("/api/jobs/nope").status_code == 404


def test_empty_upload_rejected():
    with TestClient(app) as client:
        r = client.post("/api/jobs", files={"audio": ("x.wav", b"", "audio/wav")})
        assert r.status_code == 400


import pytest  # noqa: E402


@pytest.mark.parametrize("mix", ["reference", "browser"])
def test_synthetic_song_structure(mix, synthetic_song, browser_mix, truth):
    path = synthetic_song / "mix.wav" if mix == "reference" else browser_mix
    with TestClient(app) as client:
        job = _run_job(client, path)
    assert job["status"] == "done", job.get("error")
    res = job["result"]
    assert abs(res["bpm"] - truth["bpm"]) < 1.0
    got = res["sections"]
    want = truth["sections"]
    assert [s["label"] for s in got] == [s["kind"] for s in want]
    for g, w in zip(got, want):
        # within a quarter of a bar: boundaries must land on the right downbeat
        assert abs(g["start"] - w["start"]) <= truth["bar"] / 4, (g, w)
    assert [s["name"] for s in got][:3] == ["Intro", "Verse 1", "Chorus 1"]
    # boundaries sit exactly on reported downbeats
    for s in got[1:]:
        assert s["start"] in res["downbeats"]


def _guide_for(truth: dict, path) -> None:
    """A guide track for the synthetic song: one tone burst ("word") per cue, as the browser sends it (48 kHz)."""
    import numpy as np
    import soundfile as sf

    from tests.test_speech import guide_audio

    freq = {"verse": 400, "chorus": 500, "bridge": 600, "outro": 700}
    bar, beat = truth["bar"], truth["bar"] / 4
    events = []
    for i, s in enumerate(truth["sections"][1:]):
        # the cue on beat 1 of the bar before (a touch late), or on its beat 4
        t = s["start"] - bar + 0.03 if i % 2 == 0 else s["start"] - beat
        events.append((t, freq[s["kind"]]))
        if i % 2 == 0:
            events.append((t + 2 * beat, 900))  # "three": a count, not a cue
    y = guide_audio(events, truth["duration"], sr=48000)
    sf.write(path, np.clip(y, -1, 1), 48000, subtype="PCM_16")


def test_guide_cues_place_the_sections(synthetic_song, browser_mix, truth, tmp_path, monkeypatch):
    from pathlib import Path

    from app import speech
    from tests.test_speech import fake_factory

    real_transcribe = speech.transcribe
    monkeypatch.setattr(speech, "ensure_models", lambda download=None: {"en": Path("en"), "es": Path("es")})
    monkeypatch.setattr(speech, "transcribe", lambda p, m: real_transcribe(p, m, fake_factory({"en": 0.9, "es": 0.6})))
    guide = tmp_path / "guide.wav"
    _guide_for(truth, guide)
    with TestClient(app) as client:
        job = _run_job(client, browser_mix, guide)
    assert job["status"] == "done", job.get("error")
    res = job["result"]
    assert res["sectionsFrom"] == "guide"
    assert res["guide"]["status"] == "ok" and res["guide"]["language"] == "en"
    assert [c["kind"] for c in res["guide"]["cues"]] == [s["kind"] for s in truth["sections"][1:]]
    got, want = res["sections"], truth["sections"]
    assert [s["label"] for s in got] == [s["kind"] for s in want]
    for g, w in zip(got, want):
        assert abs(g["start"] - w["start"]) <= truth["bar"] / 4, (g, w)
    assert [s["name"] for s in got][:3] == ["Intro", "Verse 1", "Chorus 1"]


def test_guide_without_speech_models_falls_back_to_the_audio(synthetic_song, browser_mix, truth, tmp_path, monkeypatch):
    monkeypatch.setenv("VOSK_MODELS_DIR", str(tmp_path / "no-models"))
    monkeypatch.setenv("ANALYZER_SPEECH_DOWNLOAD", "0")
    guide = tmp_path / "guide.wav"
    _guide_for(truth, guide)
    with TestClient(app) as client:
        job = _run_job(client, browser_mix, guide)
    assert job["status"] == "done", job.get("error")
    res = job["result"]
    assert res["sectionsFrom"] == "audio"
    assert res["guide"]["status"] == "unavailable"
    assert [s["label"] for s in res["sections"]] == [s["kind"] for s in truth["sections"]]
