import os
import time

os.environ["ANALYZER_WARMUP"] = "0"
os.environ["ANALYZER_BACKEND"] = "librosa"

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def _run_job(client: TestClient, path) -> dict:
    with open(path, "rb") as f:
        r = client.post("/api/jobs", files={"audio": ("mix.wav", f, "audio/wav")})
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
        assert client.get("/api/health").json() == {"ok": True, "backend": "librosa"}


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
