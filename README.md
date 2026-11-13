# EPOS Agent

<p align="center">
  <img src="docs/assets/epos-agent-header.png" alt="EPOS Agent — European Plate Observing System" width="100%">
</p>

EPOS Agent is a model-agnostic terminal assistant for discovering and using EPOS Platform solid-Earth data services. It works with any Pi provider/model that supports tool calling and provides compact catalogue discovery, service execution, complete FDSN event downloads, provenance, and controlled workspace analysis.

## Quick start (Windows)

On Windows 10 or 11, download the `epos-agent-vX.Y.Z.zip` asset from the [latest stable release](https://github.com/EPOS-ERIC/epos-agent/releases/latest) and extract it into your installation folder, for example `C:\Users\your-name\epos-agent`. Use the EPOS ZIP asset rather than GitHub's automatic “Source code” download.

Open **Windows PowerShell 5.1 or PowerShell 7**, enter that folder and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The installer reuses compatible Node.js (**22.19.0 or newer**), npm and Python (**3.11 or newer**). It uses `winget` to install or upgrade missing prerequisites. If `winget` is unavailable, install [Microsoft App Installer](https://aka.ms/getwinget), or install the missing prerequisites manually using [Node.js](https://nodejs.org/en/download) and [Python](https://www.python.org/downloads/windows/), then rerun the installer. Git and PowerShell 7 are not required.

Open a new PowerShell window and run `epos-agent`. Inside the agent, use `/login` to connect your AI provider.

To install into a different **empty** directory, set `$env:EPOS_INSTALL_ROOT = "C:\EPOS Agent"` before running the installer. Otherwise, installation takes place in the extracted folder. Rerunning that folder's installer preserves configuration and workspace data.

## Quick start (macOS/Linux)

On macOS, download and extract the `epos-agent-vX.Y.Z.zip` asset from the [latest stable release](https://github.com/EPOS-ERIC/epos-agent/releases/latest). Enter the extracted folder and run:

```bash
bash ./install.sh
```

The installer reuses compatible Node.js (**22.19.0 or newer**), npm and Python (**3.11 or newer**). When necessary, it asks permission to install prerequisites through Homebrew. Use `EPOS_AUTO_INSTALL=1` for unattended prerequisite installation. Creating the global launcher can request your computer password.

Run `epos-agent` in a new terminal, then use `/login` inside the agent. To install into a different empty directory, run `EPOS_INSTALL_ROOT=/other/path bash ./install.sh`.

Linux retains its existing installation through the native package manager; the release updater currently supports Windows and macOS only. Installation from a Git clone remains available:

```bash
git clone https://github.com/EPOS-ERIC/epos-agent.git
cd epos-agent
bash ./install.sh
```

## Updates (Windows and macOS)

At interactive startup, EPOS checks GitHub for a newer stable release and asks whether to install it. Answering no, running without an interactive terminal, or an unavailable update check allows normal startup. The check has a five-second timeout. Set `EPOS_SKIP_UPDATE_CHECK=1` to disable it.

```text
epos-agent --version
epos-agent update --check
epos-agent update
```

Close other EPOS sessions before updating. Updates use release packages and do not run `git pull`. They preserve provider credentials, configuration, workspace, sessions, cache, logs and downloaded MCP artifacts. Local changes to distributed source files block updates rather than being overwritten. A failure during installation restores the previous code and local dependency environments; system prerequisite upgrades performed by Homebrew or winget are not rolled back.

An interrupted process or power loss can leave a recovery backup and block further starts. After ensuring no installer/updater or EPOS session is running, restore it with:

```text
epos-agent recover-update
```

If startup itself is damaged, run `node tools/updater/update.cjs recover .` from the installation folder. Do not delete the recovery backup or lock while an update is running. Updating requires temporary disk space for the downloaded package and a backup of the installed dependency environments.

### Existing Git installations

Install the updater once, with EPOS sessions closed:

```bash
git pull --ff-only
```

Then run `bash ./install.sh` on macOS or `.\install.ps1` on Windows. Subsequent updates use `epos-agent update` or the startup prompt. Once a clone is managed through release updates, use the updater for it; keep a separate checkout for development rather than alternating release updates and Git changes.

### Publishing a version

Set `VERSION` to a stable `X.Y.Z`, commit the changes, then create and push its matching tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The release workflow checks Windows PowerShell 5.1, PowerShell 7, macOS and updater behavior before publishing the ZIP, updater bundle and SHA-256 checksums. Tag and `VERSION` must match. Changing only `VERSION`, publishing a draft or publishing a prerelease does not distribute a stable update. GitHub Actions needs permission to create repository releases. The first release must be published before the release download links become usable.

Run the offline updater tests with:

```bash
node --test tools/updater/tests/*.test.cjs
```

On Windows, run `./tools/updater/tests/windows.ps1` in both PowerShell 5.1 and 7. Full installation/update smoke tests run in CI using real dependencies; they require internet access.

## Configuration

Run `/login` inside the Pi harness and select your provider. Depending on the provider, you can choose:

- **Browser login:** Sign in to your provider account and authorize Pi through a browser or device flow. This may connect an eligible subscription.
- **API key:** Create an API key with your provider and enter it when prompted. API usage and billing are managed by the provider.

Available login methods and billing depend on the provider. Pi saves the resulting credential locally, so you don't need to edit a configuration file.

Alternatively, configure your provider credentials in `config/profile.env`. A template is available at `config/profile.env.example` with ready-to-use settings for Google Gemini, Anthropic Claude and OpenAI:

- **Google Gemini**: set `GEMINI_API_KEY`, `EPOS_PROVIDER=google`, `EPOS_MODEL=gemini-2.5-pro` (and optionally `EPOS_THINKING=medium`)
- **Anthropic Claude**: set `ANTHROPIC_API_KEY`, `EPOS_PROVIDER=anthropic`, `EPOS_MODEL=claude-sonnet-4-5`
- **OpenAI**: set `OPENAI_API_KEY`, `EPOS_PROVIDER=openai`, `EPOS_MODEL=gpt-4o`

Alternatively, you can leave them unset to use the current Pi configuration or export the standard environment variables directly.

## Token-efficient tools

Each user turn starts with only file reading and the internal `epos_load_tools` router. The model calls the router automatically to activate only the required capability. The EPOS MCP is initialized when the agent session starts and is the primary source for EPOS discovery, metadata and downloads; the specialist FDSN MCP remains on demand.

The catalogue adapter traverses all cached MCP result pages internally, deduplicates candidates and saves the full result list locally. The model receives up to 30 compact candidates; filters and cached pages expose the remainder. Metadata requests use a five-minute session cache. Chat shows relevant service or dataset titles grouped by scientific role. Discovery coverage is limited to the catalogue queries performed; it is not a guarantee of finding every scientifically relevant dataset. Pagination, batch downloads, file inspection and notebook assembly run without model calls between their mechanical steps.

## Guided study workflow

New studies follow this order: question → discovery → exact acquisition plan → user-interface approval → batch download → inspection and compatible visualization suggestions → selected visualization → reusable code and an executed Jupyter notebook. Missing essentials are collected in one compact question block. Each study is stored under `~/epos-agent/workspace/<study>-<timestamp>/`. The runtime requires recorded acquisition outcomes before inspection and a successful execution of the current `code/analysis.py` before notebook finalization.

Standard plots use the bundled `epos_viz` library and `code/visualization.json`. Static maps default to an offline coordinate grid; remote layers and interactive HTML are optional. Running the standard analysis automatically builds the notebook and executes it on a copy of the bundle with the current Python environment, comparing input hashes, counts, metrics and output names. Code or input changes invalidate prior verification. Pinned requirements come from actual imports and resolved features. This is a local reproduction check, not an installation test on every operating system.

## Security and runtime data

Sessions, cache, provenance logs, generated workspace files, Python environments, and authentication configuration are local runtime data and are excluded from Git. Provider-neutral usage metrics are appended to `logs/token-usage.jsonl` with model, active tools, token/cache counts and cost when available; prompts and scientific data are never logged there. Do not commit API keys, tokens, passwords, or `auth.json`.

## Download safety

Catalogue searches and distribution descriptions run without confirmation. Acquisition tools require an active study and a user-interface approval bound to the exact requests and resolved EPOS plans. FDSN detail calls and arbitrary public URL fetches are included; a metadata flag cannot bypass approval. The batch records downloaded, no-data, partial, access-denied, unavailable and failed outcomes. Repeating the batch reuses recorded results; `retryFailed: true` requests a new approval and retries unsuccessful transfers once while preserving earlier attempts. Restored sessions require new approval and fresh EPOS plans.

The retained-data budget is 1 GiB per study. The EPOS server additionally limits each response to 50 MiB; the wrapper checks the remaining study budget before copying the server artifact. FDSN enforces the remaining budget while writing records. These limits do not measure all wire traffic. Scientific completeness remains distinct from HTTP transfer completion. EPOS responses with pagination evidence are marked partial; arbitrary provider pagination is not automatically followed.

`metadata/` contains the approved plan, provenance, all acquisition attempts, inspection/analysis reports and the final inventory with sizes and SHA-256 hashes. Inventory records Python, available Pi/Git versions and source hashes. Large payloads and logs stay on disk. The approval checks govern acquisition tools; custom Python is not an operating-system network sandbox.

## Workflow verification

Runtime tests are in `tools/agent-runtime/tests/workflow.test.cjs`. They use the real TypeScript wrapper with a simulated Pi interface; the optional MCP test starts the real stdio server with offline HTTP fixtures, and the optional analysis test executes an actual notebook. No model API or live scientific service is needed.

Use a TypeScript 5.x development installation (the tests use its compiler API):

```bash
TYPESCRIPT_PATH=/path/to/typescript node --test tools/agent-runtime/tests/workflow.test.cjs
```

Set `MCP_TEST_PYTHON` to the installed MCP Python interpreter and `ANALYSIS_TEST_PYTHON` to the visualization interpreter with `requirements-core.txt` installed to enable both integration tests. Jupyter needs local loopback sockets. Without these variables, integration tests explicitly report skipped. Existing component tests remain:

```bash
PYTHONPATH=services/mcp-epos /path/to/mcp/python -m unittest discover -s services/mcp-epos/tests
/path/to/visualization/python -m unittest discover -s tools/visualization/tests
```

Compare `logs/token-usage.jsonl` across identical study requests and providers to measure token/call savings; the workflow checks do not establish equal scientific choices across models. No live multi-model benchmark is implied by the offline tests.

## Included FDSN service

The service in `services/mcp-fdsnws-event` is installed into a dedicated Python virtual environment by the platform installer. An explicit event `limit` is respected exactly. Without one, EPOS Agent adaptively partitions the requested time interval until every shard is below the provider result cap, deduplicates event IDs and verifies the oldest/newest boundaries before declaring the JSONL complete. Interrupted or unverifiable requests are retained as clearly marked `.partial.jsonl` files; chat receives the total and at most five samples.

Its existing tests can be run with:

```bash
cd services/mcp-fdsnws-event
./run_tests.sh
```

## License

See the license and attribution information in `services/mcp-fdsnws-event/LICENSE` and the upstream service documentation.
