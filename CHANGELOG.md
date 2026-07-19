# Changelog

Alle nennenswerten Änderungen an Hearth werden hier festgehalten (menschenlesbar, pro Version).
Format angelehnt an [Keep a Changelog](https://keepachangelog.com/).

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
