# EPOS reusable visualization

New study bundles receive `analysis.py`, the local `epos_viz` package and this compact configuration contract:

```json
{
  "version": 1,
  "mode": "auto",
  "basemap": "street",
  "datasets": [
    {
      "path": "data/events.jsonl",
      "label": "Events",
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

Leave `datasets` empty for automatic discovery. `basemap` accepts `street`, `satellite` or `none`. A scatter plot is never inferred: request `scatter` and provide `mapping.x` and `mapping.y`. WMS entries require `url`, `layers` and `attribution` from authoritative metadata.

The installer manages the shared `.venv`. Standard operation is performed through `epos_prepare_visualization`, `epos_run_python` and, only after success and on request, `epos_finalize_notebook`.
