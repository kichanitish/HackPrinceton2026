"""Run the whole pipeline: unzip the kit (if needed) → spaces → benchmarks → graph.

Usage (from the repo root): python pipeline/build_all.py
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
STEPS = ["extract_kit.py", "build_spaces.py", "build_benchmarks.py", "build_graph.py"]


def main() -> None:
    for step in STEPS:
        print(f"\n=== {step}", flush=True)
        started = time.time()
        result = subprocess.run([sys.executable, str(HERE / step)], cwd=HERE.parent)
        if result.returncode != 0:
            sys.exit(f"{step} failed — fix the error above and run again.")
        print(f"    done in {time.time() - started:.0f}s", flush=True)
    print("\nPipeline complete. Start the app with:  python -m uvicorn api.main:app --port 8000")


if __name__ == "__main__":
    main()
