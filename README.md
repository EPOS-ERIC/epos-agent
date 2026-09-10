# EPOS Agent

<p align="center">
  <img src="docs/assets/epos-agent-header.png" alt="EPOS Agent — European Plate Observing System" width="100%">
</p>

EPOS Agent is a terminal UI assistant for discovering and using EPOS Platform solid-Earth data services. It provides metadata-driven EPOS catalogue search, dedicated EPOS software search, service description and validation, read-only service execution, provenance logging, Python analysis in a controlled workspace, and MCP integrations for both the EPOS API Gateway and FDSN events.

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

Copy/edit `config/profile.env.example` as `config/profile.env` in the installation directory, or provide the provider/model settings through environment variables. Authentication is managed by pi coding agent and must be configured by each user locally.

## Security and runtime data

Sessions, cache, provenance logs, generated workspace files, Python environments, and authentication configuration are local runtime data and are excluded from Git. Do not commit API keys, tokens, passwords, or `auth.json`.

## Download safety

Service execution performs a size preflight when the endpoint supports `HEAD`, and streams responses instead of buffering them all in memory. Downloads above 50 MB require explicit user confirmation; responses above the hard 1 GB limit are refused. Use `estimateOnly` to check the size without downloading and `outputFileName` to save a confirmed response under the EPOS workspace.

## Included FDSN service

The service in `services/mcp-fdsnws-event` is installed into a dedicated Python virtual environment by `install.sh`. Its tests can be run with:

```bash
cd services/mcp-fdsnws-event
./run_tests.sh
```

## License

See the license and attribution information in `services/mcp-fdsnws-event/LICENSE` and the upstream service documentation.
