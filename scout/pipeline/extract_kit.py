"""Unzip the CoStar hackathon kit into data/costar-kit/.

The zip password is read from .env (KIT_ZIP_PASSWORD) and is never printed.

Usage (from the repo root):
    python pipeline/extract_kit.py
"""
from __future__ import annotations

import os
import sys
import zipfile
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
ZIP_PATH = ROOT / "costar-hackathon-kit.zip"
OUT_DIR = ROOT / "data" / "costar-kit"


def extract(zip_path: Path = ZIP_PATH, out_dir: Path = OUT_DIR) -> int:
    """Extract every entry, refusing any path that would land outside out_dir."""
    load_dotenv(ROOT / ".env")
    password = os.environ.get("KIT_ZIP_PASSWORD", "")
    if not password or password.startswith("<"):
        sys.exit("KIT_ZIP_PASSWORD is missing. Copy env.example to .env and fill it in.")
    if not zip_path.exists():
        sys.exit(f"Kit zip not found at {zip_path}")

    out_dir.mkdir(parents=True, exist_ok=True)
    base = out_dir.resolve()
    count = 0
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            target = (base / info.filename).resolve()
            if base != target and base not in target.parents:
                raise RuntimeError(f"Unsafe path in zip: {info.filename}")
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if target.exists() and target.stat().st_size == info.file_size:
                continue  # already extracted
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info, pwd=password.encode()) as src, open(target, "wb") as dst:
                while chunk := src.read(1 << 20):
                    dst.write(chunk)
            count += 1
            print(f"  {info.file_size / 1e6:8.1f} MB  {info.filename}", flush=True)
    return count


if __name__ == "__main__":
    n = extract()
    print(f"Extracted {n} new file(s) into {OUT_DIR}")
