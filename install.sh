#!/bin/bash
# ╔══════════════════════════════════════════════════╗
# ║         Hearth – Installer / Updater            ║
# ║  https://github.com/MarioundMB/Hearth           ║
# ╚══════════════════════════════════════════════════╝
#
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh | bash
#
# If curl is not available:
#   wget -qO- https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh | bash
#
# Download and run (recommended for interactive input):
#   curl -fsSL https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh -o install.sh && bash install.sh

set -euo pipefail

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

err()  { echo -e "\n${RED}✗  $*${NC}\n" >&2; exit 1; }
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
info() { echo -e "${CYAN}→${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
ask()  { echo -e "${BOLD}?${NC}  $*"; }

# ── Pipe detection ────────────────────────────────────────────────────────
# When running via "cmd | bash", stdin is the script pipe — not the terminal.
# Interactive `read` calls immediately get EOF and the script exits silently.
# Fix: if we are NOT in a tty, download the script to a temp file and re-run
# it directly so stdin stays connected to the terminal.
if [ ! -t 0 ]; then
  _TMP="$(mktemp /tmp/hearth-install-XXXX.sh)"
  # The script content is already being streamed to bash, so we download a
  # fresh copy rather than trying to re-read stdin.
  _SELF_URL="https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh"
  if command -v curl &>/dev/null && [[ "$(command -v curl)" != /snap/* ]]; then
    curl -fsSL "$_SELF_URL" -o "$_TMP"
  elif [ -x /usr/bin/curl ]; then
    /usr/bin/curl -fsSL "$_SELF_URL" -o "$_TMP"
  elif command -v wget &>/dev/null; then
    wget -qO "$_TMP" "$_SELF_URL"
  else
    echo "Could not download installer. Please run: bash install.sh (after downloading)" >&2
    exit 1
  fi
  chmod +x "$_TMP"
  exec bash "$_TMP"   # replace this process — interactive from here
fi

# Banner
echo ""
echo -e "${GREEN}${BOLD}  ▲  Hearth – Home Server Panel${NC}"
echo -e "${DIM}  ──────────────────────────────────────────────${NC}"
echo ""

# ── Download helper (curl or wget) ────────────────────────────────────────
# IMPORTANT: The Snap version of curl writes warnings to stdout, which
# corrupts any pipe-to-bash pattern. Always prefer the native apt curl
# (/usr/bin/curl) or wget over snap curl (/snap/bin/curl).
FETCH=""

# Prefer native /usr/bin/curl over snap curl
if [ -x /usr/bin/curl ]; then
  FETCH="/usr/bin/curl -fsSL"
elif command -v curl &>/dev/null; then
  _CURL_PATH="$(command -v curl)"
  if [[ "$_CURL_PATH" == /snap/* ]]; then
    # snap curl detected — it injects warnings into stdout and breaks pipes.
    # Try to install the native package instead.
    warn "Snap version of curl detected — it is incompatible with pipe installs."
    if command -v apt-get &>/dev/null; then
      info "Installing native curl via apt…"
      apt-get install -y -qq curl 2>/dev/null && FETCH="/usr/bin/curl -fsSL" || true
    fi
    # If apt install failed or unavailable, fall through to wget
    if [ -z "$FETCH" ] && command -v wget &>/dev/null; then
      warn "Falling back to wget."
      FETCH="wget -qO-"
    fi
    [ -z "$FETCH" ] && err "Could not get a working download tool.\n  Run: sudo apt install curl\n  Then re-run this installer."
  else
    FETCH="$_CURL_PATH -fsSL"
  fi
elif command -v wget &>/dev/null; then
  FETCH="wget -qO-"
fi

# ── Detect package manager ────────────────────────────────────────────────
_pkg_install() {
  if   command -v apt-get &>/dev/null; then apt-get install -y -qq "$@" 2>/dev/null
  elif command -v dnf     &>/dev/null; then dnf     install -y -q  "$@" 2>/dev/null
  elif command -v yum     &>/dev/null; then yum     install -y -q  "$@" 2>/dev/null
  elif command -v pacman  &>/dev/null; then pacman  -Sy --noconfirm "$@" 2>/dev/null
  elif command -v apk     &>/dev/null; then apk     add --quiet     "$@" 2>/dev/null
  else return 1
  fi
}
_apt_update() { command -v apt-get &>/dev/null && apt-get update -qq 2>/dev/null || true; }

# ── Last resort: no usable download tool found ───────────────────────────
if [ -z "$FETCH" ]; then
  info "No usable download tool found. Installing native curl via apt…"
  _apt_update
  _pkg_install curl || err "Could not install curl. Please install curl or wget manually and re-run."
  [ -x /usr/bin/curl ] && FETCH="/usr/bin/curl -fsSL" || err "curl installation failed."
  ok "curl installed"
fi

info "Checking prerequisites…"

# ── Auto-install Git ──────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  info "Installing Git…"
  _apt_update
  _pkg_install git || err "Could not install Git automatically.\n  Ubuntu/Debian: sudo apt install git\n  Fedora/RHEL:   sudo dnf install git"
  command -v git &>/dev/null && ok "Git installed" || err "Git installation failed."
fi

# ── Auto-install Docker ───────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  info "Installing Docker (this may take a minute)…"
  $FETCH https://get.docker.com | sh

  # Enable and start the service
  if command -v systemctl &>/dev/null; then
    systemctl enable docker 2>/dev/null || true
    systemctl start  docker 2>/dev/null || true
  fi

  # Add the current user to the docker group
  _TARGET_USER="${SUDO_USER:-${USER:-}}"
  if [ -n "$_TARGET_USER" ] && [ "$_TARGET_USER" != "root" ]; then
    usermod -aG docker "$_TARGET_USER" 2>/dev/null || true
    warn "Added $_TARGET_USER to the docker group."
    warn "You may need to log out and back in before running Docker without sudo."
  fi

  ok "Docker installed"
fi

# Verify Docker daemon is reachable
if ! docker info &>/dev/null 2>&1; then
  # One retry via sg in case the user was just added to the docker group
  sg docker "docker info" &>/dev/null 2>&1 \
    || err "Docker is installed but not reachable.\n  Try: sudo systemctl start docker\n  Or log out and back in if you were just added to the docker group."
fi

# ── Auto-install Docker Compose ───────────────────────────────────────────
DC=""
if   docker compose version &>/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose &>/dev/null;   then DC="docker-compose"
fi

if [ -z "$DC" ]; then
  info "Installing Docker Compose plugin…"

  # Try the official apt package first
  if command -v apt-get &>/dev/null; then
    _apt_update
    _pkg_install docker-compose-plugin 2>/dev/null || true
  fi

  # Fallback: download the standalone binary
  if ! docker compose version &>/dev/null 2>&1 && ! command -v docker-compose &>/dev/null; then
    _COMPOSE_URL="https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)"
    $FETCH "$_COMPOSE_URL" -o /usr/local/bin/docker-compose \
      && chmod +x /usr/local/bin/docker-compose 2>/dev/null || true
  fi

  if   docker compose version &>/dev/null 2>&1; then DC="docker compose"
  elif command -v docker-compose &>/dev/null;   then DC="docker-compose"
  else
    err "Docker Compose could not be installed automatically.\n  See: https://docs.docker.com/compose/install/"
  fi
  ok "Docker Compose installed"
fi

DOCKER_VER=$(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
ok "Docker ${DOCKER_VER}"
ok "Docker Compose ($DC)"
echo ""

# ── Directories ───────────────────────────────────────────────────────────
INSTALL_DIR="${HOME}/hearth"
IS_UPDATE=false

if [ -d "${INSTALL_DIR}/.git" ]; then
  IS_UPDATE=true
  warn "Hearth is already installed at ${INSTALL_DIR} — running update."
fi

if [ "${IS_UPDATE}" = false ]; then
  ask "Installation directory [${INSTALL_DIR}]:"
  read -rp "  → " INPUT_DIR  || INPUT_DIR=""
  INSTALL_DIR="${INPUT_DIR:-$INSTALL_DIR}"

  ask "Data directory for the file manager [/srv/hearth-data]:"
  read -rp "  → " INPUT_DATA || INPUT_DATA=""
  DATA_DIR="${INPUT_DATA:-/srv/hearth-data}"

  ask "Port [4500]:"
  read -rp "  → " INPUT_PORT || INPUT_PORT=""
  PORT="${INPUT_PORT:-4500}"
  echo ""
fi

# ── Clone / update repository ─────────────────────────────────────────────
if [ "${IS_UPDATE}" = true ]; then
  info "Updating Hearth…"
  git -C "${INSTALL_DIR}" pull --ff-only
else
  info "Downloading Hearth…"
  git clone https://github.com/MarioundMB/Hearth.git "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"
ok "Source code: ${INSTALL_DIR}"

# ── Create data directory ─────────────────────────────────────────────────
if [ "${IS_UPDATE}" = false ]; then
  if ! mkdir -p "${DATA_DIR}" 2>/dev/null; then
    sudo mkdir -p "${DATA_DIR}" && sudo chown "$(id -u):$(id -g)" "${DATA_DIR}"
  fi
  ok "Data directory: ${DATA_DIR}"
fi

# ── Write .env (fresh install only) ──────────────────────────────────────
if [ "${IS_UPDATE}" = false ]; then
  SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null \
    || tr -dc 'a-f0-9' < /dev/urandom | head -c 64)

  cat > .env <<EOF
PORT=${PORT}
DATA_DIR=${DATA_DIR}
SESSION_SECRET=${SESSION_SECRET}
EOF
  ok ".env created (session secret generated)"
else
  [ -f .env ] && ok ".env preserved" \
    || warn ".env missing — please create it manually (see .env.example)"
fi

# ── Build and start ────────────────────────────────────────────────────────
echo ""
info "Building and starting Hearth…"
${DC} up -d --build

# ── Done ──────────────────────────────────────────────────────────────────
PORT_DISPLAY=$(grep '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo "4500")
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

echo ""
echo -e "${GREEN}${BOLD}  ──────────────────────────────────────────────${NC}"

if [ "${IS_UPDATE}" = true ]; then
  echo -e "${GREEN}${BOLD}  ▲  Hearth updated successfully!${NC}"
else
  echo -e "${GREEN}${BOLD}  ▲  Hearth installed successfully!${NC}"
fi

echo ""
echo -e "  Open in browser:  ${BOLD}http://${IP}:${PORT_DISPLAY}${NC}"
echo ""

if [ "${IS_UPDATE}" = false ]; then
  echo -e "  ${DIM}A setup wizard will guide you through the initial configuration"
  echo -e "  (create admin account, set server name).${NC}"
  echo ""
fi

echo -e "  Directory: ${INSTALL_DIR}"
echo -e "  Data:      $(grep '^DATA_DIR=' .env 2>/dev/null | cut -d= -f2 || echo '/srv/hearth-data')"
echo ""
echo -e "  Update:  ${DIM}curl -fsSL https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh | bash${NC}"
echo -e "  Stop:    ${DIM}cd ${INSTALL_DIR} && ${DC} down${NC}"
echo -e "${GREEN}${BOLD}  ──────────────────────────────────────────────${NC}"
echo ""
