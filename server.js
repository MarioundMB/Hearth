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
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const os = require('os');
const { exec, spawn } = require('child_process');

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
    icon:        labels['hearth.icon']        || '',
    url,
    state:   c.state,                  // full Docker state
    running: c.state === 'running',
    ports:   published.map((p) => p.publicPort),
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
// Nginx / Reverse Proxy
// ---------------------------------------------------------------------------
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
app.get('/api/dockerhub/logo', requireAuth, asyncHandler(async (req, res) => {
  const raw = (req.query.image || '').split(':')[0].trim();
  if (!raw) return res.status(400).json({ error: 'image required' });

  const parts = raw.split('/');
  const [ns, name] = parts.length === 1 ? ['library', parts[0]] : [parts[0], parts[1]];
  const key = `${ns}-${name}`.replace(/[^a-z0-9_-]/gi, '_');

  const cacheDir  = path.join(FILES_ROOT, '.hearth-cache', 'logos');
  const cacheMeta = path.join(cacheDir, `${key}.json`);
  const cacheImg  = path.join(cacheDir, `${key}.img`);

  // Cache-Hit: direkt ausliefern
  if (fs.existsSync(cacheImg) && fs.existsSync(cacheMeta)) {
    try {
      const { contentType } = JSON.parse(fs.readFileSync(cacheMeta, 'utf8'));
      res.setHeader('Content-Type', contentType || 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return res.sendFile(cacheImg);
    } catch (_) {}
  }

  try {
    const infoRes = await fetch(`https://hub.docker.com/v2/repositories/${ns}/${name}/`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!infoRes.ok) return res.status(404).end();

    const info = await infoRes.json();
    const logoUrl = info.logo_url?.large || info.logo_url?.small;
    if (!logoUrl) return res.status(404).end();

    const imgRes = await fetch(logoUrl, { signal: AbortSignal.timeout(8000) });
    if (!imgRes.ok) return res.status(404).end();

    const contentType = imgRes.headers.get('content-type') || 'image/png';
    const buffer = Buffer.from(await imgRes.arrayBuffer());

    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheImg,  buffer);
    fs.writeFileSync(cacheMeta, JSON.stringify({ contentType, ts: Date.now() }));

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.send(buffer);
  } catch (e) {
    res.status(500).end();
  }
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
  const { domain, target, enabled = true, strip = '' } = req.body || {};
  if (!domain || !target) return res.status(400).json({ error: 'domain and target are required' });

  const rules = [...(runtimeConfig.proxyRules || [])];
  const id = Date.now().toString(36);
  rules.push({ id, domain: domain.trim(), target: target.trim().replace(/\/$/, ''), enabled: !!enabled, strip: strip.trim() });
  saveConfig({ proxyRules: rules });
  writeProxyConfigs(rules);
  await reloadNginx();
  res.json({ ok: true, id });
}));

app.put('/api/proxy/rules/:id', requireAuth, asyncHandler(async (req, res) => {
  const { domain, target, enabled, strip } = req.body || {};
  const rules = (runtimeConfig.proxyRules || []).map((r) => {
    if (r.id !== req.params.id) return r;
    return {
      ...r,
      domain:  domain  !== undefined ? domain.trim()  : r.domain,
      target:  target  !== undefined ? target.trim().replace(/\/$/, '') : r.target,
      enabled: enabled !== undefined ? !!enabled        : r.enabled,
      strip:   strip   !== undefined ? strip.trim()    : (r.strip || ''),
    };
  });
  saveConfig({ proxyRules: rules });
  writeProxyConfigs(rules);
  await reloadNginx();
  res.json({ ok: true });
}));

app.delete('/api/proxy/rules/:id', requireAuth, asyncHandler(async (req, res) => {
  const rules = (runtimeConfig.proxyRules || []).filter((r) => r.id !== req.params.id);
  saveConfig({ proxyRules: rules });
  writeProxyConfigs(rules);
  await reloadNginx();
  res.json({ ok: true });
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
  const protoStr = proto ? `/${proto}` : '';
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
    autoUpdate: runtimeConfig.autoUpdate ?? { enabled: true, hour: 0, minute: 0 },
    port:        PORT,
    dockerSocket: DOCKER_SOCKET,
    filesRoot:   FILES_ROOT,
    dataDir:     DATA_DIR,
    version:     VERSION,
    sha:         HEARTH_SHA,
  });
});

app.post(
  '/api/settings',
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      serverName, lang, showOfflineApps, refreshInterval, autoUpdate,
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
  const users = runtimeConfig.users || [];
  const user  = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const passBuf = Buffer.from(String(password || ''));
  const refBuf  = Buffer.from(user.password);
  const passOk  = passBuf.length === refBuf.length && crypto.timingSafeEqual(passBuf, refBuf);
  if (!passOk) return res.status(401).json({ error: 'Invalid username or password' });

  req.session.authed = true;
  req.session.user   = username;
  req.session.role   = user.role;
  res.json({ ok: true, role: user.role });
});

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

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, role = 'viewer' } = req.body || {};
  if (!username?.trim() || !password) return res.status(400).json({ error: 'username and password required' });
  if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const users = runtimeConfig.users || [];
  if (users.find(u => u.username === username.trim())) return res.status(409).json({ error: 'Username already taken' });
  users.push({ username: username.trim(), password, role });
  saveConfig({ users });
  res.json({ ok: true });
});

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
app.patch('/api/users/:username', requireAuth, (req, res) => {
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
    const a = Buffer.from(String(currentPassword)), b = Buffer.from(user.password);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return res.status(401).json({ error: 'Current password is incorrect' });
    if (newPassword) {
      if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      user.password = newPassword;
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
});

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

// Hilfsfunktion: prüft Docker Hub ob ein neueres Image vorliegt
async function checkImageUpdate(image) {
  try {
    const [ref] = image.split(':');
    const tag   = image.includes(':') ? image.split(':')[1] : 'latest';
    const parts = ref.split('/');
    const [ns, name] = parts.length === 1 ? ['library', parts[0]] : [parts[0], parts[1]];

    // Lokales Image-Erstelldatum
    const localInfo = await docker.getImage(image).inspect().catch(() => null);
    if (!localInfo) return { hasUpdate: null };
    const localTs = new Date(localInfo.Created).getTime();

    // Remote last_updated von Docker Hub
    const r = await fetch(
      `https://hub.docker.com/v2/repositories/${ns}/${name}/tags/${tag}/`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return { hasUpdate: null };
    const data = await r.json();
    const remoteTs = new Date(data.last_updated).getTime();

    return {
      hasUpdate: remoteTs > localTs,
      remoteDate: data.last_updated,
      localDate: localInfo.Created,
      remoteDigest: data.images?.[0]?.digest || null,
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
    let hearthUpdate = null;
    try {
      const r = await fetch(
        'https://api.github.com/repos/MarioundMB/Hearth/commits/main',
        { headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'Hearth-Panel' },
          signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const d = await r.json();
        const remoteSha = d.sha?.slice(0, 7) || 'unknown';
        hearthUpdate = {
          sha:       remoteSha,
          localSha:  HEARTH_SHA,
          hasUpdate: HEARTH_SHA !== 'unknown' && remoteSha !== HEARTH_SHA,
          message:   d.commit?.message?.split('\n')[0] || '',
          date:      d.commit?.committer?.date,
          remoteTs:  new Date(d.commit?.committer?.date || 0).getTime(),
        };
      }
    } catch (_) {}

    if (hearthUpdate?.hasUpdate) {
      addNotif('update', 'Hearth update available',
        `${hearthUpdate.localSha} → ${hearthUpdate.sha}: ${hearthUpdate.message}`,
        { section: 'updates' });
    }

    const result = { containers: containerUpdates, hearth: hearthUpdate, ts: Date.now() };
    _updateCache = { ts: Date.now(), data: result };
    res.json({ ...result, cached: false });
  })
);

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
  if (!fs.existsSync(path.join(_REPO, '.git'))) {
    throw new Error('Source directory not mounted. Add "- .:/app/repo" to the hearth volumes in docker-compose.yml.');
  }
  // Allow git to operate on the bind-mounted directory (owner may differ inside the container)
  await _exec('git', ['config', '--global', '--add', 'safe.directory', _REPO]).catch(() => {});
  await _exec('git', ['-C', _REPO, 'fetch', '--quiet']);
  const remoteSha = await _exec('git', ['-C', _REPO, 'rev-parse', '--short', 'origin/main']);

  // Pull if source dir is behind remote
  const sourceSha = await _exec('git', ['-C', _REPO, 'rev-parse', '--short', 'HEAD']);
  if (sourceSha !== remoteSha) await _exec('git', ['-C', _REPO, 'pull', '--ff-only']);
  const newSha = await _exec('git', ['-C', _REPO, 'rev-parse', '--short', 'HEAD']);

  // Only skip rebuild if the running image already reflects the latest source
  if (HEARTH_SHA !== 'unknown' && HEARTH_SHA === newSha) return { upToDate: true, sha: newSha };
  _updateCache = { ts: 0, data: null };

  // Rebuilding from inside the running container is impossible:
  // when Docker stops this container (as part of `docker compose up --build`),
  // it sends SIGKILL to ALL processes in the container — including the spawned shell.
  // Fix: run the rebuild in an EXTERNAL helper container that survives hearth being stopped.
  // We use our own image (which already has docker-cli + docker-compose) as the helper.
  const allC = await docker.listContainers({ all: true }).catch(() => []);
  const self  = allC.find(c => c.Labels?.['hearth.self'] === 'true' && (c.Names || []).some(n => n.includes('hearth')));
  const selfImage = self?.Image || 'hearth-hearth';

  _spawn('docker', [
    'run', '--rm', '--name', 'hearth-updater',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${_REPO}:/app/repo`,
    selfImage,
    'sh', '-c',
    `sleep 3 && cd /app/repo && git config --global --add safe.directory /app/repo; GIT_SHA=${newSha} docker compose up -d --build hearth`,
  ], { detached: true, stdio: 'ignore' }).unref();

  return { upToDate: false, sha: newSha };
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
    const wgStatus = running ? await vpnExec('wg show 2>/dev/null | head -20') : '';
    // List peer directories
    const peerList = running
      ? await vpnExec('ls /config 2>/dev/null | grep "^peer_" | sed "s/peer_//"')
      : '';
    const peers = peerList.split('\n').filter(Boolean).map(name => ({ name }));
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
