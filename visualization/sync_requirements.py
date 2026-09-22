#!/usr/bin/env python3
"""Generate complete direct requirements for an EPOS analysis bundle."""

from __future__ import annotations

import argparse
import ast
import importlib.metadata
import json
import sys
from pathlib import Path


IMPORT_TO_DISTRIBUTION = {
    "contextily": "contextily",
    "folium": "folium",
    "geopandas": "geopandas",
    "matplotlib": "matplotlib",
    "numpy": "numpy",
    "pandas": "pandas",
    "pyproj": "pyproj",
    "rasterio": "rasterio",
    "shapely": "shapely",
    "xyzservices": "xyzservices",
}


def imported_modules(paths: list[Path]) -> set[str]:
    modules: set[str] = set()
    for path in paths:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                modules.add(node.module.split(".")[0])
    return modules


def requirements_for_bundle(bundle: Path) -> list[str]:
    sources = [bundle / "analysis.py", *sorted((bundle / "epos_viz").rglob("*.py"))]
    sources = [path for path in sources if path.exists()]
    if not sources:
        raise ValueError("No analysis.py or epos_viz sources were found")
    local_modules = {path.stem for path in sources} | {"epos_viz"}
    modules = imported_modules(sources)
    unknown = sorted(modules - set(sys.stdlib_module_names) - local_modules - set(IMPORT_TO_DISTRIBUTION))
    if unknown:
        raise ValueError(f"Unmapped third-party imports: {', '.join(unknown)}")
    distributions = {IMPORT_TO_DISTRIBUTION[module] for module in modules if module in IMPORT_TO_DISTRIBUTION}
    report_path = bundle / "analysis-report.json"
    if report_path.exists():
        report = json.loads(report_path.read_text(encoding="utf-8"))
        for dependency in report.get("dependencies", []):
            if dependency not in IMPORT_TO_DISTRIBUTION.values():
                raise ValueError(f"Unmapped analysis dependency: {dependency}")
            distributions.add(dependency)
    result: list[str] = []
    for distribution in sorted(distributions, key=str.casefold):
        try:
            version = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError as error:
            raise ValueError(f"Required distribution is not installed in the analysis environment: {distribution}") from error
        result.append(f"{distribution}=={version}")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    requirements = requirements_for_bundle(bundle)
    (bundle / "requirements.txt").write_text("\n".join(requirements) + "\n", encoding="utf-8")
    print(json.dumps({"requirements": requirements, "path": str(bundle / "requirements.txt")}))


if __name__ == "__main__":
    main()
