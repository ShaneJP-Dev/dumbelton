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


def test_resolve_web_dist(tmp_path):
    from app.main import resolve_web_dist

    built = tmp_path / "dist"
    built.mkdir()
    (built / "index.html").write_text("<!doctype html>")
    missing = tmp_path / "nope"
    # default location used when WEB_DIST is unset, only if it has been built
    assert resolve_web_dist(None, built) == built
    assert resolve_web_dist(None, missing) is None
    assert resolve_web_dist("", built) == built
    # WEB_DIST overrides the default
    assert resolve_web_dist(str(built), missing) == built
    assert resolve_web_dist(str(missing), built) is None
