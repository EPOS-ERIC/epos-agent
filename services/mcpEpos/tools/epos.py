#!/usr/bin/env python3
"""Read-only EPOS API client, payload inspector, and HTML visualizer."""

from __future__ import annotations

import argparse
import csv
import html
import json
import mimetypes
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def fail(message: str) -> None:
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(2)


def parse_pairs(values: list[str]) -> list[tuple[str, str]]:
    pairs = []
    for value in values:
        if "=" not in value:
            fail(f"Invalid query value {value!r}; use key=value.")
        key, item = value.split("=", 1)
        if not key:
            fail("Query parameter name cannot be empty.")
        pairs.append((key, item))
    return pairs


def api_url(base: str, path: str, query: list[tuple[str, str]]) -> str:
    if not base:
        fail("Set --base or EPOS_API_BASE, for example https://host/api/v1.")
    if not path.startswith("/"):
        fail("Endpoint paths must start with '/'.")
    return f"{base.rstrip('/')}{path}?{urllib.parse.urlencode(query)}" if query else f"{base.rstrip('/')}{path}"


def artifact_path(prefix: str, suffix: str) -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return Path("artifacts") / f"{prefix}-{stamp}{suffix}"


def request(url: str, output: Path | None, preview: int) -> None:
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            body = response.read()
            content_type = response.headers.get_content_type()
            charset = response.headers.get_content_charset() or "utf-8"
            status = response.status
            headers = dict(response.headers.items())
    except urllib.error.HTTPError as error:
        body = error.read()
        detail = body.decode(error.headers.get_content_charset() or "utf-8", errors="replace")
        print(json.dumps({"url": url, "status": error.code, "error": detail[:4000]}), file=sys.stderr)
        raise SystemExit(1)
    except urllib.error.URLError as error:
        fail(f"Network request failed: {error.reason}")

    if output is None:
        suffix = mimetypes.guess_extension(content_type) or ".bin"
        output = artifact_path("epos-response", suffix)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(body)
    meta_path = output.with_suffix(output.suffix + ".meta.json")
    meta_path.write_text(json.dumps({"url": url, "status": status, "content_type": content_type, "charset": charset, "headers": headers}, indent=2), encoding="utf-8")
    result: dict[str, Any] = {"url": url, "status": status, "content_type": content_type, "bytes": len(body), "output": str(output), "metadata": str(meta_path)}
    if preview and (content_type.startswith("text/") or content_type in {"application/json", "application/geo+json"}):
        result["preview"] = body.decode(charset, errors="replace")[:preview]
    print(json.dumps(result, ensure_ascii=False, indent=2))


def load_payload(path: Path) -> tuple[bytes, str]:
    if not path.is_file():
        fail(f"File not found: {path}")
    content_type = ""
    meta_path = path.with_suffix(path.suffix + ".meta.json")
    if meta_path.is_file():
        try:
            content_type = json.loads(meta_path.read_text(encoding="utf-8")).get("content_type", "")
        except json.JSONDecodeError:
            pass
    return path.read_bytes(), content_type


def payload_kind(body: bytes, content_type: str) -> str:
    text = body.lstrip()
    lowered = content_type.lower()
    if "coveragejson" in lowered:
        return "coveragejson"
    if "geo+json" in lowered:
        return "geojson"
    if "csv" in lowered:
        return "csv"
    if "xml" in lowered or text.startswith(b"<"):
        return "xml"
    if text.startswith((b"{", b"[")):
        try:
            decoded = json.loads(text)
            if isinstance(decoded, dict) and decoded.get("type") in {"Feature", "FeatureCollection"}:
                return "geojson"
            if isinstance(decoded, dict) and ("coverage" in decoded or "domain" in decoded and "parameters" in decoded):
                return "coveragejson"
            return "json"
        except json.JSONDecodeError:
            pass
    if b"," in body[:4096] and b"\n" in body[:4096]:
        return "csv"
    return "binary"


def inspect(path: Path) -> None:
    body, content_type = load_payload(path)
    kind = payload_kind(body, content_type)
    result: dict[str, Any] = {"input": str(path), "bytes": len(body), "content_type": content_type or None, "kind": kind}
    text = body.decode("utf-8", errors="replace")
    if kind in {"json", "geojson", "coveragejson"}:
        data = json.loads(text)
        if isinstance(data, dict):
            result["keys"] = list(data)[:50]
            if kind == "geojson":
                result["feature_count"] = len(data.get("features", [])) if data.get("type") == "FeatureCollection" else 1
            if kind == "coveragejson":
                result["coverages"] = len(data.get("coverages", [])) if isinstance(data.get("coverages"), list) else 1
        elif isinstance(data, list):
            result["items"] = len(data)
    elif kind == "csv":
        rows = list(csv.reader(text.splitlines()))
        result["rows"] = max(0, len(rows) - 1)
        result["columns"] = rows[0] if rows else []
    elif kind == "xml":
        root = ET.fromstring(body)
        result["root"] = root.tag
        result["elements"] = sum(1 for _ in root.iter())
        result["ogc"] = any(token in root.tag.lower() for token in ("wms", "wfs", "wcs", "capabilities"))
    print(json.dumps(result, ensure_ascii=False, indent=2))


def document(title: str, content: str) -> str:
    return f"""<!doctype html>
<html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
<title>{html.escape(title)}</title>
<style>body{{font:15px system-ui,sans-serif;margin:2rem;color:#17212b}}h1{{margin:0 0 .5rem}}pre{{background:#f5f7f9;padding:1rem;overflow:auto}}table{{border-collapse:collapse;width:100%}}th,td{{border:1px solid #ccd5dd;padding:.45rem;text-align:left;vertical-align:top}}th{{background:#edf2f5}}#map{{height:70vh;border:1px solid #ccd5dd}}small{{color:#52606d}}</style>
<body><h1>{html.escape(title)}</h1>{content}</body></html>"""


def visualize(path: Path, output: Path) -> None:
    body, content_type = load_payload(path)
    kind = payload_kind(body, content_type)
    text = body.decode("utf-8", errors="replace")
    if kind == "geojson":
        data = json.loads(text)
        safe_json = json.dumps(data).replace("</", "<\\/")
        content = "<link rel=\"stylesheet\" href=\"https://unpkg.com/leaflet@1.9.4/dist/leaflet.css\"><small>Interactive map uses the OpenStreetMap and Leaflet CDNs when online.</small><div id=\"map\"></div><pre id=\"summary\"></pre><script src=\"https://unpkg.com/leaflet@1.9.4/dist/leaflet.js\"></script><script>const d=" + safe_json + ";const m=L.map('map').setView([0,0],2);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'OpenStreetMap'}).addTo(m);const l=L.geoJSON(d).addTo(m);if(l.getBounds().isValid())m.fitBounds(l.getBounds(),{padding:[20,20]});document.querySelector('#summary').textContent=`Features: ${d.type==='FeatureCollection'?d.features.length:1}`;</script>"
        rendered = document("EPOS GeoJSON", content)
    elif kind == "csv":
        rows = list(csv.reader(text.splitlines()))
        header, values = (rows[0], rows[1:]) if rows else ([], [])
        table = "<table><thead><tr>" + "".join(f"<th>{html.escape(item)}</th>" for item in header) + "</tr></thead><tbody>"
        table += "".join("<tr>" + "".join(f"<td>{html.escape(item)}</td>" for item in row) + "</tr>" for row in values[:1000]) + "</tbody></table>"
        rendered = document("EPOS CSV", f"<small>Showing {min(len(values), 1000)} of {len(values)} data rows.</small>{table}")
    elif kind == "coveragejson":
        data = json.loads(text)
        summary = json.dumps({key: data.get(key) for key in ("type", "domainType", "parameters", "referencing")}, ensure_ascii=False, indent=2)
        safe_json = json.dumps(data).replace("</", "<\\/")
        content = "<p>Coverage metadata and first scalar grid, when present.</p><canvas id=\"grid\" width=\"800\" height=\"500\"></canvas><pre id=\"result\">" + html.escape(summary) + "</pre><script>const d=" + safe_json + ";const c=d.coverages?.[0]??d,r=Object.values(c.ranges??{})[0],shape=r?.shape??{},w=shape.x??shape.lon??shape.longitude,h=shape.y??shape.lat??shape.latitude,v=r?.values;if(Number.isInteger(w)&&Number.isInteger(h)&&Array.isArray(v)&&v.length>=w*h){const a=v.slice(0,w*h).filter(Number.isFinite),min=Math.min(...a),max=Math.max(...a),ctx=document.querySelector('#grid').getContext('2d'),img=ctx.createImageData(w,h);for(let i=0;i<w*h;i++){const n=v[i],p=4*i,t=Number.isFinite(n)?(n-min)/(max-min||1):0;img.data[p]=255*t;img.data[p+1]=80*(1-t);img.data[p+2]=255*(1-t);img.data[p+3]=Number.isFinite(n)?255:0}const off=document.createElement('canvas');off.width=w;off.height=h;off.getContext('2d').putImageData(img,0,0);ctx.imageSmoothingEnabled=false;ctx.drawImage(off,0,0,800,500);document.querySelector('#result').textContent+=`\\nGrid: ${w} x ${h}, range: ${min} to ${max}`;}else{document.querySelector('#grid').replaceWith(document.createTextNode('No rectangular scalar range found for a generic heatmap.'));}</script>"
        rendered = document("EPOS CoverageJSON", content)
    elif kind == "xml":
        root = ET.fromstring(body)
        names = [element.tag.rsplit("}", 1)[-1] for element in root.iter()]
        rendered = document("EPOS OGC/XML response", f"<p>Root: <code>{html.escape(root.tag)}</code></p><pre>{html.escape(json.dumps({'elements': len(names), 'unique_element_names': sorted(set(names))}, indent=2))}</pre>")
    else:
        rendered = document("EPOS payload", f"<p>Unsupported visualization type: <code>{html.escape(kind)}</code></p><pre>{html.escape(text[:20000])}</pre>")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    print(json.dumps({"input": str(path), "kind": kind, "visualization": str(output)}, indent=2))


def add_request_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--base", default=None, help="EPOS API base, defaults to EPOS_API_BASE")
    parser.add_argument("--output", type=Path, help="Payload output file; an artifact file is created if omitted")
    parser.add_argument("--preview", type=int, default=0, help="Include at most this many text characters in the response report")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("get", "fetch", "search", "organizations", "details", "execute"):
        add_request_arguments(sub.add_parser(command))
    get = sub.choices["get"]
    get.add_argument("path")
    get.add_argument("--query", action="append", default=[], metavar="KEY=VALUE")
    fetch = sub.choices["fetch"]
    fetch.add_argument("url")
    search = sub.choices["search"]
    search.add_argument("--query", action="append", default=[], metavar="KEY=VALUE")
    organizations = sub.choices["organizations"]
    organizations.add_argument("--query", action="append", default=[], metavar="KEY=VALUE")
    details = sub.choices["details"]
    details.add_argument("id")
    details.add_argument("--extended", action="store_true")
    execute = sub.choices["execute"]
    execute.add_argument("id")
    execute.add_argument("--params", help="JSON object passed as the single params query value")
    execute.add_argument("--params-file", type=Path, help="File containing the params JSON object")
    execute.add_argument("--use-defaults", action="store_true")
    execute.add_argument("--format")
    execute.add_argument("--start-date")
    execute.add_argument("--end-date")
    execute.add_argument("--bbox")
    execute.add_argument("--plugin-id")
    execute.add_argument("--input-format")
    inspect_parser = sub.add_parser("inspect", help="Summarize a saved payload")
    inspect_parser.add_argument("input", type=Path)
    visualize_parser = sub.add_parser("visualize", help="Create an HTML view of a saved payload")
    visualize_parser.add_argument("input", type=Path)
    visualize_parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "inspect":
        inspect(args.input)
        return
    if args.command == "visualize":
        visualize(args.input, args.output)
        return
    if args.command == "fetch":
        parsed = urllib.parse.urlparse(args.url)
        if parsed.scheme not in {"http", "https"}:
            fail("Only http and https URLs can be fetched.")
        request(args.url, args.output, args.preview)
        return
    base = args.base or __import__("os").environ.get("EPOS_API_BASE", "https://www.ics-c.epos-eu.org/api/v1")
    if args.command == "get":
        path, query = args.path, parse_pairs(args.query)
    elif args.command == "search":
        path, query = "/resources/search", parse_pairs(args.query)
    elif args.command == "organizations":
        path, query = "/resources/organizations", parse_pairs(args.query)
    elif args.command == "details":
        path, query = f"/resources/details/{urllib.parse.quote(args.id, safe='')}", [("extended", "true")] if args.extended else []
    else:
        if args.params and args.params_file:
            fail("Use either --params or --params-file, not both.")
        params = args.params_file.read_text(encoding="utf-8") if args.params_file else args.params
        if params:
            try:
                if not isinstance(json.loads(params), dict):
                    fail("--params must be a JSON object.")
            except json.JSONDecodeError as error:
                fail(f"Invalid --params JSON: {error.msg}")
        path = f"/execute/{urllib.parse.quote(args.id, safe='')}"
        query = [(key, value) for key, value in [("useDefaults", "true" if args.use_defaults else None), ("format", args.format), ("startDate", args.start_date), ("endDate", args.end_date), ("bbox", args.bbox), ("pluginId", args.plugin_id), ("inputFormat", args.input_format), ("params", params)] if value is not None]
    request(api_url(base, path, query), args.output, args.preview)


if __name__ == "__main__":
    main()
