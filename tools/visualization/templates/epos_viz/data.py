"""Load, validate and normalize v2 EPOS visualization datasets."""

from __future__ import annotations

import importlib
import json
from dataclasses import dataclass, field
from itertools import product
from pathlib import Path
from typing import Any

import pandas as pd
import numpy as np


LATITUDE_NAMES = ("latitude", "lat", "y")
LONGITUDE_NAMES = ("longitude", "lon", "lng", "x")
TIME_NAMES = ("time", "timestamp", "datetime", "date", "origin_time")
CATEGORY_NAMES = ("category", "type", "class", "station", "provider")
MAGNITUDE_NAMES = ("magnitude", "mag")
DEPTH_NAMES = ("depth", "depth_km")
SUPPORTED_SUFFIXES = {".csv", ".json", ".jsonl", ".geojson", ".tif", ".tiff", ".parquet", ".gpkg", ".shp", ".xml", ".qml", ".mseed", ".msd", ".seed"}
WGS84 = "EPSG:4326"
MAX_RASTER_CELLS = 4_194_304
MAX_WAVEFORM_SAMPLES = 100_000


@dataclass
class Dataset:
    path: Path
    label: str
    role: str
    frame: pd.DataFrame
    latitude: str | None = None
    longitude: str | None = None
    time: str | None = None
    numeric: list[str] = field(default_factory=list)
    category: str | None = None
    geojson: dict[str, Any] | None = None
    grid: dict[str, Any] | None = None
    units: dict[str, str] = field(default_factory=dict)
    crs: str | None = None
    excluded_coordinates: int = 0
    warnings: list[str] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {
            "path": str(self.path), "label": self.label, "role": self.role,
            "records": int(len(self.frame)), "columns": [str(column) for column in self.frame.columns],
            "latitude": self.latitude, "longitude": self.longitude, "time": self.time,
            "numeric": self.numeric, "category": self.category, "geometry": self.geojson is not None,
            "grid": self.grid is not None, "crs": self.crs, "units": self.units,
            "missing": {str(column): int(self.frame[column].isna().sum()) for column in self.frame.columns},
            "excludedCoordinates": self.excluded_coordinates, "warnings": self.warnings,
        }


def discover_data_files(data_directory: Path) -> list[Path]:
    root = data_directory.resolve()
    return sorted(path for path in data_directory.rglob("*") if path.is_file() and path.resolve().is_relative_to(root)
                  and path.suffix.lower() in SUPPORTED_SUFFIXES and ".partial." not in path.name)


def _module(name: str) -> Any:
    try:
        return importlib.import_module(name)
    except ImportError as error:
        raise ValueError(f"{name} is required to read this dataset") from error


def _column(columns: list[str], explicit: Any, aliases: tuple[str, ...]) -> str | None:
    if isinstance(explicit, str) and explicit in columns:
        return explicit
    lowered = {column.casefold(): column for column in columns}
    return next((lowered[alias] for alias in aliases if alias in lowered), None)


def _flatten_coordinates(value: Any) -> list[tuple[float, float]]:
    if isinstance(value, list) and len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
        return [(float(value[0]), float(value[1]))]
    return [] if not isinstance(value, list) else [coordinate for item in value for coordinate in _flatten_coordinates(item)]


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
    rows = [{name: axis_values[index][position] for index, (name, position) in enumerate(zip(axis_names, indices))} | {range_name: values[offset]}
            for offset, indices in enumerate(product(*(range(len(items)) for items in axis_values))) if offset < len(values)]
    x_values, y_values = axes.get("x", {}).get("values"), axes.get("y", {}).get("values")
    grid = None
    if isinstance(x_values, list) and isinstance(y_values, list) and len(x_values) > 1 and len(y_values) > 1:
        unit = range_payload.get("unit")
        if isinstance(unit, dict):
            symbol = unit.get("symbol")
            unit = symbol.get("value") if isinstance(symbol, dict) else unit.get("label")
        grid = {"x": x_values, "y": y_values, "values": values, "shape": [len(y_values), len(x_values)],
                "name": range_name, "unit": unit if isinstance(unit, str) else None, "crs": WGS84}
    return rows, grid


def _raster_grid(path: Path) -> dict[str, Any]:
    rasterio = _module("rasterio")
    with rasterio.open(path) as source:
        height, width = source.height, source.width
        scale = min(1.0, (MAX_RASTER_CELLS / max(1, height * width)) ** 0.5)
        out_height, out_width = max(1, int(height * scale)), max(1, int(width * scale))
        band = np.ma.masked_all((out_height, out_width), dtype=float)
        for _, window in source.block_windows(1):
            row_start = int(window.row_off * out_height / height)
            row_end = min(out_height, max(row_start + 1, int(np.ceil((window.row_off + window.height) * out_height / height))))
            column_start = int(window.col_off * out_width / width)
            column_end = min(out_width, max(column_start + 1, int(np.ceil((window.col_off + window.width) * out_width / width))))
            band[row_start:row_end, column_start:column_end] = source.read(
                1, window=window, masked=True, out_shape=(row_end - row_start, column_end - column_start),
                resampling=rasterio.enums.Resampling.average,
            )
        transform = source.transform * source.transform.scale(width / out_width, height / out_height)
        x_values = [rasterio.transform.xy(transform, out_height // 2, column)[0] for column in range(out_width)]
        y_values = [rasterio.transform.xy(transform, row, out_width // 2)[1] for row in range(out_height)]
        return {"x": x_values, "y": y_values, "values": band.filled(float("nan")).ravel().tolist(),
                "shape": [out_height, out_width], "name": source.descriptions[0] or path.stem,
                "crs": str(source.crs) if source.crs else None,
                "downsampled": [out_height, out_width] != [height, width]}


def _quakeml_rows(path: Path) -> pd.DataFrame:
    catalog = _module("obspy").read_events(str(path))
    rows: list[dict[str, Any]] = []
    for event in catalog:
        origin = event.preferred_origin() or (event.origins[0] if event.origins else None)
        magnitude = event.preferred_magnitude() or (event.magnitudes[0] if event.magnitudes else None)
        if origin is None:
            continue
        focal = event.preferred_focal_mechanism() or (event.focal_mechanisms[0] if event.focal_mechanisms else None)
        nodal = focal.nodal_planes.nodal_plane_1 if focal and focal.nodal_planes else None
        rows.append({"event_id": str(event.resource_id), "time": str(origin.time), "latitude": origin.latitude,
                     "longitude": origin.longitude, "depth_km": origin.depth / 1000 if origin.depth is not None else None,
                     "magnitude": magnitude.mag if magnitude else None, "magnitude_type": magnitude.magnitude_type if magnitude else None,
                     "strike": nodal.strike if nodal else None, "dip": nodal.dip if nodal else None, "rake": nodal.rake if nodal else None})
    return pd.DataFrame(rows)


def _stationxml_rows(path: Path) -> pd.DataFrame:
    inventory = _module("obspy").read_inventory(str(path))
    return pd.DataFrame({"network": network.code, "station": station.code, "latitude": station.latitude,
                         "longitude": station.longitude, "elevation_m": station.elevation}
                        for network in inventory for station in network)


def _mseed_rows(path: Path) -> pd.DataFrame:
    stream = _module("obspy").read(str(path))
    rows: list[dict[str, Any]] = []
    remaining = MAX_WAVEFORM_SAMPLES
    for trace in stream:
        if remaining <= 0:
            break
        step = max(1, len(trace.data) // remaining)
        for index in range(0, len(trace.data), step):
            rows.append({"time": str(trace.stats.starttime + index / trace.stats.sampling_rate), "amplitude": float(trace.data[index]),
                         "station": trace.stats.station, "channel": trace.stats.channel})
            remaining -= 1
            if remaining <= 0:
                break
    return pd.DataFrame(rows)


def _geospatial_rows(path: Path, specification: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, Any]]:
    geopandas = _module("geopandas")
    frame = geopandas.read_file(path)
    source_crs = specification.get("crs") or frame.crs
    if source_crs is None:
        raise ValueError(f"{path.name} has no CRS; declare datasets[].crs explicitly")
    if frame.crs is None:
        frame = frame.set_crs(source_crs)
    frame = frame.to_crs(WGS84)
    payload = json.loads(frame.to_json())
    return pd.json_normalize(_geojson_rows(payload)), payload


def _read_payload(path: Path, specification: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, Any] | None, dict[str, Any] | None, str | None]:
    suffix, role = path.suffix.lower(), specification.get("role", "events")
    if suffix in {".tif", ".tiff"}:
        grid = _raster_grid(path)
        return pd.DataFrame(), None, grid, grid.get("crs")
    if suffix == ".parquet":
        return pd.read_parquet(path), None, None, specification.get("crs")
    if suffix in {".gpkg", ".shp"}:
        frame, geojson = _geospatial_rows(path, specification)
        return frame, geojson, None, WGS84
    if suffix in {".mseed", ".msd", ".seed"}:
        return _mseed_rows(path), None, None, specification.get("crs")
    if suffix in {".xml", ".qml"}:
        return (_stationxml_rows(path) if role == "stations" else _quakeml_rows(path)), None, None, WGS84
    if suffix == ".csv":
        return pd.read_csv(path), None, None, specification.get("crs")
    if suffix == ".jsonl":
        return pd.json_normalize([json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]), None, None, specification.get("crs")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and payload.get("type") == "FeatureCollection":
        return pd.json_normalize(_geojson_rows(payload)), payload, None, WGS84
    if isinstance(payload, dict) and payload.get("type") == "Coverage":
        rows, grid = _coverage_rows(payload)
        return pd.json_normalize(rows), None, grid, WGS84
    if isinstance(payload, list):
        return pd.json_normalize(payload), None, None, specification.get("crs")
    if isinstance(payload, dict):
        records = payload.get("records") or payload.get("features") or payload.get("data")
        return pd.json_normalize(records if isinstance(records, list) else [payload]), None, None, specification.get("crs")
    raise ValueError(f"Unsupported JSON root in {path.name}")


def _reproject(frame: pd.DataFrame, latitude: str, longitude: str, crs: str | None) -> str | None:
    if not crs or crs.upper() == WGS84:
        return crs or WGS84
    pyproj = _module("pyproj")
    transformer = pyproj.Transformer.from_crs(crs, WGS84, always_xy=True)
    valid = frame[latitude].notna() & frame[longitude].notna()
    longitudes, latitudes = transformer.transform(frame.loc[valid, longitude].to_numpy(), frame.loc[valid, latitude].to_numpy())
    frame.loc[valid, longitude], frame.loc[valid, latitude] = longitudes, latitudes
    return WGS84


def load_dataset(path: Path, specification: dict[str, Any] | None = None) -> Dataset:
    specification = specification or {}
    frame, geojson, grid, crs = _read_payload(path, specification)
    frame.columns = [str(column) for column in frame.columns]
    columns = list(frame.columns)
    mapping = specification.get("mapping") if isinstance(specification.get("mapping"), dict) else {}
    latitude, longitude = _column(columns, mapping.get("latitude"), LATITUDE_NAMES), _column(columns, mapping.get("longitude"), LONGITUDE_NAMES)
    time, category = _column(columns, mapping.get("time"), TIME_NAMES), _column(columns, mapping.get("category"), CATEGORY_NAMES)
    warnings: list[str] = []
    excluded = 0
    if latitude and longitude:
        frame[latitude], frame[longitude] = pd.to_numeric(frame[latitude], errors="coerce"), pd.to_numeric(frame[longitude], errors="coerce")
        crs = _reproject(frame, latitude, longitude, str(specification.get("crs") or crs) if specification.get("crs") or crs else None)
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
    if grid and grid.get("downsampled"):
        warnings.append(f"Raster was downsampled to {grid['shape'][1]} x {grid['shape'][0]} cells")
    return Dataset(path=path, label=str(specification.get("label") or path.stem), role=str(specification.get("role") or "events"), frame=frame,
                   latitude=latitude, longitude=longitude, time=time, numeric=numeric, category=category, geojson=geojson, grid=grid,
                   units=units, crs=crs, excluded_coordinates=excluded, warnings=warnings)
