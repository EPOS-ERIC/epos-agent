# EPOS reusable visualization v2

New study bundles receive `code/analysis.py`, the local `code/epos_viz` package, `code/visualization.schema.json`, and this versioned configuration contract in `code/visualization.json`:

```json
{
  "version": 2,
  "recipe": {
    "name": "seismic_catalog_standard",
    "parameters": { "magnitudeCompleteness": 1.5 }
  },
  "map": { "basemap": "none", "topography": false },
  "interactive": false,
  "datasets": [
    {
      "path": "data/events.jsonl",
      "label": "Events",
      "role": "events",
      "mapping": {
        "latitude": "latitude",
        "longitude": "longitude",
        "time": "time",
        "value": "magnitude"
      },
      "units": { "magnitude": "Mw" },
      "plots": ["distribution"]
    }
  ],
  "wms": []
}
```

Version 1 is intentionally unsupported. Recipes are selected from the researcher's request: `seismic_catalog_standard`, `seismic_sequence`, `focal_mechanism_standard`, `hazard_map_standard`, or `custom`. Dataset roles are `events`, `stations`, `vector_overlay`, `raster`, and `waveforms`; stations are filled red triangles, event size follows magnitude, and the largest 10% of events are stars. Interactive HTML is generated only when `interactive` is explicitly enabled after the static PNG. A scatter plot is never inferred: request `scatter` and provide `mapping.x` and `mapping.y`.

Supported inputs are CSV, JSON/JSONL/GeoJSON, CoverageJSON, GeoTIFF/COG, Parquet, Shapefile, GeoPackage, QuakeML, StationXML and miniSEED. Non-WGS84 tabular coordinates require `datasets[].crs`; vector sources are reprojected to EPSG:4326. Topography uses PyGMT only when GMT is installed, otherwise the static map records its coordinate-grid fallback. WMS entries require `url`, `layers` and `attribution` from authoritative metadata.

The report includes SHA-256 input hashes, detected fields, exclusions, output paths, backend warnings and exact installed library versions. The installer manages the shared `.venv`; optional packages are installed only for selected inputs/recipes. `epos_suggest_visualizations` inspects complete files from the current acquisition plan and saves full field statistics in `metadata/inspection.json`. Unsupported inputs and partial downloads are not silently treated as complete datasets.

Configure the selected visualization with `epos_prepare_visualization`, then execute `code/analysis.py` with `epos_run_python`. A successful run automatically creates and executes the notebook in a temporary copy of the bundle, using the same Python environment. Verification compares input hashes, record counts, metrics and output names and checks that acquisition metadata was not changed. `epos_finalize_notebook` can retry finalization after an error; a stale report alone is insufficient. Default static figures require no remote tiles. Interactive maps and remote layers may still require network access.

The notebook contains reusable imports and executed outputs; its introductory cell explains dependency installation. Requirements are pinned from the actual environment. Verification needs `nbclient` and `ipykernel`, installed through `requirements-core.txt`, and permission to open local Jupyter sockets.
