"""Interactive and static geographic maps for v2 EPOS datasets."""

from __future__ import annotations

import html
import importlib
import math
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import urlopen

import folium
import matplotlib.pyplot as plt
from folium.plugins import MarkerCluster
from matplotlib.ticker import MaxNLocator
import xyzservices.providers as xyz

from .data import DEPTH_NAMES, MAGNITUDE_NAMES, Dataset, _flatten_coordinates


EPOS_COLORS = ("#2B422D", "#C69436", "#3973AC", "#A64B3C", "#725A8C")
MAX_INTERACTIVE_FEATURES = 40_000
MAX_STATIC_POINTS = 200_000


def _deterministic_sample(frame: Any, limit: int) -> Any:
    if len(frame) <= limit:
        return frame
    return frame.iloc[::max(1, (len(frame) + limit - 1) // limit)].head(limit)


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


def _popup(dataset: Dataset, row: Any) -> str:
    return "<br>".join(f"<b>{html.escape(str(column))}</b>: {html.escape(str(row[column]))}" for column in dataset.frame.columns[:12]
                        if row[column] is not None and str(row[column]) != "nan")


def _is_station(dataset: Dataset) -> bool:
    return dataset.role == "stations"


def _numeric_map_axes(axis: Any) -> None:
    axis.xaxis.set_major_locator(MaxNLocator(nbins=7, min_n_ticks=4))
    axis.yaxis.set_major_locator(MaxNLocator(nbins=7, min_n_ticks=4))
    axis.set_xlabel("Longitude (degrees)")
    axis.set_ylabel("Latitude (degrees)")
    axis.grid(True, alpha=0.3)


def _map_extent(datasets: list[Dataset], configured: Any = None) -> tuple[float, float, float, float] | None:
    if isinstance(configured, list) and len(configured) == 4 and all(isinstance(value, (int, float)) for value in configured):
        west, south, east, north = (float(value) for value in configured)
        if west < east and south < north:
            return west, east, south, north
    bounds = _bounds(datasets)
    if bounds is None:
        return None
    south, west = bounds[0]
    north, east = bounds[1]
    latitude_padding = max(0.1, (north - south) * 0.12)
    longitude_padding = max(0.1, (east - west) * 0.12)
    return west - longitude_padding, east + longitude_padding, south - latitude_padding, north + latitude_padding


def _add_wms_layer(axis: Any, wms: dict[str, Any], extent: tuple[float, float, float, float]) -> None:
    west, east, south, north = extent
    split = urlsplit(wms["url"])
    query = dict(parse_qsl(split.query, keep_blank_values=True))
    query.update({
        "SERVICE": "WMS", "VERSION": "1.1.1", "REQUEST": "GetMap", "LAYERS": wms["layers"],
        "STYLES": "", "FORMAT": wms.get("format", "image/png"), "TRANSPARENT": "TRUE", "SRS": "EPSG:4326",
        "BBOX": f"{west},{south},{east},{north}", "WIDTH": "1400", "HEIGHT": "980",
    })
    request_url = urlunsplit((split.scheme, split.netloc, split.path, urlencode(query), split.fragment))
    with urlopen(request_url, timeout=20) as response:
        image_format = str(wms.get("format", "image/png")).split("/")[-1]
        image = plt.imread(BytesIO(response.read()), format=image_format)
    axis.imshow(image, extent=(west, east, south, north), origin="upper", aspect="auto", zorder=1)


def interactive_map(datasets: list[Dataset], output: Path, config: dict[str, Any]) -> tuple[Path, list[str]]:
    warnings: list[str] = []
    bounds = _bounds(datasets)
    center = [0.0, 0.0] if not bounds else [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]
    map_object = folium.Map(location=center, tiles=None, control_scale=True, prefer_canvas=True)
    basemap = config.get("basemap", "satellite")
    satellite_provider = None
    if basemap != "none":
        try:
            satellite_provider = xyz.NASAGIBS.BlueMarble
        except AttributeError as error:
            warnings.append(f"NASA GIBS basemap unavailable: {error}")
        folium.TileLayer(tiles=xyz.OpenStreetMap.Mapnik, name="OpenStreetMap", show=basemap != "satellite" or satellite_provider is None).add_to(map_object)
        if satellite_provider is not None:
            folium.TileLayer(tiles=satellite_provider, name="NASA GIBS Blue Marble", show=basemap == "satellite").add_to(map_object)
    for index, dataset in enumerate(datasets):
        color = EPOS_COLORS[index % len(EPOS_COLORS)]
        if dataset.geojson:
            features = dataset.geojson.get("features", [])
            if len(features) > MAX_INTERACTIVE_FEATURES:
                warnings.append(f"Rendered {MAX_INTERACTIVE_FEATURES} of {len(features)} features for {dataset.label}")
                features = features[:MAX_INTERACTIVE_FEATURES]
            property_sets = [set((feature.get("properties") or {}).keys()) for feature in features if isinstance(feature, dict)]
            fields = sorted(set.intersection(*property_sets))[:8] if property_sets else []
            folium.GeoJson({**dataset.geojson, "features": features}, name=dataset.label,
                           style_function=lambda _feature, selected=color: {"color": selected, "weight": 2, "fillOpacity": 0.35},
                           tooltip=folium.GeoJsonTooltip(fields=fields) if fields else None,
                           popup=folium.GeoJsonPopup(fields=fields) if fields else None).add_to(map_object)
        elif dataset.latitude and dataset.longitude:
            valid = dataset.frame.dropna(subset=[dataset.latitude, dataset.longitude])
            if len(valid) > MAX_INTERACTIVE_FEATURES:
                warnings.append(f"Rendered {MAX_INTERACTIVE_FEATURES} of {len(valid)} points for {dataset.label}")
                valid = _deterministic_sample(valid, MAX_INTERACTIVE_FEATURES)
            group: Any = folium.FeatureGroup(name=dataset.label).add_to(map_object)
            target: Any = MarkerCluster().add_to(group) if len(valid) > 100 and not _is_station(dataset) else group
            for _, row in valid.iterrows():
                location, popup = [float(row[dataset.latitude]), float(row[dataset.longitude])], folium.Popup(_popup(dataset, row), max_width=420)
                if _is_station(dataset):
                    folium.RegularPolygonMarker(location, number_of_sides=3, radius=7, rotation=0, color="#B00020", fill=True,
                                                fill_color="#E31A1C", fill_opacity=1, popup=popup).add_to(target)
                elif len(valid) > 100:
                    folium.Marker(location, popup=popup).add_to(target)
                else:
                    folium.CircleMarker(location, radius=5, color=color, fill=True, fill_opacity=0.8, popup=popup).add_to(target)
    for wms in config.get("wms", []):
        if not isinstance(wms, dict) or not all(isinstance(wms.get(key), str) for key in ("url", "layers", "attribution")):
            warnings.append("Skipped WMS entry without declared url, layers and attribution")
            continue
        folium.WmsTileLayer(url=wms["url"], layers=wms["layers"], name=wms.get("name", wms["layers"]), attr=wms["attribution"],
                            fmt=wms.get("format", "image/png"), transparent=True).add_to(map_object)
    if bounds:
        if bounds[0] == bounds[1]:
            latitude, longitude = bounds[0]
            bounds = [[latitude - 0.05, longitude - 0.05], [latitude + 0.05, longitude + 0.05]]
        map_object.fit_bounds(bounds, padding=(20, 20))
    folium.LayerControl(collapsed=False).add_to(map_object)
    output.parent.mkdir(parents=True, exist_ok=True)
    map_object.save(output)
    return output, warnings


def _pygmt_topographic_map(datasets: list[Dataset], output: Path) -> Path:
    pygmt = importlib.import_module("pygmt")
    bounds = _bounds(datasets)
    if bounds is None:
        raise ValueError("No valid point coordinates are available for a topographic map")
    south, west = bounds[0]
    north, east = bounds[1]
    latitude_padding, longitude_padding = max(0.03, (north - south) * 0.08), max(0.03, (east - west) * 0.08)
    region = [west - longitude_padding, east + longitude_padding, south - latitude_padding, north + latitude_padding]
    figure = pygmt.Figure()
    figure.grdimage(grid="@earth_relief_03m", region=region, projection="M15c", cmap="geo", shading=True, frame=["afg", "+tEPOS observations"])
    has_legend = False
    for dataset in datasets:
        if not dataset.latitude or not dataset.longitude:
            continue
        valid = dataset.frame.dropna(subset=[dataset.latitude, dataset.longitude])
        if _is_station(dataset):
            figure.plot(x=valid[dataset.longitude], y=valid[dataset.latitude], style="t0.24c", fill="red", pen="0.4p,black",
                        label=f"{dataset.label} (stations)")
            has_legend = True
        elif dataset.role == "events":
            magnitude = next((field for field in dataset.numeric if field.casefold() in MAGNITUDE_NAMES), None)
            magnitude_available = valid.dropna(subset=[magnitude]) if magnitude else valid.iloc[0:0]
            largest_count = max(1, math.ceil(len(magnitude_available) * 0.1))
            largest = set(magnitude_available.nlargest(largest_count, magnitude).index) if magnitude else set()
            ordinary, strongest = valid.loc[~valid.index.isin(largest)], valid.loc[valid.index.isin(largest)]
            if not ordinary.empty:
                figure.plot(x=ordinary[dataset.longitude], y=ordinary[dataset.latitude], style="c0.15c", fill="#3973AC",
                            pen="0.2p,black", label=dataset.label)
            if not strongest.empty:
                figure.plot(x=strongest[dataset.longitude], y=strongest[dataset.latitude], style="a0.3c", fill="#FFD54F",
                            pen="0.4p,black", label=f"Largest events (top 10% by {dataset.units.get(magnitude, magnitude)})")
            has_legend = True
    if has_legend:
        figure.legend(position="JTR+jTR+o0.2c", box="+gwhite+p0.5p")
    output.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(str(output))
    return output


def static_map(datasets: list[Dataset], output: Path, satellite: bool = False, config: dict[str, Any] | None = None) -> tuple[Path, list[str], list[str]]:
    config = config or {}
    warnings: list[str] = []
    dependencies: list[str] = []
    wms_layers = config.get("wms", []) if isinstance(config.get("wms"), list) else []
    if config.get("topography") and not satellite and not wms_layers:
        try:
            return _pygmt_topographic_map(datasets, output), warnings, ["pygmt"]
        except Exception as error:
            warnings.append(f"Topographic PyGMT map unavailable; rendered coordinate-grid fallback: {error}")
    figure, axis = plt.subplots(figsize=(10, 7))
    extent = _map_extent(datasets, config.get("extent"))
    if extent:
        west, east, south, north = extent
        axis.set_xlim(west, east)
        axis.set_ylim(south, north)
    attributions: list[str] = []
    plotted = False
    if satellite and extent:
        dependencies.extend(["contextily", "rasterio", "pyproj"])
        try:
            contextily = importlib.import_module("contextily")
            satellite_provider = getattr(xyz.NASAGIBS, "ViirsTrueColorCR", xyz.NASAGIBS.BlueMarble)
            contextily.add_basemap(axis, crs="EPSG:4326", source=satellite_provider,
                                   zoom=satellite_provider.get("max_zoom", 8), interpolation="nearest", attribution=False)
            attributions.append(f"Basemap: {satellite_provider.get('name', 'NASA GIBS satellite imagery')}")
            plotted = True
        except Exception as error:
            warnings.append(f"Satellite basemap unavailable; rendered coordinate grid instead: {error}")
    if extent:
        for wms in wms_layers:
            if not isinstance(wms, dict) or not all(isinstance(wms.get(key), str) for key in ("url", "layers", "attribution")):
                warnings.append("Skipped WMS entry without declared url, layers and attribution")
                continue
            try:
                _add_wms_layer(axis, wms, extent)
                attributions.append(f"WMS: {wms['attribution']}")
                axis.plot([], [], color="#725A8C", linewidth=6, alpha=0.7, label=wms.get("name", wms["layers"]))
                plotted = True
            except Exception as error:
                warnings.append(f"WMS layer {wms.get('name', wms['layers'])} unavailable in static map: {error}")
    for index, dataset in enumerate(datasets):
        color = EPOS_COLORS[index % len(EPOS_COLORS)]
        if dataset.latitude and dataset.longitude:
            valid = dataset.frame.dropna(subset=[dataset.latitude, dataset.longitude])
            if len(valid) > MAX_STATIC_POINTS:
                warnings.append(f"Rendered {MAX_STATIC_POINTS} of {len(valid)} points in the static map for {dataset.label}")
                valid = _deterministic_sample(valid, MAX_STATIC_POINTS)
            if not valid.empty:
                if _is_station(dataset):
                    axis.scatter(valid[dataset.longitude], valid[dataset.latitude], s=65, marker="^", color="#E31A1C",
                                 edgecolors="black", linewidths=0.4, label=f"{dataset.label} (stations)", zorder=4)
                else:
                    depth = next((field for field in dataset.numeric if field.casefold() in DEPTH_NAMES), None)
                    magnitude = next((field for field in dataset.numeric if field.casefold() in MAGNITUDE_NAMES), None)
                    sizes = 28
                    if dataset.role == "events" and magnitude:
                        sizes = valid[magnitude].copy()
                        sizes.loc[:] = 28
                        magnitude_available = valid.dropna(subset=[magnitude])
                        values = magnitude_available[magnitude]
                        if not magnitude_available.empty:
                            span = values.max() - values.min()
                            sizes.loc[magnitude_available.index] = 28 + (values - values.min()) / span * 72 if span else 55
                        largest_count = max(1, math.ceil(len(magnitude_available) * 0.1))
                        largest = set(magnitude_available.nlargest(largest_count, magnitude).index)
                        ordinary = valid.loc[~valid.index.isin(largest)]
                        strongest = valid.loc[valid.index.isin(largest)]
                        ordinary_sizes = sizes.loc[ordinary.index] if hasattr(sizes, "loc") else sizes
                        strongest_sizes = sizes.loc[strongest.index] if hasattr(sizes, "loc") else sizes
                    else:
                        ordinary, strongest = valid, valid.iloc[0:0]
                        ordinary_sizes, strongest_sizes = sizes, sizes
                    if depth and not ordinary.empty:
                        points = axis.scatter(ordinary[dataset.longitude], ordinary[dataset.latitude], s=ordinary_sizes, alpha=0.8,
                                              c=ordinary[depth], cmap="viridis", label=dataset.label, zorder=3)
                    else:
                        points = axis.scatter(ordinary[dataset.longitude], ordinary[dataset.latitude], s=ordinary_sizes, alpha=0.8,
                                              color=color, label=dataset.label, zorder=3)
                    if depth and not ordinary.empty:
                        figure.colorbar(points, ax=axis, label=dataset.units.get(depth, depth))
                    if not strongest.empty:
                        axis.scatter(strongest[dataset.longitude], strongest[dataset.latitude], s=strongest_sizes, marker="*",
                                     color="#FFD54F", edgecolors="black", linewidths=0.6,
                                     label=f"Largest events (top 10% by {dataset.units.get(magnitude, magnitude)})", zorder=5)
                plotted = True
        if dataset.geojson:
            labelled = False
            for feature in dataset.geojson.get("features", []):
                geometry = feature.get("geometry") if isinstance(feature, dict) else None
                if not isinstance(geometry, dict) or geometry.get("type") == "Point":
                    continue
                for coordinates in _coordinate_paths(geometry.get("coordinates")):
                    if len(coordinates) >= 2:
                        x_values, y_values = zip(*coordinates)
                        axis.plot(x_values, y_values, color=color, linewidth=1.4, label=dataset.label if not labelled else None)
                        labelled, plotted = True, True
    if not plotted:
        plt.close(figure)
        raise ValueError("No valid point coordinates are available for a static map")
    _numeric_map_axes(axis)
    axis.legend(loc="best")
    axis.set_title("EPOS observations")
    if attributions:
        figure.text(0.01, 0.01, " | ".join(attributions), fontsize=7, color="#444444")
    output.parent.mkdir(parents=True, exist_ok=True)
    figure.tight_layout()
    figure.savefig(output, dpi=160)
    plt.close(figure)
    return output, warnings, dependencies
