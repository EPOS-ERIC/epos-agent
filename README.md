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

The installer installs `pi coding agent` locally under `~/epos-agent/.runtime`, creates isolated Python environments for the bundled EPOS MCP under `services/mcp-epos` and the FDSN MCP, and keeps runtime data under `~/epos-agent`. It does not install secrets or commit credentials.

To test another installation location without touching an existing installation:

```bash
EPOS_INSTALL_ROOT=/tmp/epos-agent-test ./install.sh
EPOS_AGENT_ROOT=/tmp/epos-agent-test /tmp/epos-agent-test/bin/epos-agent
```

## Configuration

Copy/edit `config/profile.env.example` as `config/profile.env`, set `EPOS_PROVIDER`, `EPOS_MODEL` and optionally `EPOS_THINKING`, or leave them unset to use the current Pi configuration. No provider or model is selected by default. Authentication is managed by Pi and must be configured locally.

## Token-efficient tools

Each user turn starts with only file reading and the internal `epos_load_tools` router. The model calls the router automatically to activate only the required capability. The EPOS MCP is initialized when the agent session starts and is the primary source for EPOS discovery, metadata and downloads; the specialist FDSN MCP remains on demand.

The catalogue adapter traverses all result pages internally, deduplicates candidates and gives the model compact metadata for ranking. Chat shows only relevant service or dataset titles grouped by scientific role; technical IDs remain in state and provenance. Catalogue discovery never limits records in a requested scientific dataset. Tool outputs follow the [MCP tool contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) and use `structuredContent`, while raw catalogue facets and redundant linked-entity payloads stay out of the model context.

## Guided study workflow

New studies follow a provider-neutral workflow: context card, scientific question, service selection, three targeted analysis/plot suggestions plus “Valuta altre opzioni”, one data-acquisition confirmation, preliminary visualization, Python script and Jupyter notebook. Missing essentials are collected in one compact question block. Each study is stored as a self-contained bundle under `~/epos-agent/workspace/<study>-<timestamp>/`; use `/workspace` to see the active bundle and recent artifacts.

## Security and runtime data

Sessions, cache, provenance logs, generated workspace files, Python environments, and authentication configuration are local runtime data and are excluded from Git. Provider-neutral usage metrics are appended to `logs/token-usage.jsonl` with model, active tools, token/cache counts and cost when available; prompts and scientific data are never logged there. Do not commit API keys, tokens, passwords, or `auth.json`.

## Download safety

Catalogue searches, metadata and service descriptions run without confirmation. Calls that return scientific data wait for one researcher confirmation covering services, parameters, formats and the chosen analysis; no download-size estimate is produced. The cumulative raw-data budget is enforced at transfer time at 1 GiB per study. Complete responses are saved in the study bundle, while model context receives only essential metadata, measured counts, paths and at most five representative records. Transport completeness and scientific dataset completeness are reported separately.

## Included FDSN service

The service in `services/mcp-fdsnws-event` is installed into a dedicated Python virtual environment by `install.sh`. An explicit event `limit` is respected exactly. Without one, EPOS Agent adaptively partitions the requested time interval until every shard is below the provider result cap, deduplicates event IDs and verifies the oldest/newest boundaries before declaring the JSONL complete. Interrupted or unverifiable requests are retained as clearly marked `.partial.jsonl` files; chat receives the total and at most five samples.

Its existing tests can be run with:

```bash
cd services/mcp-fdsnws-event
./run_tests.sh
```

## License

See the license and attribution information in `services/mcp-fdsnws-event/LICENSE` and the upstream service documentation.
