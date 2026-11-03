from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class RawSection:
    start: float
    end: float
    label: str


@dataclass
class RawAnalysis:
    """What a backend returns, before shared post-processing. Times in seconds."""

    duration: float
    bpm: float
    beats: list[float]
    downbeats: list[float]
    sections: list[RawSection]
    backend: str
    extra: dict = field(default_factory=dict)


@dataclass
class Section:
    start: float
    end: float
    label: str  # kind: intro | verse | pre-chorus | chorus | bridge | solo | inst | break | outro
    name: str  # display name, e.g. "Chorus 2"

    def to_dict(self) -> dict:
        return {"start": self.start, "end": self.end, "label": self.label, "name": self.name}
