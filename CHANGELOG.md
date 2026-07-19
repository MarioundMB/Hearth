# Changelog

Alle nennenswerten Änderungen an Hearth werden hier festgehalten (menschenlesbar, pro Version).
Format angelehnt an [Keep a Changelog](https://keepachangelog.com/).

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
