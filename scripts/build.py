#!/usr/bin/env python3
"""Inline index.html into worker.js so the Worker can serve it from a single
module. Runs locally (make build) and in Cloudflare Workers Builds (via the
[build] command in wrangler.toml). Idempotent."""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC_WORKER = ROOT / "worker.js"
SRC_HTML = ROOT / "index.html"
OUT_DIR = ROOT / "build"
OUT = OUT_DIR / "worker.js"
PLACEHOLDER = "__HTML__"


def main() -> int:
    if not SRC_WORKER.exists():
        print(f"missing: {SRC_WORKER}", file=sys.stderr)
        return 1
    if not SRC_HTML.exists():
        print(f"missing: {SRC_HTML}", file=sys.stderr)
        return 1

    worker = SRC_WORKER.read_text()
    if PLACEHOLDER not in worker:
        print(f"worker.js is missing the {PLACEHOLDER} placeholder", file=sys.stderr)
        return 1

    html = SRC_HTML.read_text()
    # Escape for a JS template literal: backslashes, backticks, and the
    # ${...} interpolation sequence.
    escaped = html.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    built = worker.replace(PLACEHOLDER, escaped)
    OUT.write_text(built)
    print(f"built {OUT.relative_to(ROOT)} — {len(built)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
