"""CLI: analyse one audio file and print the JSON result. Run from analyzer/: uv run python ../scripts/analyze_file.py FILE [backend]"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "analyzer"))
from app.pipeline import analyze_file  # noqa: E402

t = time.time()
res = analyze_file(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
res["beats"] = f"{len(res['beats'])} beats"
res["downbeats"] = res["downbeats"][:6] + ["..."]
print(json.dumps(res, indent=1))
print(f"took {time.time() - t:.1f}s", file=sys.stderr)
