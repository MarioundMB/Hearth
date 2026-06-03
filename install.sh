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
#   wget -O /tmp/hearth-install.sh https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh && bash /tmp/hearth-install.sh

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

err()  { echo -e "\n${RED}✗  $*${NC}\n" >&2; exit 1; }
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
info() { echo -e "${CYAN}→${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
ask()  { echo -e "${BOLD}?${NC}  $*"; }

# ── Pipe detection & self-relaunch ────────────────────────────────────────
# When running via "curl URL | bash" or "wget URL | bash", bash reads the
# script from stdin. Any subsequent `read` call gets EOF immediately and
# the script exits silently. Fix: if we detect we are being read from
# stdin (i.e. $0 is "bash" rather than a file path), download the script
# to a temp file and exec it so stdin is the terminal.
_SELF_URL="https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh"

if [[ "${0##*/}" == "bash" || "${0##*/}" == "sh" || "$0" == "-bash" || "$0" == "-sh" ]]; then
  _TMP="$(mktemp /tmp/hearth-install-XXXX.sh)"
  # Use whichever download tool is available (prefer native, not snap, curl)
  if [ -x /usr/bin/curl ];        then /usr/bin/curl -fsSL "$_SELF_URL" -o "$_TMP"
  elif command -v wget &>/dev/null; then wget -qO "$_TMP" "$_SELF_URL"
  elif command -v curl &>/dev/null; then curl -fsSL "$_SELF_URL" -o "$_TMP"
  else
    echo "Neither curl nor wget found. Please run:" >&2
    echo "  wget -O /tmp/hearth-install.sh $_SELF_URL && bash /tmp/hearth-install.sh" >&2
    exit 1
  fi
  chmod +x "$_TMP"
  exec bash "$_TMP"   # replace current process — stdin is the terminal now
fi

# ── Banner ────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ▲  Hearth – Home Server Panel${NC}"
echo -e "${DIM}  ──────────────────────────────────────────────${NC}"
echo ""

# ── Sudo setup ────────────────────────────────────────────────────────────
# Run everything as root, OR cache sudo credentials once at the start so
# the user is only prompted a single time during the entire installation.
_IS_ROOT=false
_SUDO_KEEPALIVE_PID=""

if [ "$(id -u)" = "0" ]; then
  _IS_ROOT=true
else
  if ! command -v sudo &>/dev/null; then
    err "This installer needs root privileges.\nEither run it as root (sudo bash install.sh) or install sudo first."
  fi
  info "Some steps require administrator access — you will be asked for your password once."
  sudo -v || err "sudo authentication failed."
  # Keep sudo ticket alive in the background for the duration of the install
  ( while true; do sudo -n true; sleep 50; kill -0 "$$" 2>/dev/null || exit 1; done ) &
  _SUDO_KEEPALIVE_PID=$!
fi

_sudo() { [ "$_IS_ROOT" = true ] && "$@" || sudo "$@"; }

# Clean up background process on exit
trap '[ -n "$_SUDO_KEEPALIVE_PID" ] && kill "$_SUDO_KEEPALIVE_PID" 2>/dev/null; true' EXIT

# ── Package manager helpers ───────────────────────────────────────────────
_apt_update() {
  command -v apt-get &>/dev/null && _sudo apt-get update -qq 2>/dev/null || true
}

_pkg_install() {
  if   command -v apt-get &>/dev/null; then _sudo apt-get install -y -qq "$@" 2>/dev/null
  elif command -v dnf     &>/dev/null; then _sudo dnf     install -y -q  "$@" 2>/dev/null
  elif command -v yum     &>/dev/null; then _sudo yum     install -y -q  "$@" 2>/dev/null
  elif command -v pacman  &>/dev/null; then _sudo pacman  -Sy --noconfirm "$@" 2>/dev/null
  elif command -v apk     &>/dev/null; then _sudo apk     add --quiet     "$@" 2>/dev/null
  else return 1
  fi
}

# ── Download helper ───────────────────────────────────────────────────────
# Prefer native /usr/bin/curl over snap curl (snap version writes warnings
# to stdout, which corrupts pipe-to-bash installs).
FETCH=""
if   [ -x /usr/bin/curl ];         then FETCH="/usr/bin/curl -fsSL"
elif command -v wget &>/dev/null;   then FETCH="wget -qO-"
elif command -v curl &>/dev/null; then
  _CURL_PATH="$(command -v curl)"
  if [[ "$_CURL_PATH" == /snap/* ]]; then
    warn "Snap curl detected — installing native curl via apt…"
    _apt_update; _pkg_install curl
    [ -x /usr/bin/curl ] && FETCH="/usr/bin/curl -fsSL" || FETCH="wget -qO-"
  else
    FETCH="$_CURL_PATH -fsSL"
  fi
fi

if [ -z "$FETCH" ]; then
  info "No download tool found — installing curl…"
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
  _pkg_install git || err "Could not install Git.\n  Ubuntu/Debian: sudo apt install git\n  Fedora/RHEL:   sudo dnf install git"
  command -v git &>/dev/null && ok "Git installed" || err "Git installation failed."
fi

# ── Auto-install Docker ───────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  info "Installing Docker (this may take a minute)…"
  # The official Docker install script handles sudo internally
  $FETCH https://get.docker.com | _sudo sh

  # Enable and start the daemon
  if command -v systemctl &>/dev/null; then
    _sudo systemctl enable docker 2>/dev/null || true
    _sudo systemctl start  docker 2>/dev/null || true
  fi

  # Add user to the docker group so Docker can be used without sudo
  _TARGET_USER="${SUDO_USER:-${USER:-}}"
  if [ -n "$_TARGET_USER" ] && [ "$_TARGET_USER" != "root" ]; then
    _sudo usermod -aG docker "$_TARGET_USER" 2>/dev/null || true
    warn "Added '$_TARGET_USER' to the docker group."
    warn "Log out and back in after the install for Docker to work without sudo."
  fi

  ok "Docker installed"
fi

# Verify Docker is reachable
_DOCKER_NEEDS_SG=false
if ! docker info &>/dev/null 2>&1; then
  # One retry via sg (in case the user was just added to the docker group)
  if sg docker "docker info" &>/dev/null 2>&1; then
    _DOCKER_NEEDS_SG=true
  else
    err "Docker is installed but not reachable.\n  Try: sudo systemctl start docker\n  Or log out and back in if you were just added to the docker group."
  fi
fi

# ── Auto-install Docker Compose ───────────────────────────────────────────
DC=""
if   docker compose version &>/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose &>/dev/null;   then DC="docker-compose"
fi

if [ -z "$DC" ]; then
  info "Installing Docker Compose plugin…"
  if command -v apt-get &>/dev/null; then
    _apt_update
    _pkg_install docker-compose-plugin 2>/dev/null || true
  fi
  # Fallback: download the standalone binary
  if ! docker compose version &>/dev/null 2>&1 && ! command -v docker-compose &>/dev/null; then
    _COMPOSE_URL="https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)"
    $FETCH "$_COMPOSE_URL" | _sudo tee /usr/local/bin/docker-compose > /dev/null \
      && _sudo chmod +x /usr/local/bin/docker-compose 2>/dev/null || true
  fi
  if   docker compose version &>/dev/null 2>&1; then DC="docker compose"
  elif command -v docker-compose &>/dev/null;   then DC="docker-compose"
  else err "Docker Compose could not be installed.\n  See: https://docs.docker.com/compose/install/"
  fi
  ok "Docker Compose installed"
fi

DOCKER_VER=$(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
ok "Docker ${DOCKER_VER}"
ok "Docker Compose ($DC)"
echo ""

# ── Install directory ─────────────────────────────────────────────────────
INSTALL_DIR="${HOME}/hearth"
IS_UPDATE=false

if [ -d "${INSTALL_DIR}/.git" ]; then
  IS_UPDATE=true
  warn "Hearth already installed at ${INSTALL_DIR} — running update."
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

# ── Clone / update ────────────────────────────────────────────────────────
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
    _sudo mkdir -p "${DATA_DIR}"
    _sudo chown "$(id -u):$(id -g)" "${DATA_DIR}" 2>/dev/null || true
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
  ok ".env created"
else
  [ -f .env ] && ok ".env preserved" \
    || warn ".env missing — please create it manually (see .env.example)"
fi

# ── Build and start ────────────────────────────────────────────────────────
echo ""
info "Building and starting Hearth…"
export GIT_SHA=$(git -C "${INSTALL_DIR}" rev-parse --short HEAD 2>/dev/null || echo "unknown")
if [ "$_DOCKER_NEEDS_SG" = true ]; then
  sg docker "GIT_SHA=${GIT_SHA} ${DC} up -d --build"
else
  GIT_SHA=${GIT_SHA} ${DC} up -d --build
fi

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
  echo -e "  ${DIM}A setup wizard will guide you through the initial configuration.${NC}"
  echo ""
fi
echo -e "  Directory: ${INSTALL_DIR}"
echo -e "  Data:      $(grep '^DATA_DIR=' .env 2>/dev/null | cut -d= -f2 || echo '/srv/hearth-data')"
echo ""
echo -e "  Update:  ${DIM}curl -fsSL https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh | bash${NC}"
echo -e "  Stop:    ${DIM}cd ${INSTALL_DIR} && ${DC} down${NC}"
echo -e "${GREEN}${BOLD}  ──────────────────────────────────────────────${NC}"
echo ""
