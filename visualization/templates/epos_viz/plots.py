"""Deterministic scientific plots selected from inspected data fields."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np

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


def time_series(dataset: Dataset, output: Path) -> Path:
    if not dataset.time or not dataset.numeric:
        raise ValueError("A time column and at least one numeric field are required")
    fields = dataset.numeric[:3]
    figure, axes = plt.subplots(len(fields), 1, figsize=(11, max(4, 3 * len(fields))), sharex=True, squeeze=False)
    ordered = dataset.frame.sort_values(dataset.time)
    for axis, field in zip(axes[:, 0], fields):
        valid = ordered.dropna(subset=[dataset.time, field])
        axis.plot(valid[dataset.time], valid[field], linewidth=1.2, marker=".", markersize=3)
        axis.set_ylabel(_label(dataset, field))
        axis.grid(True, alpha=0.25)
    axes[-1, 0].set_xlabel("Time (UTC)")
    figure.suptitle(dataset.label)
    return _save(figure, output)


def event_summary(dataset: Dataset, output: Path) -> Path:
    magnitude = next((column for column in dataset.numeric if column.casefold() in MAGNITUDE_NAMES), None)
    depth = next((column for column in dataset.numeric if column.casefold() in DEPTH_NAMES), None)
    panels = int(dataset.time is not None) + int(magnitude is not None) + int(depth is not None)
    if not panels:
        raise ValueError("No event time, magnitude or depth fields were detected")
    figure, axes = plt.subplots(1, panels, figsize=(5 * panels, 4), squeeze=False)
    cursor = 0
    if dataset.time:
        valid = dataset.frame.dropna(subset=[dataset.time]).set_index(dataset.time)
        counts = valid.resample("D").size()
        axes[0, cursor].plot(counts.index, counts.values, linewidth=1.2)
        axes[0, cursor].set_title("Events per day")
        axes[0, cursor].set_xlabel("Time (UTC)")
        cursor += 1
    for field, title in ((magnitude, "Magnitude distribution"), (depth, "Depth distribution")):
        if field:
            axes[0, cursor].hist(dataset.frame[field].dropna(), bins="auto", color="#2B422D", alpha=0.8)
            axes[0, cursor].set_title(title)
            axes[0, cursor].set_xlabel(_label(dataset, field))
            cursor += 1
    for axis in axes[0]:
        axis.grid(True, alpha=0.2)
    return _save(figure, output)


def distribution(dataset: Dataset, output: Path) -> Path:
    if not dataset.numeric:
        raise ValueError("At least one numeric field is required")
    fields = dataset.numeric[:3]
    figure, axes = plt.subplots(1, len(fields), figsize=(5 * len(fields), 4), squeeze=False)
    for axis, field in zip(axes[0], fields):
        axis.hist(dataset.frame[field].dropna(), bins="auto", color="#3973AC", alpha=0.8)
        axis.set_title(_label(dataset, field))
        axis.grid(True, alpha=0.2)
    return _save(figure, output)


def scatter(dataset: Dataset, output: Path, x: str, y: str) -> Path:
    if x not in dataset.frame or y not in dataset.frame:
        raise ValueError(f"Scatter fields are missing: {x}, {y}")
    figure, axis = plt.subplots(figsize=(7, 6))
    valid = dataset.frame.dropna(subset=[x, y])
    axis.scatter(valid[x], valid[y], alpha=0.75, color="#C69436")
    axis.set_xlabel(_label(dataset, x))
    axis.set_ylabel(_label(dataset, y))
    axis.grid(True, alpha=0.25)
    axis.set_title(dataset.label)
    return _save(figure, output)


def raster(dataset: Dataset, output: Path) -> Path:
    if not dataset.grid:
        raise ValueError("A gridded CoverageJSON range is required")
    grid = dataset.grid
    values = np.asarray(grid["values"], dtype=float).reshape(grid["shape"])
    figure, axis = plt.subplots(figsize=(9, 6))
    image = axis.pcolormesh(grid["x"], grid["y"], values, shading="auto", cmap="viridis")
    figure.colorbar(image, ax=axis, label=_label(dataset, grid["name"]))
    axis.set_xlabel("x")
    axis.set_ylabel("y")
    axis.set_title(dataset.label)
    return _save(figure, output)
