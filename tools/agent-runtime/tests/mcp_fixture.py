"""Real MCP stdio transport with offline EPOS HTTP fixtures."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "mcp-epos" / "tools"))
import epos_mcp_http as server
from epos_mcp_stdio import main


async def fixture_get(url, timeout=60):
    content_type = "application/json"
    if "/resources/details/" in url:
        data = {"availableFormats": [{"format": "text/csv"}], "serviceParameters": [{"name": "minimum", "type": "number"}]}
        body = json.dumps(data).encode()
    elif "/execute/" in url:
        content_type = "text/csv"
        body = b"latitude,longitude,magnitude\n42,13,3\n42.1,13.1,4\n"
    else:
        body = json.dumps({"results": {"distributions": [{"id": str(index), "title": f"Event catalogue {index}"} for index in range(70)]}}).encode()
    return {"ok": True, "status": 200, "ct": content_type, "body": body, "text": body.decode(), "bytes": len(body)}


server.http_get = fixture_get
if __name__ == "__main__":
    main()
