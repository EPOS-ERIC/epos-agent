# EPOS Agent

<p align="center">
  <img src="docs/assets/epos-agent-header.png" alt="EPOS Agent — European Plate Observing System" width="100%">
</p>

EPOS Agent is a model-agnostic terminal assistant for discovering and using EPOS Platform solid-Earth data services. It works with any Pi provider/model that supports tool calling and provides compact catalogue discovery, service execution, complete FDSN event downloads, provenance, and controlled workspace analysis.

## Quick start (macOS/Linux)

The installer checks for these requirements:

- Node.js **22.19.0 or newer**
- Python **3.11 or newer**
- Git, npm and rsync

If dependencies are missing, `install.sh` asks for permission and installs Homebrew if needed, then Node.js/Python/Git/rsync on macOS. On Linux it uses the available package manager (`apt`, `dnf` or `pacman`). For unattended installation, use `EPOS_AUTO_INSTALL=1`.

From the repository directory:

```bash
./install.sh
~/epos-agent/bin/epos-agent
```

The installer installs `pi coding agent` locally under `~/epos-agent/.runtime`, installs the bundled EPOS API MCP under `services/mcp-epos`, creates an isolated Python environment for the bundled FDSN MCP, and keeps runtime data under `~/epos-agent`. It does not install secrets or commit credentials.

To test another installation location without touching an existing installation:

```bash
EPOS_INSTALL_ROOT=/tmp/epos-agent-test ./install.sh
EPOS_AGENT_ROOT=/tmp/epos-agent-test /tmp/epos-agent-test/bin/epos-agent
```

## Configuration

Copy/edit `config/profile.env.example` as `config/profile.env`, set `EPOS_PROVIDER`, `EPOS_MODEL` and optionally `EPOS_THINKING`, or leave them unset to use the current Pi configuration. No provider or model is selected by default. Authentication is managed by Pi and must be configured locally.

## Token-efficient tools

Each user turn starts with only file reading and the internal `epos_load_tools` router. The model calls the router automatically to activate only the required capability, including separate EPOS catalogue and software search groups. MCP processes also start only on their first real call.

Catalogue results contain at most five compact service cards per page. The agent shows every card retrieved on that page with title, provider, EPOS ID and a concise interpretive relevance reason, then waits for the researcher to choose or request more options. This pagination affects only alternatives shown to the model: it never limits records in a requested scientific dataset. Tool outputs follow the [MCP tool contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) and use `structuredContent`, while raw catalogue facets and redundant linked-entity payloads stay out of the model context.

## Security and runtime data

Sessions, cache, provenance logs, generated workspace files, Python environments, and authentication configuration are local runtime data and are excluded from Git. Provider-neutral usage metrics are appended to `logs/token-usage.jsonl` with model, active tools, token/cache counts and cost when available; prompts and scientific data are never logged there. Do not commit API keys, tokens, passwords, or `auth.json`.

## Download safety

Service execution performs a size preflight when the endpoint supports `HEAD`, streams the complete response to the workspace and returns only a short preview to chat. Downloads above 50 MB require explicit user confirmation; responses above the hard 1 GB limit are refused. Use `estimateOnly` to check the size without downloading; filenames are generated automatically unless `outputFileName` is provided.

## Included FDSN service

The service in `services/mcp-fdsnws-event` is installed into a dedicated Python virtual environment by `install.sh`. An explicit event `limit` is respected exactly. Without one, EPOS Agent follows every page and writes all matching events to `workspace/fdsn-events-<datacenter>-<timestamp>.jsonl`; chat receives the total and at most five samples. An interrupted multi-page request is retained only as a clearly marked `.partial.jsonl` file.

Its existing tests can be run with:

```bash
cd services/mcp-fdsnws-event
./run_tests.sh
```

## License

See the license and attribution information in `services/mcp-fdsnws-event/LICENSE` and the upstream service documentation.
