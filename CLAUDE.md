# Hearth – Projektübersicht für Claude

Hearth ist ein selbst gehostetes Docker-Management-Panel (Node.js + Vanilla JS, kein Framework).
**Test-Server:** `192.168.0.121:4500` (lmb / Geili1234)
**Repo:** https://github.com/MarioundMB/Hearth
**Aktueller Branch:** `design/ui-overhaul` (Design-Überarbeitung)
**Main-Branch:** `main` (nur stabile, getestete Änderungen)

---

## Workflow-Regeln

- Nach jedem `git commit` direkt `git push` ausführen — ohne zu fragen.
- Version in `package.json` bei jedem Commit um Patch erhöhen (`1.0.x`).
- Minor (`1.x.0`) erhöhen wenn ein Feature-Bereich vollständig abgeschlossen ist.
- Major (`x.0.0`) erhöhen nur wenn der User sagt "alles ist stabil".
- Den Server NICHT manuell deployen. Der User nutzt den Update-Button in den Einstellungen.
- Bei SSH-Zugriffen auf den Server: `expect` verwenden (sshpass nicht installiert).
  Pfad zum Hearth-Verzeichnis auf dem Server: `~/hearth`

---

## Architektur

```
server.js          — Express-Backend, alle API-Routen, Docker-Kommunikation
public/
  admin.html       — Admin-Panel (alle Tabs: Container, Store, Images, Files, Proxy, Firewall, VPN)
  index.html       — Gäste-Ansicht (öffentliche App-Übersicht)
  login.html       — Login-Seite
  setup.html       — Ersteinrichtungs-Wizard
  css/style.css    — Gemeinsames Stylesheet (Dark Theme, CSS-Variablen)
  js/
    admin.js       — Komplette Admin-Panel-Logik
    guest.js       — Gäste-Ansicht-Logik
    common.js      — Geteilte Hilfsfunktionen (api(), toast(), etc.)
    i18n.js        — Mehrsprachigkeit (DE/EN/RO/FR/ES/IT/PL/NL/PT)
```

---

## Features & Status

### ✅ Container-Verwaltung (`view-containers`)
Start/Stop/Restart/Pause, Logs, Edit (Port/Volume/Env), Update-Check per Container,
Container-Detail-Modal mit Info + Edit-Tabs, Update-All-Button, Drag & Drop Docker-URL.
**Bekannte Schwäche:** Edit-Modal wirkt auf kleinen Screens eng.

### ✅ App-Store (`view-store`)
Vordefinierte App-Katalog mit 1-Klick-Installation, Kategorien, Suchfeld.
**Bekannte Schwäche:** Store-Karten könnten ansprechender gestaltet werden.

### ✅ Images (`view-images`)
Image-Liste, Pull-Dialog, Image löschen.
**Bekannte Schwäche:** Kaum visuelles Feedback während des Pulls.

### ✅ Dateimanager (`view-files`)
Zwei-Spalten-Layout (Sidebar + Hauptbereich), Volume-Navigation, Upload (Drag & Drop),
Breadcrumb-Navigation, Datei-Aktionen (Herunterladen, Löschen, Umbenennen).
**Bekannte Schwäche:** Auf Mobile funktioniert die Sidebar als horizontaler Scroller — noch nicht perfekt.

### ✅ Reverse Proxy (`view-proxy`)
Nginx-basierter Reverse Proxy, Domain → Container-Routing, WebSocket-Support, SSL-Hinweise.
**Bekannte Schwäche:** Kein automatisches SSL/HTTPS.

### ✅ Firewall (`view-firewall`)
UFW-basiert, Normal-Modus (Quick-Toggle für Ports) + Expert-Modus (rohe UFW-Regeln),
Auto-Regeln für Container-Ports, Persistenz.
**Bekannte Schwäche:** Fehlermeldungen von UFW sind manchmal kryptisch.

### ✅ VPN (`vpn`)
WireGuard-Integration, Peer-Verwaltung, QR-Code für Mobile-Clients.
**Bekannte Schwäche:** Setup ist noch etwas umständlich.

### ✅ System-Monitoring (Sidebar)
CPU, RAM, Disk, Netzwerk (Live-Charts), Temperaturen, System-Info.
Auf Mobile: ausklappbares Panel.
**Bekannte Schwäche:** Netzwerk-Chart skaliert nicht immer schön.

### ✅ Self-Update
Git-basiertes Update-System: Hearth fetcht von GitHub, resettet, rebuilt via externem
`hearth-updater`-Container. Nightly-Auto-Update konfigurierbar.
**Wichtig:** Erfordert Volume-Mount `.:/app/repo` im docker-compose.yml.

### ✅ Benachrichtigungen
Notification-Bell in der Topbar, Update-Hinweise, persistente Benachrichtigungen.

### ✅ Mehrsprachigkeit
9 Sprachen (DE/EN/RO/FR/ES/IT/PL/NL/PT), Sprach-Auswahl in Gäste-Ansicht + per API.

### ✅ Authentifizierung
bcrypt-Passwort-Hashing, Session-basiert, Setup-Wizard bei Erststart.

---

## Aktueller Branch: `design/ui-overhaul`

**Ziel:** Das allgemeine Design verbessern, ohne Features zu verändern.

Geplante Verbesserungen:
- [ ] Konsistentere Abstände und Proportionen
- [ ] Bessere visuelle Hierarchie (Überschriften, Sektionen)
- [ ] Container-Karten ansprechender gestalten
- [ ] Store-Karten überarbeiten
- [ ] Leere Zustände (Empty States) verbessern
- [ ] Animations & Transitions verfeinern
- [ ] Gäste-Ansicht App-Karten verbessern
- [ ] Einstellungs-Modal überarbeiten
- [ ] Allgemeine Konsistenz zwischen allen Seiten

**Merge-Kriterium:** Wenn der User das Design als "fertig" bestätigt → Minor hochzählen → in `main` mergen.

---

## Nächste geplante Features (nach Design-Branch)

Diese Features sind geplant, aber noch nicht begonnen. Jeder neue Chat kann hier nachschauen:

- **OAuth / SSO** — Google/GitHub-Login als Alternative zu User+Passwort
- **Compose-Editor** — docker-compose.yml direkt im Browser bearbeiten und deployen
- **Container-Gruppen** — Container logisch gruppieren (z.B. "Medien", "Tools")
- **Backup & Restore** — Volume-Backups automatisieren
- **Logs verbessern** — Log-Streaming in Echtzeit, Filter, Download
- **HTTPS/SSL** — Automatisches SSL über Let's Encrypt im Reverse Proxy
- **Mehrere Benutzer** — Admin + Read-Only Gäste mit echten Accounts
- **Dashboard-Widgets** — Konfigurierbares Dashboard statt fixer Monitoring-Sidebar
- **Mobile App / PWA** — Progressive Web App für Homescreen-Installation
