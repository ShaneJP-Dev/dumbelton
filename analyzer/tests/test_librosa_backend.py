from app.backends.librosa_backend import _merge_alternating, fill_beat_grid, label_segments


def test_fill_beat_grid_extends_head_tail_and_gaps():
    tracked = [8.0 + 0.5 * i for i in range(20)]  # 8.0 .. 17.5
    del tracked[10:13]  # a gap of 4 intervals
    grid = fill_beat_grid(tracked, duration=20.0)
    assert abs(grid[0] - 0.0) < 1e-6
    assert all(abs(b - a - 0.5) < 1e-6 for a, b in zip(grid, grid[1:]))
    assert grid[-1] >= 19.5 - 1e-6


def test_merge_alternating_joins_chorus_halves():
    # [start_beat, end_beat, cluster, bars]
    runs = [[0, 16, 9, 4], [16, 48, 1, 8], [48, 56, 0, 2], [56, 64, 2, 2], [64, 72, 0, 2], [72, 80, 2, 2],
            [80, 112, 1, 8], [112, 120, 0, 2], [120, 128, 2, 2], [128, 136, 0, 2], [136, 144, 2, 2]]
    out = _merge_alternating(runs)
    assert [r[2] for r in out] == [9, 1, 0, 1, 0]
    assert out[2][0] == 48 and out[2][1] == 80 and out[2][3] == 8


def test_merge_alternating_keeps_long_verse_chorus_alternation():
    runs = [[0, 32, 1, 8], [32, 64, 0, 8], [64, 96, 1, 8], [96, 128, 0, 8]]
    assert [r[2] for r in _merge_alternating(runs)] == [1, 0, 1, 0]


def test_label_segments_typical_song():
    # intro, verse, chorus, verse, chorus, bridge, chorus, outro (outro shares the intro's cluster)
    clusters = [3, 1, 0, 1, 0, 4, 0, 3]
    energy = [0.1, 0.3, 0.8, 0.3, 0.8, 0.5, 0.8, 0.1]
    dur = [8, 16, 16, 16, 16, 8, 16, 8]
    assert label_segments(clusters, energy, dur) == [
        "intro", "verse", "chorus", "verse", "chorus", "bridge", "chorus", "outro",
    ]


def test_label_segments_pre_chorus():
    clusters = [1, 2, 0, 1, 2, 0]
    energy = [0.3, 0.4, 0.9, 0.3, 0.4, 0.9]
    assert label_segments(clusters, energy, [8] * 6) == ["verse", "pre-chorus", "chorus", "verse", "pre-chorus", "chorus"]
