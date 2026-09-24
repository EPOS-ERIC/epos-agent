#!/usr/bin/env python3
"""Run the reusable EPOS visualization pipeline for this study bundle."""

from __future__ import annotations

import json
from pathlib import Path

from epos_viz import run


def main() -> dict:
    return run(Path(__file__).resolve().parent)


if __name__ == "__main__":
    bundle = Path(__file__).resolve().parent
    report = main()
    print(json.dumps({
        "datasets": len(report["datasets"]),
        "outputs": report["outputs"],
        "warnings": report["warnings"],
        "report": str(bundle / "analysis-report.json"),
    }))
