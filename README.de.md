<div align="center">
  <img src="docs/banner.svg" alt="Hearth — Selbst gehostetes Docker-Management-Panel" width="100%"/>
</div>

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-c4f042.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933.svg?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED.svg?style=flat-square&logo=docker&logoColor=white)](https://docker.com)

**Lesen in:** &nbsp; [🇬🇧 English](README.md) &nbsp;|&nbsp; 🇩🇪 Deutsch

</div>

---

Hearth ist ein leichtgewichtiges, selbst gehostetes Docker-Management-Panel — eine saubere, moderne Alternative zu CasaOS oder Portainer für Home-Server und kleine VPS-Umgebungen.

## ✨ Features

| | |
|---|---|
| 🐳 **Container-Verwaltung** | Starten, Stoppen, Neustart, Löschen, Logs, Ports/Volumes/Env bearbeiten |
| 🔀 **Reverse Proxy** | Eingebautes Nginx — Domains auf Container routen, SSL/Let's Encrypt, WebSocket |
| 🛡 **Firewall** | UFW-basiert — Rate Limiting, Regel-Reihenfolge, Live-Logs, Outbound-Regeln |
| 🔒 **VPN** | WireGuard-Integration — Peers verwalten, QR-Codes generieren |
| 📁 **Dateimanager** | Upload, Download, Umbenennen, Löschen — auf ein sicheres Verzeichnis begrenzt |
| 🌐 **Gäste-Ansicht** | Öffentliche Seite mit laufenden Diensten — kein Login nötig |
| 📦 **App-Store** | 1-Klick-Installation für 20+ beliebte Self-Hosted-Apps |
| 📊 **Monitoring** | Live CPU, RAM, Netzwerk, Speicher, Temperaturen |
| 🔁 **Auto-Update** | Git-basiertes Selbst-Update mit Fortschrittsanzeige |
| 🌍 **9 Sprachen** | DE · EN · RO · FR · ES · IT · PL · NL · PT |

---

## 🚀 Installation

### Ein-Zeilen-Install (Empfohlen)

```bash
curl -fsSL https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh | bash
```

> **Alternative — wget:**
> ```bash
> wget -O - https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh | bash
> ```

Das Installationsskript übernimmt automatisch:
- Installation von **Docker**, **Docker Compose** und **Git** falls nicht vorhanden
- Generierung eines sicheren Session-Secrets
- Erstellen der Datenverzeichnisse
- Build und Start von Hearth

Nach der Installation **`http://<server-ip>:4500`** im Browser öffnen — ein Setup-Wizard führt durch die Erstkonfiguration.

> ℹ️ Derselbe Befehl **aktualisiert** auch eine bestehende Installation, ohne die `.env` zu verändern.

### Manuelle Installation

```bash
git clone https://github.com/MarioundMB/Hearth.git
cd Hearth
cp .env.example .env
# .env bearbeiten und SESSION_SECRET setzen (generieren mit: openssl rand -hex 32)
docker compose up -d --build
```

---

## ⚙️ Konfiguration

Alle Einstellungen werden in `.env` gespeichert (vom Installer automatisch erstellt):

| Variable | Standard | Beschreibung |
|---|---|---|
| `PORT` | `4500` | Admin-UI Port |
| `GUEST_PORT` | `3000` | Port der öffentlichen Gäste-Ansicht |
| `PROXY_PORT` | `443` | HTTPS-Port des Reverse Proxy |
| `DATA_DIR` | `/srv/hearth-data` | Wurzelverzeichnis des Dateimanagers |
| `SESSION_SECRET` | — | Erforderlich — zufälliger String für sichere Sessions |

Weitere Einstellungen (Server-Name, Sprache, Auto-Refresh, Cloudflare usw.) sind im Admin-Panel unter **⚙ Einstellungen** verfügbar.

---

## 🔀 Reverse Proxy

Hearth enthält einen eingebauten Nginx-Reverse-Proxy mit vollständiger SSL-Unterstützung:

- Domains über den Tab **Reverse Proxy** auf Container weiterleiten
- **SSL-Zertifikate** — automatisch generierte selbstsignierte, Let's Encrypt (HTTP-01 oder Cloudflare DNS-01) oder eigene Zertifikate hochladen
- **Passwortschutz** und **IP-Erlaubnisliste/-Sperrliste** pro Regel
- **Security-Header**, statisches Asset-Caching, eigene nginx-Snippets
- **Traffic-Logs** mit Statuscode-Aufschlüsselung
- Vollständige WebSocket-Unterstützung

---

## 🛡 Firewall

UFW-Regeln direkt aus dem Admin-Panel verwalten:

- **Rate Limiting** — Brute-Force mit `ufw limit` blockieren (>6 Verbindungen/30s)
- **Drag & Drop** Reihenfolge — First-Match-Wins, vollständig steuerbar
- **Live-Log-Stream** — geblockte/erlaubte Verbindungen in Echtzeit sehen
- Outbound-Regeln und Interface-Binding (z.B. `wg0` für VPN-only-Regeln)

> Benötigt den `hearth-firewall` Hilfs-Container (in `docker-compose.yml` enthalten).

---

## 🏷️ Gäste-Ansicht Labels

Steuern, wie Container auf der öffentlichen Gäste-Seite erscheinen:

| Label | Effekt |
|---|---|
| `hearth.name` | Anzeigename |
| `hearth.icon` | Emoji oder Bild-URL |
| `hearth.port` | Welcher Port die Web-UI ist |
| `hearth.scheme` | `http` (Standard) oder `https` |
| `hearth.url` | Automatisch ermittelte URL überschreiben |
| `hearth.hide=true` | Aus Gäste-Ansicht ausblenden |

**Beispiel:**
```yaml
labels:
  - "hearth.name=Jellyfin"
  - "hearth.icon=🎬"
  - "hearth.port=8096"
```

---

## 🔒 Sicherheitshinweise

- Der **Setup-Wizard** verhindert den Betrieb mit Standard-Zugangsdaten
- Docker-Socket-Zugriff gewährt root-äquivalente Rechte auf dem Host — nur in vertrauenswürdigen Netzwerken verwenden
- Für den Zugriff aus dem Internet: Hearth hinter einem Reverse Proxy mit HTTPS betreiben (oder den eingebauten Proxy mit einer echten Domain nutzen)
- Der **Dateimanager** ist auf `DATA_DIR` begrenzt — Path Traversal wird serverseitig blockiert

---

## 🏗️ Tech Stack

- **Backend:** Node.js · Express · Dockerode · Nginx
- **Frontend:** Vanilla HTML / CSS / JS — kein Build-Schritt, keine Frameworks
- **Auth:** Session-Cookies (`express-session`) · bcrypt Passwort-Hashing

```
hearth/
├── server.js              # Backend — alle API-Routen
├── Dockerfile
├── docker-compose.yml
├── nginx/nginx.conf       # Nginx-Basiskonfiguration
├── install.sh             # Ein-Zeilen-Installer
└── public/
    ├── admin.html         # Admin-Panel
    ├── index.html         # Gäste-Ansicht
    ├── login.html / setup.html
    ├── css/style.css
    └── js/
        ├── admin.js · guest.js · common.js
        └── i18n.js        # 9 Sprachen
```

---

## 🔄 Update / Stop

```bash
# Aktualisieren
curl -fsSL https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh | bash

# Oder den "Update"-Button in ⚙ Einstellungen verwenden

# Stoppen
cd ~/hearth && docker compose down
```

---

<div align="center">
  <sub>Mit ❤️ für Home-Server gebaut · <a href="https://github.com/MarioundMB/Hearth/issues">Problem melden</a></sub>
</div>
