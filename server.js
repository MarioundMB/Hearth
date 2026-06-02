/**
 * Hearth – Home Server Panel
 * Ein leichtgewichtiges Docker-Verwaltungs-Panel inspiriert von CasaOS.
 *
 * Architektur:
 *   - Express HTTP-Server, der das statische Frontend ausliefert
 *   - dockerode spricht direkt mit dem Docker-Socket (/var/run/docker.sock)
 *   - Session-basierte Admin-Authentifizierung
 *   - Öffentliche, nicht authentifizierte "Gäste"-Ansicht der laufenden Apps
 *   - In den FILES_ROOT eingesperrter Dateimanager (Schutz vor Path-Traversal)
 */

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const Docker = require('dockerode');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const os = require('os');
const { exec } = require('child_process');

const { version: VERSION } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
);

// ---------------------------------------------------------------------------
// Konfiguration (über Umgebungsvariablen steuerbar – siehe .env.example)
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '4500', 10);
const FILES_ROOT = path.resolve(process.env.FILES_ROOT || '/mnt/data');
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
// Persistente Konfigurationsdatei – wird beim Setup-Wizard erstellt
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(FILES_ROOT, 'hearth.config.json');

// FILES_ROOT anlegen, falls nicht vorhanden
try {
  fs.mkdirSync(FILES_ROOT, { recursive: true });
} catch (e) {
  console.warn(`[WARNUNG] Konnte FILES_ROOT (${FILES_ROOT}) nicht anlegen:`, e.message);
}

// ---------------------------------------------------------------------------
// Runtime-Konfiguration (Defaults aus ENV, wird durch Setup-Wizard ersetzt)
// ---------------------------------------------------------------------------
let runtimeConfig = {
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'changeme',
  serverName: process.env.SERVER_NAME || 'Hearth',
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  setupDone: !!(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== 'changeme'),
  // Einstellungen (vom Setup-Wizard / Einstellungs-Panel konfigurierbar)
  lang: 'de',
  showOfflineApps: false,
  refreshInterval: 15,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      Object.assign(runtimeConfig, saved);
    }
  } catch (e) {
    console.warn('[WARNUNG] Konfigurationsdatei konnte nicht geladen werden:', e.message);
  }
}

function saveConfig(updates) {
  Object.assign(runtimeConfig, updates, { setupDone: true });
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(runtimeConfig, null, 2), 'utf8');
}

loadConfig();

if (!runtimeConfig.setupDone) {
  console.log('\x1b[33m[SETUP] Erster Start → Setup-Wizard unter http://localhost:' + PORT + '/setup\x1b[0m');
} else if (runtimeConfig.adminPassword === 'changeme') {
  console.warn('\x1b[33m[WARNUNG] Standard-Passwort "changeme" ist aktiv!\x1b[0m');
}

const docker = new Docker({ socketPath: DOCKER_SOCKET });
const app = express();
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '2mb' }));
app.use(
  session({
    secret: runtimeConfig.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 12, // 12 Stunden
    },
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: 'Nicht angemeldet' });
}

// Setup-Redirect: alle Anfragen abfangen, solange der Wizard nicht abgeschlossen ist
app.use((req, res, next) => {
  if (runtimeConfig.setupDone) return next();
  if (
    req.path === '/setup' ||
    req.path.startsWith('/api/setup') ||
    /\.(css|js|ico|png|svg|woff2?)$/.test(req.path)
  ) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(503).json({ error: 'Setup erforderlich', setupRequired: true });
  }
  return res.redirect('/setup');
});

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

// Wandelt Docker-Container-Infos in ein schlankes Objekt um.
function mapContainer(c) {
  const labels = c.Labels || {};
  const name = (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, '');
  return {
    id: c.Id,
    shortId: c.Id.slice(0, 12),
    name,
    image: c.Image,
    state: c.State, // running, exited, ...
    status: c.Status,
    created: c.Created,
    ports: (c.Ports || []).map((p) => ({
      ip: p.IP,
      privatePort: p.PrivatePort,
      publicPort: p.PublicPort,
      type: p.Type,
    })),
    labels,
  };
}

// Baut aus einem Container eine "App-Kachel" für die Gäste-Ansicht.
// Liest optionale hearth.*-Labels aus (analog zu CasaOS-Metadaten).
function buildAppTile(c, reqHost) {
  const labels = c.labels || {};
  if (String(labels['hearth.hide']).toLowerCase() === 'true') return null;

  // Welcher veröffentlichte Host-Port soll verlinkt werden?
  const published = c.ports.filter((p) => p.publicPort);
  if (published.length === 0 && !labels['hearth.url']) return null;

  let webPort = null;
  if (labels['hearth.port']) {
    // explizit gesetzter interner Port -> passenden Host-Port finden
    const match = published.find(
      (p) => String(p.privatePort) === String(labels['hearth.port'])
    );
    webPort = match ? match.publicPort : null;
  }
  if (!webPort && published.length) {
    webPort = published[0].publicPort;
  }

  const scheme = labels['hearth.scheme'] || 'http';
  let url = labels['hearth.url'];
  if (!url && webPort) {
    url = `${scheme}://${reqHost}:${webPort}`;
  }
  if (!url) return null;

  return {
    id: c.id,
    name: labels['hearth.name'] || c.name,
    description: labels['hearth.description'] || c.image,
    icon: labels['hearth.icon'] || '', // Emoji oder Bild-URL
    url,
    running: c.state === 'running',
    ports: published.map((p) => p.publicPort),
  };
}

// Schützt vor Path-Traversal: löst einen relativen Pfad sicher innerhalb
// von FILES_ROOT auf und wirft, wenn er ausbrechen würde.
function safeResolve(relPath) {
  const clean = path.normalize(relPath || '/').replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(FILES_ROOT, '.' + path.sep + clean);
  if (full !== FILES_ROOT && !full.startsWith(FILES_ROOT + path.sep)) {
    throw new Error('Ungültiger Pfad');
  }
  return full;
}

function asyncHandler(fn) {
  return (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(err);
      res.status(err.statusCode || 500).json({ error: err.message || 'Serverfehler' });
    });
}

// ---------------------------------------------------------------------------
// Monitoring-Hilfsfunktionen
// ---------------------------------------------------------------------------

// CPU-Auslastung über /proc/stat (Linux-only, graceful fallback)
let _cpuPrev = null;
function _readProcStat() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const v = line.split(/\s+/).slice(1).map(Number);
    return { user: v[0], nice: v[1], system: v[2], idle: v[3], iowait: v[4] || 0, irq: v[5] || 0, soft: v[6] || 0 };
  } catch (_) { return null; }
}
function getCpuPercent() {
  const curr = _readProcStat();
  if (!curr) return null;
  if (!_cpuPrev) { _cpuPrev = curr; return 0; }
  const sum = (s) => s.user + s.nice + s.system + s.idle + s.iowait + s.irq + s.soft;
  const totalDiff = sum(curr) - sum(_cpuPrev);
  const idleDiff = (curr.idle + curr.iowait) - (_cpuPrev.idle + _cpuPrev.iowait);
  _cpuPrev = curr;
  return totalDiff === 0 ? 0 : Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)));
}
// Ersten Sample nehmen damit die nächste Abfrage einen sinnvollen Delta hat
_cpuPrev = _readProcStat();

// Festplatten via df (ignoriert tmpfs/overlay/squashfs)
function getDiskInfo() {
  return new Promise((resolve) => {
    exec(
      "df -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs --output=source,size,used,avail,target 2>/dev/null",
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        try {
          resolve(
            stdout.trim().split('\n').slice(1)
              .map((l) => {
                const p = l.trim().split(/\s+/);
                return { fs: p[0], total: +p[1], used: +p[2], avail: +p[3], mount: p[4] };
              })
              .filter((d) => d.total > 0 && !isNaN(d.total))
          );
        } catch (_) { resolve([]); }
      }
    );
  });
}

// Netzwerk-Durchsatz via /proc/net/dev (Delta zwischen Abfragen)
let _netPrev = null, _netPrevTs = 0;
function getNetworkRate() {
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').trim().split('\n').slice(2);
    const now = {};
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      const name = p[0].replace(':', '');
      if (name === 'lo') continue;
      now[name] = { rx: +p[1], tx: +p[9] };
    }
    const ts = Date.now();
    let rxBps = 0, txBps = 0;
    if (_netPrev && ts > _netPrevTs) {
      const dt = (ts - _netPrevTs) / 1000;
      for (const [n, v] of Object.entries(now)) {
        if (_netPrev[n]) {
          rxBps += Math.max(0, v.rx - _netPrev[n].rx) / dt;
          txBps += Math.max(0, v.tx - _netPrev[n].tx) / dt;
        }
      }
    }
    _netPrev = now; _netPrevTs = ts;
    return { rxMbps: (rxBps * 8) / 1e6, txMbps: (txBps * 8) / 1e6 };
  } catch (_) { return { rxMbps: 0, txMbps: 0 }; }
}

// Temperaturen via /sys/class/thermal oder /sys/class/hwmon
function getTemperatures() {
  const temps = [];
  const readTemp = (filePath) => {
    try { const v = +fs.readFileSync(filePath, 'utf8').trim() / 1000; return (v > 0 && v < 200) ? Math.round(v * 10) / 10 : null; } catch (_) { return null; }
  };
  try {
    const thermalBase = '/sys/class/thermal';
    if (fs.existsSync(thermalBase)) {
      for (const zone of fs.readdirSync(thermalBase).filter((z) => z.startsWith('thermal_zone'))) {
        try {
          const val = readTemp(`${thermalBase}/${zone}/temp`);
          const label = fs.readFileSync(`${thermalBase}/${zone}/type`, 'utf8').trim();
          if (val !== null) temps.push({ label, value: val });
        } catch (_) {}
      }
    }
  } catch (_) {}
  if (temps.length === 0) {
    try {
      const hwBase = '/sys/class/hwmon';
      if (fs.existsSync(hwBase)) {
        for (const hw of fs.readdirSync(hwBase)) {
          try {
            const name = fs.readFileSync(`${hwBase}/${hw}/name`, 'utf8').trim();
            for (const f of fs.readdirSync(`${hwBase}/${hw}`).filter((f) => /^temp\d+_input$/.test(f))) {
              const val = readTemp(`${hwBase}/${hw}/${f}`);
              if (val !== null) temps.push({ label: name, value: val });
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return temps;
}

// ---------------------------------------------------------------------------
// Docker Hub Metadaten-Proxy (vermeidet CORS im Browser)
// ---------------------------------------------------------------------------
app.get(
  '/api/dockerhub/info',
  requireAuth,
  asyncHandler(async (req, res) => {
    const raw = (req.query.image || '').trim().split(':')[0]; // Tag abschneiden
    if (!raw) return res.status(400).json({ error: 'image required' });

    const parts = raw.split('/');
    const [ns, name] = parts.length === 1 ? ['library', parts[0]] : [parts[0], parts[1]];

    try {
      const r = await fetch(
        `https://hub.docker.com/v2/repositories/${ns}/${name}/`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
      );
      if (!r.ok) return res.json({ found: false });
      const d = await r.json();
      res.json({
        found: true,
        image: ns === 'library' ? name : `${ns}/${name}`,
        description: (d.description || '').slice(0, 280),
        pullCount: d.pull_count || 0,
        starCount: d.star_count || 0,
        isOfficial: !!d.is_official,
        logoUrl: d.logo_url?.large || null,
      });
    } catch (_) {
      res.json({ found: false });
    }
  })
);

// ---------------------------------------------------------------------------
// Monitor-Endpoint (Admin)
// ---------------------------------------------------------------------------
app.get(
  '/api/monitor',
  requireAuth,
  asyncHandler(async (req, res) => {
    const [disks, containers] = await Promise.all([
      getDiskInfo(),
      docker.listContainers({ all: true }).catch(() => []),
    ]);
    const dockerInfo = await docker.info().catch(() => ({}));

    res.json({
      mem: { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem() },
      cpu: { percent: getCpuPercent(), cores: os.cpus().length, model: os.cpus()[0]?.model || '' },
      disks,
      net: getNetworkRate(),
      temps: getTemperatures(),
      system: {
        hostname: os.hostname(),
        uptime: os.uptime(),
        loadavg: os.loadavg(),
        containers: containers.length,
        running: containers.filter((c) => c.State === 'running').length,
        dockerVersion: dockerInfo.ServerVersion || null,
        platform: os.platform(),
      },
      ts: Date.now(),
    });
  })
);

// ---------------------------------------------------------------------------
// Einstellungen (Admin)
// ---------------------------------------------------------------------------
app.get('/api/lang', (req, res) => {
  res.json({ lang: runtimeConfig.lang || 'de' });
});

app.get('/api/settings', requireAuth, (req, res) => {
  res.json({
    // Bearbeitbar
    serverName: runtimeConfig.serverName,
    adminUser: runtimeConfig.adminUser,
    lang: runtimeConfig.lang || 'de',
    showOfflineApps: !!runtimeConfig.showOfflineApps,
    refreshInterval: runtimeConfig.refreshInterval ?? 15,
    // Nur Info
    port: PORT,
    dockerSocket: DOCKER_SOCKET,
    filesRoot: FILES_ROOT,
    version: VERSION,
  });
});

app.post(
  '/api/settings',
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      serverName, adminUser, newPassword, currentPassword,
      lang, showOfflineApps, refreshInterval,
    } = req.body || {};
    const updates = {};

    if (serverName !== undefined) updates.serverName = (serverName || '').trim() || 'Hearth';
    if (adminUser !== undefined) {
      if (!String(adminUser).trim()) {
        return res.status(400).json({ error: 'Benutzername darf nicht leer sein' });
      }
      updates.adminUser = String(adminUser).trim();
    }
    if (lang !== undefined) updates.lang = lang;
    if (showOfflineApps !== undefined) updates.showOfflineApps = !!showOfflineApps;
    if (refreshInterval !== undefined) updates.refreshInterval = Number(refreshInterval) || 0;

    if (newPassword) {
      if (newPassword.length < 8) {
        return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen lang sein' });
      }
      const curBuf = Buffer.from(String(currentPassword || ''));
      const refBuf = Buffer.from(runtimeConfig.adminPassword);
      const ok = curBuf.length === refBuf.length && crypto.timingSafeEqual(curBuf, refBuf);
      if (!ok) return res.status(401).json({ error: 'Aktuelles Passwort ist falsch' });
      updates.adminPassword = newPassword;
    }

    saveConfig(updates);
    res.json({ ok: true });
  })
);

app.post('/api/system/restart', requireAuth, (req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 400);
});

// ---------------------------------------------------------------------------
// Setup-Wizard API (nur nutzbar, solange setupDone === false)
// ---------------------------------------------------------------------------
app.get('/api/setup/status', (req, res) => {
  res.json({ needed: !runtimeConfig.setupDone });
});

app.post('/api/setup', asyncHandler(async (req, res) => {
  if (runtimeConfig.setupDone) {
    return res.status(403).json({ error: 'Setup bereits abgeschlossen' });
  }
  const { adminUser, adminPassword, serverName } = req.body || {};
  if (!adminUser || !adminPassword) {
    return res.status(400).json({ error: 'Benutzername und Passwort sind erforderlich' });
  }
  if (adminPassword.length < 8) {
    return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen lang sein' });
  }
  saveConfig({
    adminUser: adminUser.trim(),
    adminPassword,
    serverName: (serverName || 'Hearth').trim(),
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Auth-Routen
// ---------------------------------------------------------------------------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  // Konstantzeit-Vergleich, um Timing-Angriffe zu erschweren
  const userOk = username === runtimeConfig.adminUser;
  const passBuf = Buffer.from(String(password || ''));
  const refBuf = Buffer.from(runtimeConfig.adminPassword);
  const passOk =
    passBuf.length === refBuf.length && crypto.timingSafeEqual(passBuf, refBuf);

  if (userOk && passOk) {
    req.session.authed = true;
    req.session.user = username;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Benutzername oder Passwort falsch' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ authed: !!(req.session && req.session.authed), user: req.session?.user || null });
});

// ---------------------------------------------------------------------------
// Öffentliche Gäste-API (KEIN Login nötig)
// ---------------------------------------------------------------------------
app.get(
  '/api/public/apps',
  asyncHandler(async (req, res) => {
    const reqHost = (req.headers.host || 'localhost').split(':')[0];
    const containers = await docker.listContainers({ all: !!runtimeConfig.showOfflineApps });
    const tiles = containers
      .map(mapContainer)
      .map((c) => buildAppTile(c, reqHost))
      .filter(Boolean);
    res.json({ apps: tiles, host: reqHost });
  })
);

// ---------------------------------------------------------------------------
// System-Info (Admin)
// ---------------------------------------------------------------------------
app.get(
  '/api/system',
  requireAuth,
  asyncHandler(async (req, res) => {
    let dockerInfo = {};
    try {
      dockerInfo = await docker.info();
    } catch (e) {
      dockerInfo = { error: e.message };
    }
    const mem = { total: os.totalmem(), free: os.freemem() };
    res.json({
      hostname: os.hostname(),
      platform: os.platform(),
      uptime: os.uptime(),
      loadavg: os.loadavg(),
      cpus: os.cpus().length,
      memory: mem,
      docker: {
        containers: dockerInfo.Containers,
        running: dockerInfo.ContainersRunning,
        images: dockerInfo.Images,
        version: dockerInfo.ServerVersion,
        error: dockerInfo.error,
      },
      filesRoot: FILES_ROOT,
    });
  })
);

// ---------------------------------------------------------------------------
// Container-Verwaltung (Admin)
// ---------------------------------------------------------------------------
app.get(
  '/api/containers',
  requireAuth,
  asyncHandler(async (req, res) => {
    const containers = await docker.listContainers({ all: true });
    res.json(
      containers
        .map(mapContainer)
        .filter((c) => String(c.labels['hearth.self']).toLowerCase() !== 'true')
    );
  })
);

app.get(
  '/api/containers/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await docker.getContainer(req.params.id).inspect();
    res.json(data);
  })
);

app.post(
  '/api/containers/:id/:action(start|stop|restart|pause|unpause)',
  requireAuth,
  asyncHandler(async (req, res) => {
    const c = docker.getContainer(req.params.id);
    await c[req.params.action]();
    res.json({ ok: true });
  })
);

app.delete(
  '/api/containers/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const force = req.query.force === 'true';
    await docker.getContainer(req.params.id).remove({ force, v: false });
    res.json({ ok: true });
  })
);

// Container bearbeiten (stop → remove → neu erstellen mit neuen Einstellungen)
app.put(
  '/api/containers/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.image) { res.status(400); throw new Error('Image is required'); }

    const oldC = docker.getContainer(req.params.id);
    const info = await oldC.inspect();
    const wasRunning = info.State.Running;

    if (wasRunning) await oldC.stop().catch(() => {});
    await oldC.remove({ force: true });

    // Port-Bindings aufbauen
    const portBindings = {}, exposedPorts = {};
    (b.ports || []).forEach((p) => {
      if (!p.container) return;
      const proto = (p.proto || 'tcp').toLowerCase();
      const key = `${p.container}/${proto}`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: String(p.host || '') }];
    });

    const binds = (b.volumes || [])
      .filter((v) => v.host && v.container)
      .map((v) => `${v.host}:${v.container}${v.ro ? ':ro' : ''}`);

    const env = (b.env || []).filter((e) => e.key).map((e) => `${e.key}=${e.value ?? ''}`);

    const labels = {};
    (b.labels || []).forEach((l) => { if (l.key) labels[l.key] = String(l.value ?? ''); });

    const createOpts = {
      Image: b.image,
      name: b.name || undefined,
      Hostname: b.hostname || undefined,
      Env: env,
      Labels: labels,
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        Binds: binds,
        RestartPolicy: { Name: b.restart || 'unless-stopped' },
        Privileged: !!b.privileged,
        NetworkMode: b.network || 'bridge',
      },
    };

    const newC = await docker.createContainer(createOpts);
    if (wasRunning) await newC.start();
    res.json({ ok: true, id: newC.id });
  })
);

app.get(
  '/api/containers/:id/logs',
  requireAuth,
  asyncHandler(async (req, res) => {
    const c = docker.getContainer(req.params.id);
    const buf = await c.logs({
      stdout: true,
      stderr: true,
      tail: parseInt(req.query.tail || '200', 10),
      timestamps: false,
    });
    // Docker-Multiplex-Header (8 Byte) je Zeile entfernen
    const text = buf
      .toString('utf8')
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, (m) => (m === '\n' ? m : ''));
    res.type('text/plain').send(text);
  })
);

/**
 * Container erstellen.
 * Erwartet im Body:
 *   image      (string, Pflicht)  z.B. "nginx:latest"
 *   name       (string)
 *   ports      [{ host, container, proto }]
 *   volumes    [{ host, container, ro }]
 *   env        [{ key, value }]
 *   restart    (string) no|always|unless-stopped|on-failure
 *   labels     [{ key, value }]
 *   pull       (bool)  Image vorher ziehen
 */
app.post(
  '/api/containers',
  requireAuth,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.image) {
      res.status(400);
      throw new Error('Image ist erforderlich');
    }

    if (b.pull) {
      await pullImage(b.image);
    }

    const portBindings = {};
    const exposedPorts = {};
    (b.ports || []).forEach((p) => {
      if (!p.container) return;
      const proto = (p.proto || 'tcp').toLowerCase();
      const key = `${p.container}/${proto}`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: String(p.host || '') }];
    });

    const binds = (b.volumes || [])
      .filter((v) => v.host && v.container)
      .map((v) => `${v.host}:${v.container}${v.ro ? ':ro' : ''}`);

    const env = (b.env || [])
      .filter((e) => e.key)
      .map((e) => `${e.key}=${e.value ?? ''}`);

    const labels = {};
    (b.labels || []).forEach((l) => {
      if (l.key) labels[l.key] = String(l.value ?? '');
    });

    const createOpts = {
      Image: b.image,
      name: b.name || undefined,
      Env: env,
      Labels: labels,
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        Binds: binds,
        RestartPolicy: { Name: b.restart || 'unless-stopped' },
      },
    };

    const container = await docker.createContainer(createOpts);
    await container.start();
    res.json({ ok: true, id: container.id });
  })
);

// ---------------------------------------------------------------------------
// Images (Admin)
// ---------------------------------------------------------------------------
app.get(
  '/api/images',
  requireAuth,
  asyncHandler(async (req, res) => {
    const images = await docker.listImages();
    res.json(
      images.map((i) => ({
        id: i.Id,
        tags: i.RepoTags || [],
        size: i.Size,
        created: i.Created,
      }))
    );
  })
);

function pullImage(image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(
        stream,
        (doneErr) => (doneErr ? reject(doneErr) : resolve()),
        () => {}
      );
    });
  });
}

app.post(
  '/api/images/pull',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { image } = req.body || {};
    if (!image) {
      res.status(400);
      throw new Error('Image-Name erforderlich');
    }
    await pullImage(image);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/images/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    await docker.getImage(req.params.id).remove({ force: req.query.force === 'true' });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Dateimanager (Admin) – eingesperrt in FILES_ROOT
// ---------------------------------------------------------------------------
app.get(
  '/api/files',
  requireAuth,
  asyncHandler(async (req, res) => {
    const dir = safeResolve(req.query.path || '/');
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (e) => {
        let size = 0;
        let mtime = null;
        try {
          const st = await fsp.stat(path.join(dir, e.name));
          size = st.size;
          mtime = st.mtimeMs;
        } catch (_) {}
        return {
          name: e.name,
          isDir: e.isDirectory(),
          size,
          mtime,
        };
      })
    );
    items.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
    );
    res.json({ path: req.query.path || '/', items });
  })
);

app.get(
  '/api/files/download',
  requireAuth,
  asyncHandler(async (req, res) => {
    const full = safeResolve(req.query.path);
    const st = await fsp.stat(full);
    if (st.isDirectory()) {
      res.status(400);
      throw new Error('Ordner können nicht heruntergeladen werden');
    }
    res.download(full, path.basename(full));
  })
);

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 1024 * 1024 * 1024 } });
app.post(
  '/api/files/upload',
  requireAuth,
  upload.array('files'),
  asyncHandler(async (req, res) => {
    const destDir = safeResolve(req.body.path || '/');
    for (const f of req.files || []) {
      const target = path.join(destDir, f.originalname);
      // sicherstellen, dass das Ziel innerhalb FILES_ROOT bleibt
      if (!target.startsWith(FILES_ROOT)) {
        await fsp.unlink(f.path).catch(() => {});
        continue;
      }
      await fsp.rename(f.path, target).catch(async () => {
        // rename schlägt über Gerätegrenzen fehl -> kopieren
        await fsp.copyFile(f.path, target);
        await fsp.unlink(f.path).catch(() => {});
      });
    }
    res.json({ ok: true, count: (req.files || []).length });
  })
);

app.post(
  '/api/files/mkdir',
  requireAuth,
  asyncHandler(async (req, res) => {
    const target = safeResolve(path.join(req.body.path || '/', req.body.name || ''));
    await fsp.mkdir(target, { recursive: true });
    res.json({ ok: true });
  })
);

app.post(
  '/api/files/rename',
  requireAuth,
  asyncHandler(async (req, res) => {
    const from = safeResolve(req.body.from);
    const to = safeResolve(req.body.to);
    await fsp.rename(from, to);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/files',
  requireAuth,
  asyncHandler(async (req, res) => {
    const target = safeResolve(req.query.path);
    if (target === FILES_ROOT) {
      res.status(400);
      throw new Error('Wurzelverzeichnis kann nicht gelöscht werden');
    }
    await fsp.rm(target, { recursive: true, force: true });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Statisches Frontend
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// Setup-Wizard-Seite
app.get('/setup', (req, res) => {
  if (runtimeConfig.setupDone) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

// Admin-Seite nur ausliefern, wenn man eingeloggt ist – sonst zum Login
app.get('/admin', (req, res) => {
  if (req.session && req.session.authed) {
    return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  }
  return res.redirect('/login');
});
app.get('/login', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
);

app.listen(PORT, () => {
  console.log(`\x1b[32m✓ Hearth läuft auf http://localhost:${PORT}\x1b[0m`);
  console.log(`  Gäste-Ansicht:  http://localhost:${PORT}/`);
  console.log(`  Admin-Bereich:  http://localhost:${PORT}/admin`);
  console.log(`  Dateimanager-Root: ${FILES_ROOT}`);
});
