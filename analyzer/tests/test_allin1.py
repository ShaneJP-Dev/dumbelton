import pytest

pytestmark = pytest.mark.slow


def test_allin1_on_synthetic_song(synthetic_song, truth):
    from app.pipeline import analyze_file

    res = analyze_file(str(synthetic_song / "mix.wav"), "allin1")
    assert res["backend"] == "allin1"
    assert len(res["sections"]) >= 4
    assert abs(res["bpm"] - truth["bpm"]) < 2.0
    boundaries = [s["start"] for s in res["sections"][1:]]
    true_boundaries = [s["start"] for s in truth["sections"][1:]]
    hits = sum(any(abs(b - t) <= truth["bar"] for b in boundaries) for t in true_boundaries)
    assert hits >= len(true_boundaries) - 2
