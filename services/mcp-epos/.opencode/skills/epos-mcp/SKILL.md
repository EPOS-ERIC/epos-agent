---
name: epos-mcp
description: Use when configuring, deploying, testing, or validating the EPOS MCP server and its bearer-token scopes.
---

# EPOS MCP Operations

Use `.venv/bin/python -m unittest discover -s tests -v` for tests. Keep `mcp==2.2.0` and use its Streamable HTTP transport; do not implement MCP protocol handling manually.

Configure `EPOS_MCP_TOKENS_JSON` as a token-to-`name`/`scopes` map. Valid scopes are `search`, `execute`, `artifacts`, `metrics`, and `admin`. `EPOS_MCP_AUTH_TOKEN` is only the legacy admin fallback when no map is set. Never print token values.

Deployment variables include `EPOS_PUBLIC_BASE_URL`, `EPOS_MAX_ARTIFACTS`, `EPOS_STATE_TTL_SECONDS`, `EPOS_RATE_LIMIT_PER_MINUTE`, `EPOS_CONFIRM_TIME_RANGE_DAYS`, `EPOS_CONFIRM_BBOX_AREA_DEGREES`, `EPOS_AUDIT_LOG_PATH`, `EPOS_AUDIT_MAX_BYTES`, and `EPOS_AUDIT_BACKUPS`.

For LM Studio validation, configure its MCP endpoint manually, initialize the client, then test search, candidate selection, prepare, execute, and confirmation-required plans. Do not edit `~/.lmstudio/mcp.json`.
