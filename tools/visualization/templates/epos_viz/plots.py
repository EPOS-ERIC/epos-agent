"""Deterministic, numerically annotated scientific plots for v2 datasets."""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.ticker import MaxNLocator

from .data import DEPTH_NAMES, MAGNITUDE_NAMES, Dataset


def _save(figure: Any, output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    figure.tight_layout()
    figure.savefig(output, dpi=160)
    plt.close(figure)
    return output


def _label(dataset: Dataset, field: str) -> str:
    unit = dataset.units.get(field)
    return f"{field} ({unit})" if unit else field


def _numeric_axes(axis: Any, x: bool = True, y: bool = True) -> None:
    if x:
        axis.xaxis.set_major_locator(MaxNLocator(nbins=7, min_n_ticks=4))
    if y:
        axis.yaxis.set_major_locator(MaxNLocator(nbins=7, min_n_ticks=4))
    axis.grid(True, alpha=0.25)


def magnitude_field(dataset: Dataset) -> str | None:
    return next((column for column in dataset.numeric if column.casefold() in MAGNITUDE_NAMES), None)


def depth_field(dataset: Dataset) -> str | None:
    return next((column for column in dataset.numeric if column.casefold() in DEPTH_NAMES), None)


def time_series(dataset: Dataset, output: Path) -> Path:
    if not dataset.time or not dataset.numeric:
        raise ValueError("A time column and at least one numeric field are required")
    fields = dataset.numeric[:3]
    figure, axes = plt.subplots(len(fields), 1, figsize=(11, max(4, 3 * len(fields))), sharex=True, squeeze=False)
    ordered = dataset.frame.sort_values(dataset.time)
    for axis, field in zip(axes[:, 0], fields):
        valid = ordered.dropna(subset=[dataset.time, field])
        axis.plot(valid[dataset.time], valid[field], linewidth=1.2, marker=".", markersize=3, label=_label(dataset, field))
        axis.set_ylabel(_label(dataset, field))
        axis.legend(loc="best")
        _numeric_axes(axis, x=False)
    axes[-1, 0].set_xlabel("Time (UTC)")
    figure.suptitle(dataset.label)
    return _save(figure, output)


def event_summary(dataset: Dataset, output: Path) -> Path:
    magnitude, depth = magnitude_field(dataset), depth_field(dataset)
    panels = int(dataset.time is not None) + int(magnitude is not None) + int(depth is not None)
    if not panels:
        raise ValueError("No event time, magnitude or depth fields were detected")
    figure, axes = plt.subplots(1, panels, figsize=(5 * panels, 4), squeeze=False)
    cursor = 0
    if dataset.time:
        valid = dataset.frame.dropna(subset=[dataset.time]).set_index(dataset.time)
        counts = valid.resample("D").size()
        axes[0, cursor].plot(counts.index, counts.values, linewidth=1.2, label="Events per day")
        axes[0, cursor].set_title("Events per day")
        axes[0, cursor].set_xlabel("Time (UTC)")
        axes[0, cursor].set_ylabel("Event count")
        axes[0, cursor].legend(loc="best")
        _numeric_axes(axes[0, cursor], x=False)
        cursor += 1
    for field, title in ((magnitude, "Magnitude distribution"), (depth, "Depth distribution")):
        if field:
            axes[0, cursor].hist(dataset.frame[field].dropna(), bins="auto", color="#2B422D", alpha=0.8,
                                 label=_label(dataset, field))
            axes[0, cursor].set_title(title)
            axes[0, cursor].set_xlabel(_label(dataset, field))
            axes[0, cursor].set_ylabel("Event count")
            axes[0, cursor].legend(loc="best")
            _numeric_axes(axes[0, cursor])
            cursor += 1
    return _save(figure, output)


def distribution(dataset: Dataset, output: Path) -> Path:
    if not dataset.numeric:
        raise ValueError("At least one numeric field is required")
    fields = dataset.numeric[:3]
    figure, axes = plt.subplots(1, len(fields), figsize=(5 * len(fields), 4), squeeze=False)
    for axis, field in zip(axes[0], fields):
        axis.hist(dataset.frame[field].dropna(), bins="auto", color="#3973AC", alpha=0.8, label=_label(dataset, field))
        axis.set_title(_label(dataset, field))
        axis.set_xlabel(_label(dataset, field))
        axis.set_ylabel("Observation count")
        axis.legend(loc="best")
        _numeric_axes(axis)
    return _save(figure, output)


def scatter(dataset: Dataset, output: Path, x: str, y: str) -> Path:
    if x not in dataset.frame or y not in dataset.frame:
        raise ValueError(f"Scatter fields are missing: {x}, {y}")
    figure, axis = plt.subplots(figsize=(7, 6))
    valid = dataset.frame.dropna(subset=[x, y])
    axis.scatter(valid[x], valid[y], alpha=0.75, color="#C69436", label=dataset.label)
    axis.set_xlabel(_label(dataset, x))
    axis.set_ylabel(_label(dataset, y))
    axis.set_title(dataset.label)
    axis.legend(loc="best")
    _numeric_axes(axis)
    return _save(figure, output)


def raster(dataset: Dataset, output: Path) -> Path:
    if not dataset.grid:
        raise ValueError("A gridded CoverageJSON or GeoTIFF range is required")
    grid = dataset.grid
    values = np.asarray(grid["values"], dtype=float).reshape(grid["shape"])
    figure, axis = plt.subplots(figsize=(9, 6))
    image = axis.pcolormesh(grid["x"], grid["y"], values, shading="auto", cmap="viridis")
    figure.colorbar(image, ax=axis, label=_label(dataset, grid["name"]))
    axis.set_xlabel(_label(dataset, "x"))
    axis.set_ylabel(_label(dataset, "y"))
    axis.set_title(dataset.label)
    _numeric_axes(axis)
    return _save(figure, output)


def gutenberg_richter(dataset: Dataset, output: Path, completeness: float | None) -> tuple[Path, dict[str, float | int | None]]:
    magnitude = magnitude_field(dataset)
    if magnitude is None:
        raise ValueError("Gutenberg-Richter requires a magnitude field")
    values = np.sort(dataset.frame[magnitude].dropna().to_numpy(dtype=float))
    if len(values) < 2:
        raise ValueError("Gutenberg-Richter requires at least two magnitudes")
    bins = np.round(np.arange(np.floor(values.min() * 10) / 10, values.max() + 0.1001, 0.1), 2)
    cumulative = np.asarray([(values >= value).sum() for value in bins], dtype=float)
    selected = (bins >= completeness) & (cumulative > 0) if completeness is not None else np.zeros(len(bins), dtype=bool)
    b_value: float | None = None
    if selected.sum() >= 2:
        slope, _ = np.polyfit(bins[selected], np.log10(cumulative[selected]), 1)
        b_value = float(-slope)
    figure, axis = plt.subplots(figsize=(8, 5))
    axis.semilogy(bins, cumulative, marker="o", linewidth=1.2, label="Cumulative catalog")
    if completeness is not None:
        axis.axvline(completeness, color="#A64B3C", linestyle="--", label=f"Mc = {completeness:g}")
    if b_value is not None:
        axis.text(0.98, 0.95, f"b = {b_value:.2f}", ha="right", va="top", transform=axis.transAxes)
    axis.set_xlabel(_label(dataset, magnitude))
    axis.set_ylabel("Cumulative event count")
    axis.set_title("Gutenberg–Richter frequency–magnitude")
    axis.legend(loc="best")
    _numeric_axes(axis)
    return _save(figure, output), {"magnitudeCompleteness": completeness, "bValue": b_value, "events": int(len(values))}


def space_time(dataset: Dataset, output: Path) -> Path:
    if not dataset.time or not dataset.latitude or not dataset.longitude:
        raise ValueError("Space-time plot requires time, latitude and longitude")
    figure, axes = plt.subplots(1, 2, figsize=(12, 5), sharey=True)
    valid = dataset.frame.dropna(subset=[dataset.time, dataset.latitude, dataset.longitude])
    for axis, field, label in zip(axes, (dataset.longitude, dataset.latitude), ("Longitude (degrees)", "Latitude (degrees)")):
        axis.scatter(valid[dataset.time], valid[field], s=18, alpha=0.75, color="#3973AC", label=dataset.label)
        axis.set_xlabel("Time (UTC)")
        axis.set_ylabel(label)
        axis.legend(loc="best")
        _numeric_axes(axis, x=False)
    figure.suptitle(f"Space-time evolution: {dataset.label}")
    return _save(figure, output)


def vertical_section(dataset: Dataset, output: Path, axis_name: str = "longitude") -> Path:
    depth = depth_field(dataset)
    if depth is None or not dataset.latitude or not dataset.longitude:
        raise ValueError("Vertical section requires depth and coordinates")
    field = dataset.longitude if axis_name == "longitude" else dataset.latitude
    figure, axis = plt.subplots(figsize=(9, 5))
    valid = dataset.frame.dropna(subset=[field, depth])
    color = valid[magnitude_field(dataset)] if magnitude_field(dataset) else "#3973AC"
    scatter_plot = axis.scatter(valid[field], valid[depth], c=color, s=25, alpha=0.8, cmap="viridis", label=dataset.label)
    if magnitude_field(dataset):
        figure.colorbar(scatter_plot, ax=axis, label=_label(dataset, magnitude_field(dataset) or "magnitude"))
    axis.invert_yaxis()
    axis.set_xlabel(f"{axis_name.title()} (degrees)")
    axis.set_ylabel(_label(dataset, depth))
    axis.set_title(f"Vertical hypocentral section: {dataset.label}")
    axis.legend(loc="best")
    _numeric_axes(axis)
    return _save(figure, output)


def catalog_dashboard(dataset: Dataset, output: Path) -> Path:
    magnitude, depth = magnitude_field(dataset), depth_field(dataset)
    figure, axes = plt.subplots(2, 2, figsize=(12, 9))
    if dataset.time and magnitude:
        valid = dataset.frame.dropna(subset=[dataset.time, magnitude]).sort_values(dataset.time)
        axes[0, 0].plot(valid[dataset.time], valid[magnitude], marker=".", linewidth=0.8, label=_label(dataset, magnitude))
        axes[0, 0].set_xlabel("Time (UTC)")
        axes[0, 0].set_ylabel(_label(dataset, magnitude))
        axes[0, 0].legend(loc="best")
        _numeric_axes(axes[0, 0], x=False)
    if magnitude:
        axes[0, 1].hist(dataset.frame[magnitude].dropna(), bins="auto", color="#2B422D", label=_label(dataset, magnitude))
        axes[0, 1].set_xlabel(_label(dataset, magnitude))
        axes[0, 1].set_ylabel("Event count")
        axes[0, 1].legend(loc="best")
        _numeric_axes(axes[0, 1])
    if depth:
        axes[1, 0].hist(dataset.frame[depth].dropna(), bins="auto", color="#3973AC", label=_label(dataset, depth))
        axes[1, 0].set_xlabel(_label(dataset, depth))
        axes[1, 0].set_ylabel("Event count")
        axes[1, 0].legend(loc="best")
        _numeric_axes(axes[1, 0])
    if dataset.latitude and dataset.longitude:
        valid = dataset.frame.dropna(subset=[dataset.latitude, dataset.longitude])
        axes[1, 1].scatter(valid[dataset.longitude], valid[dataset.latitude], s=18, alpha=0.7, label=dataset.label)
        axes[1, 1].set_xlabel("Longitude (degrees)")
        axes[1, 1].set_ylabel("Latitude (degrees)")
        axes[1, 1].legend(loc="best")
        _numeric_axes(axes[1, 1])
    figure.suptitle(f"Seismic catalog summary: {dataset.label}")
    return _save(figure, output)


def beachballs(dataset: Dataset, output: Path) -> Path:
    required = {"strike", "dip", "rake"}
    if not required.issubset(dataset.frame.columns):
        raise ValueError("Beachball plot requires strike, dip and rake")
    try:
        beach = importlib.import_module("obspy.imaging.beachball").beach
    except ImportError as error:
        raise ValueError("obspy is required for beachball plots") from error
    valid = dataset.frame.dropna(subset=list(required)).head(20)
    if valid.empty:
        raise ValueError("No complete focal mechanisms were available")
    figure, axis = plt.subplots(figsize=(max(6, len(valid) * 1.1), 3))
    for index, (_, row) in enumerate(valid.iterrows()):
        collection = beach([row["strike"], row["dip"], row["rake"]], xy=(index, 0), width=0.8)
        axis.add_collection(collection)
    axis.set_xlim(-1, len(valid))
    axis.set_ylim(-0.8, 0.8)
    axis.set_aspect("equal")
    axis.set_xticks(range(len(valid)))
    axis.set_xlabel("Event index")
    axis.set_yticks([])
    axis.set_title(f"Focal mechanisms: {dataset.label}")
    axis.scatter([], [], marker="o", facecolors="none", edgecolors="black", label="Focal mechanism")
    axis.legend(loc="best")
    return _save(figure, output)


def interactive_plot(dataset: Dataset, output: Path, kind: str, x: str | None = None, y: str | None = None) -> Path:
    try:
        express = importlib.import_module("plotly.express")
    except ImportError as error:
        raise ValueError("plotly is required for interactive plots") from error
    if kind == "time_series":
        if not dataset.time or not dataset.numeric:
            raise ValueError("Interactive time series requires time and numeric fields")
        figure = express.line(dataset.frame, x=dataset.time, y=dataset.numeric[:3], title=dataset.label)
        figure.update_xaxes(title_text="Time (UTC)")
        figure.update_yaxes(title_text="Value (units in legend)")
        figure.for_each_trace(lambda trace: trace.update(name=_label(dataset, str(trace.name))))
    elif kind == "scatter":
        if not x or not y:
            raise ValueError("Interactive scatter requires x and y")
        figure = express.scatter(dataset.frame, x=x, y=y, title=dataset.label, labels={x: _label(dataset, x), y: _label(dataset, y)})
    else:
        raise ValueError(f"Unsupported interactive plot: {kind}")
    output.parent.mkdir(parents=True, exist_ok=True)
    figure.write_html(output, include_plotlyjs="cdn", full_html=True)
    return output
