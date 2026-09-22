"""Load supported EPOS data formats and detect plotting fields."""

from __future__ import annotations

import importlib
import json
from dataclasses import dataclass, field
from itertools import product
from pathlib import Path
from typing import Any

import pandas as pd


LATITUDE_NAMES = ("latitude", "lat", "y")
LONGITUDE_NAMES = ("longitude", "lon", "lng", "x")
TIME_NAMES = ("time", "timestamp", "datetime", "date", "origin_time")
CATEGORY_NAMES = ("category", "type", "class", "station", "provider")
MAGNITUDE_NAMES = ("magnitude", "mag")
DEPTH_NAMES = ("depth", "depth_km")
SUPPORTED_SUFFIXES = {".csv", ".json", ".jsonl", ".geojson", ".tif", ".tiff"}


@dataclass
class Dataset:
    path: Path
    label: str
    frame: pd.DataFrame
    latitude: str | None = None
    longitude: str | None = None
    time: str | None = None
    numeric: list[str] = field(default_factory=list)
    category: str | None = None
    geojson: dict[str, Any] | None = None
    grid: dict[str, Any] | None = None
    units: dict[str, str] = field(default_factory=dict)
    excluded_coordinates: int = 0
    warnings: list[str] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "label": self.label,
            "records": int(len(self.frame)),
            "columns": [str(column) for column in self.frame.columns],
            "latitude": self.latitude,
            "longitude": self.longitude,
            "time": self.time,
            "numeric": self.numeric,
            "category": self.category,
            "geometry": self.geojson is not None,
            "grid": self.grid is not None,
            "units": self.units,
            "missing": {str(column): int(self.frame[column].isna().sum()) for column in self.frame.columns},
            "excludedCoordinates": self.excluded_coordinates,
            "warnings": self.warnings,
        }


def discover_data_files(data_directory: Path) -> list[Path]:
    root = data_directory.resolve()
    return sorted(
        path for path in data_directory.rglob("*")
        if path.is_file()
        and path.resolve().is_relative_to(root)
        and path.suffix.lower() in SUPPORTED_SUFFIXES
        and ".partial." not in path.name
    )


def _column(columns: list[str], explicit: Any, aliases: tuple[str, ...]) -> str | None:
    if isinstance(explicit, str) and explicit in columns:
        return explicit
    lowered = {column.casefold(): column for column in columns}
    for alias in aliases:
        if alias in lowered:
            return lowered[alias]
    return None


def _flatten_coordinates(value: Any) -> list[tuple[float, float]]:
    if isinstance(value, list) and len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
        return [(float(value[0]), float(value[1]))]
    if not isinstance(value, list):
        return []
    return [coordinate for item in value for coordinate in _flatten_coordinates(item)]


def _geojson_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for feature in payload.get("features", []):
        if not isinstance(feature, dict):
            continue
        properties = dict(feature.get("properties") or {})
        geometry = feature.get("geometry") if isinstance(feature.get("geometry"), dict) else {}
        coordinates = _flatten_coordinates(geometry.get("coordinates"))
        if geometry.get("type") == "Point" and coordinates:
            properties["longitude"], properties["latitude"] = coordinates[0]
        properties["_geometry_type"] = geometry.get("type")
        rows.append(properties)
    return rows


def _coverage_rows(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    domain = payload.get("domain") if isinstance(payload.get("domain"), dict) else {}
    axes = domain.get("axes") if isinstance(domain.get("axes"), dict) else {}
    ranges = payload.get("ranges") if isinstance(payload.get("ranges"), dict) else {}
    if not axes or not ranges:
        return [], None
    range_name, range_payload = next(iter(ranges.items()))
    if not isinstance(range_payload, dict) or not isinstance(range_payload.get("values"), list):
        return [], None
    axis_names = range_payload.get("axisNames") or list(axes)
    axis_values = [axes.get(name, {}).get("values", []) for name in axis_names]
    if not axis_values or any(not isinstance(values, list) or not values for values in axis_values):
        return [], None
    values = range_payload["values"]
    rows: list[dict[str, Any]] = []
    for offset, indices in enumerate(product(*(range(len(items)) for items in axis_values))):
        if offset >= len(values):
            break
        row = {name: axis_values[index][position] for index, (name, position) in enumerate(zip(axis_names, indices))}
        row[range_name] = values[offset]
        rows.append(row)
    x_values = axes.get("x", {}).get("values")
    y_values = axes.get("y", {}).get("values")
    grid = None
    if isinstance(x_values, list) and isinstance(y_values, list) and len(x_values) > 1 and len(y_values) > 1:
        unit = range_payload.get("unit")
        if isinstance(unit, dict):
            symbol = unit.get("symbol")
            unit = symbol.get("value") if isinstance(symbol, dict) else unit.get("label")
        grid = {"x": x_values, "y": y_values, "values": values, "shape": [len(y_values), len(x_values)], "name": range_name, "unit": unit if isinstance(unit, str) else None}
    return rows, grid


def _read_payload(path: Path) -> tuple[pd.DataFrame, dict[str, Any] | None, dict[str, Any] | None]:
    suffix = path.suffix.lower()
    if suffix in {".tif", ".tiff"}:
        rasterio = importlib.import_module("rasterio")
        with rasterio.open(path) as source:
            band = source.read(1, masked=True)
            height, width = band.shape
            x_values = [source.xy(height // 2, column)[0] for column in range(width)]
            y_values = [source.xy(row, width // 2)[1] for row in range(height)]
            grid = {
                "x": x_values,
                "y": y_values,
                "values": band.filled(float("nan")).ravel().tolist(),
                "shape": [height, width],
                "name": source.descriptions[0] or path.stem,
                "crs": str(source.crs) if source.crs else None,
            }
        return pd.DataFrame(), None, grid
    if suffix == ".csv":
        return pd.read_csv(path), None, None
    if suffix == ".jsonl":
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return pd.json_normalize(rows), None, None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and payload.get("type") == "FeatureCollection":
        return pd.json_normalize(_geojson_rows(payload)), payload, None
    if isinstance(payload, dict) and payload.get("type") == "Coverage":
        rows, grid = _coverage_rows(payload)
        return pd.json_normalize(rows), None, grid
    if isinstance(payload, list):
        return pd.json_normalize(payload), None, None
    if isinstance(payload, dict):
        records = payload.get("records") or payload.get("features") or payload.get("data")
        if isinstance(records, list):
            return pd.json_normalize(records), None, None
        return pd.json_normalize([payload]), None, None
    raise ValueError(f"Unsupported JSON root in {path.name}")


def load_dataset(path: Path, specification: dict[str, Any] | None = None) -> Dataset:
    specification = specification or {}
    frame, geojson, grid = _read_payload(path)
    frame.columns = [str(column) for column in frame.columns]
    columns = list(frame.columns)
    mapping = specification.get("mapping") if isinstance(specification.get("mapping"), dict) else {}
    latitude = _column(columns, mapping.get("latitude"), LATITUDE_NAMES)
    longitude = _column(columns, mapping.get("longitude"), LONGITUDE_NAMES)
    time = _column(columns, mapping.get("time"), TIME_NAMES)
    category = _column(columns, mapping.get("category"), CATEGORY_NAMES)
    warnings: list[str] = []
    excluded = 0
    if latitude and longitude:
        frame[latitude] = pd.to_numeric(frame[latitude], errors="coerce")
        frame[longitude] = pd.to_numeric(frame[longitude], errors="coerce")
        invalid = frame[latitude].isna() | frame[longitude].isna() | ~frame[latitude].between(-90, 90) | ~frame[longitude].between(-180, 180)
        excluded = int(invalid.sum())
    if time:
        parsed = pd.to_datetime(frame[time], errors="coerce", utc=True)
        if parsed.notna().any():
            frame[time] = parsed
        else:
            warnings.append(f"Column {time} did not contain parseable timestamps")
            time = None
    numeric: list[str] = []
    for column in columns:
        if column in {latitude, longitude, time}:
            continue
        converted = pd.to_numeric(frame[column], errors="coerce")
        if len(frame) and converted.notna().sum() >= max(1, min(3, len(frame))):
            frame[column] = converted
            numeric.append(column)
    explicit_values = mapping.get("values")
    if isinstance(explicit_values, list):
        numeric = [column for column in explicit_values if column in numeric]
    elif isinstance(mapping.get("value"), str) and mapping["value"] in numeric:
        numeric = [mapping["value"]] + [column for column in numeric if column != mapping["value"]]
    units = {str(key): str(value) for key, value in (specification.get("units") or {}).items()} if isinstance(specification.get("units"), dict) else {}
    if grid and isinstance(grid.get("unit"), str):
        units.setdefault(str(grid["name"]), grid["unit"])
    return Dataset(
        path=path,
        label=str(specification.get("label") or path.stem),
        frame=frame,
        latitude=latitude,
        longitude=longitude,
        time=time,
        numeric=numeric,
        category=category,
        geojson=geojson,
        grid=grid,
        units=units,
        excluded_coordinates=excluded,
        warnings=warnings,
    )
