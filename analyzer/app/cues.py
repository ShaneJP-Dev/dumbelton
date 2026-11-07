"""Turn the words spoken on a guide track into song sections.

A guide track says the name of each section ("Verse", "Chorus", "Puente"...)
about a bar before it starts, often followed by a count ("2, 3, 4"). The
speech recogniser is restricted to the words below (see `grammar`), so it
only has to tell a few dozen words apart.

Placement rule: a cue starts its section on the first downbeat after
(cue start + half a beat). That covers cues spoken anywhere from just before
beat 1 of the bar before the section up to its beat 4.
"""

from __future__ import annotations

import bisect
from dataclasses import asdict, dataclass

from .types import RawSection

# spoken word -> section kind (kinds as in postprocess.KINDS)
EN_CUES = {
    "intro": "intro",
    "introduction": "intro",
    "verse": "verse",
    "prechorus": "pre-chorus",
    "chorus": "chorus",
    "refrain": "chorus",
    "bridge": "bridge",
    "interlude": "interlude",
    "turnaround": "interlude",
    "instrumental": "inst",
    "solo": "solo",
    "tag": "tag",
    "vamp": "vamp",
    "breakdown": "break",
    "break": "break",
    "outro": "outro",
    "ending": "outro",
}
ES_CUES = {
    "intro": "intro",
    "introducción": "intro",
    "verso": "verse",
    "estrofa": "verse",
    "precoro": "pre-chorus",
    "coro": "chorus",
    "puente": "bridge",
    "interludio": "interlude",
    "instrumental": "inst",
    "solo": "solo",
    "tag": "tag",
    "vamp": "vamp",
    "final": "outro",
    "outro": "outro",
}
CUE_WORDS = {"en": EN_CUES, "es": ES_CUES}

# "pre" + one of these (within PRE_GAP seconds) is a pre-chorus
PRE_TARGETS = {"chorus": "pre-chorus", "coro": "pre-chorus"}
PRE_GAP = 1.0

# Other words guide tracks say. They are in the grammar so counts and
# directions are recognised as themselves instead of being forced into the
# nearest section word, and then ignored (sections are renumbered anyway).
FILLER = {
    "en": "one two three four five six seven eight and last time all in hold build hits drums down out again big".split(),
    "es": "uno dos tres cuatro cinco seis siete ocho y última vez todos otra".split(),
}

MIN_CONF = 0.5


@dataclass
class Word:
    word: str
    start: float
    end: float
    conf: float = 1.0


@dataclass
class Cue:
    time: float
    end: float
    kind: str
    word: str
    conf: float

    def to_dict(self) -> dict:
        d = asdict(self)
        for k in ("time", "end", "conf"):
            d[k] = round(d[k], 3)
        return d


def grammar(lang: str) -> list[str]:
    """Phrases the recogniser may output for `lang` (Vosk grammar), plus [unk] for anything else."""
    words = list(CUE_WORDS[lang]) + FILLER[lang]
    words += ["pre chorus"] if lang == "en" else ["pre coro"]
    return sorted(set(words)) + ["[unk]"]


def _kind(word: str) -> str | None:
    w = word.lower()
    return EN_CUES.get(w) or ES_CUES.get(w)


def cues_from_words(words: list[Word], min_conf: float = MIN_CONF) -> list[Cue]:
    """Section cues among recognised words (numbers, filler and low-confidence words dropped)."""
    ws = sorted(words, key=lambda w: w.start)
    out: list[Cue] = []
    i = 0
    while i < len(ws):
        w = ws[i]
        low = w.word.lower()
        if low == "pre" and i + 1 < len(ws):
            nxt = ws[i + 1]
            target = PRE_TARGETS.get(nxt.word.lower())
            if target and nxt.start - w.end <= PRE_GAP:
                conf = min(w.conf, nxt.conf)
                if conf >= min_conf:
                    out.append(Cue(w.start, nxt.end, target, f"{w.word} {nxt.word}", conf))
                i += 2
                continue
        kind = _kind(low)
        if kind and w.conf >= min_conf:
            out.append(Cue(w.start, w.end, kind, w.word, w.conf))
        i += 1
    return out


def score(cues: list[Cue]) -> float:
    """How convincing a transcription is (used to pick English or Spanish)."""
    return sum(c.conf for c in cues)


def sections_from_cues(
    cues: list[Cue], downbeats: list[float], beat: float, duration: float, min_cues: int = 2
) -> list[RawSection] | None:
    """Sections placed by spoken cues, starting on downbeats. None when there are too few cues to trust."""
    if len(cues) < min_cues or len(downbeats) == 0:
        return None
    db = sorted(float(d) for d in downbeats if 0 < d < duration)
    starts: list[tuple[float, str]] = []
    for c in sorted(cues, key=lambda c: c.time):
        i = bisect.bisect_right(db, c.time + 0.5 * beat)
        if i >= len(db):
            continue  # a cue in the last bar: nothing left to start
        t = db[i]
        if starts and t <= starts[-1][0] + 1e-6:
            continue  # same downbeat as the previous cue (a repeat, or "pre" + "chorus" split): keep the first
        starts.append((t, c.kind))
    if len(starts) < min_cues:
        return None
    sections: list[RawSection] = []
    first_t, first_kind = starts[0]
    if first_kind == "intro":
        starts[0] = (0.0, first_kind)  # the count-in before a spoken "Intro" belongs to it
    else:
        sections.append(RawSection(0.0, first_t, "intro"))
    bounds = starts + [(duration, "")]
    for (t, kind), (nxt, _) in zip(bounds, bounds[1:]):
        if nxt > t:
            sections.append(RawSection(t, nxt, kind))
    return sections
