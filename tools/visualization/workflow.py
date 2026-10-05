"""Local inspection, notebook verification and bundle inventory; no model calls."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inspect(bundle: Path) -> dict:
    sys.path.insert(0, str(bundle / "code"))
    from epos_viz.data import discover_data_files, load_dataset

    datasets, suggestions, errors = [], [], []
    manifest = json.loads((bundle / "metadata" / "manifest.json").read_text())
    outcomes = manifest["download"].get("outcomes", [])
    current = [next((item for item in reversed(outcomes) if item.get("request") == service.get("request")), {}) for service in manifest["services"]]
    selected = {Path(item["outputFile"]).resolve() for item in current if item.get("outcome") == "downloaded" and item.get("outputFile")}
    supported = set(discover_data_files(bundle / "data"))
    for path in sorted(selected):
        if path not in supported:
            errors.append({"path": str(path), "error": "No deterministic reader for this file; preserve it for custom analysis"})
            continue
        try:
            dataset = load_dataset(path)
            summary = dataset.summary()
            summary["path"] = str(path.relative_to(bundle))
            datasets.append(summary)
            if not summary["records"] and not dataset.grid:
                continue
            plots = []
            if dataset.time and dataset.numeric:
                plots.append("time_series")
            if dataset.numeric:
                plots.append("distribution")
            if dataset.geojson or (dataset.latitude and dataset.longitude):
                suggestions.append({"kind": "map", "path": summary["path"], "reason": "Usable geographic coordinates or geometries"})
            if dataset.grid:
                suggestions.append({"kind": "raster", "path": summary["path"], "reason": "A structured grid is available"})
            for plot in plots:
                suggestions.append({"kind": plot, "path": summary["path"], "fields": dataset.numeric[:6], "reason": "Compatible fields detected in the downloaded file"})
        except (ValueError, ImportError, OSError) as error:
            errors.append({"path": str(path.relative_to(bundle)), "error": str(error)})
    report = {"datasets": datasets, "suggestions": suggestions, "errors": errors}
    (bundle / "metadata" / "inspection.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return {"datasets": [{key: item[key] for key in ("path", "records", "latitude", "longitude", "time", "numeric", "geometry", "grid")} for item in datasets],
            "suggestions": suggestions[:12], "errors": errors, "reportPath": str(bundle / "metadata" / "inspection.json")}


def verify_notebook(bundle: Path, notebook: Path) -> dict:
    import nbformat
    from nbclient import NotebookClient
    from jupyter_client import KernelManager
    from jupyter_client.kernelspec import KernelSpecManager

    with tempfile.TemporaryDirectory(prefix="epos-notebook-") as temporary:
        root = Path(temporary)
        copy = root / "bundle"
        shutil.copytree(bundle, copy, ignore=shutil.ignore_patterns("__pycache__"))
        spec = root / "kernels" / "epos"
        spec.mkdir(parents=True)
        (spec / "kernel.json").write_text(json.dumps({"argv": [sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                                                   "display_name": "EPOS verification", "language": "python"}))
        manager = KernelManager(kernel_name="epos", kernel_spec_manager=KernelSpecManager(kernel_dirs=[str(spec.parent)]))
        document = nbformat.read(copy / notebook.relative_to(bundle), as_version=4)
        client = NotebookClient(document, timeout=180, startup_timeout=30, km=manager, resources={"metadata": {"path": str(copy / "notebooks")}})
        try:
            client.execute()
        finally:
            if manager.has_kernel:
                manager.shutdown_kernel(now=True)
            manager.cleanup_resources()
        before = json.loads((bundle / "metadata" / "analysis-report.json").read_text())
        after = json.loads((copy / "metadata" / "analysis-report.json").read_text())
        if before["inputs"] != after["inputs"]:
            raise ValueError("Notebook did not use the same input files as the analysis")
        if [item["records"] for item in before["datasets"]] != [item["records"] for item in after["datasets"]]:
            raise ValueError("Notebook dataset counts differ from the analysis")
        if before.get("metrics") != after.get("metrics") or before.get("recipe") != after.get("recipe"):
            raise ValueError("Notebook analysis results differ from the script")
        if [Path(item).name for item in before["outputs"]] != [Path(item).name for item in after["outputs"]]:
            raise ValueError("Notebook output inventory differs from the script")
        for name in ("provenance.json", "parameters.json"):
            if digest(bundle / "metadata" / name) != digest(copy / "metadata" / name):
                raise ValueError(f"Notebook changed acquisition metadata: {name}")
        nbformat.write(document, notebook)
    return {"verified": True, "notebookPath": str(notebook), "verification": "Executed on a copy with the current analysis environment; compared inputs, counts, recipe, metrics and output names"}


def inventory(bundle: Path) -> dict:
    files = []
    for path in sorted(bundle.rglob("*")):
        if not path.is_file() or path.is_symlink() or "__pycache__" in path.parts or path == bundle / "metadata" / "inventory.json":
            continue
        files.append({"path": str(path.relative_to(bundle)), "bytes": path.stat().st_size, "sha256": digest(path)})
    repo = Path(__file__).resolve().parents[2]
    git = shutil.which("git")
    version = subprocess.run([git, "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True) if git else None
    status = subprocess.run([git, "status", "--porcelain"], cwd=repo, capture_output=True, text=True) if git else None
    runtime = repo / ".runtime" / "node_modules" / "@earendil-works" / "pi-coding-agent" / "package.json"
    sources = [repo / "tools" / "agent-runtime" / "index.ts", repo / "prompts" / "SYSTEM.md",
               repo / "services" / "mcp-epos" / "tools" / "epos_mcp_http.py"]
    result = {"files": files, "python": sys.version, "commit": version.stdout.strip() if version and version.returncode == 0 else None,
              "dirty": bool(status.stdout) if status and status.returncode == 0 else None,
              "pi": json.loads(runtime.read_text()).get("version") if runtime.exists() else None,
              "sourceHashes": {str(path.relative_to(repo)): digest(path) for path in sources if path.exists()}}
    (bundle / "metadata" / "inventory.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return {"inventoryPath": str(bundle / "metadata" / "inventory.json"), "fileCount": len(files)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("inspect", "verify", "inventory"))
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--notebook", type=Path)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    result = inspect(bundle) if args.action == "inspect" else verify_notebook(bundle, args.notebook.resolve()) if args.action == "verify" else inventory(bundle)
    print(json.dumps(result))
