# Bundled Specialist MCP: mcp-fdsnws-event

Source: https://github.com/INGV/mcp-fdsnws-event
License: AGPL-3.0-or-later (kept as a separate bundled service under `services/mcp-fdsnws-event`; no AGPL code is copied into Pi core).

EPOS Agent does not use Docker for this service. The preferred local transport is stdio.

Local setup attempted by installer:

```bash
cd ~/epos-agent/services/mcp-fdsnws-event
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e .
```

Run manually:

```bash
cd ~/epos-agent/services/mcp-fdsnws-event
. .venv/bin/activate
mcp-fdsnws-event-server
```

Smoke-test MCP tools/list:

```bash
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"epos-agent","version":"0.1.0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
 | .venv/bin/mcp-fdsnws-event-server
```

Pi integration note: this Pi installation already exposes fdsnws-event tools in the harness. The EPOS Agent profile keeps the upstream service source isolated for local stdio operation and licensing clarity; if Pi MCP server configuration support is later exposed as an isolated CLI/resource option, point it at the command above under the EPOS profile only.
