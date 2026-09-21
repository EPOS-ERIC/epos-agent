# Remote Deployment

Deploy the Python process on a host you control and expose it only through HTTPS.

1. Copy the project to `/opt/epos-skill` and create a dedicated `epos` user.
2. Copy `epos-mcp.env.example` to `/etc/epos-mcp.env`, set named least-privilege tokens in `EPOS_MCP_TOKENS_JSON`, then run `chmod 600 /etc/epos-mcp.env`. `EPOS_MCP_AUTH_TOKEN` is a legacy admin fallback.
3. Install `epos-mcp.service.example` as `/etc/systemd/system/epos-mcp.service`, adapt paths and user, then run `systemctl daemon-reload && systemctl enable --now epos-mcp`.
4. Install `nginx-epos-mcp.conf.example`, replace `mcp.example.org`, and configure a valid TLS certificate.
5. Install dependencies with `python3 -m pip install -r requirements.txt` (including pinned `mcp==2.2.0`), then configure MCP clients with `https://mcp.example.org/mcp` and the header `Authorization: Bearer <EPOS_MCP_AUTH_TOKEN>`.

Do not expose the Python port directly, run without TLS, or commit the environment file.

## Docker Compose

Docker Compose is an alternative to systemd. Copy `epos-mcp.env.example` to `epos-mcp.env`, set the token, then run:

```bash
docker compose --env-file deploy/epos-mcp.env -f deploy/docker-compose.yml up -d --build
```

The compose file maps the container only to `127.0.0.1:8765`; nginx still terminates public HTTPS. Ensure the host `artifacts/` directory is writable by container UID `10001` before starting it.

## Health checks

The server exposes authenticated `GET /healthz`, JSON `GET /metrics`, and Prometheus `GET /metrics/prometheus`. Metrics requires `metrics` or `admin`; artifact downloads require `artifacts`. Audit JSONL rotation is configured by `EPOS_AUDIT_LOG_PATH`, `EPOS_AUDIT_MAX_BYTES`, and `EPOS_AUDIT_BACKUPS`.

## Execution limits

Set `EPOS_MAX_TIME_RANGE_DAYS` (default `366`) and `EPOS_MAX_BBOX_AREA_DEGREES` (default `1000`) in the environment to constrain `epos_execute`. Requests exceeding either limit are rejected before any EPOS service call. The time limit covers dedicated `startDate`/`endDate` arguments and `params` pairs named `starttime`/`endtime`, `startDate`/`endDate`, or `start_date`/`end_date`.

## Temporary state and artifacts

Set `EPOS_STATE_TTL_SECONDS` (default `1800`) and `EPOS_MAX_ARTIFACTS` (default `1000`) to control lifecycle. Expired files and metadata are deleted. `EPOS_PUBLIC_BASE_URL` returns absolute artifact URLs. Plans may require `epos_execute(plan_id, confirm=true)` after confirmation.
