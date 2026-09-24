"""Versioned visualization recipes and fail-fast configuration validation."""

from __future__ import annotations

from typing import Any


DATASET_ROLES = {"events", "stations", "vector_overlay", "raster", "waveforms"}
RECIPE_NAMES = {
    "seismic_catalog_standard",
    "seismic_sequence",
    "focal_mechanism_standard",
    "hazard_map_standard",
    "custom",
}
PLOT_NAMES = {"distribution", "scatter", "time_series", "gutenberg_richter", "space_time", "vertical_section", "beachballs"}


def validate_configuration(config: Any) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise ValueError("visualization.json must be an object")
    if config.get("version") != 2:
        raise ValueError("visualization.json v1 is unsupported; recreate the study with version 2")
    recipe = config.get("recipe")
    if not isinstance(recipe, dict) or recipe.get("name") not in RECIPE_NAMES:
        raise ValueError(f"recipe.name must be one of: {', '.join(sorted(RECIPE_NAMES))}")
    datasets = config.get("datasets")
    if not isinstance(datasets, list):
        raise ValueError("datasets must be an array")
    for item in datasets:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("Every dataset requires a path")
        if item.get("role", "events") not in DATASET_ROLES:
            raise ValueError(f"Unsupported dataset role: {item.get('role')}")
        if "crs" in item and not isinstance(item["crs"], str):
            raise ValueError("datasets[].crs must be a CRS string")
        if "plots" in item and (not isinstance(item["plots"], list) or any(plot not in PLOT_NAMES for plot in item["plots"])):
            raise ValueError(f"datasets[].plots may contain only: {', '.join(sorted(PLOT_NAMES))}")
    map_config = config.get("map", {})
    if not isinstance(map_config, dict) or map_config.get("basemap", "satellite") not in {"street", "satellite", "none"}:
        raise ValueError("map.basemap must be street, satellite or none")
    if "topography" in map_config and not isinstance(map_config["topography"], bool):
        raise ValueError("map.topography must be boolean")
    extent = map_config.get("extent")
    if extent is not None and (not isinstance(extent, list) or len(extent) != 4
                               or any(not isinstance(value, (int, float)) for value in extent)
                               or extent[0] >= extent[2] or extent[1] >= extent[3]):
        raise ValueError("map.extent must be [west, south, east, north] with increasing bounds")
    if not isinstance(config.get("interactive", False), bool):
        raise ValueError("interactive must be boolean")
    return config


def recipe_parameters(config: dict[str, Any]) -> dict[str, Any]:
    recipe = config["recipe"]
    parameters = recipe.get("parameters", {})
    if not isinstance(parameters, dict):
        raise ValueError("recipe.parameters must be an object")
    completeness = parameters.get("magnitudeCompleteness")
    if completeness is not None and not isinstance(completeness, (int, float)):
        raise ValueError("recipe.parameters.magnitudeCompleteness must be numeric")
    return parameters
