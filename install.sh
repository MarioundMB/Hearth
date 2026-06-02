#!/bin/bash
# ╔══════════════════════════════════════════════════╗
# ║         Hearth – Installer / Updater            ║
# ║  https://github.com/MarioundMB/Hearth           ║
# ╚══════════════════════════════════════════════════╝
#
# Nutzung (einzeiliger Install-Befehl):
#   curl -fsSL https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh | bash
#
# Oder herunterladen und ausführen (empfohlen für interaktive Eingaben):
#   curl -fsSL https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh -o install.sh && bash install.sh

set -euo pipefail

# ── Farben ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

err()  { echo -e "\n${RED}✗  $*${NC}\n" >&2; exit 1; }
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
info() { echo -e "${CYAN}→${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
ask()  { echo -e "${BOLD}?${NC}  $*"; }

# Stdin-Umleitung für den Fall, dass das Script via curl | bash läuft
[ -t 0 ] || exec </dev/tty 2>/dev/null || true

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ▲  Hearth – Home Server Panel${NC}"
echo -e "${DIM}  ──────────────────────────────────────────────${NC}"
echo ""

# ── Voraussetzungen prüfen ────────────────────────────────────────────────────
info "Prüfe Voraussetzungen…"

command -v docker &>/dev/null \
  || err "Docker ist nicht installiert.\n  → https://docs.docker.com/get-docker/"

docker info &>/dev/null 2>&1 \
  || err "Docker läuft nicht oder du hast keine Berechtigung.\n  Tipp: Füge deinen Nutzer zur docker-Gruppe hinzu: sudo usermod -aG docker \$USER"

command -v git &>/dev/null \
  || err "Git ist nicht installiert.\n  Ubuntu/Debian: sudo apt install git\n  Fedora/RHEL:   sudo dnf install git"

# Docker Compose Plugin oder standalone ermitteln
if docker compose version &>/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose &>/dev/null; then
  DC="docker-compose"
else
  err "Docker Compose fehlt. Installiere Docker >= 20.10 oder das Compose-Plugin."
fi

DOCKER_VER=$(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
ok "Docker ${DOCKER_VER}"
ok "Docker Compose (${DC})"
echo ""

# ── Installationsverzeichnis ──────────────────────────────────────────────────
INSTALL_DIR="${HOME}/hearth"
IS_UPDATE=false

if [ -d "${INSTALL_DIR}/.git" ]; then
  IS_UPDATE=true
  warn "Hearth ist bereits in ${INSTALL_DIR} installiert – führe Update durch."
fi

# ── Konfiguration abfragen ────────────────────────────────────────────────────
if [ "${IS_UPDATE}" = false ]; then
  ask "Installationsverzeichnis [${INSTALL_DIR}]:"
  read -rp "  → " INPUT_DIR
  INSTALL_DIR="${INPUT_DIR:-$INSTALL_DIR}"

  ask "Datenpfad für den Dateimanager [/srv/hearth-data]:"
  read -rp "  → " INPUT_DATA
  DATA_DIR="${INPUT_DATA:-/srv/hearth-data}"

  ask "Port [4500]:"
  read -rp "  → " INPUT_PORT
  PORT="${INPUT_PORT:-4500}"

  echo ""
fi

# ── Repo klonen oder aktualisieren ────────────────────────────────────────────
if [ "${IS_UPDATE}" = true ]; then
  info "Aktualisiere Hearth…"
  git -C "${INSTALL_DIR}" pull --ff-only
else
  info "Lade Hearth herunter…"
  git clone https://github.com/MarioundMB/Hearth.git "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"
ok "Quellcode: ${INSTALL_DIR}"

# ── Datenpfad anlegen ─────────────────────────────────────────────────────────
if [ "${IS_UPDATE}" = false ]; then
  if ! mkdir -p "${DATA_DIR}" 2>/dev/null; then
    sudo mkdir -p "${DATA_DIR}"
    sudo chown "$(id -u):$(id -g)" "${DATA_DIR}"
  fi
  ok "Datenpfad: ${DATA_DIR}"
fi

# ── .env schreiben (nur bei Erstinstallation) ─────────────────────────────────
if [ "${IS_UPDATE}" = false ]; then
  SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null \
    || tr -dc 'a-f0-9' < /dev/urandom | head -c 64)

  cat > .env <<EOF
PORT=${PORT}
DATA_DIR=${DATA_DIR}
SESSION_SECRET=${SESSION_SECRET}
EOF
  ok ".env erstellt (Session-Secret generiert)"
else
  # Beim Update .env nicht überschreiben
  [ -f .env ] && ok ".env beibehalten" || warn ".env fehlt – bitte manuell anlegen (siehe .env.example)"
fi

# ── Container bauen und starten ───────────────────────────────────────────────
echo ""
info "Baue und starte Hearth…"
${DC} up -d --build

# ── Fertig ────────────────────────────────────────────────────────────────────
PORT_DISPLAY=$(grep '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo "4500")
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

echo ""
echo -e "${GREEN}${BOLD}  ──────────────────────────────────────────────${NC}"

if [ "${IS_UPDATE}" = true ]; then
  echo -e "${GREEN}${BOLD}  ▲  Hearth wurde erfolgreich aktualisiert!${NC}"
else
  echo -e "${GREEN}${BOLD}  ▲  Hearth wurde erfolgreich installiert!${NC}"
fi

echo ""
echo -e "  Browser öffnen:  ${BOLD}http://${IP}:${PORT_DISPLAY}${NC}"
echo ""

if [ "${IS_UPDATE}" = false ]; then
  echo -e "  ${DIM}Beim ersten Aufruf startet der Setup-Wizard."
  echo -e "  Dort vergibst du Benutzername und Passwort.${NC}"
  echo ""
fi

echo -e "  Verzeichnis: ${INSTALL_DIR}"
echo -e "  Daten:       $(grep '^DATA_DIR=' .env 2>/dev/null | cut -d= -f2 || echo '/srv/hearth-data')"
echo ""
echo -e "  Aktualisieren:  ${DIM}curl -fsSL https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh | bash${NC}"
echo -e "  Stoppen:        ${DIM}cd ${INSTALL_DIR} && ${DC} down${NC}"
echo -e "${GREEN}${BOLD}  ──────────────────────────────────────────────${NC}"
echo ""
