---
name: epos-plot
description: Generates deterministic scientific plots for saved EPOS datasets from their declared format, fields and spatial or temporal coverage. Use after data has been downloaded and inspected.
---

# Deterministic EPOS visualization

Load `analysis` and work only inside the active study bundle. Prefer the saved `analysis.py`; the notebook must import it rather than duplicate its logic.

## Requirements and defaults

CRITICAL: Whenever you create a jupyter notebook, you MUST include a `requirements.txt` file in the study bundle with all the required libraries (e.g. `matplotlib`, `pandas`). Furthermore, the VERY FIRST CELL of the notebook MUST execute a script to install them (e.g. `!pip install -r requirements.txt` or `!pip install matplotlib pandas`). Do not rely on global system packages; assume the environment is completely bare. This is mandatory to prevent `ModuleNotFoundError`.
Create or propose the creation of the Jupyter Notebook ONLY if explicitly requested by the user, or only AT THE END of the workflow, after having successfully validated the analysis/plot in Python (`analysis.py`). Do not create the notebook at the beginning of the task.

**Workflow ordering:** The agent must NEVER propose visualization or analysis options (plots, maps, scatter) before physically acquiring the data. Make your graphical proposals only based on the nature and quantity of the data just downloaded and verified.

Use the study context, scientific question, confirmed filters and dataset metadata already present in state. Ask a question only when the requested scientific comparison remains ambiguous. Never ask for coordinates when a selected resource or saved dataset already provides a bounding box, point geometry or coordinate columns.

Do not use a hardcoded place, center, extent, layer, CRS, endpoint or time range. Derive them from, in order:

1. confirmed study parameters;
2. authoritative resource or service metadata;
3. the saved dataset's coordinates and timestamps.

If none is available, ask for one reference point or a latitude/longitude pair. Do not ask for both.

## Format inspection

Inspect before plotting and record detected format, fields, record count, missing values and usable coordinate/time columns.

- CSV, JSON and JSONL: use declared or detected columns; do not assume column names without checking them.
- GeoJSON: use feature geometries and properties; derive the extent from valid geometries.
- CoverageJSON: use declared axes, ranges and referencing.
- XML/OGC: parse capabilities first and use only declared layers, feature types, coverages, CRS and extents.
- Binary or unsupported data: do not invent a decoder or plot. Report that deterministic visualization is unavailable and preserve the file for later analysis.

## Plot selection

Choose the smallest set that answers the scientific question:

- point coordinates: spatial map with extent derived from valid data plus a small proportional padding;
- timestamps and a numeric variable: time series or scatter plot;
- event-like records: counts through time and distributions of relevant numeric variables;
- gridded coverage: raster or contour plot using declared axes and CRS;
- OGC map layer: render the declared layer for the confirmed extent, then overlay compatible saved observations when requested.

Label axes with units from metadata when available. Keep missing or invalid records out of the plotted subset but report how many were excluded. Automated observations are preliminary and must remain distinct from scientific validation.

## Outputs

Save figures under `figures/`, reusable plotting logic in `analysis.py`, parameters and source paths in `parameters.json`, and provenance in `provenance.json`. Prefer PNG for a portable preview and SVG when a vector result is appropriate. Report absolute output paths and display an image inline when supported.
