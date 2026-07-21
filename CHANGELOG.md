# Changelog

Alle nennenswerten Änderungen an Hearth werden hier festgehalten (menschenlesbar, pro Version).
Format angelehnt an [Keep a Changelog](https://keepachangelog.com/).

## [1.5.49] - 2026-07-21

### Docs
- **README (EN/DE): echte Produkt-Screenshots** — neue 📸-Screenshots-Sektion (Container-Dashboard,
  App-Store, Reverse Proxy, Firewall, VPN, Gäste-Ansicht) unter `docs/screenshots/`.
- **Neues Getting-Started-Tutorial** unter `docs/getting-started.md` — Schritt für Schritt von der
  Installation bis zur ersten App aus dem Store, im README unter "Contents" verlinkt.

## [1.5.48] - 2026-07-20

### Security
- **Viewer-Rolle konnte volle Admin-Aktionen ausführen** (Broken Access Control): 76 zustandsändernde
  Routen (Container, Firewall, Reverse Proxy, VPN, Dateimanager, RAID, System-Updates, Terminal-Token
  u.a.) prüften nur `requireAuth` statt `requireAdmin` — ein als "Viewer" (read-only) angelegter Account
  konnte z.B. per `PUT /api/containers/:id` einen privilegierten Container mit `/`-Bind-Mount anlegen und
  damit Root auf dem Host erreichen. Eigene Konto-Aktionen (2FA, Passkeys, eigenes Passwort) bleiben
  bewusst `requireAuth`.
- **Stored XSS über das `hearth.url`-Label**: Jeder Container (App-Store, Docker-Hub-Pull, eigenes
  Compose) konnte `hearth.url="javascript:…"` setzen; `esc()` escaped nur HTML-Sonderzeichen, keine
  URL-Schemes. Betraf sowohl die Admin-Container-Liste als auch die öffentliche Gäste-Ansicht. Neue
  `safeUrl()`-Hilfsfunktion in `common.js` lässt nur noch `http(s):`-URLs durch.
- **Path Traversal in `/api/files/copy`**: Das Ziel wurde nach dem Zusammenbauen nicht erneut durch
  `safeResolve()` geprüft (anders als bei mkdir/rename) — ein Dateiname wie `../../../../app/server.js`
  konnte Dateien außerhalb von `DATA_DIR` überschreiben. Gleiches Muster (schwächerer Prefix-Check ohne
  Trennzeichen) im Upload-Handler behoben.
- **Shell-Injection über `req.params.num`** in `DELETE /api/firewall/rules/num/:num` (ungeprüft in einen
  `ufw delete`-Befehl im privilegierten, host-vernetzten Firewall-Container eingesetzt) und über
  Verzeichnisnamen in `/api/files/volumes` (`df -k "$p"` per `exec` statt `execFile`).
- **`/admin` und `/admin.html` waren ohne Login erreichbar**: Eine unauthentifizierte Route registrierte
  sich vor der eigentlich vorgesehenen, session-geprüften `/admin`-Route und machte diese zu totem Code.
- Login und 2FA-Verify hatten keinerlei Brute-Force-Schutz — jetzt IP-basiertes Rate-Limit (10 Versuche /
  15 Min). Zusätzlich: Session wird bei Login neu generiert (Session-Fixation), Cookie nutzt
  `secure: 'auto'`, Cloudflare-Secrets (`cfApiToken`/`cfZoneId`/`cfTunnelToken`) werden in
  `GET /api/settings` nur noch an Admins ausgeliefert, IP-Allow-/Denylist im Reverse Proxy wird jetzt vor
  dem Schreiben in die nginx-Config validiert.

## [1.5.44] - 2026-07-19

### Added
- VPN: Neuer "⚙ Einstellungen"-Button im VPN-Tab selbst (nicht im globalen Einstellungen-Modal)
  für Server-Adresse (VPN_HOST) und Port. Jede Änderung stößt eine kurze Neuerstellung des
  `hearth-vpn`-Containers an (bestehende Verbindungen werden kurz getrennt) und passt bei einer
  Port-Änderung zusätzlich die UFW-Regel an.
- "Server"-Anzeige im VPN-Tab nutzt jetzt die echten, vom Backend aufgelösten Werte statt der
  alten (kaputten) Heuristik, die aus `wg show` eine "endpoint"-Zeile herauszulesen versuchte.

### Fixed — größeres Redesign der Peer-Persistenz
- **Peers, die über "+ Client" angelegt wurden, überlebten keinen Container-Neustart** (Host-Reboot,
  Docker-Update, oder — wie hier beim Testen der Port-Funktion entdeckt — jede Änderung an
  SERVERURL/SERVERPORT/PEERS). Ursache: Das `linuxserver/wireguard`-Image regeneriert seine
  `wg_confs/wg0.conf` bei jedem Start komplett neu, ausschließlich basierend auf der `PEERS`-Env-
  Variable — manuell per `wg set` + Datei-Anhängen hinzugefügte Peers fallen dabei durch und
  verschwinden aus der aktiven Config (die Dateien bleiben liegen, sind aber nicht mehr aktiv).
  Add/Rename/Delete laufen jetzt stattdessen über die `PEERS`-Variable + Container-Neuerstellung —
  der offizielle, vom Image selbst erkannte Mechanismus. Kostet dafür bei jeder Änderung einen
  kurzen Verbindungsabbruch (wie beim Port), garantiert aber Neustart-Festigkeit.
- Setup-Assistent: Peer-Zähler hatte denselben veralteten `peer_`-Präfix-Bug wie in 1.5.34, jetzt
  auch hier korrigiert.
- Container-Neuerstellung (`recreateVpnContainer`) hatte zwei eigene Bugs, die erst beim Live-Testen
  auffielen: (1) Die Referenz auf den alten Container nutzte dessen Namen statt der unveränderlichen
  ID — nach dem Umbenennen zielte ein späterer "lösche den alten"-Aufruf versehentlich auf den
  bereits fertigen *neuen* Container. (2) Der alte Container wurde vor der Neuerstellung nicht
  gestoppt, was fehlschlug ("port already allocated"), sobald sich der Port nicht ändert (nur beim
  ursprünglichen Port-Wechsel-Test unbemerkt geblieben, weil sich der Port dort ja tatsächlich
  änderte). Beide gefixt und am echten Server verifiziert.
- Monitoring-Sidebar zeigte den `hearth-cloudflared`-Tunnel-Container fälschlich als "aktiven
  Nutzer-Container" mit (z. B. "3/3" statt "2/2"), weil ihm (bewusst, wegen einer separaten
  Namenskollision mit der Self-Update-Erkennung) das `hearth.self`-Label fehlte. Self-Update-Logik
  schließt "cloudflared" jetzt explizit aus, wodurch das Label sicher ergänzt werden konnte.

## [1.5.42] - 2026-07-19

### Fixed
- VPN: Der Admin-Port (4500/4501) war per UFW absichtlich auf das echte LAN beschränkt
  (`hearth-rule-adminpanel-lan`). Da `hearth-vpn` nicht im Host-Netzwerk läuft, maskiert seine
  eigene PostUp-Regel jeden VPN-Client auf die eigene Docker-Bridge-IP, bevor der Traffic den
  Host erreicht — UFW sah also nie die echte LAN-Quelle und blockierte den Zugriff auf den
  Admin-Port über VPN (andere LAN-Geräte ohne diese Beschränkung blieben erreichbar).
  `enforceLanOnlyPort` erkennt jetzt automatisch das Docker-Netz von `hearth-vpn` (per Container-
  Inspektion, nicht hartkodiert) und nimmt dessen Subnetz zusätzlich in die Freigabe auf —
  betrifft jede Installation mit VPN, nicht nur diesen Server, und heilt sich beim nächsten
  5-Minuten-Resync oder Neustart automatisch selbst.

## [1.5.41] - 2026-07-19

### Changed
- VPN: `#view-vpn` padding-bottom von 100px auf 260px erhöht.

## [1.5.40] - 2026-07-19

### Added
- VPN: Client-Zeilen sind jetzt anklickbar (wie bei Containern) und öffnen ein
  "Client bearbeiten"-Modal mit QR-Code, .conf-Download, Umbenennen und Löschen an einem Ort,
  statt einzelner Buttons pro Zeile.
- Backend: `PATCH /api/vpn/peers/:name` (umbenennen — reines Datei-Rename + Kommentar-Update,
  keine Neuverbindung nötig) und `DELETE /api/vpn/peers/:name` (live per `wg set ... remove`,
  Verzeichnis löschen, Eintrag aus `wg0.conf` entfernen).

### Fixed
- VPN: Die "nächste freie IP"-Suche beim Anlegen eines Clients prüfte nur den *live*
  `wg show`-Status. Verliert ein Peer aus irgendeinem Grund kurzzeitig seine live Allowed-IP
  (persistierte `wg0.conf` bleibt davon unberührt), konnte ein neuer Client versehentlich
  dieselbe IP bekommen — WireGuard entzieht dem älteren Peer dann stillschweigend seine Route.
  Die Suche prüft jetzt zusätzlich die IPs aus `wg0.conf` gegen.

## [1.5.39] - 2026-07-19

### Fixed
- VPN: 1.5.38 hatte `#view-vpn { min-height: 100px }` gesetzt statt des gewünschten
  `padding-bottom: 100px` — korrigiert.

## [1.5.38] - 2026-07-19

### Fixed
- VPN: `#view-vpn` bekommt `min-height: 100px`, damit die Seite bei wenig Inhalt (z. B. keine
  oder wenige Clients) nicht zu knapp/abgeschnitten wirkt.

## [1.5.37] - 2026-07-19

### Added
- VPN: Neuer "+ Client"-Button erstellt einen neuen VPN-Peer live (Keypair-Generierung,
  freie IP im Subnetz suchen, `wg set` auf die laufende Schnittstelle anwenden — ohne
  Container-Neustart, bestehende Verbindungen bleiben also aktiv) und persistiert ihn
  zusätzlich in `wg_confs/wg0.conf`, damit er auch einen Neustart übersteht. Direkt danach
  öffnet sich das QR-/`.conf`-Modal zur Übergabe an den neuen Client.
- Frische Installationen starten jetzt mit 0 vorgefertigten Peers statt 1 (`VPN_PEERS`
  Default in `docker-compose.yml` und `.env.example`) — Clients werden über den neuen
  Button angelegt statt beim Container-Start vorgeneriert. Bestehende Installationen sind
  davon nicht betroffen.

### Fixed
- Setup-Assistent: Der VPN-Peer-Zähler suchte ebenfalls nach dem falschen `peer_`-Verzeichnisformat
  (gleiche Ursache wie in 1.5.34) und zeigte dadurch fälschlich 0 Peers an.

## [1.5.36] - 2026-07-19

### Fixed
- VPN: QR-Code-Modal war auf kürzeren Fenstern/Bildschirmen abgeschnitten — Titel, QR-Bild,
  Hinweistext und Footer (Download/Schließen) scrollten gemeinsam mit dem Hintergrund-Overlay,
  wodurch Footer-Buttons unerreichbar sein konnten. Kopf- und Fußbereich des Modals bleiben jetzt
  fix sichtbar, nur der QR-Code-Bereich scrollt bei Bedarf, und die Bildgröße schrumpft vorher
  proaktiv mit der Fensterhöhe (`clamp(140px, 32vh, 220px)`) statt zu überlaufen.

## [1.5.35] - 2026-07-19

### Fixed
- VPN: QR-Code aus 1.5.34 wurde zwar wieder gefunden, aber unscharf angezeigt — das von
  `linuxserver/wireguard` mitgelieferte PNG ist nur 207×207px und wurde vom Browser auf die
  220px-Anzeigegröße (bzw. auf Retina-Displays effektiv 440px) hochskaliert. Der QR-Code wird
  jetzt serverseitig direkt aus dem .conf-Inhalt mit dem bereits vorhandenen `qrcode`-Paket in
  440×440px erzeugt, statt die kleine mitgelieferte Datei aus dem Container auszulesen.

## [1.5.34] - 2026-07-19

### Fixed
- VPN: Peer-Erkennung suchte nach Verzeichnissen im Format `peer_<name>`, das echte
  `linuxserver/wireguard`-Image legt sie aber als `peer1`, `peer2`, ... an (ohne Unterstrich).
  Dadurch wurden Peers nie über das Verzeichnis gefunden, sondern nur über einen unzuverlässigen
  `wg show`-Fallback mit abgeschnittenem Public Key als Namen — und die daraus gebauten Pfade für
  QR-Code und .conf-Download existierten gar nicht.
  - QR-Code wurde dadurch nie angezeigt (Datei nicht gefunden → leerer Response).
  - .conf-Download lieferte statt eines echten Configs nur die Fehlermeldung von `cat` aus,
    zusätzlich mit `Content-Type: text/plain`, wodurch der Browser `.txt` an den Dateinamen anhängte
    (z. B. `peer1.conf.txt`) und WireGuard die Datei nicht erkannte.
  - Fix: Verzeichnisname wird jetzt unverändert als Peer-Name übernommen und für Pfad-Konstruktion
    wiederverwendet; `.conf`-Download nutzt `application/octet-stream` statt `text/plain`; fehlender
    Config-Inhalt liefert jetzt korrekt 404 statt einer kaputten Datei.
  - Nebenbei: Docker-Exec-Streams (`vpnExec`, QR-Route) demultiplexen jetzt korrekt über
    `docker-modem`s `demuxStream` statt naiv 8 Bytes von jedem Chunk abzuschneiden (robust auch
    bei größeren/binären Antworten, die über mehrere Chunks verteilt ankommen).
