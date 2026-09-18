# EPOS MCP Server

Authenticated Streamable HTTP MCP server for EPOS search and data execution, using official `mcp==2.2.0` transport and `httpx` async connection pooling.

## Run and test

```bash
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python tools/epos_mcp_http.py --port 8765
.venv/bin/python -m unittest discover -s tests -v
```

The local default binds to loopback. The MCP endpoint is `/mcp`; authenticated artifacts are `/artifacts/{artifact_id}`.

## Authorization

Set `EPOS_MCP_TOKENS_JSON` to a JSON object mapping bearer token values to names and scopes:

```json
{"reader-token":{"name":"reader","scopes":["search","artifacts"]},"operator-token":{"name":"operator","scopes":["search","execute","artifacts","metrics"]}}
```

Scopes are `search`, `execute`, `artifacts`, `metrics`, and `admin`. `EPOS_MCP_AUTH_TOKEN` remains supported only when the JSON map is absent; it is a full-admin token. Tokens are never logged. Missing or invalid credentials return 401; valid credentials without the required scope return 403.

Searches and plans belong to the token identity and exact MCP session where available. Artifacts belong to the token identity and can be downloaded from another session. IDs are opaque UUIDs. Set `EPOS_PUBLIC_BASE_URL` to return absolute `download_url`; otherwise tools return relative `artifact_url`.

## Tools

`epos_search`, `epos_search_page`, `epos_select_candidate`, and `epos_search_filter` support compact cached discovery. Returned descriptions are capped at 300 characters; full responses stay in server artifacts. Discovery ranking is deterministic and favors title/provider/description query matches and active records.

By default `EPOS_MCP_TOOL_PROFILE=compact` exposes seven tools suitable for smaller LM Studio contexts. Its `epos_search` accepts only documented EPOS search fields: `q`, `startDate`, `endDate`, `bbox`, and `organisations`; it returns five ranked candidates. Set `EPOS_MCP_TOOL_PROFILE=full` to expose the extended API search fields, cached-search navigation tools, and `epos_fetch`.

`epos_prepare_execute` validates formats, enum values, numeric ranges, safe patterns, and basic numeric/boolean/date types, returning structured reasons. It returns `requires_confirmation` for ranges exceeding `EPOS_CONFIRM_TIME_RANGE_DAYS` (90) or bboxes exceeding `EPOS_CONFIRM_BBOX_AREA_DEGREES` (100). Run `epos_execute(plan_id, confirm=true)` only after confirmation when required.

All SDK tool calls provide native structured content plus a concise fallback. `epos_fetch` only accepts public HTTP/S destinations and does not follow redirects.

## Operations

Use the templates in `deploy/`. Relevant limits: `EPOS_STATE_TTL_SECONDS` (1800), `EPOS_MAX_ARTIFACTS` (1000), `EPOS_RATE_LIMIT_PER_MINUTE` (60), `EPOS_MAX_TIME_RANGE_DAYS`, and `EPOS_MAX_BBOX_AREA_DEGREES`. Expired artifacts and their `.meta.json` files are removed safely. `EPOS_AUDIT_LOG_PATH` enables rotated JSONL audit output controlled by `EPOS_AUDIT_MAX_BYTES` and `EPOS_AUDIT_BACKUPS`.

`GET /metrics` returns JSON and `GET /metrics/prometheus` emits Prometheus text; both require `metrics` or `admin`. Metrics use aggregates/buckets, not unbounded latency retention. Keep nginx rate limiting enabled as a second layer.

For LM Studio, configure its MCP client manually with the remote URL and bearer header, reload MCP servers, then validate `search -> select -> prepare -> execute` and a confirmation-required plan. Do not modify `~/.lmstudio/mcp.json` automatically.
