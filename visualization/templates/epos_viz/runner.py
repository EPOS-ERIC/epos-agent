"""Select and run reusable EPOS visualizations from a compact configuration."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .data import DEPTH_NAMES, MAGNITUDE_NAMES, Dataset, discover_data_files, load_dataset
from .maps import interactive_map, static_map
from .plots import distribution, event_summary, raster, scatter, time_series


def _configuration(bundle: Path) -> dict[str, Any]:
    path = bundle / "visualization.json"
    if not path.exists():
        return {"version": 1, "mode": "auto", "datasets": [], "basemap": "street"}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise ValueError("visualization.json must be an object with version 1")
    return payload


def _dataset_specs(bundle: Path, config: dict[str, Any]) -> list[tuple[Path, dict[str, Any]]]:
    declared = config.get("datasets")
    if isinstance(declared, list) and declared:
        result: list[tuple[Path, dict[str, Any]]] = []
        for item in declared:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                raise ValueError("Every configured dataset requires a path")
            path = (bundle / item["path"]).resolve()
            if bundle.resolve() not in path.parents:
                raise ValueError(f"Dataset is outside the study bundle: {item['path']}")
            result.append((path, item))
        return result
    return [(path, {}) for path in discover_data_files(bundle / "data")]


def _requested_plots(specification: dict[str, Any]) -> set[str]:
    plots = specification.get("plots")
    return {str(item) for item in plots} if isinstance(plots, list) else set()


def run(bundle: Path | str) -> dict[str, Any]:
    root = Path(bundle).resolve()
    figures = root / "figures"
    config = _configuration(root)
    datasets: list[Dataset] = []
    specifications: list[dict[str, Any]] = []
    warnings: list[str] = []
    outputs: list[str] = []
    dependencies = {"pandas", "matplotlib", "folium", "xyzservices"}
    for path, specification in _dataset_specs(root, config):
        try:
            dataset = load_dataset(path, specification)
            datasets.append(dataset)
            specifications.append(specification)
            warnings.extend(dataset.warnings)
            if path.suffix.lower() in {".tif", ".tiff"}:
                dependencies.add("rasterio")
        except Exception as error:
            warnings.append(f"Skipped {path.name}: {error}")
    geographic = [dataset for dataset in datasets if dataset.geojson or (dataset.latitude and dataset.longitude)]
    if geographic:
        html, map_warnings = interactive_map(geographic, figures / "interactive-map.html", config)
        outputs.append(str(html))
        warnings.extend(map_warnings)
        png, map_warnings, map_dependencies = static_map(
            geographic,
            figures / "static-map.png",
            satellite=config.get("basemap") == "satellite",
        )
        outputs.append(str(png))
        warnings.extend(map_warnings)
        dependencies.update(map_dependencies)
    for dataset, specification in zip(datasets, specifications):
        requested = _requested_plots(specification)
        safe_name = "".join(character if character.isalnum() or character in "-_" else "-" for character in dataset.label).strip("-").lower() or "dataset"
        event_fields = {column.casefold() for column in dataset.numeric} & set(MAGNITUDE_NAMES + DEPTH_NAMES)
        if dataset.grid:
            outputs.append(str(raster(dataset, figures / f"{safe_name}-raster.png")))
        if dataset.time and dataset.numeric:
            outputs.append(str(time_series(dataset, figures / f"{safe_name}-time-series.png")))
        if event_fields:
            outputs.append(str(event_summary(dataset, figures / f"{safe_name}-events.png")))
        elif "distribution" in requested and dataset.numeric:
            outputs.append(str(distribution(dataset, figures / f"{safe_name}-distribution.png")))
        if "scatter" in requested:
            mapping = specification.get("mapping") if isinstance(specification.get("mapping"), dict) else {}
            x, y = mapping.get("x"), mapping.get("y")
            if not isinstance(x, str) or not isinstance(y, str):
                warnings.append(f"Skipped scatter for {dataset.label}: mapping.x and mapping.y are required")
            else:
                outputs.append(str(scatter(dataset, figures / f"{safe_name}-scatter.png", x, y)))
    if not datasets:
        warnings.append("No supported datasets were available for visualization")
    report = {
        "version": 1,
        "datasets": [dataset.summary() for dataset in datasets],
        "outputs": outputs,
        "warnings": warnings,
        "dependencies": sorted(dependencies),
    }
    (root / "analysis-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report
