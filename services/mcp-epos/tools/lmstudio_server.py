#!/usr/bin/env python3
"""Minimal OpenAI-compatible server exposing EPOS tools via LM Studio.

Usage:
  # Start the server (runs on port 1235 by default)
  EPOS_API_BASE="https://www.ics-c.epos-eu.org/api/v1" python3 tools/lmstudio_server.py

  # Then point LM Studio or any OpenAI client at it:
  #   base_url = http://localhost:1235/v1

This server does NOT run an LLM — it exposes the EPOS tools as a function
library that an OpenAI-compatible server (like LM Studio) can call, or
that you can use with any client that supports function calling.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# Ensure tools/ is importable
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
if TOOLS_DIR not in sys.path:
    sys.path.insert(0, TOOLS_DIR)

from lmstudio_tools import openai_tools_schema, run_tool

PORT = int(os.environ.get("EPOS_LM_PORT", "1235"))


class EPOSHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write(f"[EPOS] {fmt % args}\n")

    def _send_json(self, data: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/v1/models":
            self._send_json({
                "object": "list",
                "data": [{"id": "epos-tools", "object": "model", "owned_by": "epos"}],
            })
        elif self.path == "/health" or self.path == "/":
            self._send_json({"status": "ok"})
        else:
            self._send_json({"error": "Not found"}, 404)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""

        if self.path == "/v1/chat/completions":
            self._handle_chat(raw)
        else:
            self._send_json({"error": "Not found"}, 404)

    def _handle_chat(self, raw: bytes) -> None:
        try:
            request = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON"}, 400)
            return

        messages = request.get("messages", [])
        tools_in = request.get("tools", openai_tools_schema)

        # Collect all tool calls the model requested
        tool_calls: list[dict[str, Any]] = []
        tool_results: list[dict[str, Any]] = []

        for msg in messages:
            if msg.get("role") == "assistant" and msg.get("tool_calls"):
                for tc in msg["tool_calls"]:
                    fn_name = tc.get("function", {}).get("name", "")
                    try:
                        args = json.loads(tc["function"].get("arguments", "{}"))
                    except json.JSONDecodeError:
                        args = {}
                    result = run_tool(fn_name, args)
                    tool_results.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id", str(uuid.uuid4())),
                        "content": result,
                    })

        # If last message is user, build a helpful response listing the tools
        last_msg = messages[-1] if messages else {}
        content = (
            "EPOS API Tools Server\n\n"
            "This server exposes the following EPOS tools via OpenAI-compatible function calling:\n\n"
            + "\n".join(f"- **{t['function']['name']}**: {t['function']['description']}" for t in openai_tools_schema)
            + "\n\nPass these tools in the `tools` parameter of your chat completion request. "
            "The model will return `tool_calls` and you execute them with `run_tool(name, args)`."
        )

        response: dict[str, Any] = {
            "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
            "object": "chat.completion",
            "created": int(datetime.now(UTC).timestamp()),
            "model": request.get("model", "epos-tools"),
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }
        self._send_json(response)


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), EPOSHandler)
    print(f"EPOS Tools Server listening on http://0.0.0.0:{PORT}")
    print(f"  Models endpoint:  http://localhost:{PORT}/v1/models")
    print(f"  Chat completions: http://localhost:{PORT}/v1/chat/completions")
    print(f"  EPOS API base:    {os.environ.get('EPOS_API_BASE', '(not set)')}")
    print(f"  Tools:            {', '.join(t['function']['name'] for t in openai_tools_schema)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
