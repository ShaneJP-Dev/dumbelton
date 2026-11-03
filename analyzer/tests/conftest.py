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
