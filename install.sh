#!/usr/bin/env bash
set -euo pipefail

# INSTALL_ROOT defaults to the repository directory itself (in-place install).
# Override with EPOS_INSTALL_ROOT=/other/path ./install.sh if needed.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="${EPOS_INSTALL_ROOT:-$REPO_ROOT}"
PI_PACKAGE="${PI_PACKAGE:-@earendil-works/pi-coding-agent}"

say()  { printf '[EPOS] %s\n' "$*"; }
fail() { printf '[EPOS] ERROR: %s\n' "$*" >&2; exit 1; }

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
    command -v node  >/dev/null 2>&1 || packages+=(node)
    command -v npm   >/dev/null 2>&1 || packages+=(node)
    command -v python3 >/dev/null 2>&1 || packages+=(python)
    command -v git   >/dev/null 2>&1 || packages+=(git)
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
      packages=(nodejs npm python3 python3-venv git)
      confirm_install
      if [[ "$(id -u)" == "0" ]]; then apt-get update && apt-get install -y "${packages[@]}"; else sudo apt-get update && sudo apt-get install -y "${packages[@]}"; fi
    elif command -v dnf >/dev/null 2>&1; then
      packages=(nodejs npm python3 python3-pip git)
      confirm_install
      if [[ "$(id -u)" == "0" ]]; then dnf install -y "${packages[@]}"; else sudo dnf install -y "${packages[@]}"; fi
    elif command -v pacman >/dev/null 2>&1; then
      packages=(nodejs npm python git)
      confirm_install
      if [[ "$(id -u)" == "0" ]]; then pacman -Sy --noconfirm "${packages[@]}"; else sudo pacman -Sy --noconfirm "${packages[@]}"; fi
    else
      fail "Unsupported Linux package manager. Install Node.js >= 22.19.0, Python >= 3.11 and Git manually."
    fi
  else
    fail "Unsupported operating system: $os"
  fi
  hash -r 2>/dev/null || true
}

install_dependencies
command -v node >/dev/null 2>&1 || fail "Node.js >= 22.19.0 is required."
command -v npm  >/dev/null 2>&1 || fail "npm is required."
command -v git  >/dev/null 2>&1 || fail "Git is required."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_version="$(node -p 'process.versions.node')"
(( node_major >= 22 )) || fail "Node.js >= 22.19.0 is required (found $node_version). Update Node.js and re-run."

# ── Find the best available Python ───────────────────────────────────────────
# Prefer Homebrew / system Python over conda-managed Python because conda's
# Python can fail to create venvs via symlinks on macOS (SIGKILL from SIP).
find_python() {
  local candidates=(
    /opt/homebrew/bin/python3   # Homebrew Apple Silicon
    /usr/local/bin/python3      # Homebrew Intel
    /usr/bin/python3            # macOS system (Xcode CLT)
    python3                     # whatever is on PATH (may be conda)
  )
  for py in "${candidates[@]}"; do
    if command -v "$py" >/dev/null 2>&1; then
      local ok
      ok="$("$py" -c 'import sys; print(int(sys.version_info >= (3, 11)))' 2>/dev/null || true)"
      if [[ "$ok" == "1" ]]; then
        printf '%s' "$py"
        return
      fi
    fi
  done
  return 1
}
PYTHON="$(find_python)" || fail "Python >= 3.11 is required. Install it via Homebrew (brew install python) and re-run."
python_version="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
say "Using Python $python_version ($PYTHON)"

# ── Create a venv, retrying with --copies if symlinking fails ────────────────
# --clear removes any partially-created venv from a previous failed run.
make_venv() {
  local venv_path="$1"
  if "$PYTHON" -m venv --clear "$venv_path" 2>/dev/null; then
    return 0
  fi
  say "Symlink-based venv failed; retrying with --copies …"
  "$PYTHON" -m venv --clear --copies "$venv_path"
}

# ── In-place installation: create runtime directories inside the repo ─────────
say "Installing into $INSTALL_ROOT"
mkdir -p "$INSTALL_ROOT/workspace" "$INSTALL_ROOT/config/pi-agent" \
         "$INSTALL_ROOT/cache" "$INSTALL_ROOT/logs/provenance" "$INSTALL_ROOT/sessions"
touch "$INSTALL_ROOT/workspace/.gitkeep"

say "Installing pi coding agent locally"
mkdir -p "$INSTALL_ROOT/.runtime"
npm install --prefix "$INSTALL_ROOT/.runtime" --no-fund --no-audit "$PI_PACKAGE@latest"

say "Creating Python environment for EPOS MCP"
make_venv "$INSTALL_ROOT/services/mcp-epos/.venv"
"$INSTALL_ROOT/services/mcp-epos/.venv/bin/python" -m pip install --upgrade pip >/dev/null
"$INSTALL_ROOT/services/mcp-epos/.venv/bin/python" -m pip install -r "$INSTALL_ROOT/services/mcp-epos/requirements.txt" >/dev/null

say "Creating Python environment for FDSN MCP"
make_venv "$INSTALL_ROOT/services/mcp-fdsnws-event/.venv"
"$INSTALL_ROOT/services/mcp-fdsnws-event/.venv/bin/python" -m pip install --upgrade pip >/dev/null
"$INSTALL_ROOT/services/mcp-fdsnws-event/.venv/bin/python" -m pip install "$INSTALL_ROOT/services/mcp-fdsnws-event" >/dev/null

say "Creating shared Python environment for EPOS visualizations"
make_venv "$INSTALL_ROOT/tools/visualization/.venv"
"$INSTALL_ROOT/tools/visualization/.venv/bin/python" -m pip install --upgrade pip >/dev/null
"$INSTALL_ROOT/tools/visualization/.venv/bin/python" -m pip install -r "$INSTALL_ROOT/tools/visualization/requirements-core.txt" >/dev/null

if [[ ! -f "$INSTALL_ROOT/config/profile.env" ]]; then
  cp "$INSTALL_ROOT/config/profile.env.example" "$INSTALL_ROOT/config/profile.env"
fi
printf 'EPOS_AGENT_ROOT=%s\n' "$INSTALL_ROOT" > "$INSTALL_ROOT/.epos-agent-installation"
chmod +x "$INSTALL_ROOT/bin/epos-agent"

# ── Make epos-agent available globally ────────────────────────────────────────
SYMLINK_CREATED=0
if [[ -d /usr/local/bin ]] && sudo ln -sf "$INSTALL_ROOT/bin/epos-agent" /usr/local/bin/epos-agent 2>/dev/null; then
  say "Symlink created: /usr/local/bin/epos-agent"
  SYMLINK_CREATED=1
else
  # Fallback: add to ~/.local/bin (no sudo needed)
  mkdir -p "$HOME/.local/bin"
  ln -sf "$INSTALL_ROOT/bin/epos-agent" "$HOME/.local/bin/epos-agent"
  # Ensure ~/.local/bin is in PATH via shell profile
  for rc_file in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [[ -f "$rc_file" ]] && ! grep -q 'epos-agent' "$rc_file" 2>/dev/null; then
      printf '\n# EPOS Agent\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc_file"
    fi
  done
  say "Symlink created: $HOME/.local/bin/epos-agent"
  say "Open a new terminal (or run: source ~/.zshrc) for the command to become available."
  SYMLINK_CREATED=1
fi

printf '\n'
say "Installation completed."
printf '[EPOS]\n'
printf '[EPOS]  To configure your provider/API key, edit config/profile.env:\n'
printf '[EPOS]    nano %s/config/profile.env\n' "$INSTALL_ROOT"
printf '[EPOS]\n'
printf '[EPOS]  To start EPOS Agent, run:\n'
if (( SYMLINK_CREATED )); then
  printf '[EPOS]    epos-agent\n'
else
  printf '[EPOS]    %s/bin/epos-agent\n' "$INSTALL_ROOT"
fi
printf '[EPOS]\n'
