---
name: epos-plot
description: Generates deterministic scientific plots for saved EPOS datasets from their declared format, fields and spatial or temporal coverage. Use after data has been downloaded and inspected.
---

# Deterministic EPOS visualization

Load `analysis` and work only inside the active study bundle. Call `epos_prepare_visualization`, run the saved `code/analysis.py` with `epos_run_python`, and use `epos_finalize_notebook` only if the researcher requests the notebook. Do not reproduce the reusable plotting library in a tool call or notebook.

## Requirements and defaults

Never hand-write `requirements.txt` or guess dependencies. `epos_finalize_notebook` must derive them from the actual imports and resolved visualization features, and must reject unmapped third-party imports. The generated notebook installs that file in its first cell with `%pip install -r requirements.txt`.
Generate and display static PNG outputs first with `interactive: false`. After they succeed, offer an interactive version; regenerate with `interactive: true` only after explicit confirmation and display the HTML in the terminal. Then propose a Jupyter Notebook with the code to reproduce it. Create the notebook only when explicitly requested and do not create a placeholder at the beginning of the study.

**Workflow ordering:** The agent must NEVER propose visualization or analysis options (plots, maps, scatter) before physically acquiring the data. Make your graphical proposals only based on the nature and quantity of the data just downloaded and verified.

Use the study context, scientific question, confirmed filters and dataset metadata already present in state. Ask a question only when the requested scientific comparison remains ambiguous. Never ask for coordinates when a selected resource or saved dataset already provides a bounding box, point geometry or coordinate columns.

Select the v2 recipe from the researcher's stated scientific request, then pass it to `epos_prepare_visualization`; do not infer a recipe merely from matching columns. Pass dataset roles (`events`, `stations`, `vector_overlay`, `raster`, `waveforms`) and mappings only when metadata resolves an ambiguity. The standard path produces a compact `visualization.json`, not generated plotting code.

Do not use a hardcoded place, center, extent, layer, CRS, endpoint or time range. Derive them from, in order:

1. confirmed study parameters;
2. authoritative resource or service metadata;
3. the saved dataset's coordinates and timestamps.

For a WMS-only PNG, pass the resulting `[west, south, east, north]` extent to `epos_prepare_visualization`; omit it when saved observations already define the map bounds.

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

Static maps use the token-free NASA GIBS satellite layer by default, render selected authoritative WMS layers in the PNG, and fall back to a coordinate grid when remote imagery is unavailable. Event markers scale with magnitude, the largest 10% use stars, and stations use triangles. Interactive maps additionally provide OpenStreetMap. Satellite imagery is visual context rather than scientific data; preserve provider attribution.

Every figure must include a legend and label both axes with units from metadata when available, or UTC/date context for temporal axes. Keep missing or invalid records out of the plotted subset but report how many were excluded. Automated observations are preliminary and must remain distinct from scientific validation.

## Outputs

Save figures and interactive HTML maps under `figures/`, configuration in `visualization.json`, detected fields and exclusions in `analysis-report.json`, parameters in `parameters.json`, and provenance in `provenance.json`. Report absolute output paths and display a PNG inline when supported.
