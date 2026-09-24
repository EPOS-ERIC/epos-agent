# EPOS reusable visualization v2

New study bundles receive `analysis.py`, the local `epos_viz` package, `visualization.schema.json`, and this versioned configuration contract:

```json
{
  "version": 2,
  "recipe": {
    "name": "seismic_catalog_standard",
    "parameters": { "magnitudeCompleteness": 1.5 }
  },
  "map": { "basemap": "satellite", "topography": false },
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

The report includes SHA-256 input hashes, detected fields, exclusions, output paths, backend warnings and exact installed library versions. The installer manages the shared `.venv`; optional packages are installed only for selected inputs/recipes. Standard operation is performed through `epos_prepare_visualization`, `epos_run_python` and, only after success and on request, `epos_finalize_notebook`.
