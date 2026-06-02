# Hearth — Home Server Panel

A lightweight, self-hosted Docker management panel — a clean alternative to CasaOS.

- **Container management** — create, start, stop, restart, delete, view logs
- **Image management** — pull and delete images
- **File manager** — upload, download, rename, delete — locked to a configurable directory
- **Public guest view** — shows running services as tiles, no login required
- **Setup wizard** on first run — no manual config needed
- **Settings panel** — server name, language, auto-refresh, password change and more
- **Built-in reverse proxy** (Nginx) — route domains to containers, WebSocket support
- **Firewall management** (ufw) — normal and expert mode
- **Monitoring sidebar** — CPU, RAM, network, storage, temperatures, system info
- **Auto-update checker** — notifies when container images have updates available
- **9 languages** — DE, EN, RO, FR, ES, IT, PL, NL, PT

---

## Installation

### One-Line Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh | bash
```

**If `curl` is not available:**
```bash
wget -qO- https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh | bash
```

The installer **automatically handles everything**:
- Installs `curl` / `wget` if neither is present
- Installs **Docker** (via the official `get.docker.com` script)
- Installs **Docker Compose** (plugin or standalone binary)
- Installs **Git**
- Generates a secure session secret
- Creates data directories
- Builds and starts Hearth

After installation, open `http://<server-ip>:4500` in a browser. A **setup wizard** guides you through creating your admin account.

The **same command** updates an existing installation without touching your `.env`.

**Prerequisites:** A Linux system (Ubuntu, Debian, Fedora, and similar are supported). The script needs to be run as root or a user with sudo privileges to install system packages.

---

### Manual Installation

```bash
git clone https://github.com/MarioundMB/Hearth.git
cd Hearth
cp .env.example .env
# Edit .env: set SESSION_SECRET (generate with: openssl rand -hex 32)
docker compose up -d --build
```

Open `http://localhost:4500` — the setup wizard will appear on the first visit.

---

## Configuration

All settings are stored in `.env` (created automatically by the installer):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4500` | Admin UI port |
| `DATA_DIR` | `/srv/hearth-data` | Host path for the file manager |
| `SESSION_SECRET` | — | Random string for secure sessions (required) |
| `ADMIN_USER` | — | Admin username (optional — set via setup wizard) |
| `ADMIN_PASSWORD` | — | Admin password (optional — set via setup wizard) |

Additional settings (server name, language, auto-refresh interval, guest view options) are available directly in the admin panel under **⚙ Settings** and are stored in `hearth.config.json`.

---

## Guest View

The home page (`/`) shows all running containers with published ports as clickable tiles — no login required. Container appearance is controlled via Docker labels:

| Label | Effect |
|---|---|
| `hearth.name` | Display name |
| `hearth.icon` | Emoji (e.g. `🎬`) or image URL |
| `hearth.description` | Short description |
| `hearth.port` | Which internal port is the web UI (if the container exposes multiple) |
| `hearth.scheme` | `http` (default) or `https` |
| `hearth.url` | Force a specific URL instead of auto-detection |
| `hearth.hide` | `true` — hide from guest view |
| `hearth.self` | `true` — hide from admin container list (used by Hearth itself) |

**Example (Jellyfin):**
```yaml
labels:
  - "hearth.name=Jellyfin"
  - "hearth.icon=🎬"
  - "hearth.description=Media Server"
  - "hearth.port=8096"
```

---

## Reverse Proxy

Hearth includes a built-in Nginx reverse proxy. Manage rules in the admin panel under the **Reverse Proxy** tab:
- Route incoming requests by domain to any container port
- Full WebSocket support (for Portainer, VS Code Server, etc.)
- Rules are stored in `hearth.config.json` and applied instantly via `nginx -s reload`
- Proxy listens on port **80**; admin UI on port **4500**

---

## Firewall

Manage UFW firewall rules from the admin panel (**Firewall** tab). Requires the `hearth-firewall` helper container included in `docker-compose.yml`.

- **Normal mode** — toggle common ports (SSH 22, HTTP 80, HTTPS 443, DNS 53, and more) with a single click
- **Expert mode** — full rule management (add/delete by port, protocol, source IP)

---

## Security

- The **setup wizard** prevents running with default credentials
- Docker socket access grants root-equivalent privileges on the host — only run on trusted networks
- For external access, place a reverse proxy with HTTPS in front (Caddy, Nginx Proxy Manager, etc.)
- The **file manager** is locked to `DATA_DIR` — path traversal is blocked server-side
- Passwords are compared using `crypto.timingSafeEqual` to prevent timing attacks

---

## Languages

Available in **9 languages**:
🇩🇪 Deutsch · 🇬🇧 English · 🇷🇴 Română · 🇫🇷 Français · 🇪🇸 Español · 🇮🇹 Italiano · 🇵🇱 Polski · 🇳🇱 Nederlands · 🇵🇹 Português

Change language in **⚙ Settings → Language** — applies immediately without a page reload.

---

## Tech Stack

- **Backend**: Node.js + Express, Dockerode (Docker Engine API), Nginx (reverse proxy)
- **Frontend**: Static HTML / CSS / Vanilla JS — no build step, easy to customize
- **Auth**: Session cookies (`express-session`), config persisted in `hearth.config.json`

```
hearth/
├── server.js                 # Backend — all API endpoints
├── install.sh                # One-line installer for Linux
├── Dockerfile
├── docker-compose.yml        # Production (reads from .env)
├── docker-compose.local.yml  # Local testing on Windows/Mac
├── nginx/nginx.conf          # Nginx base configuration
├── .env.example              # Configuration template
└── public/
    ├── index.html            # Guest view    →  /
    ├── login.html            #               →  /login
    ├── setup.html            # Setup wizard  →  /setup  (first boot only)
    ├── admin.html            # Admin panel   →  /admin
    ├── favicon.svg           # Browser tab icon
    ├── css/style.css         # Shared stylesheet
    └── js/
        ├── common.js         # api() helper, toast(), formatting
        ├── guest.js          # Guest view logic
        ├── setup.js          # Setup wizard logic
        ├── admin.js          # Admin panel logic
        └── i18n.js           # Translations (9 languages)
```

---

## Updating

Run the same install command again — it detects the existing installation and updates without touching your `.env`:

```bash
curl -fsSL https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh | bash
```

## Stopping

```bash
cd ~/hearth && docker compose down
```
