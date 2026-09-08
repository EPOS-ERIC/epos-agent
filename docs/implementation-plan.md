# EPOS Agent Implementation Plan

1. Reuse the installed `/opt/homebrew/bin/pi` runtime without modifying Pi core or `~/.pi`.
2. Launch Pi with an EPOS-specific `PI_CODING_AGENT_DIR` and `--session-dir` under `~/epos-agent`.
3. Load only explicit EPOS resources with `--no-extensions --no-skills --no-prompt-templates --no-context-files`, then add the EPOS extension and skill by path.
4. Provide an EPOS system prompt through `--system-prompt`.
5. Register a small stable tool surface:
   - `epos_search_resources`
   - `epos_describe_resource`
   - `epos_describe_service`
   - `epos_execute_service`
   - `epos_fdsnws_event_call` for the bundled specialist MCP server
6. Use the EPOS API Gateway / Resources Service as the service registry and load details only on demand.
7. Store sessions, cache, logs, and request provenance exclusively under `~/epos-agent`.
8. Bundle `mcp-fdsnws-event` under `~/epos-agent/services`, isolate Python dependencies in `.venv`, and call it over stdio.
