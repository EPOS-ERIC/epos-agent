---
name: epos-api
description: Use when searching EPOS datasets or distributions, retrieving EPOS resource details, or executing an EPOS service through /resources/search, /resources/details/{instance_id}, or /execute/{instance_id}.
---

# EPOS API Discovery And Execution

Use this skill to discover and query services exposed by the EPOS API Gateway.

## API Contract

- The local OpenAPI definition at `definitions/api-spec.json` is the authoritative contract.
- The API base path in that definition is `/api/v1`. Obtain the deployment origin from the user or the current environment; do not invent one.
- The search, organization, details, and execution endpoints are public in the supplied definition. Treat an HTTP 401 or 403 as an access restriction and report it clearly.
- The resource identifier used by details and execution is the distribution `id` or `instanceId` returned by search. Prefer the explicitly returned `id`.
- Before calling an endpoint not documented in this skill, read its method, parameters, request body, security, and response schema in `definitions/api-spec.json`. Never infer an endpoint contract from its name.

Set the base URL once per task, without a trailing slash:

```bash
EPOS_API_BASE="https://<epos-api-origin>/api/v1"
```

## Local Harness

Use `python3 tools/epos.py` for all read-only EPOS and provider requests. It saves each response and an adjacent `.meta.json` file containing the source URL, status, content type, and headers. Store task outputs under `artifacts/`, which is intentionally ignored by Git.

```bash
# Show available operations and options.
python3 tools/epos.py --help

# Call any documented GET endpoint. Query values are safely URL-encoded.
python3 tools/epos.py get /resources/linkedentities/parameters/<distribution-id> \
  --output artifacts/parameters.json

# Fetch a direct OGC or provider URL after obtaining it from EPOS metadata.
python3 tools/epos.py fetch "https://<provider>/service?service=WMS&request=GetCapabilities" \
  --output artifacts/capabilities.xml

# Classify and summarize a saved response, then create a user-viewable HTML artifact.
python3 tools/epos.py inspect artifacts/capabilities.xml
python3 tools/epos.py visualize artifacts/capabilities.xml \
  --output artifacts/capabilities.html
```

The harness recognizes GeoJSON, CoverageJSON, CSV, JSON, XML/OGC responses, and unknown binary data. `visualize` creates:

- a Leaflet map for GeoJSON when the generated page is opened with network access;
- a tabular preview for CSV, capped at 1,000 rows;
- a metadata view for CoverageJSON;
- an XML/OGC capabilities structure summary;
- a safe text preview for unrecognized text responses.

For OGC services, first obtain the service URL from EPOS distribution details, then fetch `GetCapabilities` before selecting a layer, coverage, feature type, CRS, spatial extent, or time dimension. Read the capabilities document and construct provider requests only from values it declares.

## Required Workflow

Follow these phases in order. Insert organization discovery before search when the request names or constrains a provider. Do not skip details before executing a parameterized service.

1. When relevant, resolve an organization to its ID with `GET /resources/organizations`.
2. Search candidate datasets and distributions with `GET /resources/search`.
3. Select an appropriate distribution and retrieve its metadata with `GET /resources/details/{instance_id}`.
4. Inspect the returned `parameters`, `endpoint`, `serviceEndpoint`, `accessURL`, `downloadURL`, `format`, and service descriptions.
5. Build the execution request from the declared parameter names, types, allowed values, defaults, and constraints.
6. Run `GET /execute/{instance_id}` and inspect the response payload and content type.

If multiple results match, present a concise choice with title, distribution ID, provider, format, and description before executing. Ask for missing required execution values. Ask for confirmation before a potentially large download, long time range, or broad spatial query.

## 1. Search

Use `/resources/search` to discover distributions. Always put the user's natural-language subject in `q`; use the other fields to constrain that free-text search. Supported optional query parameters are:

- `q`: required preferred free-text query describing the dataset or phenomenon
- `organisations`: comma-separated list of organization IDs returned by `/resources/organizations`
- `startDate`, `endDate`: temporal bounds formatted exactly as `YYYY-MM-DDTHH:mm:ss`
- `bbox`: exactly four comma-separated values in this order: `maxLatitude,minLatitude,maxLongitude,minLongitude`
- `facetstype`: `categories`, `dataproviders`, or `serviceproviders`
- `facets`: boolean

Search results are nested under `results` and may contain child nodes. Distributions are in `results.distributions` and potentially in descendant `children[].distributions`. For each candidate, retain `id`, `title`, `description`, `href`, `hrefExtended`, `availableFormats`, provider fields, and status.

Do not use an organization display name in `organisations`. When the user names a provider, first call `/resources/organizations`, collect the returned `id` values, then send the relevant ID list unchanged.

Example:

```bash
curl --fail-with-body --get "$EPOS_API_BASE/resources/search" \
  --data-urlencode "q=earthquake catalogue" \
  --data-urlencode "startDate=2020-01-01T00:00:00" \
  --data-urlencode "endDate=2020-12-31T23:59:59" \
  --data-urlencode "bbox=46.50,36.00,19.00,6.00" \
  --data-urlencode "organisations=<organization-id-1>,<organization-id-2>"
```

Do not assume the values or syntax accepted by a particular provider beyond what search returns.

## Organization Discovery

Use `GET /resources/organizations` to resolve a provider name before filtering search results. Its optional query parameters are:

- `id`: an organization ID already known
- `q`: free-text organization query
- `country`
- `type`: one or both comma-separated values `dataproviders` and `serviceproviders`

The response uses `OrganizationBean` objects, with `id`, `name`, `country`, `logo`, and `url`. Use the returned `id` unchanged as the value of the `organisations` parameter in `/resources/search`; do not substitute the organization display name, `metaid`, or `instanceid` from a different endpoint.

```bash
curl --fail-with-body --get "$EPOS_API_BASE/resources/organizations" \
  --data-urlencode "q=INGV" \
  --data-urlencode "type=dataproviders"

curl --fail-with-body --get "$EPOS_API_BASE/resources/search" \
  --data-urlencode "organisations=<organization-id>" \
  --data-urlencode "q=earthquake catalogue"
```

`GET /resources/organizations/full` returns extended organization information, including `dataProducts` and `webServices`, but has no query parameters in the supplied contract. Use it only when the added relationship metadata is needed, because it may return the full organization collection.

## Distribution Details

Retrieve details for the chosen distribution. Use `extended=true` when more context is needed.

```bash
curl --fail-with-body --get \
  "$EPOS_API_BASE/resources/details/<distribution-id>" \
  --data-urlencode "extended=true"
```

The details payload is a `Distribution`. For executable services, inspect `parameters`, whose entries can include:

- `name`: exact key required for execution
- `required`: whether a value is mandatory
- `type`, `valuePattern`, `minValue`, `maxValue`
- `enumValue`, `multipleValue`
- `defaultValue`, `value`, `readOnlyValue`

Use exact parameter names. Do not guess undocumented parameter names or fabricate values. If all needed values have safe defaults and the user requested defaults, `useDefaults=true` may be used instead of supplying them manually.

## Execute

Call the gateway execution endpoint, not the provider endpoint directly:

```text
GET /execute/{instance_id}
```

Supported query parameters are `useDefaults`, `format`, `startDate`, `endDate`, `bbox`, `pluginId`, `inputFormat`, and `params`.

`params` is a **single query-string value containing a JSON object**. It is not a JSON request body and its members are not separate query parameters. Serialize valid JSON, then let the HTTP client URL-encode it.

```bash
curl --fail-with-body --get \
  "$EPOS_API_BASE/execute/<distribution-id>" \
  --data-urlencode 'params={"param1":"value1","param2":"value2"}' \
  --data-urlencode "format=application/json"
```

For an execution using metadata defaults:

```bash
curl --fail-with-body --get \
  "$EPOS_API_BASE/execute/<distribution-id>" \
  --data-urlencode "useDefaults=true"
```

Use `--data-urlencode` for every value that can contain spaces, punctuation, timestamps, URLs, WKT, or JSON. Keep `startDate`, `endDate`, and `bbox` as their dedicated query parameters when the service supports them; only put provider-specific fields inside `params`.

The response media type is unrestricted (`*/*`). Check `Content-Type` before parsing: JSON may be analyzed as structured data, while CSV, GeoJSON, XML, binary data, or a download response must be handled according to its declared type.

## LM Studio Integration (MCP)

The EPOS tools are exposed as an **MCP server** that LM Studio can load directly in the GUI.

### Setup in LM Studio GUI

Start the local HTTP server before opening or reloading MCP servers in LM Studio. It binds only to `127.0.0.1` and must remain running while the tools are used:

```bash
python3 tools/epos_mcp_http.py --port 8765
```

The server uses stateless Streamable HTTP MCP: JSON-RPC requests use `POST /mcp`, requests receive direct JSON responses, and notifications receive HTTP `202`. It deliberately does not provide an SSE stream, so `GET /mcp` returns `405` as required by the transport. Browser origins outside the configured allowlist are rejected.

### Remote HTTPS deployment

For use by MCP clients outside the host machine, deploy behind HTTPS with a Bearer token. Never expose the Python port directly. Deployment templates are in `deploy/`; they include systemd and Docker Compose options, both with nginx for TLS termination.

```json
{
  "mcpServers": {
    "epos": {
      "url": "https://mcp.example.org/mcp",
      "headers": {
        "Authorization": "Bearer <EPOS_MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

Set `EPOS_MCP_AUTH_TOKEN` to a high-entropy secret on the host. The server refuses a non-local `--host` without that token. Configure `EPOS_MCP_ALLOWED_ORIGINS` with any browser origin that must access the endpoint. Direct TLS is also available with `--tls-cert` and `--tls-key`, but a reverse proxy remains the preferred deployment.

For private monitoring, `GET /healthz` reports server readiness. It uses the same token in remote mode and is intentionally not proxied by the nginx template.

1. Open LM Studio → **Settings** (gear icon) → **Developer** tab
2. Click **Edit Config** → opens `mcp.json`
3. Configure the local MCP endpoint:

```json
{
  "mcpServers": {
    "epos": {
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

4. Save and **restart LM Studio** (or reload MCP servers)
5. Load a model that supports tool calling (Qwen 2.5, Llama 3.1/3.2, Mistral, Gemma)
6. The 7 EPOS tools are now available to the model

After each LM Studio update, verify the integration from the GUI with a simple prompt such as “Search EPOS for seismic datasets”. A successful local `curl` request only verifies this server; it does not prove the LM Studio MCP client accepted the configured HTTP transport.

### What happens in chat

When you ask something like "Find earthquake catalogues from INGV", the model will:
- Call `epos_organizations` to get INGV's ID
- Call `epos_search` with the organization ID and query
- Call `epos_details` on the best matching distribution
- Call `epos_execute` with the right parameters
- Return the results

### Available MCP tools

| Tool | Purpose |
|---|---|
| `epos_search` | Search datasets by keyword, provider, domain, time, space |
| `epos_organizations` | Resolve organization names to IDs |
| `epos_details` | Get distribution metadata and execution parameters |
| `epos_execute` | Run a data service with parameters |
| `epos_inspect` | Analyze a saved payload's structure |
| `epos_visualize` | Generate HTML visualization (map, table, heatmap) |
| `epos_fetch` | Fetch external URLs (OGC GetCapabilities, etc.) |

`epos_fetch` accepts only public HTTP/HTTPS hosts and does not follow redirects. `epos_inspect` and `epos_visualize` accept only files under `artifacts/`. Each saved response has a unique filename and adjacent `.meta.json` metadata file.

`epos_search` returns a compact candidate list containing distribution ID, title, provider, available formats, status, and description. The complete gateway response remains in the returned artifact path.

`epos_details` returns declared formats plus each executable operation and its parameter names, required flags, defaults, type, bounds, enum values, and value patterns. The tool supports both current flattened gateway metadata (`serviceParameters`) and nested operation metadata (`operations[].serviceParameters`).

### Alternative: Python SDK (programmatic)

```python
import lmstudio as lms
from tools.lmstudio_tools import epos_tools

model = lms.llm("qwen2.5-7b-instruct")
result = model.act("Find earthquake catalogues from INGV", epos_tools)
```

## Failure Handling

- `400`: report the submitted distribution ID and parameter names, then compare them against distribution details before retrying.
- `401` or `403`: explain that the requested resource requires authorization; do not expose or fabricate credentials.
- `404`: return to search and choose an active distribution ID.
- Network, gateway, or provider errors: retain the response body and state whether failure arose during discovery, metadata retrieval, or execution.

In the final result, state the selected distribution, the execution parameters used (redacting secrets), response content type, and a concise payload summary or the returned payload when reasonably sized.
