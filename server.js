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
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const os = require('os');
const { exec, spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const BCRYPT_ROUNDS = 12;

// Modul-weite Zustandsvariablen (müssen vor jeder Nutzung deklariert sein)
let _nginxProc  = null;
let _cpuPrev    = null;
let _netPrev    = null, _netPrevTs = 0;

const { version: VERSION } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
);
const HEARTH_SHA = (process.env.HEARTH_SHA || 'unknown').slice(0, 7);

// ---------------------------------------------------------------------------
// Konfiguration (über Umgebungsvariablen steuerbar – siehe .env.example)
// ---------------------------------------------------------------------------
const PORT        = parseInt(process.env.PORT        || '4500', 10);
// Separate public-facing port for the guest view only (no admin routes)
const GUEST_PORT  = parseInt(process.env.GUEST_PORT  || '3000', 10);
const PROXY_PORT  = parseInt(process.env.PROXY_PORT  || '80',   10);
const FILES_ROOT  = path.resolve(process.env.FILES_ROOT || '/mnt/data');
const DATA_DIR    = process.env.DATA_DIR    || '/srv/hearth-data';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const CONFIG_PATH   = process.env.CONFIG_PATH   || path.join(FILES_ROOT, 'hearth.config.json');
const NGINX_PROXY_DIR = '/etc/nginx/hearth-proxy';
const VPN_CONTAINER   = process.env.VPN_CONTAINER || 'hearth-vpn';

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
  lang: 'en',
  showOfflineApps: false,
  refreshInterval: 15,
  proxyRules: [],
  guestHidden: [],
  users: [],
  autoUpdate: { enabled: true, hour: 0, minute: 0 },
  updateBranch: 'main',
  cfApiToken: '',
  cfZoneId: '',
  cfTunnelToken: '',
  serverPublicIp: '',
};

// In-memory URL cache: populated while containers are running so we can
// still link to them when they go offline (survives across load() calls).
const _tileUrlCache = {};

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

// Migrate single-user to users array (runs once on first start after upgrade)
if (!runtimeConfig.users?.length) {
  runtimeConfig.users = [{
    username: runtimeConfig.adminUser || 'admin',
    password: runtimeConfig.adminPassword || 'changeme',
    role: 'admin',
  }];
  if (runtimeConfig.setupDone) saveConfig({ users: runtimeConfig.users });
}

// Migrate plaintext passwords to bcrypt hashes (one-time, idempotent)
{
  let _migrated = false;
  for (const user of runtimeConfig.users) {
    if (user.password && !user.password.startsWith('$2')) {
      user.password = bcrypt.hashSync(user.password, BCRYPT_ROUNDS);
      _migrated = true;
    }
  }
  if (_migrated) {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(runtimeConfig, null, 2), 'utf8');
      console.log('\x1b[32m[SECURITY] Passwörter zu bcrypt-Hashes migriert.\x1b[0m');
    } catch (e) {
      console.warn('[WARNUNG] Migration konnte nicht gespeichert werden:', e.message);
    }
  }
}

if (!runtimeConfig.setupDone) {
  console.log('\x1b[33m[SETUP] First run → Setup wizard at http://localhost:' + PORT + '/setup\x1b[0m');
} else if (runtimeConfig.adminPassword === 'changeme') {
  console.warn('\x1b[33m[WARNING] Default password "changeme" is active!\x1b[0m');
}

// Nginx starten (läuft parallel zum Express-Server)
startNginx();

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
  return res.status(401).json({ error: 'Not authenticated' });
}

function requireAdmin(req, res, next) {
  if (!req.session?.authed) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
  next();
}

// ── Guest-port isolation ─────────────────────────────────────────────────
// Requests arriving on GUEST_PORT have req.fromGuestPort = true (set by the
// guest http.Server wrapper below). Admin routes and API endpoints are blocked
// on that port so the guest view can be exposed publicly without risk.
app.use((req, res, next) => {
  if (!req.fromGuestPort) return next();

  // Block admin pages
  if (['/admin', '/login', '/setup'].some(p => req.path === p || req.path.startsWith(p + '/'))) {
    return res.status(403).send(
      '<!doctype html><html><body style="font-family:sans-serif;padding:40px">' +
      '<h2>Admin access is restricted to the local network.</h2>' +
      '<p>Connect via VPN or access from your local network.</p></body></html>'
    );
  }

  // Block all /api/* except the public guest endpoints
  if (req.path.startsWith('/api/')) {
    const allowed = ['/api/lang', '/api/public/'];
    if (!allowed.some(a => req.path.startsWith(a))) {
      return res.status(403).json({ error: 'Not available on the guest port.' });
    }
  }

  next();
});

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

// Build an app tile for the guest view from a mapped container.
// Always shows the tile even if the container is stopped, as long as
// we have a URL (from label, active port, or in-memory cache).
function buildAppTile(c, reqHost) {
  const labels = c.labels || {};
  if (String(labels['hearth.hide']).toLowerCase() === 'true') return null;

  const published = c.ports.filter((p) => p.publicPort);

  let webPort = null;
  if (labels['hearth.port']) {
    const match = published.find(
      (p) => String(p.privatePort) === String(labels['hearth.port'])
    );
    // When stopped, fall back to using hearth.port as the host port directly
    webPort = match ? match.publicPort : (published.length === 0 ? labels['hearth.port'] : null);
  }
  if (!webPort && published.length) {
    webPort = published[0].publicPort;
  }

  const scheme = labels['hearth.scheme'] || 'http';
  let url = labels['hearth.url'];
  if (!url && webPort) url = `${scheme}://${reqHost}:${webPort}`;

  // Cache the URL while container is running; reuse cache when stopped
  if (url && c.state === 'running') _tileUrlCache[c.id] = url;
  if (!url) url = _tileUrlCache[c.id] || null;
  if (!url) return null;

  return {
    id: c.id,
    name:        labels['hearth.name']        || c.name,
    description: labels['hearth.description'] || c.image,
    icon:        labels['hearth.icon']        || `/api/dockerhub/logo?image=${encodeURIComponent(c.image.split(':')[0])}`,
    url,
    state:   c.state,                  // full Docker state
    running: c.state === 'running',
    ports:   published.map((p) => p.publicPort),
  };
}

// Schützt vor Path-Traversal und Symlink-Ausbruch.
// Gibt den absoluten Pfad zurück; wirft bei ungültigem Zugriff.
function safeResolve(relPath) {
  const clean = path.normalize(relPath || '/').replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(FILES_ROOT, '.' + path.sep + clean);
  if (full !== FILES_ROOT && !full.startsWith(FILES_ROOT + path.sep)) {
    throw new Error('Ungültiger Pfad');
  }
  // Follow symlinks to prevent escape via symlinks inside FILES_ROOT.
  try {
    const real = fs.realpathSync(full);
    if (real !== FILES_ROOT && !real.startsWith(FILES_ROOT + path.sep)) {
      throw new Error('Symlink-Ausbruch verhindert');
    }
  } catch (e) {
    if (e.message === 'Symlink-Ausbruch verhindert') throw e;
    if (e.code === 'ENOENT') {
      // Path doesn't exist yet (upload/mkdir) — validate parent instead.
      try {
        const parentReal = fs.realpathSync(path.dirname(full));
        if (parentReal !== FILES_ROOT && !parentReal.startsWith(FILES_ROOT + path.sep)) {
          throw new Error('Symlink-Ausbruch verhindert');
        }
      } catch (e2) {
        if (e2.message === 'Symlink-Ausbruch verhindert') throw e2;
        // Parent also non-existent: string-based check already passed above.
      }
    } else {
      throw new Error('Ungültiger Pfad');
    }
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
// Nginx / Reverse Proxy
// ---------------------------------------------------------------------------

// Strict allowlist validation for proxy inputs to prevent config injection.
// Domain: valid hostname or wildcard (*.example.com), no special chars.
// Target: valid http(s) URL with hostname/IP and optional port.
const _DOMAIN_RE = /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const _HOST_RE   = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$|^(\d{1,3}\.){3}\d{1,3}$/;

function validateProxyInputs(domain, target) {
  if (!domain || !_DOMAIN_RE.test(domain.replace(/^\*\./, ''))) {
    const err = new Error('Ungültige Domain – nur Buchstaben, Ziffern, Bindestriche und Punkte erlaubt');
    err.statusCode = 400;
    throw err;
  }
  let url;
  try { url = new URL(target); } catch {
    const err = new Error('Ungültiges Target – muss eine gültige http:// oder https:// URL sein');
    err.statusCode = 400;
    throw err;
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    const err = new Error('Target muss mit http:// oder https:// beginnen');
    err.statusCode = 400;
    throw err;
  }
  if (!_HOST_RE.test(url.hostname)) {
    const err = new Error('Ungültiger Hostname im Target');
    err.statusCode = 400;
    throw err;
  }
  if (url.port && (isNaN(+url.port) || +url.port < 1 || +url.port > 65535)) {
    const err = new Error('Ungültiger Port im Target');
    err.statusCode = 400;
    throw err;
  }
}

function nginxConfForRule(rule) {
  return `# Hearth Proxy: ${rule.id} (${rule.domain})
server {
    listen ${PROXY_PORT};
    server_name ${rule.domain};
    location / {
        proxy_pass ${rule.target};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 300;
        proxy_connect_timeout 300;
        proxy_send_timeout 300;
    }
}
`;
}

function writeProxyConfigs(rules) {
  try {
    fs.mkdirSync(NGINX_PROXY_DIR, { recursive: true });
    for (const f of fs.readdirSync(NGINX_PROXY_DIR)) {
      fs.unlinkSync(path.join(NGINX_PROXY_DIR, f));
    }
    for (const r of (rules || []).filter((r) => r.enabled)) {
      fs.writeFileSync(path.join(NGINX_PROXY_DIR, `${r.id}.conf`), nginxConfForRule(r));
    }
  } catch (e) {
    console.warn('[PROXY] Konnte Nginx-Configs nicht schreiben:', e.message);
  }
}

function reloadNginx() {
  return new Promise((resolve) => {
    exec('nginx -s reload 2>/dev/null', (err) => resolve(!err));
  });
}

function startNginx() {
  const nginxBin = ['/usr/sbin/nginx', '/usr/bin/nginx', '/sbin/nginx'].find(fs.existsSync);
  if (!nginxBin) {
    console.log('[PROXY] Nginx nicht gefunden – Reverse Proxy deaktiviert');
    return;
  }
  writeProxyConfigs(runtimeConfig.proxyRules);
  _nginxProc = spawn(nginxBin, ['-g', 'daemon off;'], { stdio: ['ignore', 'pipe', 'pipe'] });
  _nginxProc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg && !msg.includes('signal process started')) console.warn('[NGINX]', msg);
  });
  _nginxProc.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[NGINX] Exited (code ${code}), restart in 3s`);
      setTimeout(startNginx, 3000);
    }
  });
  console.log(`\x1b[32m✓ Reverse Proxy (Nginx) auf Port ${PROXY_PORT}\x1b[0m`);
}

// ---------------------------------------------------------------------------
// Firewall-Helfer (exec in hearth-firewall Container)
// ---------------------------------------------------------------------------
const FW_CONTAINER = process.env.FW_CONTAINER || 'hearth-firewall';

async function fwExec(cmd) {
  return new Promise(async (resolve, reject) => {
    try {
      const c = docker.getContainer(FW_CONTAINER);
      const exec = await c.exec({
        Cmd: ['sh', '-c', cmd],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({});
      let out = '';
      stream.on('data', (chunk) => {
        // Docker-Multiplex-Header (8 Byte) überspringen
        const text = chunk.slice(8).toString('utf8');
        out += text;
      });
      stream.on('end', () => resolve(out.trim()));
      stream.on('error', reject);
    } catch (e) { reject(e); }
  });
}

async function fwAvailable() {
  try {
    await docker.getContainer(FW_CONTAINER).inspect();
    return true;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Monitoring-Hilfsfunktionen
// ---------------------------------------------------------------------------

// CPU-Auslastung über /proc/stat (Linux-only, graceful fallback)
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

// Disk info: query host filesystem mounted at /host (read-only), fall back to own mounts.
// Uses POSIX df (-P) which works with both BusyBox (Alpine) and GNU coreutils.
function getDiskInfo() {
  return new Promise((resolve) => {
    const useHost = fs.existsSync('/host/proc');
    // BusyBox df does not support --output or -x; use POSIX format and filter in JS.
    exec('df -P -B1 2>/dev/null', (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const SKIP_FS = /^(tmpfs|devtmpfs|shm|udev|overlay|squashfs|none|rootfs|cgroupfs)/;
      try {
        // Collect all candidates, then deduplicate: keep shortest mount path per device
        // so bind-mounts of the same partition don't create duplicate entries.
        const byDevice = new Map();
        for (const line of stdout.trim().split('\n').slice(1)) {
          const p = line.trim().split(/\s+/);
          if (p.length < 6) continue;
          const [fsName, , , , , mountRaw] = p;
          const total = +p[1], used = +p[2], avail = +p[3];
          if (SKIP_FS.test(fsName) || total === 0 || isNaN(total)) continue;

          // In host mode: only accept mounts inside /host, strip the prefix.
          // In container-only mode: accept everything remaining.
          let mount;
          if (useHost) {
            if (!mountRaw.startsWith('/host')) continue;
            mount = mountRaw.replace(/^\/host/, '') || '/';
          } else {
            mount = mountRaw;
          }

          const prev = byDevice.get(fsName);
          if (!prev || mount.length < prev.mount.length) {
            byDevice.set(fsName, { fs: fsName, total, used, avail, mount });
          }
        }
        resolve([...byDevice.values()]);
      } catch (_) { resolve([]); }
    });
  });
}

// Netzwerk-Durchsatz via /proc/net/dev (Delta zwischen Abfragen)
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
// Docker Registry Manifest API — holt ExposedPorts, Volumes, Env ohne Pull
// ---------------------------------------------------------------------------
async function getRegistryImageConfig(ns, name, tag = 'latest') {
  try {
    const tokenRes = await fetch(
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${ns}/${name}:pull`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!tokenRes.ok) return null;
    const { token } = await tokenRes.json();

    const manifestRes = await fetch(
      `https://registry-1.docker.io/v2/${ns}/${name}/manifests/${tag}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: [
            'application/vnd.oci.image.index.v1+json',
            'application/vnd.docker.distribution.manifest.list.v2+json',
            'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.docker.distribution.manifest.v2+json',
          ].join(', '),
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!manifestRes.ok) return null;
    const manifest = await manifestRes.json();

    let configDigest;
    if (manifest.manifests) {
      // Manifest-Liste → linux/amd64 bevorzugen
      const pick = manifest.manifests.find(
        m => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64'
      ) || manifest.manifests.find(m => m.platform?.os === 'linux') || manifest.manifests[0];
      const platRes = await fetch(
        `https://registry-1.docker.io/v2/${ns}/${name}/manifests/${pick.digest}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json',
          },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!platRes.ok) return null;
      configDigest = (await platRes.json()).config?.digest;
    } else {
      configDigest = manifest.config?.digest;
    }
    if (!configDigest) return null;

    const blobRes = await fetch(
      `https://registry-1.docker.io/v2/${ns}/${name}/blobs/${configDigest}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!blobRes.ok) return null;
    const blob = await blobRes.json();
    const cfg  = blob.config || blob.Config || {};

    // System-Env-Vars herausfiltern — nur appspezifische behalten
    const SYSTEM_PREFIXES = ['PATH', 'HOME', 'LANG', 'LC_', 'TERM', 'SHELL', 'SHLVL',
      'NODE_', 'NPM_', 'YARN_', 'JAVA_', 'JRE_', 'JDK_', 'PYTHON', 'PIP_',
      'GOLANG', 'GOPATH', 'GOROOT', 'RUBY_', 'GEM_', 'PHP_', 'COMPOSER_'];
    const env = (cfg.Env || []).filter(e => {
      const key = e.split('=')[0];
      return !SYSTEM_PREFIXES.some(p => key === p || key.startsWith(p));
    });

    return {
      ports:   Object.keys(cfg.ExposedPorts || {}),
      volumes: Object.keys(cfg.Volumes      || {}),
      env,
    };
  } catch (_) { return null; }
}

// Sucht in der full_description nach docker-compose- oder docker-run-Beispielen
function extractDockerSnippets(fullDesc) {
  let composeSnippet = null;
  let dockerRunSnippet = null;

  // Compose: Codeblock der 'services:' enthält
  const codeBlocks = [...fullDesc.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(m => m[1]);
  for (const block of codeBlocks) {
    if (!composeSnippet && /^\s*services\s*:/m.test(block)) composeSnippet = block.trim();
    if (!dockerRunSnippet && /^\s*docker\s+run\b/m.test(block)) dockerRunSnippet = block.trim();
  }
  // Fallback: inline docker run ohne Codeblock
  if (!dockerRunSnippet) {
    const m = fullDesc.match(/`(docker run[^`\n]{10,})`/);
    if (m) dockerRunSnippet = m[1].trim();
  }
  return { composeSnippet, dockerRunSnippet };
}

// ---------------------------------------------------------------------------
// Docker Hub Logo-Cache (lädt einmalig herunter, speichert lokal)
// ---------------------------------------------------------------------------
// Hilfsfunktion: versucht ein Icon von mehreren Quellen zu laden.
// Reihenfolge: Docker Hub logo_url → selfhst/icons CDN → dashboard-icons CDN
async function _fetchIconBuffer(ns, name, explicitSlug) {
  // Slug-Kandidaten: explizit > name > name ohne Suffixe > namespace
  const nameLower = name.toLowerCase();
  const stripped  = nameLower.replace(/-(ce|ee|oss|community|server|docker|app|ui)$/i, '');
  const slugs = [...new Set([
    explicitSlug,
    nameLower,
    stripped !== nameLower ? stripped : null,
    ns !== 'library' ? ns.toLowerCase() : null,
  ].filter(Boolean))];

  const SELFHST = 'https://cdn.jsdelivr.net/gh/selfhst/icons/png';
  const DASH    = 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png';

  // Quellen in Priorität
  const sources = [];

  // 1. Docker Hub logo_url (sofern vorhanden)
  try {
    const hubRes = await fetch(`https://hub.docker.com/v2/repositories/${ns}/${name}/`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (hubRes.ok) {
      const info = await hubRes.json();
      const url  = info.logo_url?.large || info.logo_url?.small;
      if (url) sources.push(url);
    }
  } catch (_) {}

  // 2. selfhst/icons + dashboard-icons für jeden Slug-Kandidaten
  for (const slug of slugs) {
    sources.push(`${SELFHST}/${slug}.png`, `${DASH}/${slug}.png`);
  }

  for (const url of sources) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 200) continue; // Leere / Fehler-Placeholder überspringen
      return { buffer: buf, contentType: ct };
    } catch (_) {}
  }
  return null;
}

app.get('/api/dockerhub/logo', asyncHandler(async (req, res) => {
  const raw  = (req.query.image || '').split(':')[0].trim();
  const slug = (req.query.slug || '').trim() || null; // optionaler expliziter Slug
  if (!raw) return res.status(400).json({ error: 'image required' });

  // Letztes Segment des Image-Namens (z. B. "jellyfin" aus "linuxserver/jellyfin")
  const rawParts = raw.split('/');
  const name = rawParts[rawParts.length - 1];
  const ns   = rawParts.length > 1 ? rawParts[rawParts.length - 2] : 'library';
  const cacheKey = (slug || `${ns}-${name}`).replace(/[^a-z0-9_-]/gi, '_');

  const cacheDir  = path.join(FILES_ROOT, '.hearth-cache', 'logos');
  const cacheMeta = path.join(cacheDir, `${cacheKey}.json`);
  const cacheImg  = path.join(cacheDir, `${cacheKey}.img`);

  // Cache-Hit
  if (fs.existsSync(cacheImg) && fs.existsSync(cacheMeta)) {
    try {
      const { contentType, notFound } = JSON.parse(fs.readFileSync(cacheMeta, 'utf8'));
      if (notFound) return res.status(404).end();
      res.setHeader('Content-Type', contentType || 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return res.sendFile(cacheImg);
    } catch (_) {}
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  const result = await _fetchIconBuffer(ns, name, slug);
  if (!result) {
    // Negative-Cache: 1 Tag kein Retry, verhindert Spam bei jedem Seitenaufruf
    fs.writeFileSync(cacheMeta, JSON.stringify({ notFound: true, ts: Date.now() }));
    return res.status(404).end();
  }

  fs.writeFileSync(cacheImg,  result.buffer);
  fs.writeFileSync(cacheMeta, JSON.stringify({ contentType: result.contentType, ts: Date.now() }));

  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.send(result.buffer);
}));

// ---------------------------------------------------------------------------
// Docker Hub Metadaten-Proxy (vermeidet CORS im Browser)
// ---------------------------------------------------------------------------
app.get(
  '/api/dockerhub/info',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rawWithTag = (req.query.image || '').trim();
    const raw        = rawWithTag.split(':')[0];
    if (!raw) return res.status(400).json({ error: 'image required' });

    const parts = raw.split('/');
    const [ns, name] = parts.length === 1 ? ['library', parts[0]] : [parts[0], parts[1]];

    const tag = rawWithTag.includes(':') ? rawWithTag.split(':')[1] : 'latest';

    try {
      const [hubRes, imgCfg] = await Promise.all([
        fetch(`https://hub.docker.com/v2/repositories/${ns}/${name}/`,
          { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }),
        getRegistryImageConfig(ns, name, tag),
      ]);
      if (!hubRes.ok) return res.json({ found: false });
      const d = await hubRes.json();

      const { composeSnippet, dockerRunSnippet } = extractDockerSnippets(d.full_description || '');

      res.json({
        found:      true,
        image:      ns === 'library' ? name : `${ns}/${name}`,
        description: (d.description || '').slice(0, 280),
        pullCount:  d.pull_count  || 0,
        starCount:  d.star_count  || 0,
        isOfficial: !!d.is_official,
        logoUrl:    d.logo_url?.large || null,
        // Konfiguration aus Registry-Manifest
        ports:   imgCfg?.ports   || [],
        volumes: imgCfg?.volumes || [],
        env:     imgCfg?.env     || [],
        // Snippets aus der README für den Full-Editor
        composeSnippet,
        dockerRunSnippet,
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
    const [disks, allContainers] = await Promise.all([
      getDiskInfo(),
      docker.listContainers({ all: true }).catch(() => []),
    ]);
    const dockerInfo = await docker.info().catch(() => ({}));
    // Interne Hearth-Container aus der Zählung ausschließen
    const userContainers = allContainers.filter(
      (c) => String((c.Labels || {})['hearth.self']).toLowerCase() !== 'true'
    );

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
        containers: userContainers.length,
        running: userContainers.filter((c) => c.State === 'running').length,
        dockerVersion: dockerInfo.ServerVersion || null,
        platform: os.platform(),
      },
      ts: Date.now(),
    });
  })
);

// ---------------------------------------------------------------------------
// Reverse-Proxy API
// ---------------------------------------------------------------------------
app.get('/api/proxy/rules', requireAuth, (req, res) => {
  res.json(runtimeConfig.proxyRules || []);
});

app.get('/api/proxy/status', requireAuth, (req, res) => {
  const nginxRunning = _nginxProc !== null && !_nginxProc.killed;
  res.json({ running: nginxRunning, port: PROXY_PORT, rules: (runtimeConfig.proxyRules || []).length });
});

app.post('/api/proxy/rules', requireAuth, asyncHandler(async (req, res) => {
  const { domain, target, enabled = true, strip = '', cfSync = false } = req.body || {};
  if (!domain || !target) return res.status(400).json({ error: 'domain and target are required' });
  validateProxyInputs(domain.trim(), target.trim());

  const rules = [...(runtimeConfig.proxyRules || [])];
  const id = Date.now().toString(36);
  const rule = { id, domain: domain.trim(), target: target.trim().replace(/\/$/, ''), enabled: !!enabled, strip: strip.trim(), cfSync: !!cfSync, cfDnsId: null };
  rules.push(rule);
  saveConfig({ proxyRules: rules });
  writeProxyConfigs(rules);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Regel gespeichert, Proxy nicht aktualisiert. Bitte Domain und Target prüfen.' });
  }
  if (cfSync) cfSyncRule(rule).catch(e => console.warn('[CF]', e.message));
  res.json({ ok: true, id });
}));

app.put('/api/proxy/rules/:id', requireAuth, asyncHandler(async (req, res) => {
  const { domain, target, enabled, strip, cfSync } = req.body || {};
  const existing = (runtimeConfig.proxyRules || []).find(r => r.id === req.params.id);
  const newDomain = domain !== undefined ? domain.trim() : existing?.domain;
  const newTarget = target !== undefined ? target.trim() : existing?.target;
  if (newDomain && newTarget) validateProxyInputs(newDomain, newTarget);

  let updatedRule;
  const rules = (runtimeConfig.proxyRules || []).map((r) => {
    if (r.id !== req.params.id) return r;
    updatedRule = {
      ...r,
      domain:  domain  !== undefined ? domain.trim()  : r.domain,
      target:  target  !== undefined ? target.trim().replace(/\/$/, '') : r.target,
      enabled: enabled !== undefined ? !!enabled        : r.enabled,
      strip:   strip   !== undefined ? strip.trim()    : (r.strip || ''),
      cfSync:  cfSync  !== undefined ? !!cfSync         : r.cfSync,
    };
    return updatedRule;
  });
  saveConfig({ proxyRules: rules });
  writeProxyConfigs(rules);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Änderung gespeichert, Proxy nicht aktualisiert. Bitte Domain und Target prüfen.' });
  }
  if (updatedRule?.cfSync) cfSyncRule(updatedRule).catch(e => console.warn('[CF]', e.message));
  res.json({ ok: true });
}));

app.delete('/api/proxy/rules/:id', requireAuth, asyncHandler(async (req, res) => {
  const toDelete = (runtimeConfig.proxyRules || []).find(r => r.id === req.params.id);
  const rules = (runtimeConfig.proxyRules || []).filter((r) => r.id !== req.params.id);
  saveConfig({ proxyRules: rules });
  writeProxyConfigs(rules);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Regel gelöscht, Proxy nicht aktualisiert.' });
  }
  if (toDelete?.cfSync) cfDeleteDnsRecord(toDelete).catch(e => console.warn('[CF]', e.message));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Proxy – Test endpoint
// ---------------------------------------------------------------------------
app.get('/api/proxy/test/:id', requireAuth, asyncHandler(async (req, res) => {
  const rule = (runtimeConfig.proxyRules || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ ok: false, error: 'Rule not found' });
  const t0 = Date.now();
  try {
    const url = new URL(rule.target);
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    await new Promise((resolve, reject) => {
      const req2 = mod.request(
        { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: '/', method: 'HEAD', timeout: 5000 },
        (r) => { r.resume(); resolve(r.statusCode); }
      );
      req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
      req2.on('error', reject);
      req2.end();
    });
    res.json({ ok: true, latency: Date.now() - t0 });
  } catch (e) {
    res.json({ ok: false, error: e.message, latency: Date.now() - t0 });
  }
}));

// ---------------------------------------------------------------------------
// System – Public IP
// ---------------------------------------------------------------------------
app.get('/api/system/public-ip', requireAuth, asyncHandler(async (req, res) => {
  try {
    const ip = await new Promise((resolve, reject) => {
      https.get('https://api.ipify.org?format=json', (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d).ip); } catch(e) { reject(e); } });
      }).on('error', reject).setTimeout(5000, function() { this.destroy(); reject(new Error('timeout')); });
    });
    res.json({ ok: true, ip });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
}));

// ---------------------------------------------------------------------------
// Cloudflare – helpers
// ---------------------------------------------------------------------------
async function cfFetch(path, method = 'GET', body = null) {
  const token = runtimeConfig.cfApiToken;
  if (!token) throw Object.assign(new Error('Kein Cloudflare API-Token konfiguriert'), { statusCode: 400 });
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.cloudflare.com',
      path: `/client/v4${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 10000,
    };
    const req = https.request(options, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('CF API: ungültige Antwort')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('CF API: timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function cfGetPublicIp() {
  if (runtimeConfig.serverPublicIp) return runtimeConfig.serverPublicIp;
  return new Promise((resolve, reject) => {
    https.get('https://api.ipify.org?format=json', (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d).ip); } catch(e) { reject(e); } });
    }).on('error', reject).setTimeout(5000, function() { this.destroy(); reject(new Error('timeout')); });
  });
}

async function cfSyncRule(rule) {
  if (!rule.cfSync || !runtimeConfig.cfApiToken || !runtimeConfig.cfZoneId) return;
  const ip = await cfGetPublicIp();
  const zoneId = runtimeConfig.cfZoneId;
  const record = { type: 'A', name: rule.domain, content: ip, ttl: 1, proxied: true };
  if (rule.cfDnsId) {
    await cfFetch(`/zones/${zoneId}/dns_records/${rule.cfDnsId}`, 'PUT', record);
  } else {
    const result = await cfFetch(`/zones/${zoneId}/dns_records`, 'POST', record);
    if (result.success && result.result?.id) {
      const rules = (runtimeConfig.proxyRules || []).map(r =>
        r.id === rule.id ? { ...r, cfDnsId: result.result.id } : r
      );
      saveConfig({ proxyRules: rules });
    }
  }
}

async function cfDeleteDnsRecord(rule) {
  if (!rule.cfDnsId || !runtimeConfig.cfApiToken || !runtimeConfig.cfZoneId) return;
  await cfFetch(`/zones/${runtimeConfig.cfZoneId}/dns_records/${rule.cfDnsId}`, 'DELETE').catch(() => {});
}

// Cloudflare – verify credentials
app.post('/api/cloudflare/verify', requireAuth, asyncHandler(async (req, res) => {
  const result = await cfFetch('/user/tokens/verify');
  if (result.success) {
    res.json({ ok: true, message: result.result?.status || 'active' });
  } else {
    res.status(400).json({ ok: false, error: result.errors?.[0]?.message || 'Ungültige Credentials' });
  }
}));

// Cloudflare – manual DNS sync for one rule
app.post('/api/cloudflare/dns-sync/:ruleId', requireAuth, asyncHandler(async (req, res) => {
  const rule = (runtimeConfig.proxyRules || []).find(r => r.id === req.params.ruleId);
  if (!rule) return res.status(404).json({ ok: false, error: 'Regel nicht gefunden' });
  const ip = await cfGetPublicIp();
  const zoneId = runtimeConfig.cfZoneId;
  if (!zoneId) return res.status(400).json({ ok: false, error: 'Keine Zone-ID konfiguriert' });
  const record = { type: 'A', name: rule.domain, content: ip, ttl: 1, proxied: true };
  let cfDnsId = rule.cfDnsId;
  if (cfDnsId) {
    const r = await cfFetch(`/zones/${zoneId}/dns_records/${cfDnsId}`, 'PUT', record);
    if (!r.success) throw Object.assign(new Error(r.errors?.[0]?.message || 'CF-Fehler'), { statusCode: 400 });
  } else {
    const r = await cfFetch(`/zones/${zoneId}/dns_records`, 'POST', record);
    if (!r.success) throw Object.assign(new Error(r.errors?.[0]?.message || 'CF-Fehler'), { statusCode: 400 });
    cfDnsId = r.result?.id;
  }
  const rules = (runtimeConfig.proxyRules || []).map(r =>
    r.id === req.params.ruleId ? { ...r, cfSync: true, cfDnsId } : r
  );
  saveConfig({ proxyRules: rules });
  res.json({ ok: true, cfDnsId, ip });
}));

// Cloudflare – delete DNS record for one rule
app.delete('/api/cloudflare/dns-sync/:ruleId', requireAuth, asyncHandler(async (req, res) => {
  const rule = (runtimeConfig.proxyRules || []).find(r => r.id === req.params.ruleId);
  if (!rule) return res.status(404).json({ ok: false, error: 'Regel nicht gefunden' });
  await cfDeleteDnsRecord(rule);
  const rules = (runtimeConfig.proxyRules || []).map(r =>
    r.id === req.params.ruleId ? { ...r, cfSync: false, cfDnsId: null } : r
  );
  saveConfig({ proxyRules: rules });
  res.json({ ok: true });
}));

// Cloudflare – Tunnel status
const CF_TUNNEL_CONTAINER = 'hearth-cloudflared';

app.get('/api/cloudflare/tunnel/status', requireAuth, asyncHandler(async (req, res) => {
  try {
    const c = docker.getContainer(CF_TUNNEL_CONTAINER);
    const info = await c.inspect();
    res.json({ ok: true, running: info.State.Running, status: info.State.Status });
  } catch (e) {
    res.json({ ok: true, running: false, status: 'not_found' });
  }
}));

app.post('/api/cloudflare/tunnel/start', requireAuth, asyncHandler(async (req, res) => {
  const token = runtimeConfig.cfTunnelToken;
  if (!token) return res.status(400).json({ ok: false, error: 'Kein Tunnel-Token konfiguriert' });
  try {
    const existing = docker.getContainer(CF_TUNNEL_CONTAINER);
    const info = await existing.inspect().catch(() => null);
    if (info) {
      if (info.State.Running) return res.json({ ok: true, already: true });
      await existing.start();
      return res.json({ ok: true });
    }
  } catch(_) {}
  const container = await docker.createContainer({
    name: CF_TUNNEL_CONTAINER,
    Image: 'cloudflare/cloudflared:latest',
    Cmd: ['tunnel', '--no-autoupdate', 'run', '--token', token],
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'host' },
  });
  await container.start();
  res.json({ ok: true });
}));

app.post('/api/cloudflare/tunnel/stop', requireAuth, asyncHandler(async (req, res) => {
  try {
    const c = docker.getContainer(CF_TUNNEL_CONTAINER);
    await c.stop();
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
}));

// ---------------------------------------------------------------------------
// Firewall API
// ---------------------------------------------------------------------------
app.get('/api/firewall/available', requireAuth, asyncHandler(async (req, res) => {
  res.json({ available: await fwAvailable() });
}));

app.get('/api/firewall/status', requireAuth, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.json({ available: false });
  try {
    const [verbose, numbered] = await Promise.all([
      fwExec('ufw status verbose'),
      fwExec('ufw status numbered'),
    ]);
    const active = verbose.includes('Status: active');
    // Regeln parsen: "[N] port/proto ALLOW/DENY IN ..."
    const ruleLines = numbered.split('\n').filter((l) => /^\[/.test(l.trim()));
    const rules = ruleLines.map((l) => {
      const m = l.match(/\[\s*(\d+)\]\s+(.+?)\s+(ALLOW|DENY)\s+(IN|OUT|FWD)?\s*(.*)/i);
      if (!m) return null;
      return { num: parseInt(m[1]), to: m[2].trim(), action: m[3].toUpperCase(), dir: (m[4] || 'IN').toUpperCase(), from: (m[5] || 'Anywhere').trim() };
    }).filter(Boolean);
    res.json({ available: true, active, raw: verbose, rules });
  } catch (e) {
    res.status(500).json({ available: true, error: e.message });
  }
}));

app.post('/api/firewall/rules', requireAuth, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const { action, port, proto, from = 'any', comment = '' } = req.body || {};
  if (!action || !port) return res.status(400).json({ error: 'action and port are required' });
  const protoStr = proto && proto !== 'any' ? ` proto ${proto}` : '';
  const fromStr  = from && from !== 'any' ? ` from ${from}` : '';
  const cmd = `ufw ${action}${fromStr} to any port ${port}${protoStr} && ufw status numbered`;
  const result = await fwExec(cmd);
  res.json({ ok: true, result });
}));

app.delete('/api/firewall/rules/:num', requireAuth, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const result = await fwExec(`echo y | ufw delete ${req.params.num}`);
  res.json({ ok: true, result });
}));

app.post('/api/firewall/toggle', requireAuth, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const { enable } = req.body || {};
  const result = await fwExec(enable ? 'ufw --force enable' : 'ufw disable');
  res.json({ ok: true, result });
}));

// ---------------------------------------------------------------------------
// Einstellungen (Admin)
// ---------------------------------------------------------------------------
app.get('/api/lang', (req, res) => {
  res.json({ lang: runtimeConfig.lang || 'de' });
});

app.get('/api/settings', requireAuth, (req, res) => {
  res.json({
    serverName: runtimeConfig.serverName,
    adminUser:  runtimeConfig.adminUser,
    lang:       runtimeConfig.lang || 'en',
    showOfflineApps:  !!runtimeConfig.showOfflineApps,
    refreshInterval:  runtimeConfig.refreshInterval ?? 15,
    autoUpdate:   runtimeConfig.autoUpdate ?? { enabled: true, hour: 0, minute: 0 },
    updateBranch: runtimeConfig.updateBranch || 'main',
    port:        PORT,
    guestPort:   GUEST_PORT,
    dockerSocket: DOCKER_SOCKET,
    filesRoot:   FILES_ROOT,
    dataDir:     DATA_DIR,
    version:     VERSION,
    cfApiToken:     runtimeConfig.cfApiToken || '',
    cfZoneId:       runtimeConfig.cfZoneId || '',
    cfTunnelToken:  runtimeConfig.cfTunnelToken || '',
    serverPublicIp: runtimeConfig.serverPublicIp || '',
  });
});

app.post(
  '/api/settings',
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      serverName, lang, showOfflineApps, refreshInterval, autoUpdate, updateBranch,
      cfApiToken, cfZoneId, cfTunnelToken, serverPublicIp,
    } = req.body || {};
    const updates = {};

    if (serverName !== undefined) updates.serverName = (serverName || '').trim() || 'Hearth';
    if (lang !== undefined) updates.lang = lang;
    if (showOfflineApps !== undefined) updates.showOfflineApps = !!showOfflineApps;
    if (refreshInterval !== undefined) updates.refreshInterval = Number(refreshInterval) || 0;

    if (autoUpdate && typeof autoUpdate === 'object') {
      updates.autoUpdate = {
        enabled: autoUpdate.enabled !== false,
        hour:    Math.max(0, Math.min(23, parseInt(autoUpdate.hour)   || 0)),
        minute:  Math.max(0, Math.min(59, parseInt(autoUpdate.minute) || 0)),
      };
    }
    if (updateBranch && typeof updateBranch === 'string') {
      updates.updateBranch = updateBranch.trim().replace(/[^a-zA-Z0-9/_.-]/g, '') || 'main';
    }
    if (cfApiToken !== undefined) updates.cfApiToken = (cfApiToken || '').trim();
    if (cfZoneId !== undefined) updates.cfZoneId = (cfZoneId || '').trim();
    if (cfTunnelToken !== undefined) updates.cfTunnelToken = (cfTunnelToken || '').trim();
    if (serverPublicIp !== undefined) updates.serverPublicIp = (serverPublicIp || '').trim();

    saveConfig(updates);
    if (updates.autoUpdate) scheduleNightlyUpdate();
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
  const trimmedUser = adminUser.trim();
  const hashedPassword = await bcrypt.hash(adminPassword, BCRYPT_ROUNDS);
  saveConfig({
    adminUser: trimmedUser,
    adminPassword: hashedPassword,
    serverName: (serverName || 'Hearth').trim(),
    users: [{ username: trimmedUser, password: hashedPassword, role: 'admin' }],
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Auth-Routen
// ---------------------------------------------------------------------------
app.post('/api/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  const users = runtimeConfig.users || [];
  const user  = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const passOk = await bcrypt.compare(String(password || ''), user.password);
  if (!passOk) return res.status(401).json({ error: 'Invalid username or password' });

  req.session.authed = true;
  req.session.user   = username;
  req.session.role   = user.role;
  res.json({ ok: true, role: user.role });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({
    authed: !!(req.session?.authed),
    user:   req.session?.user || null,
    role:   req.session?.role || null,
  });
});

// ---------------------------------------------------------------------------
// User management (admin only)
// ---------------------------------------------------------------------------
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json((runtimeConfig.users || []).map(u => ({ username: u.username, role: u.role })));
});

app.post('/api/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { username, password, role = 'viewer' } = req.body || {};
  if (!username?.trim() || !password) return res.status(400).json({ error: 'username and password required' });
  if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const users = runtimeConfig.users || [];
  if (users.find(u => u.username === username.trim())) return res.status(409).json({ error: 'Username already taken' });
  const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
  users.push({ username: username.trim(), password: hashed, role });
  saveConfig({ users });
  res.json({ ok: true });
}));

app.delete('/api/users/:username', requireAuth, requireAdmin, (req, res) => {
  const { username } = req.params;
  if (username === req.session.user) return res.status(400).json({ error: "Cannot delete your own account" });
  const users = runtimeConfig.users || [];
  const target = users.find(u => u.username === username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin' && users.filter(u => u.role === 'admin').length <= 1)
    return res.status(400).json({ error: 'Cannot delete the last admin' });
  saveConfig({ users: users.filter(u => u.username !== username) });
  res.json({ ok: true });
});

// Update own credentials (any user) or another user's role (admin only)
app.patch('/api/users/:username', requireAuth, asyncHandler(async (req, res) => {
  const { username } = req.params;
  const isSelf  = username === req.session.user;
  const isAdmin = req.session.role === 'admin';
  if (!isSelf && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

  const users = runtimeConfig.users || [];
  const user  = users.find(u => u.username === username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { currentPassword, newPassword, newUsername, role } = req.body || {};

  if (newPassword || newUsername) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
    const passOk = await bcrypt.compare(String(currentPassword), user.password);
    if (!passOk) return res.status(401).json({ error: 'Current password is incorrect' });
    if (newPassword) {
      if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    }
    if (newUsername) {
      const trim = newUsername.trim();
      if (users.find(u => u.username === trim && u.username !== username))
        return res.status(409).json({ error: 'Username already taken' });
      user.username = trim;
      if (isSelf) req.session.user = trim;
    }
  }
  if (role && isAdmin && !isSelf) {
    if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (user.role === 'admin' && role !== 'admin' && users.filter(u => u.role === 'admin').length <= 1)
      return res.status(400).json({ error: 'Cannot demote the last admin' });
    user.role = role;
  }
  saveConfig({ users });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Notifications (in-memory, per session reset)
// ---------------------------------------------------------------------------
const _notifs = [];
let   _notifSeq = 1;

function addNotif(type, title, body, action = null) {
  if (type === 'update') {
    const idx = _notifs.findIndex(n => n.type === 'update');
    if (idx >= 0) _notifs.splice(idx, 1);
  }
  _notifs.unshift({ id: _notifSeq++, type, title, body, action, ts: Date.now(), read: false });
  if (_notifs.length > 50) _notifs.pop();
}

app.get('/api/notifications', requireAuth, (req, res) => res.json(_notifs));

app.post('/api/notifications/read-all', requireAuth, (req, res) => {
  _notifs.forEach(n => (n.read = true));
  res.json({ ok: true });
});

app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
  const n = _notifs.find(n => n.id === Number(req.params.id));
  if (n) n.read = true;
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Öffentliche Gäste-API (KEIN Login nötig)
// ---------------------------------------------------------------------------
app.get(
  '/api/public/apps',
  asyncHandler(async (req, res) => {
    const reqHost   = (req.headers.host || 'localhost').split(':')[0];
    const guestHidden = new Set(runtimeConfig.guestHidden || []);

    // Always fetch ALL containers so we can show offline ones too.
    const containers = await docker.listContainers({ all: true });
    const tiles = containers
      .map(mapContainer)
      .filter((c) => {
        // Never show internal Hearth containers
        if (String(c.labels['hearth.self']).toLowerCase() === 'true') return false;
        // Respect hearth.hide label
        if (String(c.labels['hearth.hide']).toLowerCase() === 'true') return false;
        // Respect admin's per-container visibility toggle (by name or ID)
        if (guestHidden.has(c.id) || guestHidden.has(c.name)) return false;
        return true;
      })
      .map((c) => buildAppTile(c, reqHost))
      .filter(Boolean);

    res.json({ apps: tiles, host: reqHost });
  })
);

// Toggle guest-page visibility for a single container (no recreate needed)
app.post(
  '/api/containers/:id/guest-visibility',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { visible } = req.body || {};
    // Resolve name for stable storage across container recreates
    let name = req.params.id;
    try {
      const info = await docker.getContainer(req.params.id).inspect();
      name = info.Name.replace(/^\//, '');
    } catch (_) {}

    const hidden = new Set(runtimeConfig.guestHidden || []);
    // Store by name; also clean up any stale ID entry
    hidden.delete(req.params.id);
    visible ? hidden.delete(name) : hidden.add(name);

    saveConfig({ guestHidden: [...hidden] });
    res.json({ ok: true });
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
// Update-Checker
// ---------------------------------------------------------------------------

// Hilfsfunktion: prüft Docker Hub ob ein neueres Image vorliegt.
//
// Digest-Vergleich statt Timestamp: Docker Hub last_updated ist immer einige
// Minuten nach image.Created (Build→Push-Latenz) → Timestamp-Vergleich liefert
// permanent false positives, auch direkt nach einem frischen Pull.
//
// Wichtig: RepoDigests enthält den plattformspezifischen Digest (z. B. arm64),
// data.digest (Docker Hub) ist der Manifest-List-Digest (Multi-Arch-Wrapper).
// Diese zwei Ebenen sind strukturell verschieden → nie vergleichbar!
// Stattdessen: data.images[passende Arch].digest mit dem lokalen Digest matchen.
async function checkImageUpdate(image) {
  try {
    const [ref] = image.split(':');
    const tag   = image.includes(':') ? image.split(':')[1] : 'latest';
    const parts = ref.split('/');
    const [ns, name] = parts.length === 1 ? ['library', parts[0]] : [parts[0], parts[1]];

    const localInfo = await docker.getImage(image).inspect().catch(() => null);
    if (!localInfo) return { hasUpdate: null };

    // Plattformspezifischer Digest aus RepoDigests: "registry/image@sha256:abc…"
    const localDigest = (localInfo.RepoDigests || [])
      .map(d => d.split('@')[1])
      .find(d => d?.startsWith('sha256:')) || null;

    const r = await fetch(
      `https://hub.docker.com/v2/repositories/${ns}/${name}/tags/${tag}/`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return { hasUpdate: null };
    const data = await r.json();

    // data.digest ist der Manifest-List-Digest des Tags (top-level, arch-unabhängig).
    // RepoDigests speichert ebenfalls den Manifest-List-Digest, da Docker beim Pull
    // den gesamten Multi-Arch-Index referenziert.
    // → Beide befinden sich auf derselben Hierarchieebene → direkter Vergleich korrekt.
    // data.images[arch].digest wäre die plattformspezifische Manifest-Ebene darunter —
    // nie kompatibel mit RepoDigests.
    const remoteDigest = data.digest || null;

    let hasUpdate;
    if (localDigest && remoteDigest) {
      hasUpdate = localDigest !== remoteDigest;
    } else {
      // Fallback für lokale Images ohne RepoDigests:
      // Zeitstempel mit 15-Min-Toleranz für Build→Push-Latenz
      const localTs  = new Date(localInfo.Created).getTime();
      const remoteTs = new Date(data.last_updated).getTime();
      hasUpdate = (remoteTs - localTs) > 15 * 60 * 1000;
    }

    return {
      hasUpdate,
      remoteDate:  data.last_updated,
      localDate:   localInfo.Created,
      remoteDigest,
      localDigest,
    };
  } catch (_) {
    return { hasUpdate: null };
  }
}

// Update-Cache (verhindert zu häufige Docker Hub Anfragen)
let _updateCache = { ts: 0, data: null };
const UPDATE_CACHE_TTL = 15 * 60 * 1000; // 15 Minuten

app.get(
  '/api/updates/check',
  requireAuth,
  asyncHandler(async (req, res) => {
    const force = req.query.force === 'true';
    if (!force && _updateCache.data && Date.now() - _updateCache.ts < UPDATE_CACHE_TTL) {
      return res.json({ ...(_updateCache.data), cached: true });
    }

    const allContainers = await docker.listContainers({ all: true }).catch(() => []);
    const userContainers = allContainers.filter(
      (c) => String((c.Labels || {})['hearth.self']).toLowerCase() !== 'true'
    );

    // Container-Updates parallel prüfen
    const containerUpdates = await Promise.all(
      userContainers.map(async (c) => {
        const update = await checkImageUpdate(c.Image);
        return {
          containerId: c.Id,
          name: (c.Names[0] || '').replace(/^\//, ''),
          image: c.Image,
          state: c.State,
          ...update,
        };
      })
    );

    // Hearth-Version gegen GitHub prüfen
    // raw.githubusercontent.com für package.json (kein Rate-Limit-Problem),
    // GitHub Commits API nur für Commit-Message (optional, kein Fehler wenn nicht erreichbar)
    let hearthUpdate = null;
    try {
      const _branch = (runtimeConfig.updateBranch || 'main').trim();
      const rawUrl = `https://raw.githubusercontent.com/MarioundMB/Hearth/${_branch}/package.json?_=${Date.now()}`;
      const pkgRes = await fetch(rawUrl, { headers: { 'User-Agent': 'Hearth-Panel' }, signal: AbortSignal.timeout(6000) });
      if (pkgRes.ok) {
        const pkg = await pkgRes.json();
        const remoteVersion = pkg.version || '0.0.0';
        // Commit-Message optional via GitHub API (ignorieren wenn Rate-Limit)
        let message = '';
        try {
          const ghHeaders = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'Hearth-Panel' };
          const commitRes = await fetch(
            `https://api.github.com/repos/MarioundMB/Hearth/commits/${_branch}`,
            { headers: ghHeaders, signal: AbortSignal.timeout(4000) }
          );
          if (commitRes.ok) {
            const c = await commitRes.json();
            message = c.commit?.message?.split('\n')[0] || '';
          }
        } catch (_) {}
        hearthUpdate = {
          remoteVersion,
          localVersion: VERSION,
          hasUpdate: remoteVersion !== VERSION,
          message,
        };
      }
    } catch (_) {}

    if (hearthUpdate?.hasUpdate) {
      addNotif('update', 'Hearth update available',
        `v${hearthUpdate.localVersion} → v${hearthUpdate.remoteVersion}: ${hearthUpdate.message}`,
        { section: 'updates' });
    }

    const result = { containers: containerUpdates, hearth: hearthUpdate, ts: Date.now() };
    _updateCache = { ts: Date.now(), data: result };
    res.json({ ...result, cached: false });
  })
);

// List available remote branches for the update branch selector
app.get('/api/updates/branches', requireAuth, asyncHandler(async (req, res) => {
  // Try git first (fast, works when volume is mounted)
  if (fs.existsSync(path.join(_REPO, '.git'))) {
    await _exec('git', ['config', '--global', '--add', 'safe.directory', _REPO]).catch(() => {});
    await _exec('git', ['-C', _REPO, 'fetch', '--quiet']).catch(() => {});
    const raw = await _exec('git', ['-C', _REPO, 'branch', '-r']).catch(() => '');
    const branches = raw
      .split('\n')
      .map(b => b.trim().replace(/^origin\//, ''))
      .filter(b => b && b !== 'HEAD' && !b.includes('->'))
      .sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
    if (branches.length) return res.json({ branches });
  }
  // Fallback: GitHub API
  try {
    const r = await fetch(
      'https://api.github.com/repos/MarioundMB/Hearth/branches?per_page=100',
      { headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'Hearth-Panel' },
        signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const data = await r.json();
      const branches = data
        .map(b => b.name)
        .sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
      return res.json({ branches });
    }
  } catch (_) {}
  res.json({ branches: ['main'] });
}));


// Einzelnen Container auf neues Image updaten (pull → recreate)
app.post(
  '/api/updates/container/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const c    = docker.getContainer(req.params.id);
    const info = await c.inspect();
    const image = info.Config.Image;
    const wasRunning = info.State.Running;

    // Neues Image ziehen
    await pullImage(image);

    // Container neu erstellen mit identischer Konfiguration
    if (wasRunning) await c.stop().catch(() => {});
    await c.remove({ force: true });

    const hc = info.HostConfig;
    const cc = info.Config;
    const portBindings = hc.PortBindings || {};
    const exposedPorts = {};
    for (const key of Object.keys(portBindings)) exposedPorts[key] = {};

    const newC = await docker.createContainer({
      Image: image,
      name:  info.Name.replace(/^\//, ''),
      Env:   cc.Env    || [],
      Labels: cc.Labels || {},
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        Binds:        hc.Binds        || [],
        RestartPolicy: hc.RestartPolicy || { Name: 'unless-stopped' },
        Privileged:   hc.Privileged   || false,
        NetworkMode:  hc.NetworkMode  || 'bridge',
      },
    });
    if (wasRunning) await newC.start();

    // Cache invalidieren
    _updateCache = { ts: 0, data: null };
    res.json({ ok: true, id: newC.id });
  })
);

// ---------------------------------------------------------------------------
// Hearth self-update logic (shared by manual endpoint + nightly scheduler)
// ---------------------------------------------------------------------------
const { execFile: _execFile, spawn: _spawn } = require('child_process');
const _REPO = '/app/repo';

function _exec(cmd, args) {
  return new Promise((resolve, reject) =>
    _execFile(cmd, args, (err, stdout, stderr) =>
      err ? reject(new Error(stderr?.trim() || err.message)) : resolve(stdout.trim())
    )
  );
}

async function runHearthSelfUpdate() {
  const branch = (runtimeConfig.updateBranch || 'main').trim();

  const allC = await docker.listContainers({ all: true }).catch(() => []);
  const self  = allC.find(c => c.Labels?.['hearth.self'] === 'true' && (c.Names || []).some(n => n.includes('/hearth') && !n.includes('firewall') && !n.includes('vpn') && !n.includes('updater')));
  const selfImage = self?.Image || 'hearth-hearth';

  // Resolve the HOST-side repo path via bind-mount inspection.
  let repoHostPath = null;
  try {
    if (self) {
      const info = await docker.getContainer(self.Id).inspect();
      const mount = (info.Mounts || []).find(m => m.Destination === '/app/repo');
      if (mount?.Source) repoHostPath = mount.Source;
    }
  } catch (_) {}

  // ── Fallback: volume not mounted → clone repo on the HOST via docker run ──
  if (!repoHostPath || !fs.existsSync(path.join(_REPO, '.git'))) {
    const tmpHostPath = '/tmp/hearth-src';
    console.log('[UPDATE] /app/repo not mounted — cloning from GitHub to HOST ' + tmpHostPath);
    await new Promise((resolve, reject) => {
      const p = _spawn('docker', [
        'run', '--rm',
        '-v', `${tmpHostPath}:/dst`,
        selfImage,
        'sh', '-c',
        `rm -rf /dst && git clone --depth=1 --branch ${branch} https://github.com/MarioundMB/Hearth.git /dst`,
      ], { stdio: 'ignore' });
      p.on('close', code => code === 0 ? resolve() : reject(new Error('Fallback git clone fehlgeschlagen')));
    });
    repoHostPath = tmpHostPath;
  } else {
    // Volume is mounted — fetch + reset inside the container as usual
    await _exec('git', ['config', '--global', '--add', 'safe.directory', _REPO]).catch(() => {});
    await _exec('git', ['-C', _REPO, 'fetch', '--quiet']);
    const remoteSha = await _exec('git', ['-C', _REPO, 'rev-parse', '--short', `origin/${branch}`]);
    const sourceSha = await _exec('git', ['-C', _REPO, 'rev-parse', '--short', 'HEAD']);
    if (sourceSha !== remoteSha) {
      await _exec('git', ['-C', _REPO, 'reset', '--hard', `origin/${branch}`]);
      await _exec('git', ['-C', _REPO, 'clean', '-fd']).catch(() => {});
    }
  }

  // Version aus dem (ggf. frisch geklonten) Repo lesen
  const newPkgPath = fs.existsSync(path.join(_REPO, 'package.json'))
    ? path.join(_REPO, 'package.json')
    : path.join('/tmp/hearth-src', 'package.json');
  const newVersion = fs.existsSync(newPkgPath)
    ? JSON.parse(fs.readFileSync(newPkgPath, 'utf8')).version
    : null;
  if (newVersion && newVersion === VERSION) return { upToDate: true, version: newVersion };
  _updateCache = { ts: 0, data: null };

  const newSha = await _exec('git', ['-C', repoHostPath === '/tmp/hearth-src' ? _REPO : repoHostPath,
    'rev-parse', '--short', 'HEAD']).catch(() => 'unknown');

  const projectName = self?.Labels?.['com.docker.compose.project']
    || path.basename(repoHostPath)
    || 'hearth';

  _spawn('docker', [
    'run', '--rm', '--name', 'hearth-updater',
    '--label', 'hearth.self=true',
    '--label', 'hearth.hide=true',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${repoHostPath}:/app/repo`,
    selfImage,
    'sh', '-c',
    `sleep 3 && cd /app/repo && git config --global --add safe.directory /app/repo 2>/dev/null; docker compose -p ${projectName} up -d --build hearth`,
  ], { detached: true, stdio: 'ignore' }).unref();

  return { upToDate: false, version: newVersion };
}

// Nightly auto-update — time and enabled flag read from runtimeConfig.autoUpdate
let _nightlyTimer = null;

function scheduleNightlyUpdate() {
  if (_nightlyTimer) { clearTimeout(_nightlyTimer); _nightlyTimer = null; }
  const cfg = runtimeConfig.autoUpdate ?? { enabled: true, hour: 0, minute: 0 };
  if (!cfg.enabled) { console.log('[UPDATE] Auto-update disabled.'); return; }

  const hour   = Math.max(0, Math.min(23, cfg.hour   ?? 0));
  const minute = Math.max(0, Math.min(59, cfg.minute ?? 0));
  const now    = new Date();
  let   next   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  _nightlyTimer = setTimeout(() => {
    _nightlyTimer = null;
    console.log('[UPDATE] Running scheduled auto-update…');
    runHearthSelfUpdate()
      .then(r => {
        if (!r.upToDate) addNotif('update-done', 'Hearth updated', `Successfully updated to ${r.sha}.`, { section: 'updates' });
        console.log(r.upToDate ? '[UPDATE] Already up to date.' : `[UPDATE] Updated to ${r.sha}.`);
      })
      .catch(e => {
        addNotif('error', 'Auto-update failed', e.message);
        console.error('[UPDATE] Auto-update failed:', e.message);
      });
    scheduleNightlyUpdate();
  }, next - now);
  console.log(`[UPDATE] Next auto-update scheduled at ${next.toLocaleString()}`);
}

// Manual trigger endpoint
app.post(
  '/api/updates/hearth',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const result = await runHearthSelfUpdate();
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
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
    const guestHiddenSet = new Set(runtimeConfig.guestHidden || []);
    res.json(
      containers
        .map(mapContainer)
        .filter((c) => String(c.labels['hearth.self']).toLowerCase() !== 'true')
        .map((c) => ({
          ...c,
          guestVisible: !guestHiddenSet.has(c.id) && !guestHiddenSet.has(c.name),
        }))
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

    // Auto-firewall: open host ports in UFW for the new container (best-effort).
    if (await fwAvailable()) {
      const publicPorts = (b.ports || []).filter(p => p.host && p.container);
      for (const p of publicPorts) {
        const proto = (p.proto || 'tcp').toLowerCase();
        await fwExec(`ufw allow ${p.host}/${proto} comment "hearth: ${b.name || b.image}"`).catch(() => {});
      }
    }

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
    // Image-IDs der internen Hearth-Container ermitteln und ausblenden
    const selfContainers = await docker.listContainers({ all: true }).catch(() => []);
    const systemImageIds = new Set(
      selfContainers
        .filter((c) => String((c.Labels || {})['hearth.self']).toLowerCase() === 'true')
        .map((c) => c.ImageID)
    );

    const images = await docker.listImages();
    res.json(
      images
        .filter((i) => !systemImageIds.has(i.Id))
        .map((i) => ({
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
    // Return the canonical relative path so the frontend always shows the real location,
    // even when the input was dirty (e.g. "../" resolves to the root).
    const relPath = '/' + path.relative(FILES_ROOT, dir).replace(/\\/g, '/');
    const cleanPath = relPath === '/.' ? '/' : relPath;

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
    res.json({ path: cleanPath, items });
  })
);

app.get(
  '/api/files/download',
  requireAuth,
  asyncHandler(async (req, res) => {
    const full = safeResolve(req.query.path);
    const st = await fsp.stat(full);
    if (st.isDirectory()) {
      // Stream folder as tar.gz archive
      const name = path.basename(full) || 'archive';
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.tar.gz"`);
      const tar = spawn('tar', ['czf', '-', '-C', path.dirname(full), name]);
      tar.stdout.pipe(res);
      tar.stderr.on('data', () => {});
      tar.on('error', (e) => { if (!res.headersSent) res.status(500).end(); else res.end(); });
      return;
    }
    res.download(full, path.basename(full));
  })
);

// Read text file content (max 5 MB)
app.get(
  '/api/files/content',
  requireAuth,
  asyncHandler(async (req, res) => {
    const full = safeResolve(req.query.path);
    const st = await fsp.stat(full);
    if (st.isDirectory()) { res.status(400); throw new Error('Ordner haben keinen Textinhalt'); }
    if (st.size > 5 * 1024 * 1024) { res.status(400); throw new Error('Datei zu groß für den Editor (max 5 MB)'); }
    const content = await fsp.readFile(full, 'utf8');
    res.type('text/plain; charset=utf-8').send(content);
  })
);

// Write text file content
app.put(
  '/api/files/content',
  requireAuth,
  asyncHandler(async (req, res) => {
    const full = safeResolve(req.body.path);
    const st = await fsp.stat(full).catch(() => null);
    if (st && st.isDirectory()) { res.status(400); throw new Error('Ordner können nicht beschrieben werden'); }
    await fsp.writeFile(full, req.body.content ?? '', 'utf8');
    res.json({ ok: true });
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

app.post(
  '/api/files/copy',
  requireAuth,
  asyncHandler(async (req, res) => {
    const from = safeResolve(req.body.from);
    const toDir = safeResolve(req.body.toDir || '/');
    const name = req.body.name || path.basename(from);
    const target = path.join(toDir, name);
    if (target === from) {
      res.status(400);
      throw new Error('Quelle und Ziel sind identisch');
    }
    await fsp.cp(from, target, { recursive: true });
    res.json({ ok: true });
  })
);

app.get(
  '/api/files/volumes',
  requireAuth,
  asyncHandler(async (req, res) => {
    let entries = [];
    try {
      entries = await fsp.readdir(FILES_ROOT, { withFileTypes: true });
    } catch (_) {}
    const volumes = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const p = path.join(FILES_ROOT, e.name);
          let used = 0, total = 0;
          try {
            await new Promise((resolve) => {
              exec(`df -k "${p}"`, (err, stdout) => {
                if (!err && stdout) {
                  const lines = stdout.trim().split('\n');
                  const parts = lines[lines.length - 1].trim().split(/\s+/);
                  if (parts.length >= 3) {
                    total = parseInt(parts[1]) * 1024 || 0;
                    used  = parseInt(parts[2]) * 1024 || 0;
                  }
                }
                resolve();
              });
            });
          } catch (_) {}
          return { name: e.name, path: '/' + e.name, used, total };
        })
    );
    res.json({ volumes });
  })
);

// ---------------------------------------------------------------------------
// Statisches Frontend
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// VPN (WireGuard via hearth-vpn container)
// ---------------------------------------------------------------------------
async function vpnAvailable() {
  try { await docker.getContainer(VPN_CONTAINER).inspect(); return true; } catch (_) { return false; }
}

async function vpnExec(cmd) {
  return new Promise(async (resolve, reject) => {
    try {
      const c = docker.getContainer(VPN_CONTAINER);
      const exec = await c.exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({});
      let out = '';
      stream.on('data', (chunk) => { out += chunk.slice(8).toString('utf8'); });
      stream.on('end', () => resolve(out.trim()));
      stream.on('error', reject);
    } catch (e) { reject(e); }
  });
}

app.get('/api/vpn/status', requireAuth, asyncHandler(async (req, res) => {
  if (!await vpnAvailable()) return res.json({ available: false });
  try {
    const info = await docker.getContainer(VPN_CONTAINER).inspect();
    const running = info.State.Running;
    const wgStatus = running ? await vpnExec('wg show 2>/dev/null') : '';

    // Directory-based peers (linuxserver/wireguard format: /config/peer_<name>/)
    const peerList = running
      ? await vpnExec('ls /config 2>/dev/null | grep "^peer_" | sed "s/peer_//"')
      : '';
    const dirPeers = peerList.split('\n').filter(Boolean);
    const peers = dirPeers.map(name => ({ name }));

    // Also parse `wg show` output for peers that are active but not in /config dirs
    // (manually configured peers). `peer: <pubkey>` lines mark each peer.
    const wgPeerKeys = [...wgStatus.matchAll(/^peer:\s+(\S+)/gm)].map(m => m[1]);
    for (const key of wgPeerKeys) {
      const shortKey = key.slice(0, 8) + '…';
      // Skip if a dir-based peer likely owns this key (we can't easily correlate, so
      // only add if we have more wg peers than dir peers)
      if (!peers.some(p => p.pubkey === key)) {
        // Only add as extra entry when no dir peer covers this slot
        if (peers.length < wgPeerKeys.length) {
          peers.push({ name: shortKey, pubkey: key });
        }
      }
    }

    res.json({ available: true, running, status: wgStatus, peers });
  } catch (e) {
    res.json({ available: true, running: false, error: e.message, peers: [] });
  }
}));

// Stream a peer's QR code PNG from the container
app.get('/api/vpn/peers/:name/qr', requireAuth, asyncHandler(async (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  try {
    const c = docker.getContainer(VPN_CONTAINER);
    // linuxserver/wireguard stores QR as PNG
    const execObj = await c.exec({
      Cmd: ['cat', `/config/peer_${name}/peer_${name}.png`],
      AttachStdout: true, AttachStderr: false,
    });
    const stream = await execObj.start({});
    const chunks = [];
    stream.on('data', (d) => chunks.push(d.slice(8)));
    stream.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return res.status(404).json({ error: 'QR not found' });
      res.setHeader('Content-Type', 'image/png');
      res.send(buf);
    });
    stream.on('error', (e) => res.status(500).json({ error: e.message }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// Download a peer's .conf file
app.get('/api/vpn/peers/:name/conf', requireAuth, asyncHandler(async (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  try {
    const conf = await vpnExec(`cat /config/peer_${name}/peer_${name}.conf`);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.conf"`);
    res.send(conf);
  } catch (e) { res.status(500).json({ error: e.message }); }
}));

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

// Admin server — keep this behind your firewall / VPN
http.createServer(app).listen(PORT, () => {
  console.log(`\x1b[32m✓ Admin panel   http://localhost:${PORT}/admin\x1b[0m`);
  console.log(`  File manager root: ${FILES_ROOT}`);
  scheduleNightlyUpdate();
});

// Guest server — safe to expose publicly (admin routes are blocked)
if (GUEST_PORT !== PORT) {
  http.createServer((req, res) => {
    req.fromGuestPort = true;
    app(req, res);
  }).listen(GUEST_PORT, () => {
    console.log(`\x1b[32m✓ Guest view    http://localhost:${GUEST_PORT}\x1b[0m`);
    console.log(`\x1b[2m  → Safe to expose publicly. Admin routes are blocked on this port.\x1b[0m`);
  });
}
