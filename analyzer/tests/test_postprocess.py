import numpy as np

from app.postprocess import (
    drop_silence,
    merge_short,
    name_sections,
    normalize_label,
    postprocess,
    refine_to_onsets,
    snap_to_downbeats,
)
from app.types import RawAnalysis, RawSection


def test_normalize_label():
    assert normalize_label("Chorus") == "chorus"
    assert normalize_label("start") is None
    assert normalize_label("end") is None
    assert normalize_label("prechorus") == "pre-chorus"
    assert normalize_label("weird") == "inst"


def test_refine_to_onsets_moves_only_nearby_times():
    onsets = np.array([1.010, 2.5, 3.0])
    out = refine_to_onsets([1.0, 2.0, 3.02], onsets)
    assert abs(out[0] - (1.010 - 0.003)) < 1e-9  # within 30 ms -> onset minus 3 ms
    assert out[1] == 2.0  # nearest onset 500 ms away -> unchanged
    assert abs(out[2] - 2.997) < 1e-9


def test_refine_without_onsets_is_identity():
    assert refine_to_onsets([0.5, 1.0], None) == [0.5, 1.0]


def test_drop_silence_merges_start_and_end():
    secs = [
        RawSection(0.0, 1.2, "start"),
        RawSection(1.2, 10.0, "intro"),
        RawSection(10.0, 30.0, "chorus"),
        RawSection(30.0, 33.0, "end"),
    ]
    out = drop_silence(secs, 33.0)
    assert [(s.start, s.end, s.label) for s in out] == [(0.0, 10.0, "intro"), (10.0, 33.0, "chorus")]


def test_drop_silence_all_silence_gives_one_section():
    out = drop_silence([RawSection(0, 5, "start"), RawSection(5, 9, "end")], 9.0)
    assert len(out) == 1 and out[0].start == 0 and out[0].end == 9.0


def test_snap_to_downbeats():
    secs = [RawSection(0, 7.9, "intro"), RawSection(7.9, 16.3, "verse"), RawSection(16.3, 20, "chorus")]
    out = snap_to_downbeats(secs, [0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0, 18.0])
    assert [(s.start, s.end) for s in out] == [(0, 8.0), (8.0, 16.0), (16.0, 20)]


def test_snap_drops_collapsed_sections():
    secs = [RawSection(0, 8.1, "intro"), RawSection(8.1, 8.6, "inst"), RawSection(8.6, 20, "verse")]
    out = snap_to_downbeats(secs, [0.0, 4.0, 8.0, 12.0, 16.0])
    assert [s.label for s in out] == ["intro", "verse"]
    assert out[0].end == out[1].start == 8.0


def test_merge_short():
    secs = [RawSection(0, 1, "intro"), RawSection(1, 9, "verse"), RawSection(9, 10, "inst"), RawSection(10, 20, "chorus")]
    out = merge_short(secs, 4.0)
    assert [(s.start, s.end, s.label) for s in out] == [(0, 10, "verse"), (10, 20, "chorus")]


def test_name_sections_numbers_repeats_only():
    named = name_sections([RawSection(0, 1, "verse"), RawSection(1, 2, "chorus"), RawSection(2, 3, "verse")])
    assert [s.name for s in named] == ["Verse 1", "Chorus", "Verse 2"]


def test_postprocess_end_to_end():
    downbeats = [float(t) for t in range(0, 40, 2)]
    raw = RawAnalysis(
        duration=40.0,
        bpm=120.0,
        beats=[t / 2 for t in range(80)],
        downbeats=downbeats,
        sections=[
            RawSection(0, 0.4, "start"),
            RawSection(0.4, 8.1, "intro"),
            RawSection(8.1, 23.9, "chorus"),
            RawSection(23.9, 24.5, "verse"),  # too short -> merged
            RawSection(24.5, 38, "chorus"),
            RawSection(38, 40, "end"),
        ],
        backend="test",
    )
    res = postprocess(raw, onsets=None)
    assert res["backend"] == "test"
    assert [s["name"] for s in res["sections"]] == ["Intro", "Chorus 1", "Chorus 2"]
    assert res["sections"][0]["start"] == 0.0 and res["sections"][-1]["end"] == 40.0
    for a, b in zip(res["sections"], res["sections"][1:]):
        assert a["end"] == b["start"]
        assert b["start"] in downbeats
