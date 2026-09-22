#!/usr/bin/env python3
"""MCP Server that exposes EPOS tools for LM Studio and other MCP clients.

Usage from LM Studio:
  Settings → Developer → Edit Config → mcp.json:
  {
    "epos": {
      "command": "python3",
      "args": ["/absolute/path/to/tools/epos_mcp.py"],
      "env": { "EPOS_API_BASE": "https://www.ics-c.epos-eu.org/api/v1" }
    }
  }

Or use the lmstudio:// deeplink:
  lmstudio://add_mcp?command=python3&args=/absolute/path/to/tools/epos_mcp.py&name=epos
"""

from __future__ import annotations

import json
import os
import sys

# Force unbuffered I/O before anything else
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=False, write_through=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(line_buffering=False, write_through=True)

# ── MCP JSON-RPC helpers (raw fd I/O, no Python buffering) ─────────────
import select
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

_FD_STDIN = 0
_FD_STDOUT = 1


def _fd_read(n: int) -> bytes:
    """Read exactly n bytes from fd 0, blocking until done."""
    buf = b""
    while len(buf) < n:
        chunk = os.read(_FD_STDIN, n - len(buf))
        if not chunk:
            raise EOFError("stdin closed")
        buf += chunk
    return buf


def _fd_readline() -> bytes:
    """Read one line from fd 0 (up to \\n), without buffering."""
    buf = b""
    while True:
        ch = os.read(_FD_STDIN, 1)
        if not ch:
            raise EOFError("stdin closed")
        buf += ch
        if ch == b"\n":
            return buf


def _peek_stdin() -> bool:
    """Check if data is available on stdin without blocking."""
    readable, _, _ = select.select([sys.stdin], [], [], 0)
    return bool(readable)


def _fd_write(data: bytes) -> None:
    """Write all data to fd 1, then flush with tcdrain."""
    written = 0
    while written < len(data):
        n = os.write(_FD_STDOUT, data[written:])
        written += n


def read_message() -> dict[str, Any]:
    """Read a single JSON-RPC message from stdin (LSP/MCP framing)."""
    import select as _select

    # Wait up to 90 seconds for data
    readable, _, _ = _select.select([sys.stdin], [], [], 90)
    if not readable:
        log("No data on stdin after 90s, exiting")
        raise EOFError("Timeout waiting for data")

    content_length = 0
    while True:
        line = _fd_readline()
        text = line.decode("utf-8").strip()
        if text == "":
            break
        if text.lower().startswith("content-length:"):
            content_length = int(text.split(":", 1)[1].strip())

    if content_length == 0:
        raise ValueError("No Content-Length header received")

    body = _fd_read(content_length)
    return json.loads(body)


def send_message(msg: dict[str, Any]) -> None:
    """Write a JSON-RPC message to stdout with LSP framing."""
    body = json.dumps(msg).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode()
    _fd_write(header + body)


def send_result(req_id: Any, result: Any) -> None:
    send_message({"jsonrpc": "2.0", "id": req_id, "result": result})


def send_error(req_id: Any, code: int, message: str) -> None:
    send_message(
        {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}
    )


# ── HTTP helper ───────────────────────────────────────────────────────

EPOS_API_BASE = os.environ.get("EPOS_API_BASE", "https://www.ics-c.epos-eu.org/api/v1")
ARTIFACTS = Path(
    os.environ.get(
        "EPOS_ARTIFACTS", str(Path(__file__).resolve().parent.parent / "artifacts")
    )
)
ARTIFACTS.mkdir(parents=True, exist_ok=True)


def http_get(url: str, timeout: int = 60) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            body = resp.read()
            ct = resp.headers.get_content_type()
            charset = resp.headers.get_content_charset() or "utf-8"
            return {
                "ok": True,
                "status": resp.status,
                "ct": ct,
                "text": body.decode(charset, errors="replace"),
                "bytes": len(body),
            }
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:2000]
        return {"ok": False, "status": e.code, "error": detail}
    except urllib.error.URLError as e:
        return {"ok": False, "status": 0, "error": str(e.reason)}


def save(name: str, data: bytes, ct: str = "") -> str:
    p = ARTIFACTS / name
    p.write_bytes(data)
    return str(p)


# ── Tool implementations ──────────────────────────────────────────────


def tool_search(args: dict[str, Any]) -> str:
    q = args.get("q", "")
    keywords = args.get("keywords", "")
    organisations = args.get("organisations", "")
    sciencedomains = args.get("sciencedomains", "")
    servicetypes = args.get("servicetypes", "")
    startDate = args.get("startDate", "")
    endDate = args.get("endDate", "")
    bbox = args.get("bbox", "")
    facetstype = args.get("facetstype", "")
    facets = args.get("facets", "")

    pairs = [
        (k, v)
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
        ]
        if v
    ]
    url = f"{EPOS_API_BASE}/resources/search"
    if pairs:
        url += "?" + urllib.parse.urlencode(pairs)
    r = http_get(url)
    if not r["ok"]:
        return f"Error {r['status']}: {r.get('error', 'unknown')}"
    p = save("mcp-search.json", r["text"].encode(), r["ct"])
    # Return truncated preview
    preview = r["text"][:4000]
    return f"Search OK ({r['bytes']} bytes) → {p}\n\n{preview}"


def tool_organizations(args: dict[str, Any]) -> str:
    q = args.get("q", "")
    country = args.get("country", "")
    org_type = args.get("org_type", "")

    pairs = [
        (k, v) for k, v in [("q", q), ("country", country), ("type", org_type)] if v
    ]
    url = f"{EPOS_API_BASE}/resources/organizations"
    if pairs:
        url += "?" + urllib.parse.urlencode(pairs)
    r = http_get(url)
    if not r["ok"]:
        return f"Error {r['status']}: {r.get('error', 'unknown')}"
    p = save("mcp-orgs.json", r["text"].encode(), r["ct"])
    preview = r["text"][:4000]
    return f"Organizations OK ({r['bytes']} bytes) → {p}\n\n{preview}"


def tool_details(args: dict[str, Any]) -> str:
    dist_id = args.get("distribution_id", "")
    extended = args.get("extended", "false")
    encoded = urllib.parse.quote(dist_id, safe="")
    url = f"{EPOS_API_BASE}/resources/details/{encoded}"
    if extended == "true":
        url += "?extended=true"
    r = http_get(url)
    if not r["ok"]:
        return f"Error {r['status']}: {r.get('error', 'unknown')}"
    p = save("mcp-details.json", r["text"].encode(), r["ct"])
    preview = r["text"][:4000]
    return f"Details OK ({r['bytes']} bytes) → {p}\n\n{preview}"


def tool_execute(args: dict[str, Any]) -> str:
    dist_id = args.get("distribution_id", "")
    params = args.get("params", "")
    fmt = args.get("format", "")
    startDate = args.get("startDate", "")
    endDate = args.get("endDate", "")
    bbox = args.get("bbox", "")
    useDefaults = args.get("useDefaults", "")

    if params:
        try:
            if not isinstance(json.loads(params), dict):
                return 'Error: params must be a JSON object like \'{"key": "value"}\''
        except json.JSONDecodeError as e:
            return f"Error: invalid params JSON: {e}"

    encoded = urllib.parse.quote(dist_id, safe="")
    url = f"{EPOS_API_BASE}/execute/{encoded}"
    q = [
        (k, v)
        for k, v in [
            ("useDefaults", useDefaults if useDefaults else None),
            ("format", fmt),
            ("startDate", startDate),
            ("endDate", endDate),
            ("bbox", bbox),
            ("params", params if params else None),
        ]
        if v
    ]
    if q:
        url += "?" + urllib.parse.urlencode(q)
    r = http_get(url, timeout=120)
    if not r["ok"]:
        return f"Error {r['status']}: {r.get('error', 'unknown')}"
    ct = r["ct"]
    ext = (
        ".geojson"
        if "geo+json" in ct
        else ".json"
        if "json" in ct
        else ".xml"
        if "xml" in ct
        else ".csv"
        if "csv" in ct
        else ".bin"
    )
    p = save(f"mcp-execute{ext}", r["text"].encode(), ct)
    preview = (
        r["text"][:4000]
        if ct.startswith("text/") or "json" in ct
        else f"[{r['bytes']} bytes of binary data]"
    )
    return f"Execute OK ({r['bytes']} bytes, {ct}) → {p}\n\n{preview}"


def tool_inspect(args: dict[str, Any]) -> str:
    fp = Path(args.get("file_path", ""))
    if not fp.is_file():
        return f"File not found: {fp}"
    body = fp.read_bytes()
    ct = ""
    meta = fp.with_suffix(fp.suffix + ".meta.json")
    if meta.is_file():
        try:
            ct = json.loads(meta.read_text()).get("content_type", "")
        except Exception:
            pass
    text = body.decode("utf-8", errors="replace")
    kind = "unknown"
    info: dict[str, Any] = {}
    if "json" in ct or text.lstrip()[:1] in {"{", "["}:
        try:
            data = json.loads(text)
            kind = "json"
            if isinstance(data, dict):
                info["keys"] = list(data)[:20]
                if data.get("type") in {"Feature", "FeatureCollection"}:
                    kind = "geojson"
                    info["features"] = len(data.get("features", []))
        except json.JSONDecodeError:
            kind = "text"
    elif "xml" in ct or text.lstrip()[:1] == "<":
        kind = "xml"
    elif "csv" in ct:
        kind = "csv"
    else:
        kind = "binary"
    return f"File: {fp}\nType: {kind}\nSize: {len(body)} bytes\nContent-Type: {ct}\nInfo: {json.dumps(info)}"


def tool_visualize(args: dict[str, Any]) -> str:
    from tools.epos import visualize as _vis

    fp = Path(args.get("file_path", ""))
    if not fp.is_file():
        return f"File not found: {fp}"
    out = fp.with_suffix(".html")
    _vis(fp, out)
    return f"Visualization created: {out}"


def tool_fetch(args: dict[str, Any]) -> str:
    url = args.get("url", "")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return "Only http/https URLs are supported."
    r = http_get(url, timeout=120)
    if not r["ok"]:
        return f"Error {r['status']}: {r.get('error', 'unknown')}"
    ct = r["ct"]
    ext = (
        ".xml"
        if "xml" in ct or r["text"].lstrip()[:1] == "<"
        else ".json"
        if "json" in ct
        else ".bin"
    )
    p = save(f"mcp-fetched{ext}", r["text"].encode(), ct)
    preview = (
        r["text"][:4000]
        if ct.startswith("text/") or "json" in ct
        else f"[{r['bytes']} bytes]"
    )
    return f"Fetched OK ({r['bytes']} bytes, {ct}) → {p}\n\n{preview}"


# ── MCP tool definitions ──────────────────────────────────────────────

TOOLS = [
    {
        "name": "epos_search",
        "description": "Search EPOS datasets and distributions by keyword, provider, domain, time range, or spatial extent.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "Free-text query"},
                "keywords": {
                    "type": "string",
                    "description": "Comma-separated keywords",
                },
                "organisations": {
                    "type": "string",
                    "description": "Organization ID (from epos_organizations)",
                },
                "sciencedomains": {
                    "type": "string",
                    "description": "Science domain filter",
                },
                "servicetypes": {
                    "type": "string",
                    "description": "Service type filter (WMS, WFS, WCS)",
                },
                "startDate": {"type": "string", "description": "Start date ISO"},
                "endDate": {"type": "string", "description": "End date ISO"},
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
        },
    },
    {
        "name": "epos_organizations",
        "description": "Look up EPOS organizations by name, country, or type to get their IDs for search filtering.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "q": {
                    "type": "string",
                    "description": "Organization name query (e.g. INGV)",
                },
                "country": {"type": "string", "description": "ISO country code"},
                "org_type": {
                    "type": "string",
                    "description": "dataproviders, serviceproviders, or both",
                },
            },
        },
    },
    {
        "name": "epos_details",
        "description": "Get detailed metadata for a distribution, including execution parameters and available formats.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "distribution_id": {
                    "type": "string",
                    "description": "Distribution ID from search results",
                },
                "extended": {
                    "type": "string",
                    "enum": ["true", "false"],
                    "description": "Include extended payload",
                },
            },
            "required": ["distribution_id"],
        },
    },
    {
        "name": "epos_execute",
        "description": "Execute a data service through the EPOS gateway. Check epos_details first to know accepted parameters.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "distribution_id": {
                    "type": "string",
                    "description": "Distribution ID to execute",
                },
                "params": {
                    "type": "string",
                    "description": 'JSON object with service parameters, e.g. {"starttime":"2024-01-01"}',
                },
                "format": {
                    "type": "string",
                    "description": "Output format (application/json, application/geo+json, text/csv)",
                },
                "startDate": {"type": "string", "description": "Start date ISO"},
                "endDate": {"type": "string", "description": "End date ISO"},
                "bbox": {
                    "type": "string",
                    "description": "Bounding box: west,south,east,north",
                },
                "useDefaults": {
                    "type": "string",
                    "enum": ["true", "false"],
                    "description": "Use metadata defaults",
                },
            },
            "required": ["distribution_id"],
        },
    },
    {
        "name": "epos_inspect",
        "description": "Inspect a saved payload file to understand its format, structure, and content type.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Path to artifact file"},
            },
            "required": ["file_path"],
        },
    },
    {
        "name": "epos_visualize",
        "description": "Create an HTML visualization: Leaflet map for GeoJSON, heatmap for CoverageJSON, table for CSV.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Path to artifact file"},
            },
            "required": ["file_path"],
        },
    },
    {
        "name": "epos_fetch",
        "description": "Fetch any external HTTP/HTTPS URL (e.g. OGC GetCapabilities from WMS/WFS/WCS).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Full URL to fetch"},
            },
            "required": ["url"],
        },
    },
]

DISPATCH = {
    "epos_search": tool_search,
    "epos_organizations": tool_organizations,
    "epos_details": tool_details,
    "epos_execute": tool_execute,
    "epos_inspect": tool_inspect,
    "epos_visualize": tool_visualize,
    "epos_fetch": tool_fetch,
}


# ── MCP main loop ─────────────────────────────────────────────────────


def log(msg: str) -> None:
    sys.stderr.write(f"[EPOS MCP] {msg}\n")
    sys.stderr.flush()


def main() -> None:
    """Run the MCP server over stdio with LSP framing."""
    log("Server started")
    log(f"EPOS_API_BASE={EPOS_API_BASE}")
    log(f"ARTIFACTS={ARTIFACTS}")
    log(f"PID={os.getpid()}")

    # Check if stdin has data ready
    import select as _select

    readable, _, _ = _select.select([sys.stdin], [], [], 0)
    log(f"stdin ready at startup: {readable}")

    # Check fd 0 directly
    r, _, _ = _select.select([0], [], [], 0)
    log(f"fd0 ready at startup: {bool(r)}")

    while True:
        try:
            msg = read_message()
        except (EOFError, ValueError) as e:
            log(f"Read ended: {e}")
            break

        method = msg.get("method", "")
        req_id = msg.get("id")
        params = msg.get("params", {})
        log(f"← {method} id={req_id}")

        if method == "initialize":
            send_result(
                req_id,
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "epos-mcp", "version": "1.0.0"},
                },
            )
            log("→ initialize response sent")

        elif method == "notifications/initialized":
            log("→ initialized notification (no response)")

        elif method == "tools/list":
            send_result(req_id, {"tools": TOOLS})
            log(f"→ tools/list sent ({len(TOOLS)} tools)")

        elif method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments", {})
            log(f"  calling {tool_name}({json.dumps(arguments)[:200]})")
            fn = DISPATCH.get(tool_name)
            if fn is None:
                send_error(req_id, -32601, f"Unknown tool: {tool_name}")
            else:
                try:
                    result = fn(arguments)
                    send_result(req_id, {"content": [{"type": "text", "text": result}]})
                    log(f"  → {tool_name} result sent ({len(result)} chars)")
                except Exception as e:
                    log(f"  ✗ {tool_name} failed: {e}")
                    send_result(
                        req_id,
                        {
                            "content": [{"type": "text", "text": f"Error: {e}"}],
                            "isError": True,
                        },
                    )

        elif method == "ping":
            send_result(req_id, {})
            log("→ pong")

        elif req_id is not None:
            send_error(req_id, -32601, f"Unknown method: {method}")
            log(f"→ error: unknown method {method}")


if __name__ == "__main__":
    main()
