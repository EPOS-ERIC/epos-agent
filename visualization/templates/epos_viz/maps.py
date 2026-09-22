"""Interactive and static geographic maps for inspected EPOS datasets."""

from __future__ import annotations

import html
import importlib
from pathlib import Path
from typing import Any

import folium
import matplotlib.pyplot as plt
import xyzservices.providers as xyz
from folium.plugins import MarkerCluster

from .data import Dataset, _flatten_coordinates


EPOS_COLORS = ("#2B422D", "#C69436", "#3973AC", "#A64B3C", "#725A8C")
MAX_INTERACTIVE_FEATURES = 20_000
MAX_STATIC_POINTS = 100_000


def _deterministic_sample(frame: Any, limit: int) -> Any:
    if len(frame) <= limit:
        return frame
    step = max(1, (len(frame) + limit - 1) // limit)
    return frame.iloc[::step].head(limit)


def _bounds(datasets: list[Dataset]) -> list[list[float]] | None:
    coordinates: list[tuple[float, float]] = []
    for dataset in datasets:
        if dataset.latitude and dataset.longitude:
            valid = dataset.frame.dropna(subset=[dataset.latitude, dataset.longitude])
            coordinates.extend((float(row[dataset.longitude]), float(row[dataset.latitude])) for _, row in valid.iterrows())
        if dataset.geojson:
            for feature in dataset.geojson.get("features", []):
                geometry = feature.get("geometry") if isinstance(feature, dict) else None
                if isinstance(geometry, dict):
                    coordinates.extend(_flatten_coordinates(geometry.get("coordinates")))
    if not coordinates:
        return None
    longitudes, latitudes = zip(*coordinates)
    return [[min(latitudes), min(longitudes)], [max(latitudes), max(longitudes)]]


def _coordinate_paths(value: Any) -> list[list[tuple[float, float]]]:
    if not isinstance(value, list) or not value:
        return []
    if all(isinstance(item, list) and len(item) >= 2 and all(isinstance(number, (int, float)) for number in item[:2]) for item in value):
        return [[(float(item[0]), float(item[1])) for item in value]]
    return [path for item in value for path in _coordinate_paths(item)]


def interactive_map(datasets: list[Dataset], output: Path, config: dict[str, Any]) -> tuple[Path, list[str]]:
    warnings: list[str] = []
    bounds = _bounds(datasets)
    center = [0.0, 0.0] if not bounds else [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]
    map_object = folium.Map(location=center, tiles=None, control_scale=True, prefer_canvas=True)
    basemap = config.get("basemap", "street")
    satellite_provider = None
    if basemap != "none":
        try:
            satellite_provider = xyz.NASAGIBS.BlueMarble
        except AttributeError as error:
            warnings.append(f"NASA GIBS basemap unavailable: {error}")
        folium.TileLayer(
            tiles=xyz.OpenStreetMap.Mapnik,
            name="OpenStreetMap",
            show=basemap != "satellite" or satellite_provider is None,
        ).add_to(map_object)
        if satellite_provider is not None:
            folium.TileLayer(
                tiles=satellite_provider,
                name="NASA GIBS Blue Marble",
                show=basemap == "satellite",
            ).add_to(map_object)
    for index, dataset in enumerate(datasets):
        color = EPOS_COLORS[index % len(EPOS_COLORS)]
        if dataset.geojson:
            features = dataset.geojson.get("features", [])
            if len(features) > MAX_INTERACTIVE_FEATURES:
                warnings.append(f"Rendered {MAX_INTERACTIVE_FEATURES} of {len(features)} features for {dataset.label}")
                features = features[:MAX_INTERACTIVE_FEATURES]
            rendered_geojson = {**dataset.geojson, "features": features}
            property_sets = [set((feature.get("properties") or {}).keys()) for feature in features if isinstance(feature, dict)]
            tooltip_fields = sorted(set.intersection(*property_sets))[:8] if property_sets else []
            folium.GeoJson(
                rendered_geojson,
                name=dataset.label,
                style_function=lambda _feature, selected=color: {"color": selected, "weight": 2, "fillOpacity": 0.35},
                tooltip=folium.GeoJsonTooltip(fields=tooltip_fields) if tooltip_fields else None,
                popup=folium.GeoJsonPopup(fields=tooltip_fields) if tooltip_fields else None,
            ).add_to(map_object)
        elif dataset.latitude and dataset.longitude:
            valid = dataset.frame.dropna(subset=[dataset.latitude, dataset.longitude])
            if len(valid) > MAX_INTERACTIVE_FEATURES:
                warnings.append(f"Rendered {MAX_INTERACTIVE_FEATURES} of {len(valid)} points for {dataset.label}")
                valid = _deterministic_sample(valid, MAX_INTERACTIVE_FEATURES)
            group: Any = folium.FeatureGroup(name=dataset.label)
            group.add_to(map_object)
            target: Any = MarkerCluster().add_to(group) if len(valid) > 100 else group
            for _, row in valid.iterrows():
                popup = "<br>".join(
                    f"<b>{html.escape(str(column))}</b>: {html.escape(str(row[column]))}" for column in dataset.frame.columns[:12]
                    if row[column] is not None and str(row[column]) != "nan"
                )
                location = [float(row[dataset.latitude]), float(row[dataset.longitude])]
                if len(valid) > 100:
                    folium.Marker(location, popup=folium.Popup(popup, max_width=420)).add_to(target)
                else:
                    folium.CircleMarker(
                        location, radius=5, color=color, fill=True, fill_opacity=0.8,
                        popup=folium.Popup(popup, max_width=420),
                    ).add_to(target)
    for wms in config.get("wms", []):
        if not isinstance(wms, dict) or not all(isinstance(wms.get(key), str) for key in ("url", "layers", "attribution")):
            warnings.append("Skipped WMS entry without declared url, layers and attribution")
            continue
        folium.WmsTileLayer(
            url=wms["url"], layers=wms["layers"], name=wms.get("name", wms["layers"]),
            attr=wms["attribution"], fmt=wms.get("format", "image/png"), transparent=True,
        ).add_to(map_object)
    if bounds:
        if bounds[0] == bounds[1]:
            latitude, longitude = bounds[0]
            bounds = [[latitude - 0.05, longitude - 0.05], [latitude + 0.05, longitude + 0.05]]
        map_object.fit_bounds(bounds, padding=(20, 20))
    folium.LayerControl(collapsed=False).add_to(map_object)
    output.parent.mkdir(parents=True, exist_ok=True)
    map_object.save(output)
    return output, warnings


def static_map(datasets: list[Dataset], output: Path, satellite: bool = False) -> tuple[Path, list[str], list[str]]:
    warnings: list[str] = []
    dependencies: list[str] = []
    figure, axis = plt.subplots(figsize=(10, 7))
    plotted = False
    for index, dataset in enumerate(datasets):
        color = EPOS_COLORS[index % len(EPOS_COLORS)]
        if dataset.latitude and dataset.longitude:
            valid = dataset.frame.dropna(subset=[dataset.latitude, dataset.longitude])
            if len(valid) > MAX_STATIC_POINTS:
                warnings.append(f"Rendered {MAX_STATIC_POINTS} of {len(valid)} points in the static map for {dataset.label}")
                valid = _deterministic_sample(valid, MAX_STATIC_POINTS)
            if not valid.empty:
                axis.scatter(valid[dataset.longitude], valid[dataset.latitude], s=28, alpha=0.8, color=color, label=dataset.label)
                plotted = True
        if dataset.geojson:
            labelled = False
            for feature in dataset.geojson.get("features", []):
                geometry = feature.get("geometry") if isinstance(feature, dict) else None
                if not isinstance(geometry, dict) or geometry.get("type") == "Point":
                    continue
                for coordinates in _coordinate_paths(geometry.get("coordinates")):
                    if len(coordinates) < 2:
                        continue
                    x_values, y_values = zip(*coordinates)
                    axis.plot(x_values, y_values, color=color, linewidth=1.4, label=dataset.label if not labelled else None)
                    labelled = True
                    plotted = True
    if not plotted:
        plt.close(figure)
        raise ValueError("No valid point coordinates are available for a static map")
    axis.set_xlabel("Longitude (degrees)")
    axis.set_ylabel("Latitude (degrees)")
    axis.grid(True, alpha=0.25)
    axis.legend(loc="best")
    axis.set_title("EPOS observations")
    if satellite:
        dependencies.extend(["contextily", "rasterio", "pyproj"])
        try:
            contextily = importlib.import_module("contextily")
            contextily.add_basemap(
                axis,
                crs="EPSG:4326",
                source=xyz.NASAGIBS.BlueMarble,
                zoom=xyz.NASAGIBS.BlueMarble.get("max_zoom", 8),
                attribution=True,
            )
        except Exception as error:
            warnings.append(f"Satellite basemap unavailable; rendered coordinate grid instead: {error}")
    figure.tight_layout()
    output.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output, dpi=160)
    plt.close(figure)
    return output, warnings, dependencies
