"""Run v2 recipes and preserve audit information for every output."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
from pathlib import Path
from typing import Any

from .data import Dataset, discover_data_files, load_dataset
from .maps import interactive_map, static_map
from .plots import beachballs, catalog_dashboard, distribution, event_summary, gutenberg_richter, interactive_plot, raster, scatter, space_time, time_series, vertical_section
from .recipes import recipe_parameters, validate_configuration


def _configuration(bundle: Path) -> dict[str, Any]:
    path = bundle / "visualization.json"
    if not path.exists():
        raise ValueError("visualization.json v2 is required")
    return validate_configuration(json.loads(path.read_text(encoding="utf-8")))


def _dataset_specs(bundle: Path, config: dict[str, Any]) -> list[tuple[Path, dict[str, Any]]]:
    declared = config["datasets"]
    if declared:
        result: list[tuple[Path, dict[str, Any]]] = []
        for item in declared:
            path = (bundle / item["path"]).resolve()
            if bundle.resolve() not in path.parents:
                raise ValueError(f"Dataset is outside the study bundle: {item['path']}")
            result.append((path, item))
        return result
    return [(path, {"path": str(path.relative_to(bundle)), "role": "events"}) for path in discover_data_files(bundle / "data")]


def _hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _versions(dependencies: set[str]) -> dict[str, str]:
    versions: dict[str, str] = {}
    for dependency in sorted(dependencies):
        try:
            versions[dependency] = importlib.metadata.version(dependency)
        except importlib.metadata.PackageNotFoundError:
            continue
    return versions


def _event_dataset(datasets: list[Dataset]) -> Dataset | None:
    return next((dataset for dataset in datasets if dataset.role == "events"), None)


def _requested_plots(specification: dict[str, Any]) -> set[str]:
    return set(specification.get("plots", [])) if isinstance(specification.get("plots"), list) else set()


def _plot_requests(dataset: Dataset, specification: dict[str, Any], figures: Path, outputs: list[str], warnings: list[str], config: dict[str, Any], dependencies: set[str]) -> None:
    requested = _requested_plots(specification)
    safe = "".join(character if character.isalnum() or character in "-_" else "-" for character in dataset.label).strip("-").lower() or "dataset"
    mapping = specification.get("mapping") if isinstance(specification.get("mapping"), dict) else {}
    if dataset.grid:
        try:
            outputs.append(str(raster(dataset, figures / f"{safe}-raster.png")))
        except Exception as error:
            warnings.append(f"Skipped raster for {dataset.label}: {error}")
    functions = {
        "distribution": lambda: distribution(dataset, figures / f"{safe}-distribution.png"),
        "time_series": lambda: time_series(dataset, figures / f"{safe}-time-series.png"),
        "gutenberg_richter": lambda: gutenberg_richter(dataset, figures / f"{safe}-gutenberg-richter.png", None)[0],
        "space_time": lambda: space_time(dataset, figures / f"{safe}-space-time.png"),
        "vertical_section": lambda: vertical_section(dataset, figures / f"{safe}-vertical-section.png"),
        "beachballs": lambda: beachballs(dataset, figures / f"{safe}-beachballs.png"),
        "scatter": lambda: scatter(dataset, figures / f"{safe}-scatter.png", mapping.get("x"), mapping.get("y")),
    }
    for name in requested:
        try:
            outputs.append(str(functions[name]()))
        except Exception as error:
            warnings.append(f"Skipped {name} for {dataset.label}: {error}")
    if config.get("interactive") and dataset.role in {"events", "waveforms"}:
        try:
            if dataset.time and dataset.numeric:
                outputs.append(str(interactive_plot(dataset, figures / f"{safe}-time-series.html", "time_series")))
                dependencies.add("plotly")
            elif mapping.get("x") and mapping.get("y"):
                outputs.append(str(interactive_plot(dataset, figures / f"{safe}-scatter.html", "scatter", mapping["x"], mapping["y"])))
                dependencies.add("plotly")
        except Exception as error:
            warnings.append(f"Skipped interactive plot for {dataset.label}: {error}")


def run(bundle: Path | str) -> dict[str, Any]:
    root = Path(bundle).resolve()
    figures = root / "figures"
    config = _configuration(root)
    recipe_name = config["recipe"]["name"]
    parameters = recipe_parameters(config)
    datasets: list[Dataset] = []
    specifications: list[dict[str, Any]] = []
    warnings: list[str] = []
    outputs: list[str] = []
    dependencies = {"pandas", "matplotlib", "folium", "xyzservices"}
    inputs: list[dict[str, str]] = []
    for path, specification in _dataset_specs(root, config):
        try:
            dataset = load_dataset(path, specification)
            datasets.append(dataset)
            specifications.append(specification)
            warnings.extend(dataset.warnings)
            inputs.append({"path": str(path.relative_to(root)), "sha256": _hash(path)})
            if specification.get("crs") and str(specification["crs"]).upper() != "EPSG:4326":
                dependencies.add("pyproj")
            suffix = path.suffix.lower()
            if suffix in {".tif", ".tiff"}:
                dependencies.add("rasterio")
            if suffix in {".parquet"}:
                dependencies.add("pyarrow")
            if suffix in {".gpkg", ".shp"}:
                dependencies.add("geopandas")
            if suffix in {".xml", ".qml", ".mseed", ".msd", ".seed"}:
                dependencies.add("obspy")
        except Exception as error:
            warnings.append(f"Skipped {path.name}: {error}")
    geographic = [dataset for dataset in datasets if dataset.geojson or (dataset.latitude and dataset.longitude)]
    if geographic or (config.get("wms") and config.get("map", {}).get("extent")):
        map_config = {**config.get("map", {}), "wms": config.get("wms", [])}
        png, map_warnings, map_dependencies = static_map(
            geographic, figures / "static-map.png",
            satellite=config.get("map", {}).get("basemap") == "satellite", config=map_config,
        )
        outputs.append(str(png))
        warnings.extend(map_warnings)
        dependencies.update(map_dependencies)
        if config.get("interactive"):
            html, map_warnings = interactive_map(geographic, figures / "interactive-map.html", map_config)
            outputs.append(str(html))
            warnings.extend(map_warnings)
    event = _event_dataset(datasets)
    if recipe_name == "seismic_catalog_standard":
        if event is None:
            warnings.append("Seismic catalog recipe requires a dataset with role events")
        else:
            try:
                outputs.append(str(catalog_dashboard(event, figures / "seismic-catalog-dashboard.png")))
                gr_output, gr_stats = gutenberg_richter(event, figures / "gutenberg-richter.png", parameters.get("magnitudeCompleteness"))
                outputs.append(str(gr_output))
                config.setdefault("_runtime", {})["gutenbergRichter"] = gr_stats
            except Exception as error:
                warnings.append(f"Skipped seismic catalog recipe: {error}")
    elif recipe_name == "seismic_sequence":
        if event is None:
            warnings.append("Seismic sequence recipe requires a dataset with role events")
        else:
            for name, function in (("space-time", lambda: space_time(event, figures / "seismic-space-time.png")),
                                   ("vertical-section", lambda: vertical_section(event, figures / "seismic-vertical-section.png", parameters.get("sectionAxis", "longitude")))):
                try:
                    outputs.append(str(function()))
                except Exception as error:
                    warnings.append(f"Skipped {name}: {error}")
    elif recipe_name == "focal_mechanism_standard" and event is not None:
        try:
            outputs.append(str(beachballs(event, figures / "focal-mechanisms.png")))
        except Exception as error:
            warnings.append(f"Skipped focal mechanisms: {error}")
    for dataset, specification in zip(datasets, specifications):
        _plot_requests(dataset, specification, figures, outputs, warnings, config, dependencies)
    if not datasets:
        warnings.append("No supported datasets were available for visualization")
    report = {"version": 2, "recipe": config["recipe"], "datasets": [dataset.summary() for dataset in datasets], "inputs": inputs,
              "outputs": outputs, "warnings": warnings, "dependencies": sorted(dependencies), "libraryVersions": _versions(dependencies),
              "metrics": config.get("_runtime", {})}
    (root / "analysis-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report
