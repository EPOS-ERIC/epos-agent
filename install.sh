#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="${EPOS_INSTALL_ROOT:-$HOME/epos-agent}"
PI_PACKAGE="${PI_PACKAGE:-@earendil-works/pi-coding-agent}"

say() { printf '[EPOS] %s\n' "$*"; }
fail() { printf '[EPOS] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$INSTALL_ROOT" != "$REPO_ROOT" ]] || fail "EPOS_INSTALL_ROOT must be different from the repository directory."

AUTO_INSTALL="${EPOS_AUTO_INSTALL:-0}"
confirm_install() {
  local answer
  if [[ "$AUTO_INSTALL" == "1" ]]; then return 0; fi
  [[ -t 0 ]] || fail "Missing dependencies and no interactive terminal. Re-run with EPOS_AUTO_INSTALL=1 or install them manually."
  printf '[EPOS] Install missing dependencies automatically? [Y/n] '
  read -r answer
  [[ -z "$answer" || "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || fail "Dependency installation declined."
}

install_dependencies() {
  local os packages=()
  os="$(uname -s)"
  if [[ "$os" == "Darwin" ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      confirm_install
      say "Installing Homebrew (required to install Node.js and Python)"
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      if [[ -x /opt/homebrew/bin/brew ]]; then export PATH="/opt/homebrew/bin:$PATH"; fi
      if [[ -x /usr/local/bin/brew ]]; then export PATH="/usr/local/bin:$PATH"; fi
      hash -r 2>/dev/null || true
    fi
    command -v brew >/dev/null 2>&1 || fail "Homebrew installation failed. Install it from https://brew.sh/ and re-run."
    command -v node >/dev/null 2>&1 || packages+=(node)
    command -v npm >/dev/null 2>&1 || packages+=(node)
    command -v python3 >/dev/null 2>&1 || packages+=(python)
    command -v git >/dev/null 2>&1 || packages+=(git)
    command -v rsync >/dev/null 2>&1 || packages+=(rsync)
    if ((${#packages[@]})); then
      confirm_install
      brew install "${packages[@]}"
    fi
    # Homebrew's node is also used when the system Node is too old.
    if command -v node >/dev/null 2>&1 && (( $(node -p 'Number(process.versions.node.split(".")[0])') < 22 )); then
      confirm_install
      brew upgrade node || brew install node
    fi
  elif [[ "$os" == "Linux" ]]; then
    if command -v apt-get >/dev/null 2>&1; then
      packages=(nodejs npm python3 python3-venv git rsync)
      confirm_install
      if [[ "$(id -u)" == "0" ]]; then apt-get update && apt-get install -y "${packages[@]}"; else sudo apt-get update && sudo apt-get install -y "${packages[@]}"; fi
    elif command -v dnf >/dev/null 2>&1; then
      packages=(nodejs npm python3 python3-pip git rsync)
      confirm_install
      if [[ "$(id -u)" == "0" ]]; then dnf install -y "${packages[@]}"; else sudo dnf install -y "${packages[@]}"; fi
    elif command -v pacman >/dev/null 2>&1; then
      packages=(nodejs npm python git rsync)
      confirm_install
      if [[ "$(id -u)" == "0" ]]; then pacman -Sy --noconfirm "${packages[@]}"; else sudo pacman -Sy --noconfirm "${packages[@]}"; fi
    else
      fail "Unsupported Linux package manager. Install Node.js >= 22.19.0, Python >= 3.11, Git and rsync manually."
    fi
  else
    fail "Unsupported operating system: $os"
  fi
  hash -r 2>/dev/null || true
}

install_dependencies
command -v node >/dev/null 2>&1 || fail "Node.js >= 22.19.0 is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v python3 >/dev/null 2>&1 || fail "Python >= 3.11 is required."
command -v git >/dev/null 2>&1 || fail "Git is required."
command -v rsync >/dev/null 2>&1 || fail "rsync is required."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_version="$(node -p 'process.versions.node')"
(( node_major >= 22 )) || fail "Node.js >= 22.19.0 is required (found $node_version). Update Node.js and re-run."
python_version="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
python_ok="$(python3 -c 'import sys; print(int(sys.version_info >= (3, 11)))')"
[[ "$python_ok" == 1 ]] || fail "Python >= 3.11 is required (found $python_version). Update Python and re-run."
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
  --exclude='services/mcpEpos/.venv/' \
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

say "Creating Python environment for EPOS MCP"
python3 -m venv "$INSTALL_ROOT/services/mcpEpos/.venv"
"$INSTALL_ROOT/services/mcpEpos/.venv/bin/python" -m pip install --upgrade pip >/dev/null
"$INSTALL_ROOT/services/mcpEpos/.venv/bin/python" -m pip install -r "$INSTALL_ROOT/services/mcpEpos/requirements.txt" >/dev/null

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
