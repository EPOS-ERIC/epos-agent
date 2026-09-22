#!/usr/bin/env python3
"""EPOS tool definitions for LM Studio and OpenAI-compatible APIs.

Two usage modes:

1. LM Studio Python SDK (recommended):
   import lmstudio as lms
   from tools.lmstudio_tools import epos_tools
   model = lms.llm("qwen2.5-7b-instruct")
   model.act("Find earthquake catalogues from INGV", epos_tools)

2. OpenAI-compatible REST API:
   from tools.lmstudio_tools import openai_tools_schema, run_tool
   # Pass openai_tools_schema to LM Studio /v1/chat/completions
   # When model returns tool_calls, call run_tool(name, args) for each
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from tools.epos_results import summarize_details, summarize_search

EPOS_API_BASE = os.environ.get("EPOS_API_BASE", "https://www.ics-c.epos-eu.org/api/v1")
ARTIFACTS_DIR = Path(__file__).resolve().parent.parent / "artifacts"


def _ensure_artifacts() -> Path:
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    return ARTIFACTS_DIR


def _http_get(url: str, timeout: int = 60) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            body = resp.read()
            ct = resp.headers.get_content_type()
            charset = resp.headers.get_content_charset() or "utf-8"
            return {
                "status": resp.status,
                "content_type": ct,
                "body": body,
                "text": body.decode(charset, errors="replace"),
            }
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:3000]
        return {"status": e.code, "content_type": "", "body": b"", "error": detail}
    except urllib.error.URLError as e:
        return {"status": 0, "content_type": "", "body": "", "error": str(e.reason)}


def _save_artifact(name: str, content: bytes, content_type: str = "") -> str:
    d = _ensure_artifacts()
    stem, suffix = os.path.splitext(name)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    p = d / f"{stem}-{stamp}-{uuid.uuid4().hex[:8]}{suffix}"
    p.write_bytes(content if isinstance(content, bytes) else content.encode())
    meta = p.with_suffix(p.suffix + ".meta.json")
    meta.write_text(json.dumps({"content_type": content_type}, indent=2))
    return str(p)


# ──────────────────────────────────────────────
# Tool functions (callable from LM Studio SDK)
# ──────────────────────────────────────────────


def epos_search(
    q: str = "",
    keywords: str = "",
    organisations: str = "",
    sciencedomains: str = "",
    servicetypes: str = "",
    startDate: str = "",
    endDate: str = "",
    bbox: str = "",
    facetstype: str = "",
    facets: str = "",
    limit: int = 12,
    offset: int = 0,
) -> str:
    """Search EPOS catalogues for datasets and distributions.

    Args:
        q: Free-text search query (e.g. "earthquake catalogue").
        keywords: Comma-separated keywords.
        organisations: Organization ID from epos_organizations (not a name).
        sciencedomains: Science domain filter.
        servicetypes: Service type filter (e.g. "WMS", "WFS").
        startDate: Start of temporal coverage (ISO date).
        endDate: End of temporal coverage (ISO date).
        bbox: Spatial bounding box as "west,south,east,north".
        facetstype: Facet type: "categories", "dataproviders", or "serviceproviders".
        facets: "true" or "false" to include facets in the response.

    Returns:
        JSON string with search results.
    """
    pairs: list[tuple[str, str]] = []
    for k, v in [
        ("q", q),
        ("keywords", keywords),
        ("organisations", organisations),
        ("sciencedomains", sciencedomains),
        ("servicetypes", servicetypes),
        ("startDate", startDate),
        ("endDate", endDate),
        ("bbox", bbox),
        ("facetstype", facetstype),
        ("facets", facets),
    ]:
        if v:
            pairs.append((k, v))
    url = (
        f"{EPOS_API_BASE}/resources/search?{urllib.parse.urlencode(pairs)}"
        if pairs
        else f"{EPOS_API_BASE}/resources/search"
    )
    r = _http_get(url)
    if "error" in r:
        return json.dumps({"error": r["error"], "status": r["status"]})
    path = _save_artifact("search-result.json", r["body"], r["content_type"])
    try:
        summary = summarize_search(json.loads(r["text"]), limit=limit, offset=offset)
    except json.JSONDecodeError:
        summary = {"error": "Search response was not valid JSON."}
    return json.dumps(
        {
            "status": r["status"],
            "content_type": r["content_type"],
            "file": path,
            **summary,
        },
        ensure_ascii=False,
    )


def epos_organizations(
    q: str = "", country: str = "", org_type: str = "", org_id: str = ""
) -> str:
    """Look up EPOS organizations by name, country, or type.

    Args:
        q: Free-text organization name query (e.g. "INGV").
        country: ISO country code filter.
        org_type: "dataproviders", "serviceproviders", or both comma-separated.
        org_id: If you already know an organization ID, return it directly.

    Returns:
        JSON string with matching organizations including their IDs.
    """
    if org_id:
        return json.dumps({"organizations": [{"id": org_id}]})
    pairs: list[tuple[str, str]] = []
    for k, v in [("q", q), ("country", country), ("type", org_type)]:
        if v:
            pairs.append((k, v))
    url = (
        f"{EPOS_API_BASE}/resources/organizations?{urllib.parse.urlencode(pairs)}"
        if pairs
        else f"{EPOS_API_BASE}/resources/organizations"
    )
    r = _http_get(url)
    if "error" in r:
        return json.dumps({"error": r["error"], "status": r["status"]})
    path = _save_artifact("organizations.json", r["body"], r["content_type"])
    return json.dumps(
        {"status": r["status"], "file": path, "data": r["text"][:8000]},
        ensure_ascii=False,
    )


def epos_details(distribution_id: str, extended: str = "false") -> str:
    """Get detailed metadata for a specific distribution.

    Args:
        distribution_id: The distribution ID or instance ID from search results.
        extended: "true" to include extended payload with linked entities.

    Returns:
        JSON string with distribution details including parameters for execution.
    """
    params = [("extended", "true")] if extended == "true" else []
    encoded = urllib.parse.quote(distribution_id, safe="")
    url = f"{EPOS_API_BASE}/resources/details/{encoded}"
    if params:
        url += f"?{urllib.parse.urlencode(params)}"
    r = _http_get(url)
    if "error" in r:
        return json.dumps({"error": r["error"], "status": r["status"]})
    path = _save_artifact("details.json", r["body"], r["content_type"])
    try:
        summary = summarize_details(json.loads(r["text"]))
    except json.JSONDecodeError:
        summary = {"error": "Details response was not valid JSON."}
    return json.dumps(
        {"status": r["status"], "file": path, **summary}, ensure_ascii=False
    )


def epos_execute(
    distribution_id: str,
    params: str = "",
    format: str = "",
    startDate: str = "",
    endDate: str = "",
    bbox: str = "",
    useDefaults: str = "",
    pluginId: str = "",
    inputFormat: str = "",
) -> str:
    """Execute a data service through the EPOS gateway.

    Args:
        distribution_id: The distribution ID to execute.
        params: JSON object string with service-specific parameters,
                e.g. '{"starttime":"2024-01-01","endtime":"2024-12-31"}'.
        format: Output format (e.g. "application/json", "application/geo+json", "text/csv").
        startDate: Start date filter (ISO format).
        endDate: End date filter (ISO format).
        bbox: Spatial bounding box as "west,south,east,north".
        useDefaults: "true" to use default parameter values from metadata.
        pluginId: Plugin ID if required by the service.
        inputFormat: Input format for plugin execution.

    Returns:
        JSON string with execution result.
    """
    if params:
        try:
            parsed = json.loads(params)
            if not isinstance(parsed, dict):
                return json.dumps({"error": "params must be a JSON object"})
        except json.JSONDecodeError as e:
            return json.dumps({"error": f"Invalid params JSON: {e}"})
    encoded = urllib.parse.quote(distribution_id, safe="")
    url = f"{EPOS_API_BASE}/execute/{encoded}"
    q: list[tuple[str, str]] = []
    for k, v in [
        ("useDefaults", useDefaults if useDefaults else None),
        ("format", format),
        ("startDate", startDate),
        ("endDate", endDate),
        ("bbox", bbox),
        ("pluginId", pluginId),
        ("inputFormat", inputFormat),
        ("params", params if params else None),
    ]:
        if v:
            q.append((k, v))
    if q:
        url += f"?{urllib.parse.urlencode(q)}"
    r = _http_get(url, timeout=120)
    if "error" in r:
        return json.dumps({"error": r["error"], "status": r["status"]})
    ct = r["content_type"]
    ext = (
        ".json"
        if "json" in ct
        else ".xml"
        if "xml" in ct
        else ".csv"
        if "csv" in ct
        else ".geojson"
        if "geo+json" in ct
        else ".bin"
    )
    path = _save_artifact(f"execute{ext}", r["body"], ct)
    preview = (
        r["text"][:6000]
        if ct.startswith("text/") or "json" in ct
        else f"[{len(r['body'])} bytes of binary data]"
    )
    return json.dumps(
        {"status": r["status"], "content_type": ct, "file": path, "preview": preview},
        ensure_ascii=False,
    )


def epos_inspect(file_path: str) -> str:
    """Inspect a previously saved EPOS payload to understand its structure.

    Args:
        file_path: Path to the artifact file to inspect.

    Returns:
        JSON string with payload structure analysis.
    """
    from tools.epos import load_payload, payload_kind

    # Redirect inspect output to capture it
    p = Path(file_path)
    body, ct = load_payload(p)
    kind = payload_kind(body, ct)
    result: dict[str, Any] = {
        "input": str(p),
        "bytes": len(body),
        "content_type": ct or None,
        "kind": kind,
    }
    text = body.decode("utf-8", errors="replace")
    if kind in {"json", "geojson", "coveragejson"}:
        data = json.loads(text)
        if isinstance(data, dict):
            result["keys"] = list(data)[:30]
            if kind == "geojson":
                result["feature_count"] = (
                    len(data.get("features", []))
                    if data.get("type") == "FeatureCollection"
                    else 1
                )
            if kind == "coveragejson":
                result["coverages"] = (
                    len(data.get("coverages", []))
                    if isinstance(data.get("coverages"), list)
                    else 1
                )
    elif kind == "csv":
        import csv as _csv

        rows = list(_csv.reader(text.splitlines()))
        result["rows"] = max(0, len(rows) - 1)
        result["columns"] = rows[0] if rows else []
    elif kind == "xml":
        import xml.etree.ElementTree as ET

        root = ET.fromstring(body)
        result["root"] = root.tag
        result["elements"] = sum(1 for _ in root.iter())
    return json.dumps(result, ensure_ascii=False, indent=2)


def epos_visualize(file_path: str) -> str:
    """Create an HTML visualization of a saved EPOS payload.

    Args:
        file_path: Path to the artifact file to visualize.

    Returns:
        JSON string with the path to the generated HTML file.
    """
    from tools.epos import visualize as _vis

    p = Path(file_path)
    out = p.with_suffix(".html")
    _vis(p, out)
    return json.dumps({"input": str(p), "visualization": str(out)})


def epos_fetch(url: str) -> str:
    """Fetch any external HTTP/HTTPS URL (e.g. OGC GetCapabilities).

    Use this after obtaining a service URL from EPOS distribution details
    to call OGC endpoints like WMS, WFS, WCS GetCapabilities.

    Args:
        url: The full URL to fetch.

    Returns:
        JSON string with the response content and metadata.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return json.dumps({"error": "Only http and https URLs are supported."})
    r = _http_get(url, timeout=120)
    if "error" in r:
        return json.dumps({"error": r["error"], "status": r["status"]})
    ct = r["content_type"]
    ext = (
        ".xml"
        if "xml" in ct or r["text"].lstrip().startswith("<")
        else ".json"
        if "json" in ct
        else ".bin"
    )
    path = _save_artifact(f"fetched{ext}", r["body"], ct)
    preview = (
        r["text"][:6000]
        if ct.startswith("text/") or "json" in ct
        else f"[{len(r['body'])} bytes]"
    )
    return json.dumps(
        {"status": r["status"], "content_type": ct, "file": path, "preview": preview},
        ensure_ascii=False,
    )


# ──────────────────────────────────────────────
# OpenAI-format tool schema
# ──────────────────────────────────────────────

openai_tools_schema: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "epos_search",
            "description": "Search EPOS catalogues for datasets and distributions. Returns matching items with IDs, titles, providers, and available formats.",
            "parameters": {
                "type": "object",
                "properties": {
                    "q": {
                        "type": "string",
                        "description": "Free-text search query (e.g. 'earthquake catalogue')",
                    },
                    "keywords": {
                        "type": "string",
                        "description": "Comma-separated keywords",
                    },
                    "organisations": {
                        "type": "string",
                        "description": "Organization ID from epos_organizations",
                    },
                    "sciencedomains": {
                        "type": "string",
                        "description": "Science domain filter (e.g. 'Seismology')",
                    },
                    "servicetypes": {
                        "type": "string",
                        "description": "Service type filter (e.g. 'WMS', 'WFS')",
                    },
                    "startDate": {
                        "type": "string",
                        "description": "Start of temporal coverage (ISO date)",
                    },
                    "endDate": {
                        "type": "string",
                        "description": "End of temporal coverage (ISO date)",
                    },
                    "bbox": {
                        "type": "string",
                        "description": "Bounding box: west,south,east,north",
                    },
                    "facetstype": {
                        "type": "string",
                        "enum": ["categories", "dataproviders", "serviceproviders"],
                    },
                    "facets": {"type": "string", "enum": ["true", "false"]},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "epos_organizations",
            "description": "Look up EPOS organizations by name, country, or type. Use this to find organization IDs for filtering search results.",
            "parameters": {
                "type": "object",
                "properties": {
                    "q": {
                        "type": "string",
                        "description": "Free-text organization name (e.g. 'INGV')",
                    },
                    "country": {
                        "type": "string",
                        "description": "ISO country code filter",
                    },
                    "org_type": {
                        "type": "string",
                        "description": "'dataproviders', 'serviceproviders', or both comma-separated",
                    },
                    "org_id": {
                        "type": "string",
                        "description": "Return a known organization ID directly",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "epos_details",
            "description": "Get detailed metadata for a distribution, including its execution parameters, endpoint, serviceEndpoint, formats, and linked entities.",
            "parameters": {
                "type": "object",
                "properties": {
                    "distribution_id": {
                        "type": "string",
                        "description": "The distribution ID from search results",
                    },
                    "extended": {
                        "type": "string",
                        "enum": ["true", "false"],
                        "description": "Include extended payload with linked entities",
                    },
                },
                "required": ["distribution_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "epos_execute",
            "description": "Execute a data service through the EPOS gateway. Requires a distribution ID and optional parameters. Check epos_details first to know which parameters are accepted.",
            "parameters": {
                "type": "object",
                "properties": {
                    "distribution_id": {
                        "type": "string",
                        "description": "The distribution ID to execute",
                    },
                    "params": {
                        "type": "string",
                        "description": 'JSON object with service-specific params, e.g. \'{"starttime":"2024-01-01"}\'',
                    },
                    "format": {
                        "type": "string",
                        "description": "Output format (e.g. 'application/json', 'application/geo+json')",
                    },
                    "startDate": {"type": "string", "description": "Start date (ISO)"},
                    "endDate": {"type": "string", "description": "End date (ISO)"},
                    "bbox": {
                        "type": "string",
                        "description": "Bounding box: west,south,east,north",
                    },
                    "useDefaults": {
                        "type": "string",
                        "enum": ["true", "false"],
                        "description": "Use default values from metadata",
                    },
                    "pluginId": {
                        "type": "string",
                        "description": "Plugin ID if required",
                    },
                    "inputFormat": {
                        "type": "string",
                        "description": "Input format for plugin execution",
                    },
                },
                "required": ["distribution_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "epos_inspect",
            "description": "Inspect a saved EPOS payload file to understand its structure, format, and content type. Use after epos_execute or epos_fetch to analyze what was returned.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to the artifact file (from a previous epos_* result)",
                    },
                },
                "required": ["file_path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "epos_visualize",
            "description": "Create an HTML visualization of a saved payload: Leaflet map for GeoJSON, heatmap for CoverageJSON, table for CSV, structure view for XML/OGC.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to the artifact file (from a previous epos_* result)",
                    },
                },
                "required": ["file_path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "epos_fetch",
            "description": "Fetch any external HTTP/HTTPS URL, e.g. OGC GetCapabilities from a WMS/WFS/WCS service URL obtained from EPOS distribution details.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Full URL to fetch"},
                },
                "required": ["url"],
            },
        },
    },
]


# ──────────────────────────────────────────────
# Tool dispatch (for OpenAI-compatible servers)
# ──────────────────────────────────────────────

TOOL_DISPATCH: dict[str, Any] = {
    "epos_search": epos_search,
    "epos_organizations": epos_organizations,
    "epos_details": epos_details,
    "epos_execute": epos_execute,
    "epos_inspect": epos_inspect,
    "epos_visualize": epos_visualize,
    "epos_fetch": epos_fetch,
}


def run_tool(name: str, arguments: dict[str, Any]) -> str:
    """Dispatch a tool call by name and return the JSON result string."""
    fn = TOOL_DISPATCH.get(name)
    if fn is None:
        return json.dumps({"error": f"Unknown tool: {name}"})
    return fn(**arguments)


# ──────────────────────────────────────────────
# LM Studio Python SDK compatibility
# ──────────────────────────────────────────────

# This list can be passed directly to model.act() in the lmstudio SDK.
# The SDK accepts plain Python functions with type hints and docstrings.
epos_tools: list[Any] = [
    epos_search,
    epos_organizations,
    epos_details,
    epos_execute,
    epos_inspect,
    epos_visualize,
    epos_fetch,
]
