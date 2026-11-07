from app.cues import Cue, Word, cues_from_words, grammar, score, sections_from_cues
from app.postprocess import postprocess
from app.types import RawAnalysis, RawSection

BEAT = 0.5
BAR = 2.0
DOWNBEATS = [i * BAR for i in range(0, 40)]  # 120 bpm, 80 s


def cue(t: float, kind: str, conf: float = 1.0) -> Cue:
    return Cue(t, t + 0.4, kind, kind, conf)


def test_grammar_has_section_words_numbers_and_unk():
    en = grammar("en")
    assert {"verse", "chorus", "bridge", "interlude", "pre chorus", "one", "four", "[unk]"} <= set(en)
    assert en[-1] == "[unk]"
    es = grammar("es")
    assert {"verso", "coro", "puente", "pre coro", "uno", "cuatro", "[unk]"} <= set(es)


def test_cues_from_words_english():
    words = [
        Word("verse", 1.0, 1.4, 0.95),
        Word("two", 1.5, 1.7),
        Word("three", 2.0, 2.2),
        Word("four", 2.5, 2.7),
        Word("pre", 10.0, 10.2, 0.9),
        Word("chorus", 10.25, 10.7, 0.8),
        Word("chorus", 20.0, 20.4, 0.3),  # too unsure
        Word("ending", 30.0, 30.4),
    ]
    got = cues_from_words(words)
    assert [(c.kind, c.time) for c in got] == [("verse", 1.0), ("pre-chorus", 10.0), ("outro", 30.0)]
    assert got[1].word == "pre chorus" and got[1].conf == 0.8


def test_cues_from_words_spanish():
    words = [Word("verso", 1.0, 1.3), Word("uno", 1.5, 1.7), Word("coro", 5.0, 5.3), Word("puente", 9.0, 9.4), Word("final", 12.0, 12.3)]
    assert [c.kind for c in cues_from_words(words)] == ["verse", "chorus", "bridge", "outro"]
    assert [c.kind for c in cues_from_words([Word("pre", 1.0, 1.2), Word("coro", 1.3, 1.6)])] == ["pre-chorus"]


def test_pre_alone_or_far_from_chorus_is_not_a_cue():
    words = [Word("pre", 1.0, 1.2), Word("chorus", 3.0, 3.4)]
    assert [c.kind for c in cues_from_words(words)] == ["chorus"]


def test_score_sums_confidence():
    assert score([cue(0, "verse", 0.5), cue(4, "chorus", 0.75)]) == 1.25


def test_cue_on_beat_one_or_beat_four_of_the_bar_before_starts_the_next_bar():
    # verse at bar 4 (8 s): cue spoken on beat 1 of bar 3 (6.0 s), a little early (5.9 s), or on beat 4 (7.5 s)
    for t in (6.0, 5.9, 6.05, 7.0, 7.5):
        secs = sections_from_cues([cue(t, "verse"), cue(22.0, "chorus")], DOWNBEATS, BEAT, 80.0)
        assert secs is not None
        assert [(s.label, s.start) for s in secs][:2] == [("intro", 0.0), ("verse", 8.0)], t


def test_sections_cover_the_song_and_intro_is_prepended():
    secs = sections_from_cues([cue(6.0, "verse"), cue(22.0, "chorus"), cue(38.0, "bridge")], DOWNBEATS, BEAT, 80.0)
    assert [(s.label, s.start, s.end) for s in secs] == [
        ("intro", 0.0, 8.0),
        ("verse", 8.0, 24.0),
        ("chorus", 24.0, 40.0),
        ("bridge", 40.0, 80.0),
    ]


def test_a_spoken_intro_starts_at_zero():
    secs = sections_from_cues([cue(0.2, "intro"), cue(6.0, "verse")], DOWNBEATS, BEAT, 80.0)
    assert [(s.label, s.start) for s in secs] == [("intro", 0.0), ("verse", 8.0)]


def test_repeated_cue_for_the_same_bar_counts_once():
    secs = sections_from_cues([cue(6.0, "verse"), cue(6.6, "verse"), cue(22.0, "chorus")], DOWNBEATS, BEAT, 80.0)
    assert [s.label for s in secs] == ["intro", "verse", "chorus"]


def test_too_few_cues_gives_none():
    assert sections_from_cues([cue(6.0, "verse")], DOWNBEATS, BEAT, 80.0) is None
    assert sections_from_cues([], DOWNBEATS, BEAT, 80.0) is None
    assert sections_from_cues([cue(6.0, "verse"), cue(22.0, "chorus")], [], BEAT, 80.0) is None
    # both cues land on the same bar
    assert sections_from_cues([cue(6.0, "verse"), cue(6.5, "chorus")], DOWNBEATS, BEAT, 80.0) is None


def test_postprocess_uses_cues_over_audio_sections():
    raw = RawAnalysis(
        duration=80.0,
        bpm=120.0,
        beats=[i * BEAT for i in range(160)],
        downbeats=DOWNBEATS,
        sections=[RawSection(0, 40, "verse"), RawSection(40, 80, "chorus")],
        backend="test",
    )
    cues = [cue(6.0, "verse"), cue(22.0, "chorus"), cue(38.0, "interlude"), cue(46.0, "chorus"), cue(70.0, "outro")]
    res = postprocess(raw, onsets=None, cues=cues)
    assert res["sectionsFrom"] == "guide"
    assert [s["name"] for s in res["sections"]] == ["Intro", "Verse", "Chorus 1", "Interlude", "Chorus 2", "Outro"]
    assert [s["start"] for s in res["sections"]] == [0.0, 8.0, 24.0, 40.0, 48.0, 72.0]
    # without cues the audio sections stand
    assert postprocess(raw, onsets=None)["sectionsFrom"] == "audio"
    assert [s["label"] for s in postprocess(raw, onsets=None, cues=cues[:1])["sections"]] == ["verse", "chorus"]


def test_a_one_bar_cued_section_is_kept():
    raw = RawAnalysis(80.0, 120.0, [i * BEAT for i in range(160)], DOWNBEATS, [RawSection(0, 80, "verse")], "test")
    res = postprocess(raw, cues=[cue(6.0, "verse"), cue(22.0, "break"), cue(24.0, "chorus")])
    assert [(s["label"], s["start"], s["end"]) for s in res["sections"]][2:] == [("break", 24.0, 26.0), ("chorus", 26.0, 80.0)]
