import importlib
import os

from fastapi.testclient import TestClient


def test_serves_web_dist_when_configured(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("<!doctype html><title>Musical</title>")
    monkeypatch.setenv("WEB_DIST", str(tmp_path))
    monkeypatch.setenv("ANALYZER_WARMUP", "0")
    import app.main as main

    main = importlib.reload(main)
    try:
        with TestClient(main.app) as client:
            assert "Musical" in client.get("/").text
            assert client.get("/api/health").json()["ok"] is True
    finally:
        monkeypatch.delenv("WEB_DIST")
        importlib.reload(main)
        os.environ.pop("WEB_DIST", None)
