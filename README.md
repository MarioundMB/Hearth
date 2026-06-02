# 🔥 Hearth — Home Server Panel

Ein leichtgewichtiges, selbst gehostetes Panel zum Verwalten von Docker-Containern —
inspiriert von CasaOS, aber bewusst schlank gehalten. **Kein App-Store**, dafür:

- **Container** erstellen, starten, stoppen, neu starten, löschen + Logs einsehen
- **Images** ziehen und löschen
- **Dateimanager** (Hoch-/Herunterladen, Ordner, Umbenennen, Löschen) — sicher in einem Verzeichnis eingesperrt
- **Öffentliche Gäste-Ansicht** aller laufenden Dienste als Kacheln — **ohne Login**

---

## Schnellstart (empfohlen: Docker Compose)

1. `docker-compose.yml` anpassen:
   - **`ADMIN_PASSWORD`** auf ein eigenes Passwort setzen
   - **`SESSION_SECRET`** auf einen langen Zufallsstring setzen (`openssl rand -hex 32`)
   - Bei `volumes` den linken Pfad bei `/srv/hearth-data:/mnt/data` auf das Verzeichnis ändern,
     das der Dateimanager verwalten soll.

2. Starten:
   ```bash
   docker compose up -d --build
   ```

3. Öffnen:
   - Gäste-Ansicht: `http://<server-ip>:4500/`
   - Admin: `http://<server-ip>:4500/admin`

### Ohne Docker (direkt mit Node.js ≥ 18)
```bash
npm install
ADMIN_PASSWORD=meinpasswort FILES_ROOT=/srv/daten node server.js
```

---

## Die Gäste-Ansicht ("Overall")

Das ist die Startseite (`/`). Sie zeigt **automatisch** alle laufenden Container,
die einen Port nach außen veröffentlichen, als anklickbare Kacheln — ganz ohne Anmeldung.
Genau wie bei CasaOS sieht ein Gast also sofort die verfügbaren Dienste.

### Kacheln hübsch machen (optional)
Steuern lässt sich das über **Labels** am Container. Beim Erstellen im Admin-Panel
unter „Labels" eintragen, oder in deiner eigenen `docker-compose.yml`:

| Label | Wirkung |
|---|---|
| `hearth.name` | Anzeigename der Kachel |
| `hearth.icon` | Emoji (z.B. `🎬`) **oder** eine Bild-URL |
| `hearth.description` | Kurzbeschreibung |
| `hearth.port` | Welcher **interne** Port der Web-UI entspricht (falls mehrere) |
| `hearth.scheme` | `http` (Standard) oder `https` |
| `hearth.url` | Feste URL erzwingen statt automatischer Erkennung |
| `hearth.hide` | `true` = Container in der Gäste-Ansicht ausblenden |

Beispiel für einen Jellyfin-Container:
```yaml
labels:
  - "hearth.name=Jellyfin"
  - "hearth.icon=🎬"
  - "hearth.description=Medienserver"
  - "hearth.port=8096"
```

---

## Sicherheit — bitte lesen

- **Admin-Passwort ändern!** Der Standard `changeme` ist nur ein Platzhalter.
- Hearth braucht Zugriff auf den **Docker-Socket** — das ist faktisch Root-Rechte auf dem Host.
  Betreibe das Panel daher **nur im eigenen, vertrauenswürdigen Netz** und mache es nicht ungeschützt
  aus dem Internet erreichbar. Für externen Zugriff einen Reverse-Proxy mit HTTPS davorsetzen.
- Der **Dateimanager** kann ausschließlich innerhalb von `FILES_ROOT` arbeiten; Path-Traversal
  (`../`) wird blockiert.
- Die Gäste-Ansicht ist **nur lesend** und gibt keine sensiblen Daten preis — sie listet lediglich
  Name, Beschreibung und veröffentlichten Port laufender Dienste.

---

## Technik

- **Backend:** Node.js + Express, `dockerode` für die Docker-Engine-API
- **Frontend:** statisches HTML/CSS/Vanilla-JS (kein Build-Schritt — leicht anzupassen)
- **Auth:** Session-Cookie (`express-session`)

Erweiterungsideen: Container-Bearbeitung (recreate mit neuen Einstellungen),
CPU-/RAM-Statistik pro Container, mehrere Benutzer, Backups.
```
hearth/
├── server.js          # gesamte Backend-Logik
├── public/
│   ├── index.html     # Gäste-Ansicht
│   ├── login.html
│   ├── admin.html     # Admin-Panel
│   ├── css/style.css
│   └── js/{common,guest,admin}.js
├── Dockerfile
├── docker-compose.yml
└── .env.example
```
