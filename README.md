# Hearth — Home Server Panel

Ein leichtgewichtiges, selbst gehostetes Panel zum Verwalten von Docker-Containern —
inspiriert von CasaOS, aber bewusst schlank gehalten. Kein App-Store, dafür alles was man braucht.

- **Container** erstellen, starten, stoppen, neu starten, löschen + Logs einsehen
- **Images** ziehen und löschen
- **Dateimanager** — sicher in einem Verzeichnis eingesperrt (Hoch-/Herunterladen, Ordner, Umbenennen)
- **Öffentliche Gäste-Ansicht** aller laufenden Dienste als Kacheln — ohne Login
- **Setup-Wizard** beim ersten Start — kein manuelles Konfigurieren nötig
- **Einstellungs-Panel** direkt im Admin-Bereich (Name, Passwort, Sprache, Auto-Refresh u.v.m.)

---

## Installation

### Einzeiliger Installer (empfohlen)

```bash
curl -fsSL https://raw.githubusercontent.com/MarioundMB/Hearth/main/install.sh | bash
```

Der Installer prüft Voraussetzungen, fragt nach Datenpfad und Port, generiert
automatisch einen sicheren Session-Secret und startet Hearth. Beim ersten Öffnen
im Browser führt ein **Setup-Wizard** durch die Einrichtung von Benutzername und Passwort.

Derselbe Befehl aktualisiert eine bestehende Installation.

**Voraussetzungen:** Docker, Docker Compose, Git

---

### Manuell mit Docker Compose

```bash
git clone https://github.com/MarioundMB/Hearth.git
cd Hearth
cp .env.example .env
# .env öffnen und SESSION_SECRET setzen (openssl rand -hex 32)
docker compose up -d --build
```

Dann `http://<server-ip>:4500` öffnen — der Setup-Wizard startet automatisch.

---

### Ohne Docker (Node.js ≥ 18)

```bash
npm install
node server.js
```

Umgebungsvariablen können in einer `.env`-Datei oder direkt gesetzt werden.
Ohne `ADMIN_PASSWORD` in der Umgebung startet der Setup-Wizard im Browser.

---

## Konfiguration

Alle Einstellungen landen in `.env` (wird vom Installer automatisch erstellt):

| Variable | Standard | Beschreibung |
|---|---|---|
| `PORT` | `4500` | Port des Web-Interfaces |
| `DATA_DIR` | `/srv/hearth-data` | Host-Pfad für den Dateimanager |
| `SESSION_SECRET` | — | Zufälliger String für sichere Sessions (Pflicht) |
| `ADMIN_USER` | — | Admin-Benutzername (optional, sonst via Setup-Wizard) |
| `ADMIN_PASSWORD` | — | Admin-Passwort (optional, sonst via Setup-Wizard) |

Weitere Einstellungen (Server-Name, Auto-Refresh, Gäste-Ansicht-Optionen) sind
direkt im Admin-Bereich unter **⚙ Einstellungen** erreichbar und werden in
`hearth.config.json` gespeichert.

---

## Die Gäste-Ansicht

Die Startseite (`/`) zeigt automatisch alle laufenden Container mit veröffentlichten
Ports als anklickbare Kacheln — ganz ohne Anmeldung. Über **Labels** am Container
lässt sich das Aussehen steuern:

| Label | Wirkung |
|---|---|
| `hearth.name` | Anzeigename der Kachel |
| `hearth.icon` | Emoji (z.B. `🎬`) oder eine Bild-URL |
| `hearth.description` | Kurzbeschreibung |
| `hearth.port` | Welcher interne Port der Web-UI entspricht (falls mehrere) |
| `hearth.scheme` | `http` (Standard) oder `https` |
| `hearth.url` | Feste URL erzwingen statt automatischer Erkennung |
| `hearth.hide` | `true` — in der Gäste-Ansicht ausblenden |
| `hearth.self` | `true` — aus der Admin-Verwaltungsliste ausblenden (für Hearth selbst) |

Beispiel für einen Jellyfin-Container:

```yaml
labels:
  - "hearth.name=Jellyfin"
  - "hearth.icon=🎬"
  - "hearth.description=Medienserver"
  - "hearth.port=8096"
```

---

## Sicherheit

- Der **Setup-Wizard** verhindert, dass Hearth mit Standardpasswort läuft.
- Hearth benötigt Zugriff auf den **Docker-Socket** — das entspricht Root-Rechten auf dem Host.
  Nur im eigenen, vertrauenswürdigen Netz betreiben. Für externen Zugriff einen
  Reverse-Proxy mit HTTPS (z.B. Caddy, Nginx Proxy Manager) davorschalten.
- Der **Dateimanager** arbeitet ausschließlich innerhalb von `DATA_DIR`; Path-Traversal wird blockiert.
- Die **Gäste-Ansicht** ist rein lesend und gibt keine sensiblen Daten preis.
- Das **Passwort** wird mit `crypto.timingSafeEqual` verglichen (Timing-Angriffe werden erschwert).

---

## Technik

- **Backend:** Node.js + Express, `dockerode` für die Docker-Engine-API
- **Frontend:** statisches HTML / CSS / Vanilla-JS — kein Build-Schritt, leicht anpassbar
- **Auth:** Session-Cookie (`express-session`), Konfiguration persistent in `hearth.config.json`

```
hearth/
├── server.js              # gesamte Backend-Logik (API-Endpunkte, Setup, Einstellungen)
├── install.sh             # Einzeiliger Installer für Linux
├── Dockerfile
├── docker-compose.yml     # Produktiv-Setup (liest aus .env)
├── docker-compose.local.yml  # Lokales Testen unter Windows/Mac
├── .env.example           # Konfigurationsvorlage
└── public/
    ├── index.html         # Gäste-Ansicht  →  /
    ├── login.html         #                →  /login
    ├── setup.html         # Setup-Wizard   →  /setup  (nur beim ersten Start)
    ├── admin.html         # Admin-Panel    →  /admin
    ├── css/style.css
    └── js/
        ├── common.js      # api()-Helper, toast(), Formatierung
        ├── guest.js       # Gäste-Ansicht Logik
        ├── setup.js       # Setup-Wizard Logik
        └── admin.js       # Admin-Panel Logik
```
