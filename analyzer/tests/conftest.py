import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="session")
def synthetic_song(tmp_path_factory) -> Path:
    """Directory with stems, mix.wav and structure.json from scripts/make_test_song.py."""
    out = tmp_path_factory.mktemp("song")
    subprocess.run([sys.executable, str(ROOT / "scripts" / "make_test_song.py"), str(out)], check=True)
    return out


@pytest.fixture(scope="session")
def truth(synthetic_song) -> dict:
    return json.loads((synthetic_song / "structure.json").read_text())


@pytest.fixture(scope="session")
def browser_mix(synthetic_song) -> Path:
    """What the web app sends: stems (minus click) at 48 kHz, L+R averaged, peak 0.9, 16-bit."""
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    mix = None
    for name in ("drums", "bass", "keys", "lead"):
        x, sr = sf.read(synthetic_song / f"{name}.wav")
        x = resample_poly(x, 160, 147, axis=0)  # 44.1k -> 48k
        m = 0.5 * (x[:, 0] + x[:, 1])
        mix = m if mix is None else mix + m
    mix = mix / np.max(np.abs(mix)) * 0.9
    rng = np.random.default_rng(1)
    mix = mix + (rng.random(len(mix)) - rng.random(len(mix))) / 32768
    out = synthetic_song / "browser_mix.wav"
    sf.write(out, mix, 48000, subtype="PCM_16")
    return out
