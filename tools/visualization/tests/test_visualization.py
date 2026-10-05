from __future__ import annotations

import importlib.util
import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
TEMPLATES = ROOT / "visualization" / "templates"
sys.path.insert(0, str(TEMPLATES))
sys.path.insert(0, str(ROOT / "visualization"))

HAS_CORE = all(importlib.util.find_spec(module) for module in ("numpy", "pandas", "matplotlib", "folium", "xyzservices"))
HAS_RASTER = importlib.util.find_spec("rasterio") is not None


@unittest.skipUnless(HAS_CORE, "visualization core dependencies are not installed")
class DataAndPlotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.bundle = Path(self.temporary.name).resolve()
        (self.bundle / "data").mkdir()
        (self.bundle / "figures").mkdir()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_supported_fixtures_and_outputs(self) -> None:
        (self.bundle / "data" / "points.csv").write_text(
            "time,latitude,longitude,value\n2026-01-01T00:00:00Z,43.1,12.2,1.5\n2026-01-02T00:00:00Z,999,12.3,2.5\n",
            encoding="utf-8",
        )
        (self.bundle / "data" / "events.jsonl").write_text(
            '{"time":"2026-01-01T00:00:00Z","latitude":43.2,"longitude":12.1,"magnitude":2.1,"depth":5}\n'
            '{"time":"2026-01-02T00:00:00Z","latitude":43.3,"longitude":12.4,"magnitude":2.8,"depth":8}\n',
            encoding="utf-8",
        )
        geojson = {
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature", "properties": {"name": "valid"}, "geometry": {"type": "Point", "coordinates": [12.25, 43.15]}},
                {"type": "Feature", "properties": {"name": "line"}, "geometry": {"type": "LineString", "coordinates": [[12.0, 43.0], [12.5, 43.5]]}},
            ],
        }
        (self.bundle / "data" / "features.geojson").write_text(json.dumps(geojson), encoding="utf-8")
        coverage = {
            "type": "Coverage",
            "domain": {"axes": {"y": {"values": [43.0, 43.5]}, "x": {"values": [12.0, 12.5]}}},
            "ranges": {"temperature": {"axisNames": ["y", "x"], "values": [1, 2, 3, 4]}},
        }
        (self.bundle / "data" / "grid.json").write_text(json.dumps(coverage), encoding="utf-8")
        (self.bundle / "visualization.json").write_text(
            json.dumps({
                "version": 2,
                "recipe": {"name": "custom"},
                "datasets": [{"path": "data/points.csv", "role": "events", "plots": ["time_series"]}],
                "map": {"basemap": "street", "topography": False},
                "interactive": True,
            }),
            encoding="utf-8",
        )
        from epos_viz import run

        report = run(self.bundle)

        self.assertEqual(len(report["datasets"]), 1)
        self.assertTrue((self.bundle / "figures" / "interactive-map.html").exists())
        self.assertTrue((self.bundle / "figures" / "static-map.png").exists())
        self.assertLess(report["outputs"].index(str(self.bundle / "figures" / "static-map.png")),
                        report["outputs"].index(str(self.bundle / "figures" / "interactive-map.html")))
        self.assertTrue(any(path.endswith("-time-series.png") for path in report["outputs"]))
        self.assertTrue((self.bundle / "metadata" / "analysis-report.json").exists())
        self.assertTrue(report["inputs"][0]["sha256"])
        csv_summary = report["datasets"][0]
        self.assertEqual(csv_summary["excludedCoordinates"], 1)
        html = (self.bundle / "figures" / "interactive-map.html").read_text(encoding="utf-8")
        self.assertIn("NASA GIBS Blue Marble", html)
        self.assertIn("Global Imagery Browse Services", html)
        self.assertIn("OpenStreetMap", html)

    def test_v1_configuration_is_rejected(self) -> None:
        (self.bundle / "visualization.json").write_text(json.dumps({"version": 1, "datasets": []}), encoding="utf-8")
        from epos_viz import run

        with self.assertRaisesRegex(ValueError, "v1 is unsupported"):
            run(self.bundle)

    def test_seismic_recipe_renders_stations_and_frequency_magnitude(self) -> None:
        (self.bundle / "data" / "events.csv").write_text(
            "time,latitude,longitude,magnitude,depth_km\n"
            "2026-01-01T00:00:00Z,43.1,12.2,1.5,5\n"
            "2026-01-02T00:00:00Z,43.2,12.3,1.8,7\n"
            "2026-01-03T00:00:00Z,43.3,12.4,2.1,9\n",
            encoding="utf-8",
        )
        (self.bundle / "data" / "stations.csv").write_text("station,latitude,longitude\nAAA,43.15,12.25\n", encoding="utf-8")
        (self.bundle / "visualization.json").write_text(json.dumps({
            "version": 2,
            "recipe": {"name": "seismic_catalog_standard", "parameters": {"magnitudeCompleteness": 1.5}},
            "datasets": [
                {"path": "data/events.csv", "role": "events"},
                {"path": "data/stations.csv", "role": "stations"},
            ],
            "map": {"basemap": "none", "topography": False},
            "interactive": False,
        }), encoding="utf-8")
        from epos_viz import run

        report = run(self.bundle)

        self.assertTrue((self.bundle / "figures" / "gutenberg-richter.png").exists())
        self.assertTrue((self.bundle / "figures" / "seismic-catalog-dashboard.png").exists())
        self.assertIsNotNone(report["metrics"]["gutenbergRichter"]["bValue"])
        self.assertFalse((self.bundle / "figures" / "interactive-map.html").exists())

    def test_static_map_composes_declared_wms(self) -> None:
        from epos_viz.maps import static_map

        wms = {"url": "https://example.test/wms", "layers": "volcanic", "attribution": "Test provider"}
        with patch("epos_viz.maps._add_wms_layer") as add_wms:
            output, warnings, _ = static_map(
                [], self.bundle / "figures" / "wms.png",
                config={"topography": False, "extent": [12.0, 36.0, 16.0, 39.0], "wms": [wms]},
            )
        self.assertTrue(output.exists())
        self.assertEqual(warnings, [])
        add_wms.assert_called_once()

    def test_satellite_failure_falls_back_to_coordinate_grid(self) -> None:
        from epos_viz.data import load_dataset
        from epos_viz.maps import static_map

        path = self.bundle / "data" / "points.csv"
        path.write_text("latitude,longitude,value\n43.1,12.2,1\n", encoding="utf-8")
        dataset = load_dataset(path)
        real_import_module = importlib.import_module
        def offline_contextily(name: str, package: str | None = None):
            if name == "contextily":
                raise ImportError("offline")
            return real_import_module(name, package)
        with patch("epos_viz.maps.importlib.import_module", side_effect=offline_contextily):
            output, warnings, dependencies = static_map([dataset], self.bundle / "figures" / "fallback.png", satellite=True)
        self.assertTrue(output.exists())
        self.assertTrue(any("coordinate grid" in warning for warning in warnings))
        self.assertIn("contextily", dependencies)

    @unittest.skipUnless(HAS_RASTER, "rasterio is not installed")
    def test_geotiff_is_loaded_as_a_grid(self) -> None:
        import numpy as np
        import rasterio
        from rasterio.transform import from_origin
        from epos_viz.data import load_dataset
        from epos_viz.plots import raster

        path = self.bundle / "data" / "grid.tif"
        with rasterio.open(
            path, "w", driver="GTiff", height=2, width=2, count=1, dtype="float32",
            crs="EPSG:4326", transform=from_origin(12.0, 44.0, 0.5, 0.5),
        ) as destination:
            destination.write(np.asarray([[1, 2], [3, 4]], dtype="float32"), 1)
        dataset = load_dataset(path)
        self.assertEqual(dataset.grid["shape"], [2, 2])
        output = raster(dataset, self.bundle / "figures" / "geotiff.png")
        self.assertTrue(output.exists())


class RequirementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.bundle = Path(self.temporary.name)
        (self.bundle / "code" / "epos_viz").mkdir(parents=True)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_stdlib_and_local_imports_are_excluded(self) -> None:
        from sync_requirements import imported_modules

        source = self.bundle / "code" / "analysis.py"
        source.write_text("import json\nfrom pathlib import Path\nfrom epos_viz import run\nimport pandas as pd\n", encoding="utf-8")
        self.assertEqual(imported_modules([source]), {"json", "pathlib", "epos_viz", "pandas"})

    def test_unknown_import_is_rejected(self) -> None:
        from sync_requirements import requirements_for_bundle

        (self.bundle / "code" / "analysis.py").write_text("import unknown_science_package\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Unmapped third-party imports"):
            requirements_for_bundle(self.bundle)

    @unittest.skipUnless(importlib.util.find_spec("pandas"), "pandas is not installed")
    def test_installed_versions_are_pinned(self) -> None:
        from sync_requirements import requirements_for_bundle

        (self.bundle / "code" / "analysis.py").write_text("import json\nimport pandas\n", encoding="utf-8")
        requirements = requirements_for_bundle(self.bundle)
        self.assertEqual(len(requirements), 1)
        self.assertRegex(requirements[0], r"^pandas==\d")

    @unittest.skipUnless(importlib.util.find_spec("contextily"), "optional map dependencies are not installed")
    def test_resolved_optional_dependencies_are_included(self) -> None:
        from sync_requirements import requirements_for_bundle

        (self.bundle / "code" / "analysis.py").write_text("import pandas\n", encoding="utf-8")
        (self.bundle / "metadata").mkdir()
        (self.bundle / "metadata" / "analysis-report.json").write_text(
            json.dumps({"dependencies": ["pandas", "contextily", "rasterio", "pyproj"]}),
            encoding="utf-8",
        )
        requirements = requirements_for_bundle(self.bundle)
        self.assertTrue(any(item.startswith("contextily==") for item in requirements))
        self.assertTrue(any(item.startswith("rasterio==") for item in requirements))
        self.assertTrue(any(item.startswith("pyproj==") for item in requirements))


if __name__ == "__main__":
    unittest.main()
