#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="${EPOS_INSTALL_ROOT:-$HOME/epos-agent}"
PI_PACKAGE="${PI_PACKAGE:-@earendil-works/pi-coding-agent}"

say() { printf '[EPOS] %s\n' "$*"; }
fail() { printf '[EPOS] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$INSTALL_ROOT" != "$REPO_ROOT" ]] || fail "EPOS_INSTALL_ROOT must be different from the repository directory."
command -v node >/dev/null 2>&1 || fail "Node.js >= 22.19.0 is required. Install it from https://nodejs.org/"
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v python3 >/dev/null 2>&1 || fail "Python >= 3.11 is required."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_version="$(node -p 'process.versions.node')"
(( node_major >= 22 )) || fail "Node.js >= 22.19.0 is required (found $node_version)."
python_version="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
python_ok="$(python3 -c 'import sys; print(int(sys.version_info >= (3, 11)))')"
[[ "$python_ok" == 1 ]] || fail "Python >= 3.11 is required (found $python_version)."

if [[ -e "$INSTALL_ROOT" && -n "$(find "$INSTALL_ROOT" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  if [[ ! -f "$INSTALL_ROOT/.epos-agent-installation" ]]; then
    fail "$INSTALL_ROOT already exists and is not an EPOS Agent installation. Choose another path with EPOS_INSTALL_ROOT=/path ./install.sh."
  fi
else
  mkdir -p "$INSTALL_ROOT"
fi

say "Copying EPOS Agent files to $INSTALL_ROOT"
rsync -a --delete \
  --exclude='.git/' --exclude='.runtime/' --exclude='services/mcp-fdsnws-event/.venv/' \
  --exclude='cache/' --exclude='logs/' --exclude='sessions/' \
  --exclude='workspace/*' --exclude='config/pi-agent/' \
  "$REPO_ROOT/" "$INSTALL_ROOT/"
mkdir -p "$INSTALL_ROOT/workspace" "$INSTALL_ROOT/config/pi-agent" "$INSTALL_ROOT/cache" "$INSTALL_ROOT/logs/provenance" "$INSTALL_ROOT/sessions"
touch "$INSTALL_ROOT/workspace/.gitkeep"

say "Installing pi coding agent locally"
mkdir -p "$INSTALL_ROOT/.runtime"
npm install --prefix "$INSTALL_ROOT/.runtime" --no-fund --no-audit "$PI_PACKAGE@latest"

say "Installing EPOS API MCP"
npm install --prefix "$INSTALL_ROOT/services/mcp-epos" --no-fund --no-audit

say "Creating Python environment for FDSN MCP"
python3 -m venv "$INSTALL_ROOT/services/mcp-fdsnws-event/.venv"
"$INSTALL_ROOT/services/mcp-fdsnws-event/.venv/bin/python" -m pip install --upgrade pip >/dev/null
"$INSTALL_ROOT/services/mcp-fdsnws-event/.venv/bin/python" -m pip install "$INSTALL_ROOT/services/mcp-fdsnws-event" >/dev/null

if [[ ! -f "$INSTALL_ROOT/config/profile.env" ]]; then
  cp "$INSTALL_ROOT/config/profile.env.example" "$INSTALL_ROOT/config/profile.env"
fi
printf 'EPOS_AGENT_ROOT=%s\n' "$INSTALL_ROOT" > "$INSTALL_ROOT/.epos-agent-installation"
chmod +x "$INSTALL_ROOT/bin/epos-agent"
say "Installation completed. Start with: $INSTALL_ROOT/bin/epos-agent"
