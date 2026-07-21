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
const dns = require('dns').promises;
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { PassThrough } = require('stream');
const crypto = require('crypto');
const os = require('os');
const { exec, execFile, spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const BCRYPT_ROUNDS = 12;
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { WebSocketServer } = require('ws');

// Modul-weite Zustandsvariablen (müssen vor jeder Nutzung deklariert sein)
let _nginxProc  = null;
let _cpuPrev    = null;
let _netPrev    = null, _netPrevTs = 0;
const _termTokens = new Map(); // one-time terminal auth tokens
let _hearthImage = 'alpine:latest'; // filled at startup by self-inspect

const { version: VERSION } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
);
const HEARTH_SHA = (process.env.HEARTH_SHA || 'unknown').slice(0, 7);

// ---------------------------------------------------------------------------
// Konfiguration (über Umgebungsvariablen steuerbar – siehe .env.example)
// ---------------------------------------------------------------------------
const DATA_DIR    = process.env.DATA_DIR    || '/srv/hearth-data';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
// Deliberately NOT derived from FILES_ROOT (see below) — Hearth's own
// operational config must live somewhere stable regardless of what the
// file manager's root is currently set to.
const CONFIG_PATH        = process.env.CONFIG_PATH        || '/mnt/data/hearth.config.json';
const NOTIF_ARCHIVE_PATH = process.env.NOTIF_ARCHIVE_PATH || '/mnt/data/hearth.notifications.json';

// Early config read so saved port/files-root values can override defaults before server binds
let _earlyConfig = {};
try { if (fs.existsSync(CONFIG_PATH)) _earlyConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) {}

// FILES_ROOT prefers the env var (an explicit operator override in .env)
// but falls back to the durably-persisted config value rather than the
// hardcoded default. .env-based overrides have proven fragile across
// self-updates (the updater's git-checkout/compose-project-directory
// detection can end up stale after a container recreate, silently losing
// the .env override on the next rebuild) — persisting the choice in
// hearth.config.json means it survives that regardless of what .env says.
const FILES_ROOT  = path.resolve(process.env.FILES_ROOT || _earlyConfig.configFilesRoot || '/mnt/data');

const PORT        = parseInt(process.env.PORT       || _earlyConfig.configPort      || '4500', 10);
// Separate public-facing port for the guest view only (no admin routes)
const GUEST_PORT  = parseInt(process.env.GUEST_PORT || _earlyConfig.configGuestPort || '3000', 10);
const PROXY_PORT  = parseInt(process.env.PROXY_PORT  || _earlyConfig.configProxyPort || '443',  10);
const HTTP_PORT   = parseInt(process.env.HTTP_PORT   || _earlyConfig.configHttpPort  || '80',   10);
// Optional HTTPS listener for the admin panel itself, using a self-signed
// cert for the LAN IP — WebAuthn (passkeys) requires a secure context
// (HTTPS or localhost), which a plain-HTTP LAN-IP admin panel never is.
const ADMIN_HTTPS_PORT = parseInt(process.env.ADMIN_HTTPS_PORT || _earlyConfig.configAdminHttpsPort || '4501', 10);
const ADMIN_LOCAL_CERT_KEY = '_admin-local';
const NGINX_PROXY_DIR   = '/etc/nginx/hearth-proxy';
const NGINX_STREAMS_DIR = '/etc/nginx/hearth-streams';
const CERTS_DIR       = '/etc/nginx/hearth-certs';
const AUTH_DIR        = '/etc/nginx/hearth-auth';
const NGINX_LOG_DIR   = '/var/log/nginx';
const ACME_SH         = '/root/.acme.sh/acme.sh';
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
  redirectRules: [],
  notFoundHosts: [],
  streamRules: [],
  firewallRules: [],
  firewallAliases: [],
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
renewCertsIfNeeded().catch(() => {});
// LE certs are 90 days — check daily so long-uptime deployments still renew
// without needing a restart to re-trigger the boot-time check above.
setInterval(() => renewCertsIfNeeded().catch(() => {}), 24 * 60 * 60 * 1000);

const docker = new Docker({ socketPath: DOCKER_SOCKET });

// Detect own Docker image at startup so the terminal uses the same image (has util-linux/nsenter)
(async () => {
  try {
    const selfId = (process.env.HOSTNAME || '').trim();
    if (selfId) {
      const info = await docker.getContainer(selfId).inspect();
      _hearthImage = info.Config.Image || 'alpine:latest';
    }
  } catch (_) {}

  // Auto-install mdadm on the host if missing (needed for Software-RAID feature)
  try {
    const { stdout: which } = await raidExec('ls /usr/sbin/mdadm /sbin/mdadm 2>/dev/null | head -1 || echo missing');
    if (!which || which.includes('missing') || !which.includes('/')) {
      const { stdout: pmPath } = await raidExec(
        'which apt-get 2>/dev/null || which dnf 2>/dev/null || which yum 2>/dev/null || which pacman 2>/dev/null || echo ""'
      );
      let cmd = '';
      if      (pmPath.includes('apt-get')) cmd = 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mdadm 2>&1';
      else if (pmPath.includes('dnf'))     cmd = 'dnf install -y -q mdadm 2>&1';
      else if (pmPath.includes('yum'))     cmd = 'yum install -y -q mdadm 2>&1';
      else if (pmPath.includes('pacman'))  cmd = 'pacman -Sy --noconfirm mdadm 2>&1';
      if (cmd) {
        console.log('[RAID] mdadm not found — installing on host…');
        const res = await raidExec(cmd);
        if (res.ok) console.log('[RAID] mdadm installed successfully.');
        else        console.warn('[RAID] mdadm install failed:', res.stderr || res.stdout);
      }
    }
  } catch (e) {
    console.warn('[RAID] mdadm startup check skipped:', e.message);
  }

  // Auto-install + enable avahi-daemon (mDNS) on the host if missing. This is
  // what makes `<hostname>.local` (the same hostname the Server-Name setting
  // already controls) resolvable on the LAN without any manual client setup —
  // needed because WebAuthn/passkeys reject bare IP addresses as an RP ID
  // ("effective domain is not a valid domain") regardless of HTTPS, so the
  // local-HTTPS admin cert only actually works for passkeys against a real
  // hostname, not the raw LAN IP. Same install pattern as mdadm above, and
  // every Hearth install gets this automatically — not a one-off server fix.
  try {
    const { stdout: active } = await raidExec('systemctl is-active avahi-daemon 2>/dev/null || echo inactive');
    if (!active.trim().includes('active') || active.includes('inactive')) {
      const { stdout: pmPath } = await raidExec(
        'which apt-get 2>/dev/null || which dnf 2>/dev/null || which yum 2>/dev/null || which pacman 2>/dev/null || echo ""'
      );
      let cmd = '';
      if      (pmPath.includes('apt-get')) cmd = 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq avahi-daemon 2>&1';
      else if (pmPath.includes('dnf'))     cmd = 'dnf install -y -q avahi 2>&1';
      else if (pmPath.includes('yum'))     cmd = 'yum install -y -q avahi 2>&1';
      else if (pmPath.includes('pacman'))  cmd = 'pacman -Sy --noconfirm avahi 2>&1';
      if (cmd) {
        console.log('[MDNS] avahi-daemon not active — installing on host…');
        const res = await raidExec(`${cmd} && systemctl enable --now avahi-daemon 2>&1`);
        if (res.ok) console.log('[MDNS] avahi-daemon installed and started.');
        else        console.warn('[MDNS] avahi-daemon install failed:', res.stderr || res.stdout);
      }
    }
  } catch (e) {
    console.warn('[MDNS] avahi-daemon startup check skipped:', e.message);
  }

  await resyncFirewall('boot');
})();

// Self-heals ufw/iptables drift (see resyncFirewall above) regardless of what
// causes it — Docker daemon restarts, host reboots, package updates — since
// none of those necessarily coincide with Hearth's own restart.
setInterval(() => resyncFirewall('periodic').catch(() => {}), 5 * 60 * 1000);

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
      // 'auto' marks the cookie Secure only on an actual HTTPS connection
      // (direct via the local-HTTPS admin server, or via the reverse proxy's
      // X-Forwarded-Proto — trust proxy is enabled above) — plain 'true'
      // would break login entirely on the default plain-HTTP admin port.
      secure: 'auto',
      maxAge: 1000 * 60 * 60 * 12, // 12 Stunden
    },
  })
);

// Simple in-memory brute-force throttle for /api/login and /api/2fa/verify —
// keyed by IP, not per-account, so it can't be used to lock a known admin
// username out by spraying wrong passwords from one address.
const _loginAttempts = new Map(); // ip -> { count, firstAttempt }
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
function _isRateLimited(ip) {
  const rec = _loginAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.firstAttempt > LOGIN_WINDOW_MS) { _loginAttempts.delete(ip); return false; }
  return rec.count >= LOGIN_MAX_ATTEMPTS;
}
function _registerFailedAttempt(ip) {
  const now = Date.now();
  const rec = _loginAttempts.get(ip);
  if (!rec || now - rec.firstAttempt > LOGIN_WINDOW_MS) {
    _loginAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    rec.count++;
  }
  if (_loginAttempts.size > 5000) {
    for (const [k, v] of _loginAttempts) { if (now - v.firstAttempt > LOGIN_WINDOW_MS) _loginAttempts.delete(k); }
  }
}
function _clearRateLimit(ip) {
  _loginAttempts.delete(ip);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

function requireAdmin(req, res, next) {
  if (!req.session?.authed) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
  next();
}

// A verified TAP-Key grants req.session.setupAccessUser — a narrow identity
// that's only accepted by the passkey-registration and 2FA-setup endpoints
// (via requireAuthOrSetupAccess below), not by requireAuth generally. This
// is what lets someone bootstrap a passkey+2FA for a brand-new domain (e.g.
// a Reverse Proxy host they just pointed at the guest port) without first
// needing a password login there — while still not handing out a real
// admin session to whoever has the code.
function requireAuthOrSetupAccess(req, res, next) {
  if (req.session?.authed) return next();
  if (req.session?.setupAccessUser) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}
function effectiveUsername(req) {
  return req.session?.authed ? req.session.user : req.session?.setupAccessUser;
}

// ── Guest-port isolation ─────────────────────────────────────────────────
// Requests arriving on GUEST_PORT have req.fromGuestPort = true (set by the
// guest http.Server wrapper below). Admin routes and API endpoints are blocked
// on that port so the guest view can be exposed publicly without risk.
app.use((req, res, next) => {
  if (!req.fromGuestPort) return next();

  // /setup is a pre-auth first-run flow — never expose it here, regardless
  // of the admin-access gate below.
  if (req.path === '/setup' || req.path.startsWith('/setup/')) {
    return res.status(403).send(
      '<!doctype html><html><body style="font-family:sans-serif;padding:40px">' +
      '<h2>Admin access is restricted to the local network.</h2>' +
      '<p>Connect via VPN or access from your local network.</p></body></html>'
    );
  }

  // Same bar as exposing the admin port via the Reverse Proxy: only once
  // every admin account has both a passkey and 2FA enabled is it safe to
  // let the guest port reach /admin at all — password auth alone isn't
  // enough for a port meant to be internet-facing. Login itself still goes
  // through the normal password(+2FA) flow; this just stops blocking the
  // routes it needs.
  // A verified TAP-Key session (see requireAuthOrSetupAccess) is already
  // narrowly scoped to just the passkey/2FA setup endpoints regardless of
  // this bypass — a multi-admin setup where only SOME admins have finished
  // securing their account would otherwise leave isAdminAccessSecured()
  // false and lock the very flow meant to onboard the rest.
  if (isAdminAccessSecured() || req.session?.setupAccessUser) return next();

  // Block admin pages — but if a TAP-Key is actively waiting to be used,
  // send visitors straight to where it's actually usable instead of a dead
  // end that just tells them to go set one up (they may well already have
  // one, generated from the LAN admin panel, with nowhere obvious to enter it).
  if (['/admin', '/login'].some(p => req.path === p || req.path.startsWith(p + '/'))) {
    if (_tapKey && _tapKey.expiresAt > Date.now()) {
      return res.redirect('/setup-access');
    }
    return res.status(403).sendFile(path.join(__dirname, 'public', 'access-restricted.html'));
  }

  // Block all /api/* except the public guest endpoints
  if (req.path.startsWith('/api/')) {
    // /api/dockerhub/logo is the icon fallback buildAppTile() emits for
    // containers without a hearth.icon label — unauthenticated on the admin
    // port too, so it's safe to expose here as well. Without it, guest-view
    // icons 403 for every app that doesn't set hearth.icon explicitly.
    // /api/setup-access/* is the TAP-Key check + status — has to be
    // reachable before setupAccessUser exists to grant it in the first place.
    const allowed = ['/api/lang', '/api/public/', '/api/dockerhub/logo', '/api/setup-access/'];
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

// The guest view is meant for access from outside the LAN, where a raw
// IP:port URL either doesn't route (port-forwarding rarely covers every
// app port) or skips straight past the domain/TLS setup already done in
// the Reverse Proxy. If an enabled proxy rule forwards to this published
// host port, prefer that public domain over the local IP:port link.
function findProxyDomainForPort(webPort) {
  if (!webPort) return null;
  const rule = (runtimeConfig.proxyRules || []).find(
    (r) => r.enabled && String(r.forwardPort) === String(webPort)
  );
  return rule ? `https://${rule.domain}` : null;
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
  if (!url && webPort) url = findProxyDomainForPort(webPort) || `${scheme}://${reqHost}:${webPort}`;

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

function validateDomain(domain) {
  if (!domain || !_DOMAIN_RE.test(domain.replace(/^\*\./, ''))) {
    const err = new Error(`Ungültige Domain '${domain}' – nur Buchstaben, Ziffern, Bindestriche und Punkte erlaubt`);
    err.statusCode = 400;
    throw err;
  }
}

function validateProxyInputs(domain, target) {
  validateDomain(domain);
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

// Builds+validates a target URL from split scheme/host/port fields (used for
// the main forward target and for each custom location).
function buildTarget(scheme, host, port) {
  const s = (scheme === 'https') ? 'https' : 'http';
  const h = (host || '').trim();
  const p = String(port || '').trim();
  if (!h) { const err = new Error('Forward-Hostname/IP ist erforderlich'); err.statusCode = 400; throw err; }
  if (!_HOST_RE.test(h)) { const err = new Error(`Ungültiger Forward-Hostname '${h}'`); err.statusCode = 400; throw err; }
  if (!p || isNaN(+p) || +p < 1 || +p > 65535) { const err = new Error(`Ungültiger Forward-Port '${p}'`); err.statusCode = 400; throw err; }
  return `${s}://${h}:${p}`;
}

// Shared gate for anything that exposes Hearth's own admin control plane
// (Docker socket, root file manager, firewall) beyond the LAN — password
// auth alone isn't an acceptable guard at that level, so every admin
// account must have both a passkey and TOTP 2FA enabled first.
function isAdminAccessSecured() {
  const admins = (runtimeConfig.users || []).filter((u) => u.role === 'admin');
  return admins.length > 0 && admins.every((u) => u.totp_enabled && (u.passkeys || []).length > 0);
}

// A Proxy Host / Stream whose target is Hearth's own admin port would expose
// the full control plane to the internet. Require the passkey+2FA gate
// before such a rule can be created or (re-)enabled.
function assertNoUnsecuredAdminExposure(forwardPort, enabled) {
  if (!enabled) return;
  if (parseInt(forwardPort, 10) !== PORT) return;
  if (isAdminAccessSecured()) return;
  const err = new Error(
    'Um den Admin-Port öffentlich freizugeben, müssen für alle Admin-Konten sowohl Passkey als auch 2FA aktiviert sein (Einstellungen → Sicherheit).'
  );
  err.statusCode = 400;
  throw err;
}

function normalizeExtraDomains(list) {
  return (Array.isArray(list) ? list : [])
    .map((d) => String(d || '').trim())
    .filter(Boolean)
    .filter((d, i, arr) => arr.indexOf(d) === i);
}

// Safe URL-path characters only — this string is interpolated directly into
// generated nginx config (`location ${path} { ... }`), so anything outside
// this allowlist (braces, quotes, semicolons, newlines, …) could break out
// of the location block and inject arbitrary nginx directives.
const _LOC_PATH_RE = /^\/[a-zA-Z0-9\-._~/%]*$/;

function normalizeLocations(list) {
  return (Array.isArray(list) ? list : []).map((l, i) => {
    const locPath = String(l?.path || '').trim() || '/';
    if (!_LOC_PATH_RE.test(locPath)) { const err = new Error(`Ungültiger Custom-Location-Pfad '${locPath}' — muss mit / beginnen und darf nur Buchstaben, Ziffern, -._~/% enthalten`); err.statusCode = 400; throw err; }
    const forwardScheme = l?.forwardScheme === 'https' ? 'https' : 'http';
    const forwardHost = String(l?.forwardHost || '').trim();
    const forwardPort = String(l?.forwardPort || '').trim();
    return {
      id: l?.id || `loc-${Date.now().toString(36)}-${i}`,
      path: locPath,
      forwardScheme, forwardHost, forwardPort,
      target: buildTarget(forwardScheme, forwardHost, forwardPort),
    };
  });
}

function allDomainsOf(rule) {
  return [rule.domain, ...(rule.extraDomains || [])].filter(Boolean);
}

// ---------------------------------------------------------------------------
// SSL-Zertifikat-Verwaltung
// ---------------------------------------------------------------------------

function certPaths(domain) {
  const dir = path.join(CERTS_DIR, domain);
  return { dir, cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'key.pem') };
}

function certExists(domain) {
  const { cert, key } = certPaths(domain);
  return fs.existsSync(cert) && fs.existsSync(key);
}

function getCertInfo(domain) {
  const { cert } = certPaths(domain);
  if (!fs.existsSync(cert)) return null;
  try {
    const out = require('child_process').execSync(
      `openssl x509 -in "${cert}" -noout -enddate -issuer 2>/dev/null`
    ).toString();
    const expLine = (out.match(/notAfter=(.+)/) || [])[1] || '';
    const issuerLine = (out.match(/issuer=(.+)/) || [])[1] || '';
    const expires = expLine ? new Date(expLine) : null;
    const isLE = issuerLine.includes("Let's Encrypt") || issuerLine.includes('R3') || issuerLine.includes('E1');
    const daysLeft = expires ? Math.ceil((expires - Date.now()) / 86400000) : null;
    return { expires: expires?.toISOString(), daysLeft, isLE, domain };
  } catch (_) { return { domain }; }
}

// IPV4_RE is declared once, further down, and reused here — see its
// definition for why (IP allowlist validation elsewhere in the file).
function generateSelfSignedCert(domain, allDomains = [domain], force = false) {
  return new Promise((resolve, reject) => {
    const { dir, cert, key } = certPaths(domain);
    if (!force && certExists(domain)) { resolve(); return; }
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    // Browsers validate IP-based certs against the SAN's IP entries, not
    // DNS entries — a plain LAN IP like 192.168.0.10 needs `IP:...`, not
    // `DNS:...`, or WebAuthn's isSecureContext check (and the browser)
    // won't accept the connection as a valid secure context.
    const sanList = (allDomains.length ? allDomains : [domain])
      .map((d) => `${IPV4_RE.test(d) ? 'IP' : 'DNS'}:${d}`).join(',');
    const p = spawn('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', key, '-out', cert,
      '-days', '3650', '-nodes',
      '-subj', `/CN=${domain}`,
      '-addext', `subjectAltName=${sanList}`,
    ], { stdio: 'ignore' });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`openssl fehlgeschlagen für ${domain}`)));
  });
}

async function requestLECert(domain, allDomains = [domain]) {
  if (!fs.existsSync(ACME_SH)) throw new Error('acme.sh nicht gefunden');
  const { dir, cert, key } = certPaths(domain);
  fs.mkdirSync(dir, { recursive: true });
  const cfToken  = runtimeConfig.cfApiToken;
  const cfZoneId = runtimeConfig.cfZoneId;
  const usesCf   = !!(cfToken && cfZoneId);
  const env = { ...process.env, HOME: '/root' };
  if (usesCf) { env.CF_Token = cfToken; env.CF_Zone_ID = cfZoneId; }

  // Create webroot directory if using webroot mode
  if (!usesCf) {
    try { fs.mkdirSync('/var/www/acme', { recursive: true }); } catch (_) {}
  }

  const domainFlags = (allDomains.length ? allDomains : [domain]).flatMap((d) => ['-d', d]);
  // acme.sh needs a syntactically valid contact email to register a Let's
  // Encrypt account (rejects anything without a dotted domain part) — we
  // don't collect one from the admin, so derive one from the rule's own
  // domain, which always has a dot.
  const accountEmail = `admin@${domain}`;

  await new Promise((resolve, reject) => {
    const args = usesCf
      ? [ACME_SH, '--issue', '--dns', 'dns_cf', ...domainFlags, '--accountemail', accountEmail, '--server', 'letsencrypt']
      : [ACME_SH, '--issue', '--webroot', '/var/www/acme', ...domainFlags, '--accountemail', accountEmail, '--server', 'letsencrypt'];
    const p = spawn('sh', args, { env, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    p.on('close', code => {
      if (code === 0 || code === 2) resolve(out);  // code 2 = already issued
      else reject(new Error(out.slice(-500) || 'acme.sh fehlgeschlagen'));
    });
  });

  // Copy certs to hearth-certs dir. nginx's ssl_certificate needs the full
  // chain (leaf + intermediate), not just the leaf — otherwise strict TLS
  // clients that don't already have the intermediate cached (e.g. cloudflared)
  // fail with "unable to get local issuer certificate" even though browsers
  // tolerate it. --fullchain-file (not --cert-file) writes leaf+intermediate.
  await new Promise((resolve, reject) => {
    const args = [ACME_SH, '--install-cert', '-d', domain,
      '--fullchain-file', cert, '--key-file', key,
      '--reloadcmd', 'nginx -s reload 2>/dev/null || true'];
    const p = spawn('sh', args, { env, stdio: 'ignore' });
    p.on('close', code => code === 0 ? resolve() : reject(new Error('acme.sh install-cert fehlgeschlagen')));
  });
}

async function renewCertsIfNeeded() {
  if (!fs.existsSync(ACME_SH)) return;
  const all = [
    ...(runtimeConfig.proxyRules || []),
    ...(runtimeConfig.redirectRules || []),
    ...(runtimeConfig.notFoundHosts || []),
  ];
  for (const r of all.filter(r => r.certType === 'letsencrypt')) {
    const info = getCertInfo(r.domain);
    if (info?.daysLeft != null && info.daysLeft < 30) {
      console.log(`[CERT] Renewing LE cert for ${r.domain} (${info.daysLeft} days left)`);
      await requestLECert(r.domain, allDomainsOf(r)).catch(e => console.warn('[CERT] Renewal failed:', e.message));
    }
  }
}

async function ensureDefaultCert() {
  if (!certExists('_default')) {
    await generateSelfSignedCert('_default').catch(e => console.warn('[CERT]', e.message));
  }
}

async function ensureCertsForRules(rules) {
  for (const r of (rules || []).filter(r => r.enabled)) {
    if (!r.certType || r.certType === 'self-signed') {
      // Regenerated every time so the SAN list always matches the rule's
      // current domain + extraDomains — cheap, no rate limits, no external calls.
      await generateSelfSignedCert(r.domain, allDomainsOf(r), true).catch(e => console.warn('[CERT]', e.message));
    } else if (!certExists(r.domain)) {
      // LE/custom cert missing (shouldn't normally happen) — fall back so nginx can still start.
      await generateSelfSignedCert(r.domain, allDomainsOf(r), true).catch(e => console.warn('[CERT]', e.message));
    }
  }
}

// ---------------------------------------------------------------------------
// Basic-Auth Verwaltung
// ---------------------------------------------------------------------------

function htpasswdPath(ruleId) {
  return path.join(AUTH_DIR, `${ruleId}.htpasswd`);
}

async function writeHtpasswd(ruleId, user, password) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const hash = await new Promise((resolve, reject) => {
    const p = spawn('openssl', ['passwd', '-apr1', password], { stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error('htpasswd generation failed')));
  });
  fs.writeFileSync(htpasswdPath(ruleId), `${user}:${hash}\n`);
}

// ---------------------------------------------------------------------------
// Nginx-Konfiguration
// ---------------------------------------------------------------------------

// Shared proxy_pass + headers block, reused for the main location and every
// custom location — `target` differs, everything else stays identical.
function proxyPassBlock(target, { basicAuthLines = '', websockets = true } = {}) {
  return `${basicAuthLines}
        proxy_pass ${target};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;${websockets ? `
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;` : ''}
        proxy_read_timeout 300;
        proxy_connect_timeout 300;
        proxy_send_timeout 300;`;
}

// Conservative "block common exploits" ruleset — blocks dotfile access
// (besides ACME challenges), common backup/VCS/config file extensions, and
// well-known exploit patterns in the query string.
const BLOCK_EXPLOITS_SNIPPET = `
    location ~ /\\.(?!well-known) { deny all; }
    location ~* \\.(git|env|htaccess|htpasswd|bak|sql|swp)$ { deny all; }
    if ($query_string ~ "(<|%3C).*script.*(>|%3E)") { return 403; }
    if ($query_string ~ "GLOBALS(=|\\[|%\\[0-9A-Z]{0,2})") { return 403; }
    if ($query_string ~ "_REQUEST(=|\\[|%\\[0-9A-Z]{0,2})") { return 403; }
    if ($query_string ~ "proc/self/environ") { return 403; }
    if ($query_string ~ "base64_(en|de)code\\(.*\\)") { return 403; }`;

function nginxConfForRule(rule) {
  const { cert, key } = certPaths(rule.domain);
  const logFile = path.join(NGINX_LOG_DIR, `hearth-${rule.id}.log`);
  const ba = rule.basicAuth;
  const maxBody = rule.maxBodySize ? rule.maxBodySize.replace(/[^0-9kmgKMG]/g, '') : '';
  const serverNames = allDomainsOf(rule).join(' ');
  const websockets = rule.websockets !== false;
  const forceSsl = rule.forceSsl !== false;
  const http2 = !!rule.http2;

  // IP access control — validated here (not just at rule-save time) since
  // this is the actual point where values reach the nginx config file,
  // regardless of which route wrote the rule.
  const ipLines = [];
  (rule.ipDenylist || '').split(',').map(s => s.trim()).filter(s => IPV4_RE.test(s) || IPV6_RE.test(s)).forEach(ip => {
    ipLines.push(`    deny ${ip};`);
  });
  (rule.ipAllowlist || '').split(',').map(s => s.trim()).filter(s => IPV4_RE.test(s) || IPV6_RE.test(s)).forEach(ip => {
    ipLines.push(`    allow ${ip};`);
  });
  if ((rule.ipAllowlist || '').trim().length > 0) {
    ipLines.push('    deny all;');
  }

  // HSTS + other security headers (independent toggles)
  const hstsHeader = rule.hstsEnabled
    ? `\n    add_header Strict-Transport-Security "max-age=31536000${rule.hstsSubdomains ? '; includeSubDomains' : ''}" always;`
    : '';
  const secHeaders = rule.securityHeaders ? `
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;` : '';

  const blockExploits = rule.blockExploits ? BLOCK_EXPLOITS_SNIPPET : '';

  // Static cache location
  const staticCache = rule.cacheStatic ? `
    location ~* \\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|webp)$ {
        proxy_pass ${rule.target};
        proxy_set_header Host $host;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
    }` : '';

  // Custom Locations (sub-path routing to other backends)
  const customLocations = (rule.locations || []).map((loc) => `
    location ${loc.path} {
        ${proxyPassBlock(loc.target, { websockets })}
    }`).join('\n');

  // Custom snippet (strip dangerous directives)
  const snippet = (rule.customSnippet || '')
    .split('\n').filter(l => !/^\s*(root|alias|include|load_module)\s/i.test(l)).join('\n');

  const basicAuthLines = ba?.enabled && ba?.user
    ? `auth_basic "Restricted";\n        auth_basic_user_file ${htpasswdPath(rule.id)};`
    : '';

  // When Force SSL is off, the HTTP server also serves real content, so it
  // needs the same IP allow/deny + exploit-blocking as the HTTPS block —
  // otherwise those protections would be silently bypassed over plain HTTP.
  const httpServer = `server {
    listen ${HTTP_PORT};
    server_name ${serverNames};
    location /.well-known/acme-challenge/ {
        root /var/www/acme;
    }
    ${forceSsl ? '' : ipLines.join('\n    ')}
    ${forceSsl ? '' : blockExploits}
    location / {
        ${forceSsl
          ? 'return 301 https://$host$request_uri;'
          : proxyPassBlock(rule.target, { basicAuthLines, websockets })}
    }
}`;

  return `# Hearth Proxy: ${rule.id} (${serverNames})
${httpServer}
server {
    listen ${PROXY_PORT} ssl${http2 ? ' http2' : ''};
    server_name ${serverNames};
    ssl_certificate     ${cert};
    ssl_certificate_key ${key};
    access_log ${logFile} hearth_combined;
    ${maxBody ? `client_max_body_size ${maxBody};` : ''}
    ${hstsHeader}
    ${secHeaders}
    ${ipLines.join('\n    ')}
    ${blockExploits}
    ${staticCache}
    ${customLocations}
    location / {
        ${proxyPassBlock(rule.target, { basicAuthLines, websockets })}
        ${snippet}
    }
}
`;
}

// Redirection Hosts — same domain/cert machinery as proxy rules, but the
// location block just returns a redirect instead of proxy_pass-ing anywhere.
function nginxConfForRedirect(rule) {
  const { cert, key } = certPaths(rule.domain);
  const serverNames = allDomainsOf(rule).join(' ');
  const forceSsl = rule.forceSsl !== false;
  const http2 = !!rule.http2;
  const statusCode = [301, 302].includes(+rule.statusCode) ? +rule.statusCode : 301;
  const targetUrl = rule.targetUrl.replace(/\/$/, '');
  const redirectTarget = rule.preservePath ? `${targetUrl}$request_uri` : targetUrl;

  const hstsHeader = rule.hstsEnabled
    ? `\n    add_header Strict-Transport-Security "max-age=31536000${rule.hstsSubdomains ? '; includeSubDomains' : ''}" always;`
    : '';

  const httpServer = `server {
    listen ${HTTP_PORT};
    server_name ${serverNames};
    location /.well-known/acme-challenge/ {
        root /var/www/acme;
    }
    location / {
        ${forceSsl ? 'return 301 https://$host$request_uri;' : `return ${statusCode} ${redirectTarget};`}
    }
}`;

  return `# Hearth Redirect: ${rule.id} (${serverNames} -> ${rule.targetUrl})
${httpServer}
server {
    listen ${PROXY_PORT} ssl${http2 ? ' http2' : ''};
    server_name ${serverNames};
    ssl_certificate     ${cert};
    ssl_certificate_key ${key};
    ${hstsHeader}
    location / {
        return ${statusCode} ${redirectTarget};
    }
}
`;
}

// A "404 Host" claims a domain (with its own trusted cert) without proxying
// anywhere — useful to explicitly serve a clean 404 for a domain instead of
// falling through to nginx's self-signed `_default` catch-all, which breaks
// strict TLS clients like cloudflared (see nginxConfForRule's HSTS comment).
function nginxConfForNotFound(rule) {
  const { cert, key } = certPaths(rule.domain);
  const serverNames = allDomainsOf(rule).join(' ');
  const http2 = !!rule.http2;
  const hstsHeader = rule.hstsEnabled
    ? `\n    add_header Strict-Transport-Security "max-age=31536000${rule.hstsSubdomains ? '; includeSubDomains' : ''}" always;`
    : '';

  return `# Hearth 404 Host: ${rule.id} (${serverNames})
server {
    listen ${HTTP_PORT};
    server_name ${serverNames};
    location /.well-known/acme-challenge/ {
        root /var/www/acme;
    }
    location / {
        return 404;
    }
}
server {
    listen ${PROXY_PORT} ssl${http2 ? ' http2' : ''};
    server_name ${serverNames};
    ssl_certificate     ${cert};
    ssl_certificate_key ${key};
    ${hstsHeader}
    location / {
        return 404;
    }
}
`;
}

function nginxConfForStream(rule) {
  const target = `${rule.forwardHost}:${rule.forwardPort}`;
  const listeners = rule.protocol === 'udp'
    ? [`listen ${rule.listenPort} udp;`]
    : rule.protocol === 'both'
      ? [`listen ${rule.listenPort};`, `listen ${rule.listenPort} udp;`]
      : [`listen ${rule.listenPort};`];
  return `# Hearth Stream: ${rule.id} (${rule.name || rule.listenPort})
${listeners.map(l => `server {\n    ${l}\n    proxy_pass ${target};\n}`).join('\n')}
`;
}

async function writeProxyConfigs(
  rules = runtimeConfig.proxyRules || [],
  redirects = runtimeConfig.redirectRules || [],
  notFoundHosts = runtimeConfig.notFoundHosts || [],
) {
  try {
    fs.mkdirSync(NGINX_PROXY_DIR, { recursive: true });
    for (const f of fs.readdirSync(NGINX_PROXY_DIR)) {
      fs.unlinkSync(path.join(NGINX_PROXY_DIR, f));
    }
    await ensureDefaultCert();
    await ensureCertsForRules(rules);
    await ensureCertsForRules(redirects);
    await ensureCertsForRules(notFoundHosts);
    for (const r of (rules || []).filter((r) => r.enabled)) {
      fs.writeFileSync(path.join(NGINX_PROXY_DIR, `${r.id}.conf`), nginxConfForRule(r));
    }
    for (const r of (redirects || []).filter((r) => r.enabled)) {
      fs.writeFileSync(path.join(NGINX_PROXY_DIR, `redirect-${r.id}.conf`), nginxConfForRedirect(r));
    }
    for (const r of (notFoundHosts || []).filter((r) => r.enabled)) {
      fs.writeFileSync(path.join(NGINX_PROXY_DIR, `404host-${r.id}.conf`), nginxConfForNotFound(r));
    }
  } catch (e) {
    console.warn('[PROXY] Konnte Nginx-Configs nicht schreiben:', e.message);
  }
}

async function writeStreamConfigs(streams = runtimeConfig.streamRules || []) {
  try {
    fs.mkdirSync(NGINX_STREAMS_DIR, { recursive: true });
    for (const f of fs.readdirSync(NGINX_STREAMS_DIR)) {
      fs.unlinkSync(path.join(NGINX_STREAMS_DIR, f));
    }
    for (const r of (streams || []).filter((r) => r.enabled)) {
      fs.writeFileSync(path.join(NGINX_STREAMS_DIR, `stream-${r.id}.conf`), nginxConfForStream(r));
    }
  } catch (e) {
    console.warn('[PROXY] Konnte Stream-Configs nicht schreiben:', e.message);
  }
}

function reloadNginx() {
  return new Promise((resolve) => {
    exec('nginx -s reload 2>/dev/null', (err) => resolve(!err));
  });
}

function renderNginxBaseConfig() {
  const templatePath = '/etc/nginx/nginx.conf.template';
  if (!fs.existsSync(templatePath)) return; // already-rendered nginx.conf from an older image
  const rendered = fs.readFileSync(templatePath, 'utf8')
    .replace(/__HTTP_PORT__/g, HTTP_PORT)
    .replace(/__PROXY_PORT__/g, PROXY_PORT);
  fs.writeFileSync('/etc/nginx/nginx.conf', rendered);
}

async function startNginx() {
  const nginxBin = ['/usr/sbin/nginx', '/usr/bin/nginx', '/sbin/nginx'].find(fs.existsSync);
  if (!nginxBin) {
    console.log('[PROXY] Nginx nicht gefunden – Reverse Proxy deaktiviert');
    return;
  }
  renderNginxBaseConfig();
  await writeProxyConfigs(runtimeConfig.proxyRules);
  await writeStreamConfigs(runtimeConfig.streamRules);
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
  console.log(`\x1b[32m✓ Reverse Proxy (Nginx) HTTPS:${PROXY_PORT} HTTP:${HTTP_PORT}\x1b[0m`);
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

// network_mode: host means os.networkInterfaces() sees the HOST's real
// interfaces directly — used to auto-detect the LAN subnet(s) so the admin
// ports can be locked to them without the admin having to know or supply
// their own CIDR. Docker's own virtual interfaces are excluded by name
// (they're not "the LAN" and would produce nonsense 172.x-style rules).
function _netmaskToCidr(mask) {
  return mask.split('.').reduce((acc, o) => acc + ((parseInt(o, 10).toString(2).match(/1/g) || []).length), 0);
}
function _ipv4NetworkAddress(address, cidr) {
  const [a, b, c, d] = address.split('.').map(Number);
  const maskBits = cidr === 0 ? 0 : (~((1 << (32 - cidr)) - 1)) >>> 0;
  const addrInt  = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const netInt   = (addrInt & maskBits) >>> 0;
  return [(netInt >>> 24) & 255, (netInt >>> 16) & 255, (netInt >>> 8) & 255, netInt & 255].join('.');
}
function getLocalLanCidrs() {
  const nets = os.networkInterfaces();
  const skip = /^(lo|docker|br-|veth|vxlan|virbr)/;
  const cidrs = new Set();
  for (const name of Object.keys(nets)) {
    if (skip.test(name)) continue;
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal || !net.netmask) continue;
      const cidr = _netmaskToCidr(net.netmask);
      if (cidr < 8 || cidr > 30) continue; // sanity bounds — skip anything degenerate
      cidrs.add(`${_ipv4NetworkAddress(net.address, cidr)}/${cidr}`);
    }
  }
  return [...cidrs];
}

// hearth-vpn isn't on host networking, so its own PostUp rule masquerades
// every VPN client to the container's own address on Docker's bridge
// network before that traffic ever reaches the host — getLocalLanCidrs()
// deliberately excludes docker/br-/veth interfaces, so without this, VPN
// clients could reach every other LAN device but not Hearth's own admin
// panel (the one port that's actually LAN-restricted). Detected per-install
// via the container's actual network rather than hardcoded, since Docker
// assigns that subnet dynamically. Returns null (no-op for the caller) if
// the VPN container/network doesn't exist — installs without VPN configured
// aren't affected.
async function getVpnBridgeCidr() {
  try {
    const info = await docker.getContainer(VPN_CONTAINER).inspect();
    for (const netName of Object.keys(info.NetworkSettings?.Networks || {})) {
      const subnet = (await docker.getNetwork(netName).inspect().catch(() => null))
        ?.IPAM?.Config?.[0]?.Subnet;
      if (subnet) return subnet;
    }
  } catch (_) {}
  return null;
}

// Locks a port to the detected LAN subnet(s), replacing ANY existing rule
// for that exact port (regardless of who created it or how broad it is —
// a stray "Anywhere" rule alongside a LAN-only one would still let the
// port through from anywhere, since ufw ALLOW rules for the same port are
// evaluated as OR'd). Skips entirely if no LAN subnet could be detected,
// rather than risk locking the admin out with an empty rule set.
async function enforceLanOnlyPort(port, tag) {
  const lanCidrs = getLocalLanCidrs();
  const vpnCidr = await getVpnBridgeCidr();
  if (vpnCidr && !lanCidrs.includes(vpnCidr)) lanCidrs.push(vpnCidr);
  if (!lanCidrs.length) return;
  const numbered = await fwExec('ufw status numbered').catch(() => '');
  const lines = numbered.split('\n').filter(l => /^\[/.test(l.trim()));
  const portRe = new RegExp(`\\b${port}/tcp\\b`);
  const matching = lines.filter(l => portRe.test(l));
  const alreadyCorrect =
    matching.length === lanCidrs.length &&
    lanCidrs.every((cidr) => matching.some((l) => l.includes(cidr)));
  if (alreadyCorrect) return;

  const nums = matching
    .map((l) => parseInt((l.match(/\[\s*(\d+)\]/) || [])[1], 10))
    .filter(Boolean)
    .sort((a, b) => b - a);
  for (const num of nums) {
    await fwExec(`echo y | ufw delete ${num}`).catch(() => {});
  }
  for (const cidr of lanCidrs) {
    await fwExec(`ufw allow from ${cidr} to any port ${port} proto tcp comment ${tag}`).catch(() => {});
  }
}

// Newer Docker versions (28+) reassert `iptables -P FORWARD DROP` themselves
// on every dockerd startup as part of their own default hardening — this
// happens independently of ufw and of Hearth's own lifecycle (host reboots,
// docker.io package updates, a manual `systemctl restart docker`), so a
// boot-time fix alone only catches it if Hearth itself restarts at the same
// time. Re-asserting on an interval makes this self-healing regardless of
// what triggered the drift. Also covers the related case where ufw's rule
// file and the live kernel chains fall out of sync (`ufw status` only ever
// reads the file, so it can't detect that on its own).
//
// Also (re-)enforces the admin ports as LAN-only every cycle — not just at
// boot — so a rule change made outside Hearth (or a fresh install that
// never had one at all) gets locked down within one resync interval rather
// than staying open indefinitely.
let _lastFwResyncOk = null;
async function resyncFirewall(reason) {
  if (!(await fwAvailable())) return false;
  try {
    await fwExec('ufw --force reload');
    await fwExec('iptables -P FORWARD ACCEPT').catch(() => {});
    await enforceLanOnlyPort(PORT, 'hearth-admin-port-lan').catch((e) => console.warn('[FW] admin port lock failed:', e.message));
    await enforceLanOnlyPort(ADMIN_HTTPS_PORT, 'hearth-admin-https-port-lan').catch((e) => console.warn('[FW] admin https port lock failed:', e.message));
    if (_lastFwResyncOk === false) console.log(`[FW] resync recovered (${reason})`);
    _lastFwResyncOk = true;
    return true;
  } catch (e) {
    _lastFwResyncOk = false;
    console.warn(`[FW] resync failed (${reason}):`, e.message);
    return false;
  }
}

function fwError(msg, statusCode = 400) {
  const e = new Error(msg);
  e.statusCode = statusCode;
  return e;
}

// ---- Aliases: named, reusable IP/network or port lists (referenced as "@Name") ----
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const IPV6_RE = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;
const ALIAS_NAME_RE = /^[A-Za-z0-9_-]+$/;

function isValidNetworkLiteral(v) {
  if (!v) return false;
  if (IPV4_RE.test(v)) return v.split('/')[0].split('.').every(o => Number(o) <= 255);
  if (v.includes(':') && IPV6_RE.test(v)) return true;
  return false;
}

function isValidPortToken(v) {
  return /^\d{1,5}(:\d{1,5})?$/.test(v) && v.split(':').every(n => Number(n) <= 65535);
}

function isValidAliasMember(v, kind) {
  return kind === 'port' ? isValidPortToken(v) : isValidNetworkLiteral(v);
}

// "any" / "@AliasName" / a literal IPv4/IPv6(+CIDR) value — used for From/To
function isValidEndpoint(str) {
  const v = String(str ?? '').trim();
  if (!v || v === 'any') return true;
  if (v.startsWith('@')) return v.length > 1;
  return isValidNetworkLiteral(v);
}

// "any" / "@AliasName" / a port number, range, or comma-list — used for Port
function isValidPortSpec(str) {
  const v = String(str ?? '').trim();
  if (!v || v === 'any') return true;
  if (v.startsWith('@')) return v.length > 1;
  return v.split(',').every(t => isValidPortToken(t.trim()));
}

// Resolves a From/To/Port token to its member list: "@Name" → alias members, else itself
function resolveAliasMembers(token, kind, aliases) {
  const raw = String(token ?? '').trim();
  if (!raw || raw === 'any') return ['any'];
  if (raw.startsWith('@')) {
    const name = raw.slice(1);
    const alias = (aliases || []).find(a => a.kind === kind && a.name === name);
    if (!alias) throw fwError(`Unknown ${kind} alias @${name}`);
    return alias.members;
  }
  return raw.split(',').map(t => t.trim()).filter(Boolean);
}

function buildUfwCmds(rule, aliases) {
  const action    = String(rule.action).replace(/[^a-z]/gi, '');
  const direction = String(rule.direction) === 'out' ? 'out' : 'in';
  const iface     = rule.iface ? String(rule.iface).replace(/[^a-z0-9]/gi, '') : '';
  const proto     = rule.proto && rule.proto !== 'any' ? String(rule.proto).replace(/[^a-z]/gi, '') : '';
  const id        = String(rule.id).replace(/[^a-z0-9]/gi, '');

  const froms = resolveAliasMembers(rule.from, 'network', aliases);
  const tos   = resolveAliasMembers(rule.to,   'network', aliases);
  const ports = resolveAliasMembers(rule.port, 'port',    aliases);

  if (froms.length * tos.length * ports.length > 100) {
    throw fwError('Alias expansion exceeds 100 rules — narrow the alias members');
  }

  const cmds = [];
  for (const from of froms) {
    for (const to of tos) {
      for (const port of ports) {
        const f = from !== 'any' ? String(from).replace(/[^a-f0-9\.:/]/gi, '') : '';
        const t = to   !== 'any' ? String(to  ).replace(/[^a-f0-9\.:/]/gi, '') : '';
        const p = port !== 'any' ? String(port).replace(/[^0-9:]/g, '') : '';
        let cmd = `ufw ${action}`;
        if (direction === 'out') cmd += ' out';
        if (iface) cmd += ` on ${iface}`;
        if (f) cmd += ` from ${f}`;
        cmd += t ? ` to ${t}` : ' to any';
        if (p) cmd += ` port ${p}`;
        if (proto) cmd += ` proto ${proto}`;
        cmd += ` comment "hearth-rule-${id}"`;
        cmds.push(cmd);
      }
    }
  }
  return cmds;
}

// Returns a list of { id, error } for rules that failed to apply (e.g. a dangling
// alias reference) — callers should surface these instead of assuming ok:true
// means every rule actually made it into ufw.
async function syncFirewallRules(rules) {
  if (!await fwAvailable()) return [];
  const aliases = runtimeConfig.firewallAliases || [];
  const numbered = await fwExec('ufw status numbered').catch(() => '');
  const lines = numbered.split('\n').filter(l => /^\[/.test(l.trim()));
  // Find and delete existing hearth-managed rules in reverse order
  const managed = lines
    .filter(l => l.includes('hearth-rule-'))
    .map(l => parseInt((l.match(/\[\s*(\d+)\]/) || [])[1]))
    .filter(Boolean)
    .sort((a, b) => b - a);
  for (const num of managed) {
    await fwExec(`echo y | ufw delete ${num}`).catch(() => {});
  }
  // Re-add all rules in new order, skipping disabled ones
  const warnings = [];
  for (const rule of (rules || [])) {
    if (rule.enabled === false) continue;
    try {
      for (const cmd of buildUfwCmds(rule, aliases)) {
        await fwExec(cmd).catch(e => warnings.push({ id: rule.id, error: e.message }));
      }
    } catch (e) { warnings.push({ id: rule.id, error: e.message }); }
  }
  if (warnings.length) console.warn('[FW] sync warnings:', warnings);
  return warnings;
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
// Port-Konflikt Auflösung
// ---------------------------------------------------------------------------
async function findFreeHostPort(desired) {
  let port = Math.max(1, parseInt(desired) || 8080);
  if (!port || port > 65535) return port;
  try {
    const containers = await docker.listContainers({ all: true });
    const used = new Set([PORT, PROXY_PORT, HTTP_PORT, GUEST_PORT]);
    containers.forEach(c => (c.Ports || []).forEach(p => { if (p.PublicPort) used.add(p.PublicPort); }));
    while (used.has(port)) port++;
  } catch (_) {}
  return port;
}

async function resolvePortConflicts(ports) {
  const resolved = [];
  for (const p of (ports || [])) {
    if (!p.host || !p.container) { resolved.push(p); continue; }
    const free = await findFreeHostPort(p.host);
    resolved.push({ ...p, host: String(free), _autoAssigned: free !== Number(p.host) });
  }
  return resolved;
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

app.post('/api/proxy/rules', requireAdmin, asyncHandler(async (req, res) => {
  const {
    domain, extraDomains, forwardScheme, forwardHost, forwardPort,
    locations, enabled = true, cfSync = false,
    basicAuth, ipAllowlist = '', ipDenylist = '',
    securityHeaders = false, hstsEnabled = false, hstsSubdomains = false,
    forceSsl = true, http2 = false, blockExploits = false, websockets = true,
    cacheStatic = false, maxBodySize = '', customSnippet = '',
  } = req.body || {};
  if (!domain || !forwardHost || !forwardPort) return res.status(400).json({ error: 'domain, forwardHost and forwardPort are required' });
  assertNoUnsecuredAdminExposure(forwardPort, enabled);
  const target = buildTarget(forwardScheme, forwardHost, forwardPort);
  validateProxyInputs(domain.trim(), target);
  const extraDomainsClean = normalizeExtraDomains(extraDomains);
  extraDomainsClean.forEach(validateDomain);
  const locationsClean = normalizeLocations(locations);

  const rules = [...(runtimeConfig.proxyRules || [])];
  const id = Date.now().toString(36);
  const rule = {
    id, domain: domain.trim(), extraDomains: extraDomainsClean,
    forwardScheme: forwardScheme === 'https' ? 'https' : 'http',
    forwardHost: forwardHost.trim(), forwardPort: String(forwardPort).trim(),
    target, locations: locationsClean,
    enabled: !!enabled, cfSync: !!cfSync, cfDnsId: null,
    basicAuth: basicAuth || null, ipAllowlist, ipDenylist,
    securityHeaders: !!securityHeaders, hstsEnabled: !!hstsEnabled, hstsSubdomains: !!hstsSubdomains,
    forceSsl: !!forceSsl, http2: !!http2, blockExploits: !!blockExploits, websockets: !!websockets,
    cacheStatic: !!cacheStatic, maxBodySize, customSnippet, certType: 'self-signed',
  };
  if (basicAuth?.enabled && basicAuth?.user && basicAuth?.password) {
    await writeHtpasswd(id, basicAuth.user, basicAuth.password).catch(e => console.warn('[AUTH]', e.message));
    delete rule.basicAuth.password;
  }
  rules.push(rule);
  saveConfig({ proxyRules: rules });
  await writeProxyConfigs(rules);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Regel gespeichert, Proxy nicht aktualisiert. Bitte Domain und Target prüfen.' });
  }
  if (cfSync) cfSyncRule(rule).catch(e => console.warn('[CF]', e.message));
  res.json({ ok: true, id });
}));

app.put('/api/proxy/rules/:id', requireAdmin, asyncHandler(async (req, res) => {
  const {
    domain, extraDomains, forwardScheme, forwardHost, forwardPort,
    locations, enabled, cfSync,
    basicAuth, ipAllowlist, ipDenylist,
    securityHeaders, hstsEnabled, hstsSubdomains,
    forceSsl, http2, blockExploits, websockets,
    cacheStatic, maxBodySize, customSnippet,
  } = req.body || {};
  const existing = (runtimeConfig.proxyRules || []).find(r => r.id === req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Regel nicht gefunden' });

  const newDomain = domain !== undefined ? domain.trim() : existing.domain;
  const newForwardHost = forwardHost !== undefined ? forwardHost.trim() : existing.forwardHost;
  const newForwardPort = forwardPort !== undefined ? String(forwardPort).trim() : existing.forwardPort;
  const newForwardScheme = forwardScheme !== undefined ? (forwardScheme === 'https' ? 'https' : 'http') : (existing.forwardScheme || 'http');
  const newEnabled = enabled !== undefined ? !!enabled : existing.enabled;
  assertNoUnsecuredAdminExposure(newForwardPort, newEnabled);
  const newTarget = buildTarget(newForwardScheme, newForwardHost, newForwardPort);
  validateProxyInputs(newDomain, newTarget);
  const newExtraDomains = extraDomains !== undefined ? normalizeExtraDomains(extraDomains) : (existing.extraDomains || []);
  newExtraDomains.forEach(validateDomain);
  const newLocations = locations !== undefined ? normalizeLocations(locations) : (existing.locations || []);

  let updatedRule;
  const rules = (runtimeConfig.proxyRules || []).map((r) => {
    if (r.id !== req.params.id) return r;
    updatedRule = {
      ...r,
      domain: newDomain, extraDomains: newExtraDomains,
      forwardScheme: newForwardScheme, forwardHost: newForwardHost, forwardPort: newForwardPort,
      target: newTarget, locations: newLocations,
      enabled: enabled !== undefined ? !!enabled : r.enabled,
      cfSync:  cfSync  !== undefined ? !!cfSync : r.cfSync,
      basicAuth:      basicAuth      !== undefined ? basicAuth      : r.basicAuth,
      ipAllowlist:    ipAllowlist    !== undefined ? ipAllowlist    : (r.ipAllowlist || ''),
      ipDenylist:     ipDenylist     !== undefined ? ipDenylist     : (r.ipDenylist || ''),
      securityHeaders: securityHeaders !== undefined ? !!securityHeaders : r.securityHeaders,
      hstsEnabled:    hstsEnabled    !== undefined ? !!hstsEnabled   : !!r.hstsEnabled,
      hstsSubdomains: hstsSubdomains !== undefined ? !!hstsSubdomains: !!r.hstsSubdomains,
      forceSsl:       forceSsl       !== undefined ? !!forceSsl      : (r.forceSsl !== false),
      http2:          http2          !== undefined ? !!http2        : !!r.http2,
      blockExploits:  blockExploits  !== undefined ? !!blockExploits: !!r.blockExploits,
      websockets:     websockets     !== undefined ? !!websockets   : (r.websockets !== false),
      cacheStatic:    cacheStatic    !== undefined ? !!cacheStatic  : r.cacheStatic,
      maxBodySize:    maxBodySize    !== undefined ? maxBodySize    : (r.maxBodySize || ''),
      customSnippet:  customSnippet  !== undefined ? customSnippet  : (r.customSnippet || ''),
    };
    return updatedRule;
  });
  if (updatedRule?.basicAuth?.enabled && updatedRule.basicAuth?.user && updatedRule.basicAuth?.password) {
    await writeHtpasswd(req.params.id, updatedRule.basicAuth.user, updatedRule.basicAuth.password)
      .catch(e => console.warn('[AUTH]', e.message));
    delete updatedRule.basicAuth.password;
  }
  saveConfig({ proxyRules: rules });
  await writeProxyConfigs(rules);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Änderung gespeichert, Proxy nicht aktualisiert. Bitte Domain und Target prüfen.' });
  }
  if (updatedRule?.cfSync) cfSyncRule(updatedRule).catch(e => console.warn('[CF]', e.message));
  res.json({ ok: true });
}));

app.delete('/api/proxy/rules/:id', requireAdmin, asyncHandler(async (req, res) => {
  const toDelete = (runtimeConfig.proxyRules || []).find(r => r.id === req.params.id);
  const rules = (runtimeConfig.proxyRules || []).filter((r) => r.id !== req.params.id);
  saveConfig({ proxyRules: rules });
  await writeProxyConfigs(rules);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Regel gelöscht, Proxy nicht aktualisiert.' });
  }
  if (toDelete?.cfSync) cfDeleteDnsRecord(toDelete).catch(e => console.warn('[CF]', e.message));
  // Clean up htpasswd file
  try { fs.unlinkSync(htpasswdPath(req.params.id)); } catch (_) {}
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Proxy – Cert management
// ---------------------------------------------------------------------------
app.get('/api/proxy/rules/:id/cert', requireAuth, (req, res) => {
  const rule = (runtimeConfig.proxyRules || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ ok: false });
  const info = getCertInfo(rule.domain) || {};
  res.json({ ok: true, ...info, certType: rule.certType || 'self-signed' });
});

const certUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 1024 * 1024 } });
app.post('/api/proxy/rules/:id/cert/upload', requireAdmin, certUpload.fields([
  { name: 'cert', maxCount: 1 },
  { name: 'key',  maxCount: 1 },
]), asyncHandler(async (req, res) => {
  const rule = (runtimeConfig.proxyRules || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ ok: false });
  const certFile = req.files?.cert?.[0];
  const keyFile  = req.files?.key?.[0];
  if (!certFile || !keyFile) return res.status(400).json({ ok: false, error: 'cert and key files required' });
  const { dir, cert, key } = certPaths(rule.domain);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(certFile.path, cert);
  fs.copyFileSync(keyFile.path, key);
  fs.unlinkSync(certFile.path);
  fs.unlinkSync(keyFile.path);
  const rules = (runtimeConfig.proxyRules || []).map(r =>
    r.id === req.params.id ? { ...r, certType: 'custom' } : r
  );
  saveConfig({ proxyRules: rules });
  await writeProxyConfigs(rules);
  await reloadNginx();
  res.json({ ok: true });
}));

app.post('/api/proxy/rules/:id/cert/letsencrypt', requireAdmin, asyncHandler(async (req, res) => {
  const rule = (runtimeConfig.proxyRules || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ ok: false });
  // Remove existing cert so it can be replaced
  const { cert, key } = certPaths(rule.domain);
  try { fs.unlinkSync(cert); fs.unlinkSync(key); } catch (_) {}
  await requestLECert(rule.domain, allDomainsOf(rule));
  const rules = (runtimeConfig.proxyRules || []).map(r =>
    r.id === req.params.id ? { ...r, certType: 'letsencrypt' } : r
  );
  saveConfig({ proxyRules: rules });
  await writeProxyConfigs(rules);
  await reloadNginx();
  const info = getCertInfo(rule.domain);
  res.json({ ok: true, ...info });
}));

// Delete the current certificate and fall back to a fresh self-signed one —
// there was previously no way to get unstuck from a broken/unwanted cert
// short of editing files on disk by hand.
app.delete('/api/proxy/rules/:id/cert', requireAdmin, asyncHandler(async (req, res) => {
  const rule = (runtimeConfig.proxyRules || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ ok: false });
  const { dir } = certPaths(rule.domain);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  const rules = (runtimeConfig.proxyRules || []).map(r =>
    r.id === req.params.id ? { ...r, certType: 'self-signed' } : r
  );
  saveConfig({ proxyRules: rules });
  await writeProxyConfigs(rules);  // regenerates a fresh self-signed cert
  await reloadNginx();
  const info = getCertInfo(rule.domain);
  res.json({ ok: true, ...info });
}));

// ---------------------------------------------------------------------------
// Redirection Hosts — domain(s) -> a plain redirect, no backend container.
// Reuses the same cert machinery as proxy rules (self-signed/LE/custom).
// ---------------------------------------------------------------------------
app.get('/api/proxy/redirects', requireAuth, (req, res) => {
  res.json(runtimeConfig.redirectRules || []);
});

app.post('/api/proxy/redirects', requireAdmin, asyncHandler(async (req, res) => {
  const {
    domain, extraDomains, targetUrl, statusCode = 301, preservePath = false,
    enabled = true, cfSync = false, forceSsl = true, http2 = false,
    hstsEnabled = false, hstsSubdomains = false,
  } = req.body || {};
  if (!domain || !targetUrl) return res.status(400).json({ error: 'domain and targetUrl are required' });
  validateDomain(domain.trim());
  let url;
  try { url = new URL(targetUrl.trim()); } catch { const err = new Error('Ungültige Ziel-URL'); err.statusCode = 400; throw err; }
  if (!['http:', 'https:'].includes(url.protocol)) { const err = new Error('Ziel-URL muss mit http:// oder https:// beginnen'); err.statusCode = 400; throw err; }
  const extraDomainsClean = normalizeExtraDomains(extraDomains);
  extraDomainsClean.forEach(validateDomain);

  const redirects = [...(runtimeConfig.redirectRules || [])];
  const id = Date.now().toString(36);
  const rule = {
    id, domain: domain.trim(), extraDomains: extraDomainsClean,
    targetUrl: targetUrl.trim().replace(/\/$/, ''), statusCode: [301, 302].includes(+statusCode) ? +statusCode : 301,
    preservePath: !!preservePath, enabled: !!enabled, cfSync: !!cfSync, cfDnsId: null,
    forceSsl: !!forceSsl, http2: !!http2, hstsEnabled: !!hstsEnabled, hstsSubdomains: !!hstsSubdomains,
    certType: 'self-signed',
  };
  redirects.push(rule);
  saveConfig({ redirectRules: redirects });
  await writeProxyConfigs(runtimeConfig.proxyRules || [], redirects);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Regel gespeichert, Proxy nicht aktualisiert. Bitte Domain und Ziel-URL prüfen.' });
  }
  if (cfSync) cfSyncRule(rule).catch(e => console.warn('[CF]', e.message));
  res.json({ ok: true, id });
}));

app.put('/api/proxy/redirects/:id', requireAdmin, asyncHandler(async (req, res) => {
  const {
    domain, extraDomains, targetUrl, statusCode, preservePath,
    enabled, cfSync, forceSsl, http2, hstsEnabled, hstsSubdomains,
  } = req.body || {};
  const existing = (runtimeConfig.redirectRules || []).find(r => r.id === req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Regel nicht gefunden' });

  const newDomain = domain !== undefined ? domain.trim() : existing.domain;
  const newTargetUrl = targetUrl !== undefined ? targetUrl.trim().replace(/\/$/, '') : existing.targetUrl;
  validateDomain(newDomain);
  try { new URL(newTargetUrl); } catch { const err = new Error('Ungültige Ziel-URL'); err.statusCode = 400; throw err; }
  const newExtraDomains = extraDomains !== undefined ? normalizeExtraDomains(extraDomains) : (existing.extraDomains || []);
  newExtraDomains.forEach(validateDomain);

  let updatedRule;
  const redirects = (runtimeConfig.redirectRules || []).map((r) => {
    if (r.id !== req.params.id) return r;
    updatedRule = {
      ...r,
      domain: newDomain, extraDomains: newExtraDomains, targetUrl: newTargetUrl,
      statusCode: statusCode !== undefined ? ([301, 302].includes(+statusCode) ? +statusCode : 301) : r.statusCode,
      preservePath: preservePath !== undefined ? !!preservePath : r.preservePath,
      enabled: enabled !== undefined ? !!enabled : r.enabled,
      cfSync: cfSync !== undefined ? !!cfSync : r.cfSync,
      forceSsl: forceSsl !== undefined ? !!forceSsl : (r.forceSsl !== false),
      http2: http2 !== undefined ? !!http2 : !!r.http2,
      hstsEnabled: hstsEnabled !== undefined ? !!hstsEnabled : !!r.hstsEnabled,
      hstsSubdomains: hstsSubdomains !== undefined ? !!hstsSubdomains : !!r.hstsSubdomains,
    };
    return updatedRule;
  });
  saveConfig({ redirectRules: redirects });
  await writeProxyConfigs(runtimeConfig.proxyRules || [], redirects);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Änderung gespeichert, Proxy nicht aktualisiert.' });
  }
  if (updatedRule?.cfSync) cfSyncRule(updatedRule).catch(e => console.warn('[CF]', e.message));
  res.json({ ok: true });
}));

app.delete('/api/proxy/redirects/:id', requireAdmin, asyncHandler(async (req, res) => {
  const toDelete = (runtimeConfig.redirectRules || []).find(r => r.id === req.params.id);
  const redirects = (runtimeConfig.redirectRules || []).filter((r) => r.id !== req.params.id);
  saveConfig({ redirectRules: redirects });
  await writeProxyConfigs(runtimeConfig.proxyRules || [], redirects);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Regel gelöscht, Proxy nicht aktualisiert.' });
  }
  if (toDelete?.cfSync) cfDeleteDnsRecord(toDelete).catch(e => console.warn('[CF]', e.message));
  res.json({ ok: true });
}));

app.get('/api/proxy/redirects/:id/cert', requireAuth, (req, res) => {
  const rule = (runtimeConfig.redirectRules || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ ok: false });
  const info = getCertInfo(rule.domain) || {};
  res.json({ ok: true, ...info, certType: rule.certType || 'self-signed' });
});

app.post('/api/proxy/redirects/:id/cert/letsencrypt', requireAdmin, asyncHandler(async (req, res) => {
  const rule = (runtimeConfig.redirectRules || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ ok: false });
  const { cert, key } = certPaths(rule.domain);
  try { fs.unlinkSync(cert); fs.unlinkSync(key); } catch (_) {}
  await requestLECert(rule.domain, allDomainsOf(rule));
  const redirects = (runtimeConfig.redirectRules || []).map(r =>
    r.id === req.params.id ? { ...r, certType: 'letsencrypt' } : r
  );
  saveConfig({ redirectRules: redirects });
  await writeProxyConfigs(runtimeConfig.proxyRules || [], redirects);
  await reloadNginx();
  const info = getCertInfo(rule.domain);
  res.json({ ok: true, ...info });
}));

app.delete('/api/proxy/redirects/:id/cert', requireAdmin, asyncHandler(async (req, res) => {
  const rule = (runtimeConfig.redirectRules || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ ok: false });
  const { dir } = certPaths(rule.domain);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  const redirects = (runtimeConfig.redirectRules || []).map(r =>
    r.id === req.params.id ? { ...r, certType: 'self-signed' } : r
  );
  saveConfig({ redirectRules: redirects });
  await writeProxyConfigs(runtimeConfig.proxyRules || [], redirects);
  await reloadNginx();
  const info = getCertInfo(rule.domain);
  res.json({ ok: true, ...info });
}));

// ---------------------------------------------------------------------------
// 404 Hosts — claim a domain with a real cert but serve nothing on it.
// Same cert machinery as proxy/redirect rules.
// ---------------------------------------------------------------------------
app.get('/api/proxy/404hosts', requireAuth, (req, res) => {
  res.json(runtimeConfig.notFoundHosts || []);
});

app.post('/api/proxy/404hosts', requireAdmin, asyncHandler(async (req, res) => {
  const { domain, extraDomains, enabled = true, http2 = false, hstsEnabled = false, hstsSubdomains = false } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain is required' });
  validateDomain(domain.trim());
  const extraDomainsClean = normalizeExtraDomains(extraDomains);
  extraDomainsClean.forEach(validateDomain);

  const hosts = [...(runtimeConfig.notFoundHosts || [])];
  const id = Date.now().toString(36);
  const rule = {
    id, domain: domain.trim(), extraDomains: extraDomainsClean, enabled: !!enabled,
    http2: !!http2, hstsEnabled: !!hstsEnabled, hstsSubdomains: !!hstsSubdomains,
    certType: 'self-signed',
  };
  hosts.push(rule);
  saveConfig({ notFoundHosts: hosts });
  await writeProxyConfigs(runtimeConfig.proxyRules || [], runtimeConfig.redirectRules || [], hosts);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Regel gespeichert, Proxy nicht aktualisiert.' });
  }
  res.json({ ok: true, id });
}));

app.put('/api/proxy/404hosts/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { domain, extraDomains, enabled, http2, hstsEnabled, hstsSubdomains } = req.body || {};
  const existing = (runtimeConfig.notFoundHosts || []).find(r => r.id === req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Regel nicht gefunden' });

  const newDomain = domain !== undefined ? domain.trim() : existing.domain;
  validateDomain(newDomain);
  const newExtraDomains = extraDomains !== undefined ? normalizeExtraDomains(extraDomains) : (existing.extraDomains || []);
  newExtraDomains.forEach(validateDomain);

  const hosts = (runtimeConfig.notFoundHosts || []).map((r) => {
    if (r.id !== req.params.id) return r;
    return {
      ...r,
      domain: newDomain, extraDomains: newExtraDomains,
      enabled: enabled !== undefined ? !!enabled : r.enabled,
      http2: http2 !== undefined ? !!http2 : !!r.http2,
      hstsEnabled: hstsEnabled !== undefined ? !!hstsEnabled : !!r.hstsEnabled,
      hstsSubdomains: hstsSubdomains !== undefined ? !!hstsSubdomains : !!r.hstsSubdomains,
    };
  });
  saveConfig({ notFoundHosts: hosts });
  await writeProxyConfigs(runtimeConfig.proxyRules || [], runtimeConfig.redirectRules || [], hosts);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Änderung gespeichert, Proxy nicht aktualisiert.' });
  }
  res.json({ ok: true });
}));

app.delete('/api/proxy/404hosts/:id', requireAdmin, asyncHandler(async (req, res) => {
  const hosts = (runtimeConfig.notFoundHosts || []).filter((r) => r.id !== req.params.id);
  saveConfig({ notFoundHosts: hosts });
  await writeProxyConfigs(runtimeConfig.proxyRules || [], runtimeConfig.redirectRules || [], hosts);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Regel gelöscht, Proxy nicht aktualisiert.' });
  }
  res.json({ ok: true });
}));

app.get('/api/proxy/404hosts/:id/cert', requireAuth, (req, res) => {
  const rule = (runtimeConfig.notFoundHosts || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ ok: false });
  const info = getCertInfo(rule.domain) || {};
  res.json({ ok: true, ...info, certType: rule.certType || 'self-signed' });
});

app.post('/api/proxy/404hosts/:id/cert/letsencrypt', requireAdmin, asyncHandler(async (req, res) => {
  const rule = (runtimeConfig.notFoundHosts || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ ok: false });
  const { cert, key } = certPaths(rule.domain);
  try { fs.unlinkSync(cert); fs.unlinkSync(key); } catch (_) {}
  await requestLECert(rule.domain, allDomainsOf(rule));
  const hosts = (runtimeConfig.notFoundHosts || []).map(r =>
    r.id === req.params.id ? { ...r, certType: 'letsencrypt' } : r
  );
  saveConfig({ notFoundHosts: hosts });
  await writeProxyConfigs(runtimeConfig.proxyRules || [], runtimeConfig.redirectRules || [], hosts);
  await reloadNginx();
  const info = getCertInfo(rule.domain);
  res.json({ ok: true, ...info });
}));

app.delete('/api/proxy/404hosts/:id/cert', requireAdmin, asyncHandler(async (req, res) => {
  const rule = (runtimeConfig.notFoundHosts || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ ok: false });
  const { dir } = certPaths(rule.domain);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  const hosts = (runtimeConfig.notFoundHosts || []).map(r =>
    r.id === req.params.id ? { ...r, certType: 'self-signed' } : r
  );
  saveConfig({ notFoundHosts: hosts });
  await writeProxyConfigs(runtimeConfig.proxyRules || [], runtimeConfig.redirectRules || [], hosts);
  await reloadNginx();
  const info = getCertInfo(rule.domain);
  res.json({ ok: true, ...info });
}));

// ---------------------------------------------------------------------------
// Streams — raw TCP/UDP port forwarding (nginx stream{} module). Requires
// Hearth to run with network_mode: host so arbitrary listen ports work.
// ---------------------------------------------------------------------------
function validatePort(n, label = 'Port') {
  const p = parseInt(n, 10);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    const err = new Error(`${label} muss zwischen 1 und 65535 liegen`);
    err.statusCode = 400;
    throw err;
  }
  return p;
}

function checkStreamPortFree(listenPort, protocol, streams, excludeId) {
  const reserved = [PORT, GUEST_PORT, HTTP_PORT, PROXY_PORT];
  if (reserved.includes(listenPort)) {
    const err = new Error(`Port ${listenPort} wird bereits von Hearth selbst verwendet`);
    err.statusCode = 400;
    throw err;
  }
  const collides = (streams || []).some((s) => {
    if (s.id === excludeId || !s.enabled) return false;
    if (s.listenPort !== listenPort) return false;
    return s.protocol === protocol || s.protocol === 'both' || protocol === 'both';
  });
  if (collides) {
    const err = new Error(`Port ${listenPort} wird bereits von einem anderen Stream verwendet`);
    err.statusCode = 400;
    throw err;
  }
}

app.get('/api/proxy/streams', requireAuth, (req, res) => {
  res.json(runtimeConfig.streamRules || []);
});

app.post('/api/proxy/streams', requireAdmin, asyncHandler(async (req, res) => {
  const { name, listenPort, protocol = 'tcp', forwardHost, forwardPort, enabled = true } = req.body || {};
  if (!forwardHost || !String(forwardHost).trim()) return res.status(400).json({ error: 'forwardHost is required' });
  if (!['tcp', 'udp', 'both'].includes(protocol)) return res.status(400).json({ error: 'invalid protocol' });
  const lp = validatePort(listenPort, 'Listen-Port');
  const fp = validatePort(forwardPort, 'Ziel-Port');
  assertNoUnsecuredAdminExposure(fp, enabled);
  const streams = [...(runtimeConfig.streamRules || [])];
  checkStreamPortFree(lp, protocol, streams, null);

  const id = Date.now().toString(36);
  const rule = {
    id, name: (name || '').trim().slice(0, 63), listenPort: lp, protocol,
    forwardHost: forwardHost.trim(), forwardPort: fp, enabled: !!enabled,
  };
  streams.push(rule);
  saveConfig({ streamRules: streams });
  await writeStreamConfigs(streams);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Regel gespeichert, Proxy nicht aktualisiert.' });
  }
  res.json({ ok: true, id });
}));

app.put('/api/proxy/streams/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { name, listenPort, protocol, forwardHost, forwardPort, enabled } = req.body || {};
  const existing = (runtimeConfig.streamRules || []).find(r => r.id === req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Regel nicht gefunden' });

  const newProtocol = protocol !== undefined ? protocol : existing.protocol;
  if (!['tcp', 'udp', 'both'].includes(newProtocol)) return res.status(400).json({ error: 'invalid protocol' });
  const newListenPort  = listenPort  !== undefined ? validatePort(listenPort, 'Listen-Port') : existing.listenPort;
  const newForwardPort = forwardPort !== undefined ? validatePort(forwardPort, 'Ziel-Port')  : existing.forwardPort;
  const newForwardHost = forwardHost !== undefined ? forwardHost.trim() : existing.forwardHost;
  if (!newForwardHost) return res.status(400).json({ error: 'forwardHost is required' });
  const newEnabled = enabled !== undefined ? !!enabled : existing.enabled;
  assertNoUnsecuredAdminExposure(newForwardPort, newEnabled);
  checkStreamPortFree(newListenPort, newProtocol, runtimeConfig.streamRules || [], req.params.id);

  const streams = (runtimeConfig.streamRules || []).map((r) => {
    if (r.id !== req.params.id) return r;
    return {
      ...r,
      name: name !== undefined ? (name || '').trim().slice(0, 63) : r.name,
      listenPort: newListenPort, protocol: newProtocol,
      forwardHost: newForwardHost, forwardPort: newForwardPort,
      enabled: enabled !== undefined ? !!enabled : r.enabled,
    };
  });
  saveConfig({ streamRules: streams });
  await writeStreamConfigs(streams);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Änderung gespeichert, Proxy nicht aktualisiert.' });
  }
  res.json({ ok: true });
}));

app.delete('/api/proxy/streams/:id', requireAdmin, asyncHandler(async (req, res) => {
  const streams = (runtimeConfig.streamRules || []).filter((r) => r.id !== req.params.id);
  saveConfig({ streamRules: streams });
  await writeStreamConfigs(streams);
  const reloadOk = await reloadNginx();
  if (!reloadOk) {
    return res.status(500).json({ ok: false, error: 'Nginx-Reload fehlgeschlagen – Regel gelöscht, Proxy nicht aktualisiert.' });
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Proxy – Traffic Logs
// ---------------------------------------------------------------------------
app.get('/api/proxy/rules/:id/logs', requireAuth, asyncHandler(async (req, res) => {
  const rule = (runtimeConfig.proxyRules || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ ok: false });
  const logFile = path.join(NGINX_LOG_DIR, `hearth-${rule.id}.log`);
  if (!fs.existsSync(logFile)) return res.json({ ok: true, entries: [] });
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).slice(-200).reverse();
  const entries = lines.map(l => {
    const [time, status, method, uri, bytes, ip, ua] = l.split('|');
    return { time, status: parseInt(status) || 0, method, uri, bytes: parseInt(bytes) || 0, ip, ua };
  });
  res.json({ ok: true, entries });
}));

app.get('/api/proxy/rules/:id/stats', requireAuth, asyncHandler(async (req, res) => {
  const rule = (runtimeConfig.proxyRules || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ ok: false });
  const logFile = path.join(NGINX_LOG_DIR, `hearth-${rule.id}.log`);
  if (!fs.existsSync(logFile)) return res.json({ ok: true, total: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 });
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  let s2xx = 0, s3xx = 0, s4xx = 0, s5xx = 0;
  lines.forEach(l => {
    const status = parseInt(l.split('|')[1]) || 0;
    if (status >= 200 && status < 300) s2xx++;
    else if (status >= 300 && status < 400) s3xx++;
    else if (status >= 400 && status < 500) s4xx++;
    else if (status >= 500) s5xx++;
  });
  res.json({ ok: true, total: lines.length, s2xx, s3xx, s4xx, s5xx });
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
// Setup Assistant — guided checks for Reverse Proxy, Firewall, VPN.
// Port reachability can't be verified from inside the same network (NAT
// hairpinning), so external checks go through check-host.net's free public
// API (multiple international vantage points, no auth required).
// ---------------------------------------------------------------------------
function checkHostRequest(pathAndQuery) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'check-host.net',
      path: pathAndQuery,
      headers: { 'Accept': 'application/json' },
      timeout: 8000,
    }, (r) => {
      let d = '';
      r.on('data', (c) => d += c);
      r.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('check-host.net: ungültige Antwort')); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('check-host.net: Zeitüberschreitung')); });
  });
}

async function checkExternalPort(port, proto = 'tcp') {
  const ip = await cfGetPublicIp();
  const type = proto === 'udp' ? 'check-udp' : 'check-tcp';
  const init = await checkHostRequest(`/${type}?host=${ip}:${port}&max_nodes=3`);
  if (!init.ok || !init.request_id) throw new Error('check-host.net: Anfrage fehlgeschlagen');
  // Nodes need a few seconds to actually run the check before results land.
  await new Promise((r) => setTimeout(r, 6000));
  const result = await checkHostRequest(`/check-result/${init.request_id}`);
  let checked = 0, open = 0;
  for (const nodeRes of Object.values(result || {})) {
    if (!Array.isArray(nodeRes) || !nodeRes[0]) continue; // node not ready yet
    checked++;
    if (!nodeRes[0].error) open++;
  }
  return { ip, port, proto, checked, open, ok: checked > 0 && open > 0 };
}

app.get('/api/setup-assistant/proxy', requireAuth, asyncHandler(async (req, res) => {
  const checks = [];
  const nginxRunning = _nginxProc !== null && !_nginxProc.killed;
  checks.push({ id: 'proxyRunning', status: nginxRunning ? 'ok' : 'error' });

  let ip = null;
  try { ip = await cfGetPublicIp(); } catch (_) {}

  const [port80, port443] = await Promise.all([
    ip ? checkExternalPort(80, 'tcp').catch(() => null) : Promise.resolve(null),
    ip ? checkExternalPort(443, 'tcp').catch(() => null) : Promise.resolve(null),
  ]);
  checks.push({ id: 'port80External', status: !ip ? 'warn' : (port80?.ok ? 'ok' : 'error'), data: { ip: ip || '?' } });
  checks.push({ id: 'port443External', status: !ip ? 'warn' : (port443?.ok ? 'ok' : 'error'), data: { ip: ip || '?' } });

  // UFW allow rules for 80/443
  let ufwMissing = ['80', '443'];
  if (await fwAvailable()) {
    try {
      const numbered = await fwExec('ufw status numbered');
      ufwMissing = ['80', '443'].filter((p) => !new RegExp(`\\b${p}\\/tcp\\b[^\\n]*ALLOW`).test(numbered));
    } catch (_) {}
  }
  checks.push({ id: 'ufwPorts', status: ufwMissing.length ? 'warn' : 'ok', data: { detail: ufwMissing.join(', ') } });

  // DNS: do configured domains actually point at this server?
  const allRules = [
    ...(runtimeConfig.proxyRules || []),
    ...(runtimeConfig.redirectRules || []),
    ...(runtimeConfig.notFoundHosts || []),
  ].filter((r) => r.enabled);
  const domains = [...new Set(allRules.flatMap((r) => [r.domain, ...(r.extraDomains || [])]))];
  const usesCloudflare = !!(runtimeConfig.cfApiToken && runtimeConfig.cfZoneId);
  const mismatched = [];
  if (ip && domains.length) {
    await Promise.all(domains.map(async (d) => {
      try {
        const addrs = await dns.resolve4(d);
        if (!addrs.includes(ip)) mismatched.push(d);
      } catch (_) { mismatched.push(d); }
    }));
  }
  checks.push({
    id: 'dnsRecords',
    status: !domains.length || !mismatched.length ? 'ok' : (usesCloudflare ? 'info' : 'warn'),
    data: { ip: ip || '?', detail: mismatched.join(', ') },
  });

  res.json({ checks });
}));

app.get('/api/setup-assistant/firewall', requireAuth, asyncHandler(async (req, res) => {
  const checks = [];
  const available = await fwAvailable();
  checks.push({ id: 'firewallContainerRunning', status: available ? 'ok' : 'error' });

  if (available) {
    const numbered = await fwExec('ufw status numbered').catch(() => '');
    const verbose  = await fwExec('ufw status verbose').catch(() => '');
    checks.push({ id: 'ufwActive', status: verbose.includes('Status: active') ? 'ok' : 'warn' });

    const sshOk = new RegExp(`\\b22\\/tcp\\b[^\\n]*ALLOW`).test(numbered);
    checks.push({ id: 'ufwSsh', status: sshOk ? 'ok' : 'warn' });

    const adminLine = numbered.split('\n').find((l) => l.includes(`${PORT}/tcp`) && /ALLOW/.test(l));
    const adminPublic = !!adminLine && /Anywhere/.test(adminLine);
    checks.push({ id: 'adminPortExposure', status: adminPublic ? 'warn' : 'ok', data: { port: PORT } });
  } else {
    checks.push({ id: 'ufwActive', status: 'error' });
    checks.push({ id: 'ufwSsh', status: 'error' });
    checks.push({ id: 'adminPortExposure', status: 'error', data: { port: PORT } });
  }

  res.json({ checks });
}));

app.get('/api/setup-assistant/vpn', requireAuth, asyncHandler(async (req, res) => {
  const checks = [];
  let running = false;
  try {
    const info = await docker.getContainer(VPN_CONTAINER).inspect();
    running = info.State.Running;
  } catch (_) {}
  checks.push({ id: 'vpnContainerRunning', status: running ? 'ok' : 'error' });

  const vpnPort = parseInt(process.env.VPN_PORT || '51820', 10);

  let ufwOk = false;
  if (await fwAvailable()) {
    const numbered = await fwExec('ufw status numbered').catch(() => '');
    ufwOk = new RegExp(`\\b${vpnPort}\\/udp\\b[^\\n]*ALLOW`).test(numbered);
  }
  checks.push({ id: 'vpnUfwRule', status: ufwOk ? 'ok' : 'warn', data: { port: vpnPort } });

  let peerCount = 0;
  if (running) {
    try {
      const peerList = await vpnExec('ls /config 2>/dev/null | grep "^peer"');
      peerCount = peerList.split('\n').filter(Boolean).length;
    } catch (_) {}
  }
  checks.push({ id: 'vpnPeers', status: peerCount > 0 ? 'ok' : 'warn' });

  let ip = null;
  try { ip = await cfGetPublicIp(); } catch (_) {}
  const udpCheck = ip ? await checkExternalPort(vpnPort, 'udp').catch(() => null) : null;
  checks.push({ id: 'vpnPortExternal', status: udpCheck?.ok ? 'ok' : 'warn', data: { ip: ip || '?', port: vpnPort } });

  res.json({ checks });
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
app.post('/api/cloudflare/verify', requireAdmin, asyncHandler(async (req, res) => {
  const result = await cfFetch('/user/tokens/verify');
  if (result.success) {
    res.json({ ok: true, message: result.result?.status || 'active' });
  } else {
    res.status(400).json({ ok: false, error: result.errors?.[0]?.message || 'Ungültige Credentials' });
  }
}));

// Cloudflare – manual DNS sync for one rule
app.post('/api/cloudflare/dns-sync/:ruleId', requireAdmin, asyncHandler(async (req, res) => {
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
app.delete('/api/cloudflare/dns-sync/:ruleId', requireAdmin, asyncHandler(async (req, res) => {
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

app.post('/api/cloudflare/tunnel/start', requireAdmin, asyncHandler(async (req, res) => {
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
  // dockerode's createContainer, unlike `docker run`, does not auto-pull a
  // missing image — without this the first-ever start fails with
  // "No such image: cloudflare/cloudflared:latest".
  await pullImage('cloudflare/cloudflared:latest');
  const container = await docker.createContainer({
    name: CF_TUNNEL_CONTAINER,
    Image: 'cloudflare/cloudflared:latest',
    Cmd: ['tunnel', '--no-autoupdate', 'run', '--token', token],
    // hearth.self marks this as Hearth-managed infra (excludes it from the
    // "N containers running" user-app count, same as vpn/firewall). The
    // self-update "find the main hearth container" lookup would otherwise
    // match this too (same hearth.self=true + name containing "hearth"), so
    // its exclusion list explicitly excludes "cloudflared" as well.
    Labels: { 'hearth.hide': 'true', 'hearth.self': 'true' },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'host' },
  });
  await container.start();
  res.json({ ok: true });
}));

app.post('/api/cloudflare/tunnel/stop', requireAdmin, asyncHandler(async (req, res) => {
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
    const ruleLines = numbered.split('\n').filter((l) => /^\[/.test(l.trim()));
    const ufwRules = ruleLines.map((l) => {
      const m = l.match(/\[\s*(\d+)\]\s+(.+?)\s+(ALLOW|DENY|LIMIT)\s+(IN|OUT|FWD)?\s*(.*)/i);
      if (!m) return null;
      const comment = (l.match(/# (.+)$/) || [])[1] || '';
      const hearthId = (comment.match(/hearth-rule-(\S+)/) || [])[1] || null;
      return { num: parseInt(m[1]), to: m[2].trim(), action: m[3].toUpperCase(), dir: (m[4] || 'IN').toUpperCase(), from: (m[5] || 'Anywhere').trim().replace(/#.*$/, '').trim(), comment, hearthId };
    }).filter(Boolean);
    // Merge stored Hearth rules (preserve order + metadata) with live UFW data
    const stored = runtimeConfig.firewallRules || [];
    const aliases = runtimeConfig.firewallAliases || [];
    res.json({ available: true, active, raw: verbose, rules: ufwRules, stored, aliases });
  } catch (e) {
    res.status(500).json({ available: true, error: e.message });
  }
}));

app.post('/api/firewall/rules', requireAdmin, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const { action, port, proto = 'any', from = 'any', to = 'any', direction = 'in', iface = '', comment = '' } = req.body || {};
  if (!action || !port) return res.status(400).json({ error: 'action and port are required' });
  if (!isValidEndpoint(from)) return res.status(400).json({ error: `Invalid source: ${from}` });
  if (!isValidEndpoint(to))   return res.status(400).json({ error: `Invalid destination: ${to}` });
  if (!isValidPortSpec(port)) return res.status(400).json({ error: `Invalid port: ${port}` });
  const id = Date.now().toString(36);
  const rule = { id, action, port, proto, from, to, direction, iface, comment, enabled: true };
  const cmds = buildUfwCmds(rule, runtimeConfig.firewallAliases || []);
  const rules = [...(runtimeConfig.firewallRules || []), rule];
  saveConfig({ firewallRules: rules });
  for (const cmd of cmds) await fwExec(cmd);
  res.json({ ok: true, id, rules });
}));

app.put('/api/firewall/rules/reorder', requireAdmin, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const current = runtimeConfig.firewallRules || [];
  const reordered = ids.map(id => current.find(r => r.id === id)).filter(Boolean);
  saveConfig({ firewallRules: reordered });
  const warnings = await syncFirewallRules(reordered);
  res.json({ ok: true, warnings });
}));

app.put('/api/firewall/rules/:id', requireAdmin, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const { action, port, proto = 'any', from = 'any', to = 'any', direction = 'in', iface = '', comment = '' } = req.body || {};
  if (!isValidEndpoint(from)) return res.status(400).json({ error: `Invalid source: ${from}` });
  if (!isValidEndpoint(to))   return res.status(400).json({ error: `Invalid destination: ${to}` });
  if (!isValidPortSpec(port)) return res.status(400).json({ error: `Invalid port: ${port}` });
  const rules = runtimeConfig.firewallRules || [];
  const idx = rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Rule not found' });
  rules[idx] = { ...rules[idx], action, port, proto, from, to, direction, iface, comment };
  saveConfig({ firewallRules: rules });
  const warnings = await syncFirewallRules(rules);
  res.json({ ok: true, warnings });
}));

app.patch('/api/firewall/rules/:id/toggle', requireAdmin, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const rules = runtimeConfig.firewallRules || [];
  const rule = rules.find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  rule.enabled = rule.enabled === false ? true : false;
  saveConfig({ firewallRules: rules });
  const warnings = await syncFirewallRules(rules);
  res.json({ ok: true, enabled: rule.enabled !== false, warnings });
}));

app.delete('/api/firewall/rules/:id', requireAdmin, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const rules = (runtimeConfig.firewallRules || []).filter(r => r.id !== req.params.id);
  saveConfig({ firewallRules: rules });
  const warnings = await syncFirewallRules(rules);
  res.json({ ok: true, warnings });
}));

// Legacy: delete by UFW rule number (expert mode + auto-rules)
app.delete('/api/firewall/rules/num/:num', requireAdmin, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const num = parseInt(req.params.num, 10);
  if (!Number.isInteger(num) || num < 1) return res.status(400).json({ error: 'Invalid rule number' });
  const result = await fwExec(`echo y | ufw delete ${num}`);
  res.json({ ok: true, result });
}));

app.post('/api/firewall/toggle', requireAdmin, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const { enable } = req.body || {};
  const result = await fwExec(enable ? 'ufw --force enable' : 'ufw disable');
  res.json({ ok: true, result });
}));

app.get('/api/firewall/logs', requireAuth, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const lines = Math.min(parseInt(req.query.lines) || 100, 500);
  const raw = await fwExec(
    `tail -n ${lines} /var/log/ufw.log 2>/dev/null || dmesg 2>/dev/null | grep -i UFW | tail -n ${lines} || echo ""`
  ).catch(() => '');
  const entries = raw.split('\n').filter(l => l.includes('UFW')).map(l => {
    const action = (l.match(/\[UFW\s+(\w+)\]/) || l.match(/UFW\s+(\w+)/) || [])[1] || 'UNKNOWN';
    const src    = (l.match(/SRC=([\d.:a-fA-F]+)/) || [])[1] || '';
    const dst    = (l.match(/DST=([\d.:a-fA-F]+)/) || [])[1] || '';
    const proto  = (l.match(/PROTO=(\w+)/) || [])[1] || '';
    const dpt    = (l.match(/DPT=(\d+)/) || [])[1] || '';
    const spt    = (l.match(/SPT=(\d+)/) || [])[1] || '';
    const iface  = (l.match(/IN=(\S+)/) || [])[1] || '';
    const time   = (l.match(/^(\w+\s+\d+\s+[\d:]+)/) || [])[1] || '';
    return { time, action, src, dst, proto, dpt, spt, iface };
  }).filter(e => e.src);
  res.json({ ok: true, entries: entries.reverse() });
}));

// ---------------------------------------------------------------------------
// Firewall-Aliases (named, reusable IP/network or port lists)
// ---------------------------------------------------------------------------
function _fwCleanAliasInput(body, existingKind) {
  const name = String(body?.name || '').trim();
  const kind = existingKind || (body?.kind === 'port' ? 'port' : 'network');
  if (!ALIAS_NAME_RE.test(name)) throw fwError('Alias name must be alphanumeric (with - or _), no spaces');
  const members = [...new Set((Array.isArray(body?.members) ? body.members : []).map(m => String(m).trim()).filter(Boolean))];
  if (!members.length) throw fwError('At least one member is required');
  const bad = members.find(m => !isValidAliasMember(m, kind));
  if (bad) throw fwError(`Invalid ${kind} member: ${bad}`);
  return { name, kind, members };
}

app.post('/api/firewall/aliases', requireAdmin, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const { name, kind, members } = _fwCleanAliasInput(req.body);
  const aliases = runtimeConfig.firewallAliases || [];
  if (aliases.some(a => a.kind === kind && a.name === name)) {
    return res.status(409).json({ error: `Alias @${name} already exists` });
  }
  const id = Date.now().toString(36);
  saveConfig({ firewallAliases: [...aliases, { id, name, kind, members }] });
  res.json({ ok: true, id, aliases: runtimeConfig.firewallAliases });
}));

app.put('/api/firewall/aliases/:id', requireAdmin, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const aliases = runtimeConfig.firewallAliases || [];
  const idx = aliases.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Alias not found' });
  const { name, kind, members } = _fwCleanAliasInput(req.body, aliases[idx].kind);
  if (aliases.some((a, i) => i !== idx && a.kind === kind && a.name === name)) {
    return res.status(409).json({ error: `Alias @${name} already exists` });
  }
  aliases[idx] = { ...aliases[idx], name, members };
  saveConfig({ firewallAliases: aliases });
  const warnings = await syncFirewallRules(runtimeConfig.firewallRules || []);
  res.json({ ok: true, warnings });
}));

app.delete('/api/firewall/aliases/:id', requireAdmin, asyncHandler(async (req, res) => {
  const aliases = runtimeConfig.firewallAliases || [];
  const alias = aliases.find(a => a.id === req.params.id);
  if (!alias) return res.status(404).json({ error: 'Alias not found' });
  const token = `@${alias.name}`;
  const usedBy = (runtimeConfig.firewallRules || []).filter(r => r.from === token || r.to === token || String(r.port) === token);
  if (usedBy.length) {
    return res.status(409).json({
      error: `Alias @${alias.name} is used by ${usedBy.length} rule(s)`,
      rules: usedBy.map(r => ({ id: r.id, comment: r.comment })),
    });
  }
  saveConfig({ firewallAliases: aliases.filter(a => a.id !== req.params.id) });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Firewall Export/Import
// ---------------------------------------------------------------------------
app.get('/api/firewall/export', requireAuth, asyncHandler(async (req, res) => {
  res.json({
    version: 1,
    exportedAt: new Date().toISOString(),
    rules: runtimeConfig.firewallRules || [],
    aliases: runtimeConfig.firewallAliases || [],
  });
}));

app.post('/api/firewall/import', requireAdmin, asyncHandler(async (req, res) => {
  if (!await fwAvailable()) return res.status(503).json({ error: 'Firewall container not available' });
  const { mode = 'replace', rules = [], aliases = [] } = req.body || {};
  if (!Array.isArray(rules) || !Array.isArray(aliases)) {
    return res.status(400).json({ error: 'rules and aliases must be arrays' });
  }

  const cleanAliases = aliases.map(a => {
    const { name, kind, members } = _fwCleanAliasInput(a);
    return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, kind, members };
  });
  const cleanRules = rules.map(r => {
    const rule = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      action: r.action, port: r.port, proto: r.proto || 'any',
      from: r.from || 'any', to: r.to || 'any', direction: r.direction || 'in',
      iface: r.iface || '', comment: r.comment || '', enabled: r.enabled !== false,
    };
    if (!rule.action || !rule.port) throw fwError('Each rule requires action and port');
    if (!isValidEndpoint(rule.from)) throw fwError(`Invalid source: ${rule.from}`);
    if (!isValidEndpoint(rule.to))   throw fwError(`Invalid destination: ${rule.to}`);
    if (!isValidPortSpec(rule.port)) throw fwError(`Invalid port: ${rule.port}`);
    return rule;
  });

  let finalAliases, finalRules;
  if (mode === 'merge') {
    const existingAliases = runtimeConfig.firewallAliases || [];
    const newAliases = cleanAliases.filter(a => !existingAliases.some(e => e.kind === a.kind && e.name === a.name));
    finalAliases = [...existingAliases, ...newAliases];
    finalRules = [...(runtimeConfig.firewallRules || []), ...cleanRules];
  } else {
    finalAliases = cleanAliases;
    finalRules = cleanRules;
  }

  saveConfig({ firewallAliases: finalAliases, firewallRules: finalRules });
  const warnings = await syncFirewallRules(finalRules);
  res.json({ ok: true, rules: finalRules, aliases: finalAliases, warnings });
}));

// ---------------------------------------------------------------------------
// Einstellungen (Admin)
// ---------------------------------------------------------------------------
app.get('/api/lang', (req, res) => {
  res.json({ lang: runtimeConfig.lang || 'de', guestPort: !!req.fromGuestPort });
});

function _readHostHostname() {
  try { return fs.readFileSync('/host/etc/hostname', 'utf8').trim(); } catch (_) {}
  try { return fs.readFileSync('/etc/hostname', 'utf8').trim(); } catch (_) {}
  return os.hostname();
}

app.get('/api/settings', requireAuth, (req, res) => {
  const sysHostname = _readHostHostname();
  const isAdmin = req.session?.role === 'admin';
  res.json({
    serverName: runtimeConfig.serverName,
    hostname: sysHostname,
    adminUser:  runtimeConfig.adminUser,
    lang:       runtimeConfig.lang || 'en',
    showOfflineApps:  !!runtimeConfig.showOfflineApps,
    refreshInterval:  runtimeConfig.refreshInterval ?? 15,
    autoUpdate:   runtimeConfig.autoUpdate ?? { enabled: true, hour: 0, minute: 0 },
    updateBranch: runtimeConfig.updateBranch || 'main',
    port:        PORT,
    guestPort:   GUEST_PORT,
    configPort:      runtimeConfig.configPort      || PORT,
    configGuestPort: runtimeConfig.configGuestPort || GUEST_PORT,
    proxyPort:   PROXY_PORT,
    httpPort:    HTTP_PORT,
    configHttpPort:  runtimeConfig.configHttpPort  || HTTP_PORT,
    configProxyPort: runtimeConfig.configProxyPort || PROXY_PORT,
    dockerSocket: DOCKER_SOCKET,
    filesRoot:   FILES_ROOT,
    filesRootFull: FILES_ROOT === '/host',
    dataDir:     DATA_DIR,
    version:     VERSION,
    // Secrets — only ever sent to admins, never to viewer-role accounts.
    cfApiToken:       isAdmin ? (runtimeConfig.cfApiToken || '') : '',
    cfZoneId:         isAdmin ? (runtimeConfig.cfZoneId || '') : '',
    cfTunnelToken:    isAdmin ? (runtimeConfig.cfTunnelToken || '') : '',
    serverPublicIp:   runtimeConfig.serverPublicIp || '',
    autoUpdateLinux:        runtimeConfig.autoUpdateLinux ?? { enabled: false },
    notifArchiveMax:        runtimeConfig.notifArchiveMax  || 500,
    containerAutoUpdates:   runtimeConfig.containerAutoUpdates || {},
  });
});

app.post(
  '/api/settings',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const {
      serverName, lang, showOfflineApps, refreshInterval, autoUpdate, updateBranch,
      cfApiToken, cfZoneId, cfTunnelToken, serverPublicIp, configPort, configGuestPort,
      configHttpPort, configProxyPort, filesRootFull,
    } = req.body || {};
    const updates = {};

    if (serverName !== undefined) {
      const cleanName = (serverName || '').trim().replace(/[^a-zA-Z0-9-]/g, '').slice(0, 63) || 'hearth';
      updates.serverName = cleanName;
      // Apply to host system asynchronously
      const cmd = `docker run --rm --privileged --pid=host ${_hearthImage} ` +
        `sh -c "nsenter -t 1 -m -u -n -i -- sh -c 'printf %s ${cleanName} > /etc/hostname && hostname ${cleanName}'" 2>&1`;
      exec(cmd, err => { if (err) console.warn('[hostname] change failed:', err.message); });
    }
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
    if (configPort !== undefined) {
      const p = parseInt(configPort, 10);
      if (p >= 1 && p <= 65535) updates.configPort = p;
    }
    if (configGuestPort !== undefined) {
      const p = parseInt(configGuestPort, 10);
      if (p >= 1 && p <= 65535) updates.configGuestPort = p;
    }
    if (configHttpPort !== undefined) {
      const p = parseInt(configHttpPort, 10);
      if (p >= 1 && p <= 65535) updates.configHttpPort = p;
    }
    if (configProxyPort !== undefined) {
      const p = parseInt(configProxyPort, 10);
      if (p >= 1 && p <= 65535) updates.configProxyPort = p;
    }
    // Only ever toggles between the two paths docker-compose.yml actually
    // mounts (/mnt/data is always available; /host requires the `- /:/host`
    // volume, already present unconditionally) — persisted here so it
    // survives regardless of what .env ends up containing after an update.
    if (filesRootFull !== undefined) {
      updates.configFilesRoot = filesRootFull ? '/host' : '/mnt/data';
    }
    if (cfApiToken !== undefined) updates.cfApiToken = (cfApiToken || '').trim();
    if (cfZoneId !== undefined) updates.cfZoneId = (cfZoneId || '').trim();
    if (cfTunnelToken !== undefined) updates.cfTunnelToken = (cfTunnelToken || '').trim();
    if (serverPublicIp !== undefined) updates.serverPublicIp = (serverPublicIp || '').trim();
    const { autoUpdateLinux } = req.body || {};
    if (autoUpdateLinux && typeof autoUpdateLinux === 'object') {
      updates.autoUpdateLinux = { enabled: !!autoUpdateLinux.enabled };
    }
    const { containerAutoUpdates } = req.body || {};
    if (containerAutoUpdates && typeof containerAutoUpdates === 'object') {
      const cleaned = {};
      for (const [name, cfg] of Object.entries(containerAutoUpdates)) {
        if (typeof name === 'string' && name.length < 256 && cfg && typeof cfg === 'object') {
          cleaned[name] = {
            enabled: !!cfg.enabled,
            hour:    Math.max(0, Math.min(23, parseInt(cfg.hour)   || 0)),
            minute:  Math.max(0, Math.min(59, parseInt(cfg.minute) || 0)),
          };
        }
      }
      updates.containerAutoUpdates = cleaned;
    }

    saveConfig(updates);
    if (updates.autoUpdate) scheduleNightlyUpdate();
    res.json({ ok: true });
  })
);

app.post('/api/system/restart', requireAdmin, (req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 400);
});

app.post('/api/system/reboot', requireAdmin, asyncHandler(async (req, res) => {
  res.json({ ok: true });
  setTimeout(() => {
    exec('docker run --rm --privileged --pid=host alpine sh -c "nsenter -t 1 -m -u -n -i -- reboot" 2>&1', () => {});
  }, 500);
}));

app.post('/api/system/shutdown', requireAdmin, asyncHandler(async (req, res) => {
  res.json({ ok: true });
  setTimeout(() => {
    exec('docker run --rm --privileged --pid=host alpine sh -c "nsenter -t 1 -m -u -n -i -- halt -p" 2>&1', () => {});
  }, 500);
}));

// Terminal: issue a one-time token the WebSocket handshake validates
app.post('/api/terminal/token', requireAdmin, (req, res) => {
  const { username } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_.-]{1,64}$/.test(username)) {
    return res.status(400).json({ error: 'Ungültiger Benutzername' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  _termTokens.set(token, { username, ts: Date.now() });
  // Expire after 30 s
  setTimeout(() => _termTokens.delete(token), 30000);
  res.json({ token });
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
  const { adminUser, adminPassword, serverName, lang } = req.body || {};
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
    ...(lang ? { lang } : {}),
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Auth-Routen
// ---------------------------------------------------------------------------
app.post('/api/login', asyncHandler(async (req, res) => {
  if (_isRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts — try again in a few minutes' });
  }
  const { username, password, rememberMe } = req.body || {};
  const users = runtimeConfig.users || [];
  const user  = users.find(u => u.username === username);
  if (!user) { _registerFailedAttempt(req.ip); return res.status(401).json({ error: 'Invalid username or password' }); }

  const passOk = await bcrypt.compare(String(password || ''), user.password);
  if (!passOk) { _registerFailedAttempt(req.ip); return res.status(401).json({ error: 'Invalid username or password' }); }
  _clearRateLimit(req.ip);

  if (user.totp_enabled && user.totp_secret) {
    req.session.pending2fa = username;
    req.session.pending2faRememberMe = !!rememberMe;
    return res.json({ pending: '2fa' });
  }

  req.session.regenerate(() => {
    req.session.authed = true;
    req.session.user   = username;
    req.session.role   = user.role;
    if (rememberMe) req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000;
    res.json({ ok: true, role: user.role });
  });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------------------------------------------------------------------------
// 2FA / TOTP
// ---------------------------------------------------------------------------

app.get('/api/2fa/status', requireAuthOrSetupAccess, (req, res) => {
  const user = (runtimeConfig.users || []).find(u => u.username === effectiveUsername(req));
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ enabled: !!(user.totp_enabled && user.totp_secret) });
});

app.post('/api/2fa/setup', requireAuthOrSetupAccess, asyncHandler(async (req, res) => {
  const user = (runtimeConfig.users || []).find(u => u.username === effectiveUsername(req));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(user.username, runtimeConfig.serverName || 'Hearth', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
  req.session.pending_totp_secret = secret;
  res.json({ secret, qrDataUrl });
}));

app.post('/api/2fa/enable', requireAuthOrSetupAccess, asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token required' });
  const secret = req.session.pending_totp_secret;
  if (!secret) return res.status(400).json({ error: 'No pending setup. Call /api/2fa/setup first.' });
  if (!authenticator.verify({ token: String(token), secret }))
    return res.status(401).json({ error: 'Invalid token' });
  const users = runtimeConfig.users || [];
  const user  = users.find(u => u.username === effectiveUsername(req));
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.totp_secret  = secret;
  user.totp_enabled = true;
  delete req.session.pending_totp_secret;
  saveConfig({ users });

  // Setup-access is a one-shot bootstrap: burn it once this account has
  // both factors, so it can't be reused, and hand the frontend a signal to
  // redirect to the real login instead of granting a session directly —
  // that also proves the new passkey+2FA combo actually works end to end.
  let setupComplete = false;
  if (req.session.setupAccessUser && (user.passkeys || []).length > 0) {
    _tapKey = null;
    delete req.session.setupAccessUser;
    setupComplete = true;
  }
  res.json({ ok: true, setupComplete });
}));

app.post('/api/2fa/disable', requireAuth, asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token required' });
  const users = runtimeConfig.users || [];
  const user  = users.find(u => u.username === req.session.user);
  if (!user)              return res.status(404).json({ error: 'User not found' });
  if (!user.totp_enabled) return res.status(400).json({ error: '2FA is not enabled' });
  if (!authenticator.verify({ token: String(token), secret: user.totp_secret }))
    return res.status(401).json({ error: 'Invalid token' });
  user.totp_secret  = null;
  user.totp_enabled = false;
  saveConfig({ users });
  res.json({ ok: true });
}));

app.post('/api/2fa/verify', asyncHandler(async (req, res) => {
  if (_isRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts — try again in a few minutes' });
  }
  const pendingUser = req.session.pending2fa;
  if (!pendingUser) return res.status(400).json({ error: 'No pending 2FA login' });
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token required' });
  const user = (runtimeConfig.users || []).find(u => u.username === pendingUser);
  if (!user || !user.totp_enabled) return res.status(400).json({ error: 'Invalid state' });
  if (!authenticator.verify({ token: String(token), secret: user.totp_secret })) {
    _registerFailedAttempt(req.ip);
    return res.status(401).json({ error: 'Invalid code' });
  }
  _clearRateLimit(req.ip);
  const remember = !!req.session.pending2faRememberMe;
  req.session.regenerate(() => {
    req.session.authed = true;
    req.session.user   = user.username;
    req.session.role   = user.role;
    if (remember) req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000;
    res.json({ ok: true, role: user.role });
  });
}));

// ---------------------------------------------------------------------------
// TAP-Key — bootstraps passkey+2FA setup for a NEW domain from the guest
// port, without ever exposing password login there. A passkey is scoped to
// the exact origin it was created on (WebAuthn's RP ID), so a passkey made
// on the LAN admin panel can't be used to log into e.g. a Reverse Proxy
// domain pointed at the guest port — but that domain's /login has password
// auth hidden by design once secured, so there'd be no way in to register
// a domain-scoped passkey at all. A TAP-Key, generated from an already-
// authenticated session, grants a narrow one-time "setup session"
// (req.session.setupAccessUser, NOT req.session.authed) that only the
// passkey-registration and 2FA-setup endpoints above accept — nothing else
// — and is burned the moment that account has both a passkey and 2FA.
// ---------------------------------------------------------------------------
let _tapKey = null; // { token, username, createdAt, expiresAt, attempts }

const TAPKEY_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford-ish, no 0/O or 1/I/L mixups
function generateTapKeyToken() {
  const bytes = crypto.randomBytes(20);
  let raw = '';
  for (let i = 0; i < 20; i++) raw += TAPKEY_CHARS[bytes[i] % TAPKEY_CHARS.length];
  return raw.match(/.{1,4}/g).join('-');
}
function normalizeTapKeyInput(s) {
  return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

app.get('/api/security/tap-key', requireAdmin, (req, res) => {
  if (!_tapKey || _tapKey.expiresAt < Date.now()) return res.json({ active: false });
  res.json({ active: true, expiresAt: _tapKey.expiresAt, forUsername: _tapKey.username });
});

app.post('/api/security/tap-key', requireAdmin, (req, res) => {
  const token = generateTapKeyToken();
  _tapKey = {
    token,
    username: req.session.user,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    attempts: 0,
  };
  res.json({ token, expiresAt: _tapKey.expiresAt });
});

app.delete('/api/security/tap-key', requireAdmin, (req, res) => {
  _tapKey = null;
  res.json({ ok: true });
});

// Public/unauthenticated on purpose (no code, username, or expiry — just a
// bool) so the login page can decide whether to surface the "Zugang
// aktivieren" entry point at all, and the guest-port block page can redirect
// straight to /setup-access instead of dead-ending visitors who arrive with
// a TAP-Key but no way to use it yet.
app.get('/api/setup-access/status', (req, res) => {
  res.json({ active: !!(_tapKey && _tapKey.expiresAt > Date.now()) });
});

app.post('/api/setup-access/verify', asyncHandler(async (req, res) => {
  if (!_tapKey || _tapKey.expiresAt < Date.now()) {
    _tapKey = null;
    return res.status(400).json({ error: 'Kein aktiver Setup-Code.' });
  }
  if (_tapKey.attempts >= 10) {
    _tapKey = null;
    return res.status(429).json({ error: 'Zu viele Versuche — Code wurde ungültig gemacht.' });
  }
  _tapKey.attempts++;
  const input  = Buffer.from(normalizeTapKeyInput(req.body?.code));
  const actual = Buffer.from(normalizeTapKeyInput(_tapKey.token));
  const match  = input.length === actual.length && crypto.timingSafeEqual(input, actual);
  if (!match) return res.status(401).json({ error: 'Ungültiger Code.' });
  req.session.setupAccessUser = _tapKey.username;
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Local HTTPS for the admin panel (self-signed, LAN IP) — WebAuthn/Passkeys
// require a secure context (HTTPS or localhost), which a plain-HTTP admin
// panel reached via its LAN IP never satisfies, so there'd otherwise be no
// way to register a passkey without exposing the panel through the
// Reverse Proxy first — exactly the thing the passkey gate is meant to
// require before that's allowed.
// ---------------------------------------------------------------------------
let _adminHttpsServer = null;

function startAdminHttpsServer() {
  if (_adminHttpsServer) return true;
  if (!certExists(ADMIN_LOCAL_CERT_KEY)) return false;
  const { cert, key } = certPaths(ADMIN_LOCAL_CERT_KEY);
  try {
    _adminHttpsServer = https
      .createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, app)
      .listen(ADMIN_HTTPS_PORT, () => {
        console.log(`\x1b[32m✓ Admin (HTTPS) https://localhost:${ADMIN_HTTPS_PORT}/admin\x1b[0m`);
      });
    return true;
  } catch (e) {
    console.warn('[HTTPS] Admin-HTTPS-Server konnte nicht gestartet werden:', e.message);
    _adminHttpsServer = null;
    return false;
  }
}

app.get('/api/security/local-https', requireAuth, (req, res) => {
  res.json({
    enabled: certExists(ADMIN_LOCAL_CERT_KEY),
    port: ADMIN_HTTPS_PORT,
    host: runtimeConfig.localHttpsHost || '',
    // WebAuthn rejects bare IPs as an RP ID, so passkeys need a real
    // hostname — <server-name>.local, resolvable via the mDNS (avahi)
    // Hearth sets up automatically on the host at boot.
    suggestedHost: `${_readHostHostname()}.local`,
  });
});

app.post('/api/security/local-https', requireAdmin, asyncHandler(async (req, res) => {
  const host = String(req.body?.host || '').trim();
  if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    return res.status(400).json({ error: 'Gültiger Hostname oder IP erforderlich' });
  }
  await generateSelfSignedCert(ADMIN_LOCAL_CERT_KEY, [host, 'localhost', '127.0.0.1'], true);
  saveConfig({ localHttpsHost: host });
  const started = startAdminHttpsServer();
  res.json({ ok: true, port: ADMIN_HTTPS_PORT, url: `https://${host}:${ADMIN_HTTPS_PORT}/admin`, started });
}));

// Download the cert (not the key) so it can be imported into the OS/browser
// trust store — once trusted there, the browser accepts it without the
// per-visit warning, since it's now verifying against a certificate it
// already knows rather than an unknown one signed by nobody.
app.get('/api/security/local-https/cert', requireAuth, (req, res) => {
  if (!certExists(ADMIN_LOCAL_CERT_KEY)) return res.status(404).json({ error: 'Kein Zertifikat vorhanden' });
  const { cert } = certPaths(ADMIN_LOCAL_CERT_KEY);
  res.setHeader('Content-Disposition', 'attachment; filename="hearth-local.crt"');
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.sendFile(cert);
});

// ---------------------------------------------------------------------------
// Passkeys / WebAuthn
// ---------------------------------------------------------------------------

function _webauthnOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const rpID  = host.split(':')[0];
  return { origin: `${proto}://${host}`, rpID };
}

app.get('/api/passkeys', requireAuth, (req, res) => {
  const user = (runtimeConfig.users || []).find(u => u.username === req.session.user);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json((user.passkeys || []).map(pk => ({ id: pk.id, name: pk.name, createdAt: pk.createdAt, transports: pk.transports })));
});

app.post('/api/passkey/register-options', requireAuthOrSetupAccess, asyncHandler(async (req, res) => {
  const user = (runtimeConfig.users || []).find(u => u.username === effectiveUsername(req));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { rpID } = _webauthnOrigin(req);
  const options = await generateRegistrationOptions({
    rpName: runtimeConfig.serverName || 'Hearth',
    rpID,
    userID:      user.username,
    userName:    user.username,
    attestationType: 'none',
    excludeCredentials: (user.passkeys || []).map(pk => ({ id: pk.id, type: 'public-key', transports: pk.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  req.session.webauthn_reg_challenge = options.challenge;
  req.session.webauthn_rp_id         = rpID;
  res.json(options);
}));

app.post('/api/passkey/register-verify', requireAuthOrSetupAccess, asyncHandler(async (req, res) => {
  const challenge = req.session.webauthn_reg_challenge;
  const rpID      = req.session.webauthn_rp_id;
  if (!challenge || !rpID) return res.status(400).json({ error: 'No pending registration' });
  const { name, ...regResponse } = req.body || {};
  const { origin } = _webauthnOrigin(req);
  let verification;
  try {
    verification = await verifyRegistrationResponse({ response: regResponse, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });
  const { credentialID, credentialPublicKey, counter, transports } = verification.registrationInfo;
  const users = runtimeConfig.users || [];
  const user  = users.find(u => u.username === effectiveUsername(req));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.passkeys) user.passkeys = [];
  user.passkeys.push({
    id:        Buffer.from(credentialID).toString('base64url'),
    publicKey: Buffer.from(credentialPublicKey).toString('base64'),
    counter,
    transports: transports || [],
    name:      (name || 'Passkey').trim().slice(0, 50),
    createdAt: new Date().toISOString(),
  });
  delete req.session.webauthn_reg_challenge;
  delete req.session.webauthn_rp_id;
  saveConfig({ users });
  res.json({ ok: true });
}));

app.post('/api/passkey/auth-options', asyncHandler(async (req, res) => {
  const { username } = req.body || {};
  const { rpID } = _webauthnOrigin(req);
  let allowCredentials = [];
  if (username) {
    const user = (runtimeConfig.users || []).find(u => u.username === username);
    if (user?.passkeys?.length)
      allowCredentials = user.passkeys.map(pk => ({ id: pk.id, type: 'public-key', transports: pk.transports }));
  }
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred', allowCredentials });
  req.session.webauthn_auth_challenge = options.challenge;
  req.session.webauthn_auth_rp_id     = rpID;
  res.json(options);
}));

app.post('/api/passkey/auth-verify', asyncHandler(async (req, res) => {
  const challenge = req.session.webauthn_auth_challenge;
  const rpID      = req.session.webauthn_auth_rp_id;
  if (!challenge || !rpID) return res.status(400).json({ error: 'No pending authentication' });
  const { origin } = _webauthnOrigin(req);
  const body = req.body || {};
  let matchedUser = null, matchedKey = null;
  for (const u of runtimeConfig.users || []) {
    const pk = (u.passkeys || []).find(k => k.id === body.id);
    if (pk) { matchedUser = u; matchedKey = pk; break; }
  }
  if (!matchedUser || !matchedKey) return res.status(400).json({ error: 'Passkey not found' });
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      authenticator: {
        credentialID:        Buffer.from(matchedKey.id, 'base64url'),
        credentialPublicKey: Buffer.from(matchedKey.publicKey, 'base64'),
        counter:             matchedKey.counter,
        transports:          matchedKey.transports,
      },
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });
  matchedKey.counter = verification.authenticationInfo.newCounter;
  saveConfig({ users: runtimeConfig.users });
  delete req.session.webauthn_auth_challenge;
  delete req.session.webauthn_auth_rp_id;
  // On the guest port, passkey alone isn't the full login — it's meant to
  // replace the password step, not stand in for both factors. Since
  // isAdminAccessSecured() already requires every admin to have 2FA before
  // this port can reach /login at all, matchedUser.totp_enabled will
  // normally be true here; the check is just a safety net.
  if (req.fromGuestPort && matchedUser.totp_enabled) {
    req.session.pending2fa = matchedUser.username;
    return res.json({ pending: '2fa' });
  }
  req.session.authed = true;
  req.session.user   = matchedUser.username;
  req.session.role   = matchedUser.role;
  res.json({ ok: true, role: matchedUser.role });
}));

app.delete('/api/passkey/:id', requireAuth, (req, res) => {
  const users = runtimeConfig.users || [];
  const user  = users.find(u => u.username === req.session.user);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const before = (user.passkeys || []).length;
  user.passkeys = (user.passkeys || []).filter(pk => pk.id !== req.params.id);
  if (user.passkeys.length === before) return res.status(404).json({ error: 'Passkey not found' });
  saveConfig({ users });
  res.json({ ok: true });
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
// Stacks – Preset-Definitionen + API
// ---------------------------------------------------------------------------

const STACK_PRESETS = [
  {
    id: 'media',
    name: 'Medien-Stack',
    icon: '🎬',
    description: 'Vollständiger Medienserver: Jellyfin zum Streamen, Sonarr für Serien, Radarr für Filme, SABnzbd zum Herunterladen und Prowlarr als Indexer-Manager.',
    services: [
      {
        key: 'jellyfin', name: 'Jellyfin', description: 'Open-Source Medienserver',
        image: 'jellyfin/jellyfin', matchImages: ['jellyfin/jellyfin'], matchNames: ['jellyfin'],
        ports: [{ host: '8096', container: '8096' }],
        volumes: [
          { host: '{config}/jellyfin', container: '/config' },
          { host: '{media}', container: '/media' },
        ],
        env: [{ key: 'TZ', value: 'Europe/Berlin' }],
      },
      {
        key: 'sonarr', name: 'Sonarr', description: 'Automatischer Serien-Downloader',
        image: 'linuxserver/sonarr', matchImages: ['linuxserver/sonarr'], matchNames: ['sonarr'],
        ports: [{ host: '8989', container: '8989' }],
        volumes: [
          { host: '{config}/sonarr', container: '/config' },
          { host: '{media}/tv', container: '/tv' },
          { host: '{downloads}', container: '/downloads' },
        ],
        env: [{ key: 'PUID', value: '1000' }, { key: 'PGID', value: '1000' }, { key: 'TZ', value: 'Europe/Berlin' }],
      },
      {
        key: 'radarr', name: 'Radarr', description: 'Automatischer Film-Downloader',
        image: 'linuxserver/radarr', matchImages: ['linuxserver/radarr'], matchNames: ['radarr'],
        ports: [{ host: '7878', container: '7878' }],
        volumes: [
          { host: '{config}/radarr', container: '/config' },
          { host: '{media}/movies', container: '/movies' },
          { host: '{downloads}', container: '/downloads' },
        ],
        env: [{ key: 'PUID', value: '1000' }, { key: 'PGID', value: '1000' }, { key: 'TZ', value: 'Europe/Berlin' }],
      },
      {
        key: 'sabnzbd', name: 'SABnzbd', description: 'Usenet-Downloader',
        image: 'linuxserver/sabnzbd', matchImages: ['linuxserver/sabnzbd'], matchNames: ['sabnzbd'],
        ports: [{ host: '8080', container: '8080' }],
        volumes: [
          { host: '{config}/sabnzbd', container: '/config' },
          { host: '{downloads}', container: '/downloads' },
        ],
        env: [{ key: 'PUID', value: '1000' }, { key: 'PGID', value: '1000' }, { key: 'TZ', value: 'Europe/Berlin' }],
      },
      {
        key: 'prowlarr', name: 'Prowlarr', description: 'Indexer-Manager für Sonarr & Radarr',
        image: 'linuxserver/prowlarr', matchImages: ['linuxserver/prowlarr'], matchNames: ['prowlarr'],
        ports: [{ host: '9696', container: '9696' }],
        volumes: [{ host: '{config}/prowlarr', container: '/config' }],
        env: [{ key: 'PUID', value: '1000' }, { key: 'PGID', value: '1000' }, { key: 'TZ', value: 'Europe/Berlin' }],
        optional: true,
      },
      {
        key: 'bazarr', name: 'Bazarr', description: 'Automatische Untertitel-Downloads',
        image: 'linuxserver/bazarr', matchImages: ['linuxserver/bazarr'], matchNames: ['bazarr'],
        ports: [{ host: '6767', container: '6767' }],
        volumes: [
          { host: '{config}/bazarr', container: '/config' },
          { host: '{media}/tv', container: '/tv' },
          { host: '{media}/movies', container: '/movies' },
        ],
        env: [{ key: 'PUID', value: '1000' }, { key: 'PGID', value: '1000' }, { key: 'TZ', value: 'Europe/Berlin' }],
        optional: true,
      },
    ],
    paths: {
      config:    { label: 'Konfigurationen', default: '/opt/stacks/media', description: 'App-Configs (Sonarr, Radarr, …)' },
      media:     { label: 'Medienbibliothek', default: '/mnt/media',       description: 'Serien- und Film-Ordner' },
      downloads: { label: 'Downloads',        default: '/mnt/downloads',   description: 'Temporärer Download-Ordner' },
    },
  },
  {
    id: 'home-automation',
    name: 'Heimautomatisierung',
    icon: '🏠',
    description: 'Smart Home Zentrale: Home Assistant als Steuerzentrale, Mosquitto als MQTT-Broker und Node-RED für Automatisierungsregeln.',
    services: [
      {
        key: 'homeassistant', name: 'Home Assistant', description: 'Open-Source Smart Home Plattform',
        image: 'ghcr.io/home-assistant/home-assistant:stable',
        matchImages: ['home-assistant/home-assistant', 'homeassistant/home-assistant'],
        matchNames: ['homeassistant', 'home-assistant', 'hass'],
        ports: [{ host: '8123', container: '8123' }],
        volumes: [{ host: '{config}/homeassistant', container: '/config' }],
        env: [{ key: 'TZ', value: 'Europe/Berlin' }],
        extra: { privileged: true, network: 'host' },
      },
      {
        key: 'mosquitto', name: 'Mosquitto', description: 'MQTT-Broker',
        image: 'eclipse-mosquitto', matchImages: ['eclipse-mosquitto'], matchNames: ['mosquitto'],
        ports: [{ host: '1883', container: '1883' }, { host: '9001', container: '9001' }],
        volumes: [
          { host: '{config}/mosquitto/config', container: '/mosquitto/config' },
          { host: '{config}/mosquitto/data', container: '/mosquitto/data' },
          { host: '{config}/mosquitto/log', container: '/mosquitto/log' },
        ],
        env: [],
      },
      {
        key: 'nodered', name: 'Node-RED', description: 'Visueller Automatisierungseditor',
        image: 'nodered/node-red', matchImages: ['nodered/node-red'], matchNames: ['nodered', 'node-red'],
        ports: [{ host: '1880', container: '1880' }],
        volumes: [{ host: '{config}/nodered', container: '/data' }],
        env: [{ key: 'TZ', value: 'Europe/Berlin' }],
      },
      {
        key: 'zigbee2mqtt', name: 'Zigbee2MQTT', description: 'Zigbee-Geräte ohne Herstellerbridge',
        image: 'koenkk/zigbee2mqtt', matchImages: ['koenkk/zigbee2mqtt'], matchNames: ['zigbee2mqtt'],
        ports: [{ host: '8088', container: '8080' }],
        volumes: [
          { host: '{config}/zigbee2mqtt', container: '/app/data' },
          { host: '/run/udev', container: '/run/udev' },
        ],
        env: [{ key: 'TZ', value: 'Europe/Berlin' }],
        optional: true,
      },
    ],
    paths: {
      config: { label: 'Konfigurationen', default: '/opt/stacks/home', description: 'Konfigurationsdaten aller Dienste' },
    },
  },
  {
    id: 'monitoring',
    name: 'Monitoring',
    icon: '📊',
    description: 'Server-Überwachung: Grafana für Dashboards, Prometheus für Metriken, cAdvisor für Container-Stats und Node Exporter für Host-Metriken.',
    services: [
      {
        key: 'grafana', name: 'Grafana', description: 'Metriken-Dashboards',
        image: 'grafana/grafana', matchImages: ['grafana/grafana'], matchNames: ['grafana'],
        ports: [{ host: '3000', container: '3000' }],
        volumes: [{ host: '{config}/grafana', container: '/var/lib/grafana' }],
        env: [{ key: 'GF_SECURITY_ADMIN_PASSWORD', value: 'changeme' }],
      },
      {
        key: 'prometheus', name: 'Prometheus', description: 'Metriken-Datenbank',
        image: 'prom/prometheus', matchImages: ['prom/prometheus'], matchNames: ['prometheus'],
        ports: [{ host: '9090', container: '9090' }],
        volumes: [
          { host: '{config}/prometheus', container: '/etc/prometheus' },
          { host: '{config}/prometheus-data', container: '/prometheus' },
        ],
        env: [],
      },
      {
        key: 'cadvisor', name: 'cAdvisor', description: 'Container-Ressourcen live',
        image: 'gcr.io/cadvisor/cadvisor:latest',
        matchImages: ['cadvisor/cadvisor', 'gcr.io/cadvisor'],
        matchNames: ['cadvisor'],
        ports: [{ host: '8888', container: '8080' }],
        volumes: [
          { host: '//', container: '/rootfs', extra: ':ro' },
          { host: '/var/run', container: '/var/run', extra: ':ro' },
          { host: '/sys', container: '/sys', extra: ':ro' },
          { host: '/var/lib/docker/', container: '/var/lib/docker', extra: ':ro' },
        ],
        env: [],
        extra: { privileged: true },
      },
      {
        key: 'node-exporter', name: 'Node Exporter', description: 'Host-System-Metriken',
        image: 'prom/node-exporter', matchImages: ['prom/node-exporter'], matchNames: ['node-exporter', 'nodeexporter'],
        ports: [{ host: '9100', container: '9100' }],
        volumes: [
          { host: '/proc', container: '/host/proc', extra: ':ro' },
          { host: '/sys', container: '/host/sys', extra: ':ro' },
          { host: '/', container: '/rootfs', extra: ':ro' },
        ],
        env: [],
        extra: { network: 'host' },
        optional: true,
      },
    ],
    paths: {
      config: { label: 'Konfigurationen', default: '/opt/stacks/monitoring', description: 'Prometheus-Config und Grafana-Daten' },
    },
  },
  {
    id: 'security',
    name: 'Security & Passwörter',
    icon: '🔐',
    description: 'Passwort-Verwaltung und Zugriffskontrolle: Vaultwarden als Bitwarden-kompatibler Passwort-Manager und LLDAP als leichtgewichtiger LDAP-Server.',
    services: [
      {
        key: 'vaultwarden', name: 'Vaultwarden', description: 'Bitwarden-kompatibler Passwort-Manager',
        image: 'vaultwarden/server', matchImages: ['vaultwarden/server'], matchNames: ['vaultwarden', 'bitwarden'],
        ports: [{ host: '3012', container: '80' }],
        volumes: [{ host: '{config}/vaultwarden', container: '/data' }],
        env: [{ key: 'WEBSOCKET_ENABLED', value: 'true' }],
      },
      {
        key: 'lldap', name: 'LLDAP', description: 'Leichtgewichtiger LDAP-Server',
        image: 'lldap/lldap', matchImages: ['lldap/lldap'], matchNames: ['lldap'],
        ports: [{ host: '17170', container: '17170' }, { host: '3890', container: '3890' }],
        volumes: [{ host: '{config}/lldap', container: '/data' }],
        env: [
          { key: 'LLDAP_JWT_SECRET', value: 'CHANGE_ME_RANDOM' },
          { key: 'LLDAP_LDAP_USER_PASS', value: 'changeme' },
          { key: 'LLDAP_LDAP_BASE_DN', value: 'dc=hearth,dc=local' },
        ],
        optional: true,
      },
      {
        key: 'authelia', name: 'Authelia', description: 'Single Sign-On & 2FA-Gateway',
        image: 'authelia/authelia', matchImages: ['authelia/authelia'], matchNames: ['authelia'],
        ports: [{ host: '9091', container: '9091' }],
        volumes: [{ host: '{config}/authelia', container: '/config' }],
        env: [],
        optional: true,
      },
    ],
    paths: {
      config: { label: 'Konfigurationen', default: '/opt/stacks/security', description: 'Passwort- und Auth-Daten' },
    },
  },
];

function _matchService(service, rawContainers) {
  for (const c of rawContainers) {
    const labels = c.Labels || {};
    if (labels['hearth.stack.service'] === service.key) return { c, type: 'labeled' };
  }
  for (const c of rawContainers) {
    const img  = (c.Image || '').toLowerCase();
    const name = ((c.Names || [])[0] || '').replace(/^\//, '').toLowerCase();
    if (service.matchImages?.some(m => img.includes(m.toLowerCase()))) return { c, type: 'fuzzy' };
    if (service.matchNames?.some(m => name === m || name.startsWith(m + '-') || name.startsWith(m + '_'))) return { c, type: 'fuzzy' };
  }
  return null;
}

function _enrichPreset(preset, rawContainers) {
  let detectedCount = 0;
  const services = (preset.services || []).map(svc => {
    const match = _matchService(svc, rawContainers);
    if (match) detectedCount++;
    const state = match ? match.c.State : 'missing';
    const pub = (match?.c.Ports || []).find(p => String(p.PrivatePort) === String(svc.ports?.[0]?.container));
    return {
      key: svc.key, name: svc.name, description: svc.description,
      image: svc.image, optional: !!svc.optional,
      status: state,
      matchType: match?.type || null,
      containerId:   match?.c.Id || null,
      containerName: match ? ((match.c.Names || [])[0] || '').replace(/^\//, '') : null,
      hostPort: pub?.PublicPort || svc.ports?.[0]?.host || null,
      ports: svc.ports, volumes: svc.volumes, env: svc.env, extra: svc.extra || {},
    };
  });
  const required = services.filter(s => !s.optional);
  const runningCount = services.filter(s => s.status === 'running').length;
  return {
    id: preset.id, name: preset.name, icon: preset.icon || '📦', description: preset.description || '',
    paths: preset.paths || {},
    services,
    custom: !!preset._custom,
    detected: detectedCount > 0,
    runningCount,
    totalCount: services.length,
    requiredCount: required.length,
    requiredRunning: required.filter(s => s.status === 'running').length,
  };
}

app.get('/api/stacks', requireAuth, asyncHandler(async (req, res) => {
  const rawContainers = await docker.listContainers({ all: true }).catch(() => []);
  const customStacks  = (runtimeConfig.customStacks || []).map(s => ({ ...s, _custom: true }));
  const allPresets    = [...STACK_PRESETS, ...customStacks];
  res.json(allPresets.map(p => _enrichPreset(p, rawContainers)));
}));

// ── Custom Stack CRUD ────────────────────────────────────────────────────────

// Shared with the community-submission GitHub Action — see lib/community-validation.js
const { assertValidStackDefinition: _validateCustomStack } = require('./lib/community-validation');

app.get('/api/stacks/custom', requireAuth, (req, res) => {
  res.json(runtimeConfig.customStacks || []);
});

app.post('/api/stacks/custom', requireAdmin, asyncHandler(async (req, res) => {
  const { json, url } = req.body || {};
  let stackDef;
  if (url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
    stackDef = await resp.json();
  } else if (json) {
    stackDef = typeof json === 'string' ? JSON.parse(json) : json;
  } else {
    return res.status(400).json({ error: 'Provide json or url' });
  }
  _validateCustomStack(stackDef);
  const customs = runtimeConfig.customStacks || [];
  if ([...STACK_PRESETS, ...customs].find(p => p.id === stackDef.id))
    return res.status(409).json({ error: `Stack id "${stackDef.id}" already exists` });
  customs.push(stackDef);
  saveConfig({ customStacks: customs });
  res.json({ ok: true, id: stackDef.id });
}));

app.put('/api/stacks/custom/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { json } = req.body || {};
  const stackDef = typeof json === 'string' ? JSON.parse(json) : json;
  _validateCustomStack(stackDef);
  if (stackDef.id !== req.params.id) return res.status(400).json({ error: 'id mismatch' });
  const customs = runtimeConfig.customStacks || [];
  const idx = customs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Custom stack not found' });
  customs[idx] = stackDef;
  saveConfig({ customStacks: customs });
  res.json({ ok: true });
}));

app.delete('/api/stacks/custom/:id', requireAdmin, (req, res) => {
  const customs = runtimeConfig.customStacks || [];
  const filtered = customs.filter(s => s.id !== req.params.id);
  if (filtered.length === customs.length) return res.status(404).json({ error: 'Custom stack not found' });
  saveConfig({ customStacks: filtered });
  res.json({ ok: true });
});

// ── Stack Deploy ─────────────────────────────────────────────────────────────

app.post('/api/stacks/:presetId/services/:serviceKey/deploy', requireAdmin, asyncHandler(async (req, res) => {
  const customStacks = runtimeConfig.customStacks || [];
  const preset = [...STACK_PRESETS, ...customStacks].find(p => p.id === req.params.presetId);
  if (!preset) return res.status(404).json({ error: 'Stack not found' });
  const service = preset.services.find(s => s.key === req.params.serviceKey);
  if (!service) return res.status(404).json({ error: 'Service not found' });

  const pathVars = req.body?.paths || {};

  function resolvePath(p) {
    return p.replace(/\{(\w+)\}/g, (_, k) => pathVars[k] || preset.paths[k]?.default || `/${k}`);
  }

  // Pull image
  await new Promise((resolve, reject) => {
    docker.pull(service.image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (pullErr) => pullErr ? reject(pullErr) : resolve());
    });
  });

  const portBindings = {}, exposedPorts = {};
  (service.ports || []).forEach(p => {
    const key = `${p.container}/tcp`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostPort: String(p.host || '') }];
  });

  const binds = (service.volumes || [])
    .filter(v => v.host && v.container)
    .map(v => `${resolvePath(v.host)}:${v.container}${v.extra || ''}`);

  const envArr = (service.env || []).map(e => `${e.key}=${e.value ?? ''}`);

  const labels = {
    'hearth.stack':         preset.id,
    'hearth.stack.service': service.key,
  };

  const extra = service.extra || {};
  const newC = await docker.createContainer({
    Image: service.image,
    name:  service.key,
    Env:   envArr,
    Labels: labels,
    ExposedPorts: exposedPorts,
    HostConfig: {
      PortBindings: portBindings,
      Binds: binds,
      RestartPolicy: { Name: 'unless-stopped' },
      Privileged: !!extra.privileged,
      NetworkMode: extra.network || 'bridge',
    },
  });
  await newC.start();
  res.json({ ok: true, id: newC.id });
}));

// ── Stack Export ─────────────────────────────────────────────────────────────

app.get('/api/stacks/:id/export', requireAuth, (req, res) => {
  const customStacks = runtimeConfig.customStacks || [];
  const preset = [...STACK_PRESETS, ...customStacks].find(p => p.id === req.params.id);
  if (!preset) return res.status(404).json({ error: 'Stack not found' });
  const exportable = { ...preset };
  delete exportable._custom;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${preset.id}.stack.json"`);
  res.send(JSON.stringify(exportable, null, 2));
});

// ── Community Stacks & Themes (fetch + cache) ─────────────────────────────────

const COMMUNITY_BASE = 'https://raw.githubusercontent.com/MarioundMB/Hearth/main/community';
let _commStacksCache  = null, _commStacksAt  = 0;
let _commThemesCache  = null, _commThemesAt  = 0;
const COMMUNITY_TTL = 3600_000; // 1 hour

app.get('/api/community/stacks', requireAuth, asyncHandler(async (req, res) => {
  const now = Date.now();
  if (!_commStacksCache || now - _commStacksAt > COMMUNITY_TTL || req.query.refresh) {
    const r = await fetch(`${COMMUNITY_BASE}/stacks/index.json`);
    if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
    _commStacksCache = (await r.json()).stacks || [];
    _commStacksAt = now;
  }
  res.json(_commStacksCache);
}));

app.get('/api/community/themes', requireAuth, asyncHandler(async (req, res) => {
  const now = Date.now();
  if (!_commThemesCache || now - _commThemesAt > COMMUNITY_TTL || req.query.refresh) {
    const r = await fetch(`${COMMUNITY_BASE}/themes/index.json`);
    if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
    _commThemesCache = (await r.json()).themes || [];
    _commThemesAt = now;
  }
  res.json(_commThemesCache);
}));

// ── Theme (Custom CSS) ────────────────────────────────────────────────────────

app.get('/custom.css', (req, res) => {
  const theme = runtimeConfig.customTheme;
  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'no-store');
  if (!theme?.css) return res.send('');
  res.send(theme.css);
});

app.get('/api/theme', requireAuth, (req, res) => {
  const t = runtimeConfig.customTheme || null;
  res.json(t ? { id: t.id, name: t.name, sourceUrl: t.sourceUrl || null } : null);
});

app.post('/api/theme', requireAdmin, asyncHandler(async (req, res) => {
  const { css, url, id, name } = req.body || {};
  let finalCss = css || '';
  let sourceUrl = null;
  if (url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
    const text = await r.text();
    finalCss  = text;
    sourceUrl = url;
  }
  if (!finalCss.trim()) return res.status(400).json({ error: 'No CSS provided' });
  saveConfig({ customTheme: { id: id || 'custom', name: name || 'Custom Theme', css: finalCss, sourceUrl } });
  res.json({ ok: true });
}));

app.delete('/api/theme', requireAdmin, (req, res) => {
  saveConfig({ customTheme: null });
  res.json({ ok: true });
});

// ── Changelog (GitHub Releases) ───────────────────────────────────────────────

let _changelogCache = null, _changelogAt = 0;

app.get('/api/changelog', requireAuth, asyncHandler(async (req, res) => {
  const now = Date.now();
  if (!_changelogCache || now - _changelogAt > COMMUNITY_TTL || req.query.refresh) {
    const r = await fetch('https://api.github.com/repos/MarioundMB/Hearth/releases?per_page=8', {
      headers: { 'User-Agent': 'Hearth-Panel', Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) throw new Error(`GitHub API returned ${r.status}`);
    const data = await r.json();
    _changelogCache = data.map(rel => ({
      tag:  rel.tag_name,
      name: rel.name || rel.tag_name,
      body: rel.body || '',
      date: rel.published_at,
      url:  rel.html_url,
      prerelease: rel.prerelease,
    }));
    _changelogAt = now;
  }
  res.json(_changelogCache);
}));

// ---------------------------------------------------------------------------
// Linux system updates
// ---------------------------------------------------------------------------

function _detectPackageManager() {
  const checks = [
    ['/host/usr/bin/apt-get', 'apt'],
    ['/host/usr/bin/apt',     'apt'],
    ['/host/usr/bin/dnf',     'dnf'],
    ['/host/usr/bin/yum',     'yum'],
    ['/host/usr/bin/pacman',  'pacman'],
    ['/host/usr/bin/zypper',  'zypper'],
  ];
  for (const [p, name] of checks) if (fs.existsSync(p)) return name;
  return null;
}

function _checkRebootRequired() {
  return fs.existsSync('/host/var/run/reboot-required');
}

function _linuxCheckCmd(pm) {
  switch (pm) {
    case 'apt':    return "apt-get -qq update 2>/dev/null; C=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst' || echo 0); echo PENDING:$C";
    case 'dnf':    return "dnf check-update -q 2>/dev/null; C=$(dnf list updates 2>/dev/null | grep -vc '^$' || echo 0); echo PENDING:$C";
    case 'yum':    return "yum check-update -q 2>/dev/null; R=$?; [ $R -eq 100 ] && echo PENDING:many || echo PENDING:0";
    case 'pacman': return "pacman -Qu 2>/dev/null | wc -l | awk '{print \"PENDING:\"$1}'";
    case 'zypper': return "zypper lu 2>/dev/null | grep -c '|' | awk '{print \"PENDING:\"$1}' || echo PENDING:0";
    default:       return 'echo PENDING:?';
  }
}

function _linuxUpdateCmd(pm) {
  switch (pm) {
    case 'apt':    return 'DEBIAN_FRONTEND=noninteractive apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y';
    case 'dnf':    return 'dnf upgrade -y';
    case 'yum':    return 'yum upgrade -y';
    case 'pacman': return 'pacman -Syu --noconfirm';
    case 'zypper': return 'zypper update -y';
    default:       return null;
  }
}

const _sysUpdateJobs = new Map();
let _sysUpdateJobSeq = 1;

function _runLinuxUpdateJob(job) {
  const pm = _detectPackageManager();
  if (!pm) {
    job.output = ['No supported package manager found.\n'];
    job.status = 'error'; job.done = true;
    return;
  }
  const cmd = _linuxUpdateCmd(pm);
  if (!cmd) {
    job.output = [`Package manager '${pm}' not supported.\n`];
    job.status = 'error'; job.done = true;
    return;
  }
  const fullCmd = `nsenter -t 1 -m -u -n -i -- sh -c '${cmd.replace(/'/g, "'\\''")}'`;
  const proc = spawn('docker', ['run', '--rm', '--privileged', '--pid=host', _hearthImage, 'sh', '-c', fullCmd]);
  proc.stdout.on('data', d => job.output.push(d.toString()));
  proc.stderr.on('data', d => job.output.push(d.toString()));
  proc.on('close', code => {
    job.rebootRequired = _checkRebootRequired();
    job.status   = code === 0 ? 'done' : 'error';
    job.exitCode = code;
    job.done     = true;
    if (job.isAuto) {
      console.log(`[LINUX-UPDATE] Scheduled run done (exit ${code}).`);
      if (job.rebootRequired) {
        addNotif('linux-reboot', 'Neustart erforderlich', 'Ein Linux-Update erfordert einen Server-Neustart.', { section: 'updates' });
      } else if (code === 0) {
        addNotif('linux-update-done', 'Linux aktualisiert', 'Alle Systempakete wurden erfolgreich aktualisiert.');
      }
    }
  });
}

app.get('/api/system-updates/check', requireAuth, asyncHandler(async (req, res) => {
  const pm = _detectPackageManager();
  const rebootRequired = _checkRebootRequired();
  if (!pm) return res.json({ pkgMgr: null, pending: null, rebootRequired, error: 'Kein unterstützter Paketmanager' });
  const nsCmd = `nsenter -t 1 -m -u -n -i -- sh -c '${_linuxCheckCmd(pm)}'`;
  try {
    const { stdout } = await _exec('docker', ['run', '--rm', '--privileged', '--pid=host', _hearthImage, 'sh', '-c', nsCmd]);
    const m = stdout.match(/PENDING:(\w+)/);
    const raw = m ? m[1] : '?';
    const pending = /^\d+$/.test(raw) ? Number(raw) : raw;
    res.json({ pkgMgr: pm, pending, rebootRequired });
  } catch (e) {
    res.json({ pkgMgr: pm, pending: '?', rebootRequired, error: e.message });
  }
}));

app.post('/api/system-updates/install', requireAdmin, asyncHandler(async (req, res) => {
  const running = [..._sysUpdateJobs.values()].find(j => !j.done);
  if (running) return res.json({ jobId: running.id, status: 'running' });
  const jobId = String(_sysUpdateJobSeq++);
  const job = { id: jobId, status: 'running', output: [], done: false, rebootRequired: false };
  _sysUpdateJobs.set(jobId, job);
  if (_sysUpdateJobs.size > 20) _sysUpdateJobs.delete([..._sysUpdateJobs.keys()][0]);
  _runLinuxUpdateJob(job);
  res.json({ jobId, status: 'started' });
}));

app.get('/api/system-updates/job/:id', requireAuth, (req, res) => {
  const job = _sysUpdateJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });
  res.json({ status: job.status, output: job.output, done: job.done, rebootRequired: job.rebootRequired });
});

// ---------------------------------------------------------------------------
// Software-RAID (mdadm) — Host-Zugriff via nsenter + privileged container
// ---------------------------------------------------------------------------

function raidExec(cmd) {
  return new Promise(resolve => {
    const nsCmd = `nsenter -t 1 -m -u -n -i -- sh -c '${cmd.replace(/'/g, "'\\''")}'`;
    require('child_process').execFile(
      'docker',
      ['run', '--rm', '--privileged', '--pid=host', _hearthImage, 'sh', '-c', nsCmd],
      { timeout: 60_000 },
      (err, stdout, stderr) => resolve({
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        ok:     !err
      })
    );
  });
}

// Allow only /dev/sdX, /dev/nvmeXnYpZ, /dev/vdX, /dev/xvdX etc.
function _validDev(d) {
  return /^\/dev\/[a-z][a-z0-9]+$/.test(String(d)) ? String(d) : null;
}
// Allow md0 … md127
function _validMd(name) {
  const n = String(name).replace(/^\/dev\//, '');
  return /^md\d{1,3}$/.test(n) ? `/dev/${n}` : null;
}

function _parseMdstat(text) {
  const arrays = [];
  if (!text) return arrays;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(md\d+)\s*:\s*(\S+(?:\s+\(auto-read-only\))?)\s+(raid\d+|linear|multipath|faulty)\s+(.*)/);
    if (!m) continue;
    const name     = m[1];
    const activity = m[2].includes('active') ? 'active' : 'inactive';
    const levelRaw = m[3];
    const devStr   = m[4];
    const devices  = (devStr.match(/[a-z]+\d*(?:p\d+)?\[\d+\](\(F\)|\(S\))?/g) || [])
                       .map(s => s.replace(/\[\d+\](\(.\))?$/, ''));

    let blocks = 0, statusStr = '', syncProgress = null;
    const infoLine = lines[i + 1] || '';
    const blkM = infoLine.match(/(\d+) blocks/);
    if (blkM) blocks = parseInt(blkM[1]);
    const stM = infoLine.match(/\[([U_]+)\]/);
    if (stM) statusStr = stM[1];

    const syncLine = lines[i + 2] || '';
    const syncM = syncLine.match(/[=>]+.*?(\d+\.\d+)%.*?finish=([0-9.]+)min/);
    if (syncM) syncProgress = { percent: parseFloat(syncM[1]), finish: syncM[2] };

    const activeCount = (statusStr.match(/U/g) || []).length;
    arrays.push({
      name, activity, levelRaw,
      level: 'RAID ' + levelRaw.replace('raid', ''),
      devices,
      blocks,
      statusStr,
      degraded: !!statusStr && activeCount < devices.length,
      rebuilding: !!syncProgress,
      syncProgress
    });
  }
  return arrays;
}

function _parseMdDetail(text) {
  if (!text) return null;
  const get = key => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)`, 'm'));
    return m ? m[1].trim() : null;
  };
  const diskLines = text.split('\n').filter(l => /\/dev\//.test(l) && /active|faulty|spare|sync/.test(l));
  return {
    state:          get('State'),
    activeDevices:  get('Active Devices'),
    workingDevices: get('Working Devices'),
    failedDevices:  get('Failed Devices'),
    spareDevices:   get('Spare Devices'),
    arraySize:      get('Array Size'),
    raidDevices:    get('Raid Devices'),
    uuid:           get('UUID'),
    disks: diskLines.map(l => {
      const parts = l.trim().split(/\s+/);
      const devPath = (l.match(/\/dev\/\S+/) || [])[0];
      return devPath ? { number: parts[0], raidDevice: parts[3], state: parts.slice(4, -1).join(' '), path: devPath } : null;
    }).filter(Boolean)
  };
}

app.get('/api/raid/available', requireAuth, asyncHandler(async (req, res) => {
  const { stdout } = await raidExec('ls /usr/sbin/mdadm /sbin/mdadm 2>/dev/null | head -1 || echo missing');
  res.json({ available: stdout.includes('/') });
}));

app.get('/api/raid/status', requireAuth, asyncHandler(async (req, res) => {
  const { stdout: mdstat } = await raidExec('cat /proc/mdstat 2>/dev/null || echo ""');
  const arrays = _parseMdstat(mdstat);
  for (const arr of arrays) {
    const { stdout } = await raidExec(`mdadm --detail /dev/${arr.name} 2>/dev/null || echo ""`);
    arr.detail = _parseMdDetail(stdout);
  }
  res.json({ arrays });
}));

app.get('/api/raid/disks', requireAuth, asyncHandler(async (req, res) => {
  const { stdout } = await raidExec('lsblk -J -b -o NAME,SIZE,TYPE,MOUNTPOINT,MODEL 2>/dev/null || echo "{}"');
  let disks = [];
  try {
    const parsed = JSON.parse(stdout || '{}');
    disks = (parsed.blockdevices || []).filter(d => d.type === 'disk');
  } catch (_) {}
  res.json({ disks });
}));

app.post('/api/raid/create', requireAdmin, asyncHandler(async (req, res) => {
  const { level, devices, mddev } = req.body;
  const validLevels = ['0', '1', '4', '5', '6', '10'];
  if (!validLevels.includes(String(level))) return res.status(400).json({ error: 'Ungültiger RAID-Level' });
  if (!Array.isArray(devices) || devices.length < 2) return res.status(400).json({ error: 'Mindestens 2 Geräte erforderlich' });

  const mdPath = _validMd(mddev || 'md0');
  if (!mdPath) return res.status(400).json({ error: 'Ungültiger Array-Name' });

  const cleanDevs = devices.map(_validDev).filter(Boolean);
  if (cleanDevs.length !== devices.length) return res.status(400).json({ error: 'Ungültige Gerätenamen' });

  const minDisks = { '0': 2, '1': 2, '4': 3, '5': 3, '6': 4, '10': 4 };
  if (cleanDevs.length < (minDisks[level] || 2))
    return res.status(400).json({ error: `RAID ${level} benötigt mindestens ${minDisks[level]} Geräte` });

  const cmd = `mdadm --create ${mdPath} --level=${level} --raid-devices=${cleanDevs.length} --force ${cleanDevs.join(' ')} --run 2>&1`;
  const result = await raidExec(cmd);

  if (result.ok || /started|created/.test(result.stdout)) {
    await raidExec('mdadm --detail --scan 2>/dev/null | tee -a /etc/mdadm/mdadm.conf >/dev/null 2>&1 || true');
    res.json({ ok: true, output: result.stdout });
  } else {
    res.status(500).json({ error: result.stderr || result.stdout || 'Unbekannter Fehler' });
  }
}));

app.post('/api/raid/array/:dev/stop', requireAdmin, asyncHandler(async (req, res) => {
  const path = _validMd(req.params.dev);
  if (!path) return res.status(400).json({ error: 'Ungültiger Array-Name' });
  const { stdout, stderr, ok } = await raidExec(`mdadm --stop ${path} 2>&1`);
  res.json({ ok, output: stdout || stderr });
}));

app.post('/api/raid/array/:dev/add-disk', requireAdmin, asyncHandler(async (req, res) => {
  const path = _validMd(req.params.dev);
  const disk = _validDev(req.body.disk);
  if (!path || !disk) return res.status(400).json({ error: 'Ungültige Parameter' });
  const { stdout, stderr, ok } = await raidExec(`mdadm ${path} --add ${disk} 2>&1`);
  res.json({ ok, output: stdout || stderr });
}));

app.post('/api/raid/array/:dev/fail-disk', requireAdmin, asyncHandler(async (req, res) => {
  const path = _validMd(req.params.dev);
  const disk = _validDev(req.body.disk);
  if (!path || !disk) return res.status(400).json({ error: 'Ungültige Parameter' });
  const { stdout, stderr, ok } = await raidExec(`mdadm ${path} --fail ${disk} 2>&1`);
  res.json({ ok, output: stdout || stderr });
}));

app.post('/api/raid/array/:dev/remove-disk', requireAdmin, asyncHandler(async (req, res) => {
  const path = _validMd(req.params.dev);
  const disk = _validDev(req.body.disk);
  if (!path || !disk) return res.status(400).json({ error: 'Ungültige Parameter' });
  const { stdout, stderr, ok } = await raidExec(`mdadm ${path} --remove ${disk} 2>&1`);
  res.json({ ok, output: stdout || stderr });
}));

app.delete('/api/raid/array/:dev', requireAdmin, asyncHandler(async (req, res) => {
  const path = _validMd(req.params.dev);
  if (!path) return res.status(400).json({ error: 'Ungültiger Array-Name' });
  const { stdout: detail } = await raidExec(`mdadm --detail ${path} 2>/dev/null || echo ""`);
  const diskPaths = (detail.match(/\/dev\/[a-z][a-z0-9]+/g) || []).filter(d => !d.startsWith('/dev/md'));
  await raidExec(`mdadm --stop ${path} 2>&1`);
  for (const d of [...new Set(diskPaths)]) {
    await raidExec(`mdadm --zero-superblock ${d} 2>/dev/null || true`);
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Notifications — active (in-memory) + persistent archive (file-based)
// ---------------------------------------------------------------------------
const _notifs = [];
let   _notifSeq    = 1;
let   _notifArchive = [];
let   _dismissedUpdateVersion = null; // remote version the user has already dismissed

function _loadNotifArchive() {
  try {
    if (fs.existsSync(NOTIF_ARCHIVE_PATH)) {
      _notifArchive = JSON.parse(fs.readFileSync(NOTIF_ARCHIVE_PATH, 'utf8'));
    }
  } catch (_) { _notifArchive = []; }
}

function _saveNotifArchive() {
  const max = runtimeConfig.notifArchiveMax || 500;
  if (_notifArchive.length > max) _notifArchive = _notifArchive.slice(0, max);
  try { fs.writeFileSync(NOTIF_ARCHIVE_PATH, JSON.stringify(_notifArchive), 'utf8'); } catch (_) {}
}

function _archiveNotif(n) {
  _notifArchive.unshift({ id: n.id, type: n.type, title: n.title, body: n.body, ts: n.ts });
  _saveNotifArchive();
}

_loadNotifArchive();

function addNotif(type, title, body, action = null, version = null) {
  if (type === 'update') {
    if (version && version === _dismissedUpdateVersion) return; // already dismissed this version
    const idx = _notifs.findIndex(n => n.type === 'update');
    if (idx >= 0) _notifs.splice(idx, 1);
  }
  _notifs.unshift({ id: _notifSeq++, type, title, body, action, version, ts: Date.now() });
  if (_notifs.length > 30) _notifs.pop();
}

// Only unread (active) notifications
app.get('/api/notifications', requireAuth, (req, res) => res.json(_notifs));

// Mark single notification as read → move to archive
app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
  const idx = _notifs.findIndex(n => n.id === Number(req.params.id));
  if (idx >= 0) {
    const n = _notifs[idx];
    if (n.type === 'update' && n.version) _dismissedUpdateVersion = n.version;
    _archiveNotif(n);
    _notifs.splice(idx, 1);
  }
  res.json({ ok: true });
});

// Mark all as read → move all to archive
app.post('/api/notifications/read-all', requireAuth, (req, res) => {
  const updateNotif = _notifs.find(n => n.type === 'update');
  if (updateNotif?.version) _dismissedUpdateVersion = updateNotif.version;
  const copy = [..._notifs];
  _notifs.length = 0;
  copy.forEach(n => _notifArchive.unshift({ id: n.id, type: n.type, title: n.title, body: n.body, ts: n.ts }));
  _saveNotifArchive();
  res.json({ ok: true });
});

// Archive endpoints
app.get('/api/notifications/archive', requireAuth, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || '200', 10), 1000);
  const offset = parseInt(req.query.offset || '0', 10);
  res.json({ items: _notifArchive.slice(offset, offset + limit), total: _notifArchive.length });
});

app.delete('/api/notifications/archive', requireAdmin, (req, res) => {
  _notifArchive = [];
  _saveNotifArchive();
  res.json({ ok: true });
});

app.post('/api/notifications/archive/max', requireAdmin, (req, res) => {
  const max = parseInt(req.body?.max, 10);
  if (!max || max < 50) return res.status(400).json({ error: 'min 50' });
  saveConfig({ notifArchiveMax: max });
  _saveNotifArchive();
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

    res.json({ apps: tiles, host: reqHost, serverName: runtimeConfig.serverName || 'Hearth' });
  })
);

// Toggle guest-page visibility for a single container (no recreate needed)
app.post(
  '/api/containers/:id/guest-visibility',
  requireAdmin,
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
let _updateCache    = { ts: 0, data: null };
let _branchListCache = { ts: 0, branches: null };

// Scan host filesystem (mounted at /host) for the actual hearth git repo.
// Needed when the bind-mount resolves to an empty /app/repo on the host.
async function _findHostRepo() {
  const candidates = [];
  try {
    const mount = (await docker.getContainer((await docker.listContainers({ all: true })
      .catch(() => []))
      .find(c => c.Labels?.['hearth.self'] === 'true' && (c.Names || []).some(n => n.includes('/hearth') && !n.includes('firewall') && !n.includes('vpn') && !n.includes('updater') && !n.includes('cloudflared')))
      ?.Id)?.inspect().catch(() => null))?.Mounts?.find(m => m.Destination === '/app/repo' && m.Type === 'bind');
    if (mount?.Source) candidates.push(`/host${mount.Source}`);
  } catch (_) {}
  try {
    for (const u of fs.readdirSync('/host/home')) candidates.push(`/host/home/${u}/hearth`);
  } catch (_) {}
  candidates.push('/host/root/hearth');
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, '.git'))) return p;
  }
  return null;
}
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

    // Hearth-Version + Commit-SHA gegen GitHub prüfen
    let hearthUpdate = null;
    try {
      const _branch = await resolveUpdateBranch((req.query.branch || runtimeConfig.updateBranch || 'main').trim().replace(/[^a-zA-Z0-9/_.-]/g, ''));
      const rawUrl = `https://raw.githubusercontent.com/MarioundMB/Hearth/${_branch}/package.json?_=${Date.now()}`;
      const pkgRes = await fetch(rawUrl, { headers: { 'User-Agent': 'Hearth-Panel' }, signal: AbortSignal.timeout(6000) });
      if (pkgRes.ok) {
        const pkg = await pkgRes.json();
        const remoteVersion = pkg.version || '0.0.0';
        let message = '';
        let remoteSha = null;
        try {
          const ghHeaders = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'Hearth-Panel' };
          const commitRes = await fetch(
            `https://api.github.com/repos/MarioundMB/Hearth/commits/${_branch}`,
            { headers: ghHeaders, signal: AbortSignal.timeout(4000) }
          );
          if (commitRes.ok) {
            const c = await commitRes.json();
            message  = c.commit?.message?.split('\n')[0] || '';
            remoteSha = c.sha || null;
          }
        } catch (_) {}

        // Lokale SHA: git rev-parse HEAD (falls Volume gemountet), sonst HEARTH_SHA-Env
        let localSha = null;
        if (fs.existsSync(path.join(_REPO, '.git'))) {
          try { localSha = (await _exec('git', ['-C', _REPO, 'rev-parse', 'HEAD'])).stdout.trim(); } catch (_) {}
        }
        if (!localSha && HEARTH_SHA !== 'unknown') localSha = HEARTH_SHA;

        const shasDiffer = remoteSha && localSha && localSha.slice(0, 7) !== remoteSha.slice(0, 7);
        hearthUpdate = {
          remoteVersion,
          localVersion: VERSION,
          hasUpdate: remoteVersion !== VERSION || !!shasDiffer,
          message,
        };
      }
    } catch (_) {}

    if (hearthUpdate?.hasUpdate) {
      addNotif('update', 'Hearth update available',
        `v${hearthUpdate.localVersion} → v${hearthUpdate.remoteVersion}: ${hearthUpdate.message}`,
        { section: 'updates', label: 'Aktualisieren' },
        hearthUpdate.remoteVersion);
    }

    const result = { containers: containerUpdates, hearth: hearthUpdate, ts: Date.now() };
    _updateCache = { ts: Date.now(), data: result };
    res.json({ ...result, cached: false });
  })
);

// List available remote branches for the update branch selector
app.get('/api/updates/branches', requireAuth, asyncHandler(async (req, res) => {
  const CACHE_TTL = 5 * 60 * 1000;

  function _parseBranches(raw) {
    return raw.split('\n')
      .map(b => b.trim().replace(/^origin\//, ''))
      .filter(b => b && b !== 'HEAD' && !b.includes('->'))
      .sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
  }

  // Return cache if still fresh
  if (_branchListCache.branches && Date.now() - _branchListCache.ts < CACHE_TTL) {
    return res.json({ branches: _branchListCache.branches });
  }

  // 1) Local git (works when /app/repo is correctly bind-mounted)
  if (fs.existsSync(path.join(_REPO, '.git'))) {
    await _exec('git', ['config', '--global', '--add', 'safe.directory', _REPO]).catch(() => {});
    await _exec('git', ['-C', _REPO, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']).catch(() => {});
    await _exec('git', ['-C', _REPO, 'fetch', '--prune', '--quiet']).catch(() => {});
    const branches = _parseBranches(await _exec('git', ['-C', _REPO, 'branch', '-r']).catch(() => ''));
    if (branches.length) {
      _branchListCache = { ts: Date.now(), branches };
      return res.json({ branches });
    }
  }

  // 2) Host git via /host mount — use ls-remote to query live branch list directly from
  //    the remote. This avoids stale local remote-tracking refs (the /host mount is :ro
  //    so git fetch/prune can't write to .git/, but ls-remote is read-only).
  const hostRepo = await _findHostRepo().catch(() => null);
  if (hostRepo) {
    await _exec('git', ['config', '--global', '--add', 'safe.directory', hostRepo]).catch(() => {});
    const lsOut = await _exec('git', ['-C', hostRepo, 'ls-remote', '--heads', 'origin']).catch(() => '');
    const branches = lsOut.split('\n')
      .map(l => (l.split('\t')[1] || '').replace('refs/heads/', '').trim())
      .filter(Boolean)
      .sort((a, b) => a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b));
    if (branches.length) {
      _branchListCache = { ts: Date.now(), branches };
      return res.json({ branches });
    }
  }

  // 3) GitHub API
  try {
    const r = await fetch(
      'https://api.github.com/repos/MarioundMB/Hearth/branches?per_page=100',
      { headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'Hearth-Panel' },
        signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const branches = (await r.json()).map(b => b.name)
        .sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
      _branchListCache = { ts: Date.now(), branches };
      return res.json({ branches });
    }
    console.warn('[branches] GitHub API returned', r.status);
  } catch (e) {
    console.warn('[branches] GitHub API error:', e.message);
  }

  // 4) Stale cache beats showing only main
  if (_branchListCache.branches) return res.json({ branches: _branchListCache.branches });

  res.json({ branches: ['main'] });
}));


// Einzelnen Container auf neues Image updaten (pull → recreate)
app.post(
  '/api/updates/container/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const c    = docker.getContainer(req.params.id);
    const info = await c.inspect();
    const image = info.Config.Image;
    const wasRunning = info.State.Running;

    // Neues Image ziehen
    await pullImage(image);

    // Container neu erstellen mit identischer Konfiguration
    if (wasRunning) await c.stop().catch(() => {});

    const hc = info.HostConfig;
    const cc = info.Config;
    const portBindings = hc.PortBindings || {};
    const exposedPorts = {};
    for (const key of Object.keys(portBindings)) exposedPorts[key] = {};

    // HostConfig.Binds only reflects mounts created with the legacy `-v`
    // syntax. Containers created via Docker Compose's long-form `volumes:`
    // (type/source/target) — which is how CasaOS and most Compose stacks
    // declare mounts — store them in HostConfig.Mounts instead, which
    // Binds misses entirely. info.Mounts is the normalized view Docker
    // always populates on inspect regardless of how the mount was
    // declared, so rebuild from that instead of trusting Binds.
    const mounts = (info.Mounts || []).map(m => ({
      Type:     m.Type,
      Source:   m.Type === 'volume' ? m.Name : m.Source,
      Target:   m.Destination,
      ReadOnly: !m.RW,
    }));

    const name = info.Name.replace(/^\//, '');
    const newC = await safeRecreateContainer(c, name, {
      Image: image,
      name,
      Env:   cc.Env    || [],
      Labels: cc.Labels || {},
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        Mounts:       mounts,
        RestartPolicy: hc.RestartPolicy || { Name: 'unless-stopped' },
        Privileged:   hc.Privileged   || false,
        NetworkMode:  hc.NetworkMode  || 'bridge',
      },
    }, wasRunning);
    await reconnectExtraNetworks(newC.id, info.NetworkSettings?.Networks, hc.NetworkMode || 'bridge');

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

// One-off privileged-free chown: container root can always chown files
// under its own bind mount regardless of current ownership, so this needs
// no special privileges beyond the default ones `docker run` already has.
async function fixRepoOwnership(hostRepoPath, uid, gid) {
  await new Promise((resolve) => {
    const p = _spawn('docker', [
      'run', '--rm',
      '-v', `${hostRepoPath}:/app/repo`,
      'alpine:latest',
      'chown', '-R', `${uid}:${gid}`, '/app/repo',
    ], { stdio: 'ignore' });
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
}

// Runs git against a bind-mounted repo via a small dedicated image rather
// than this container's own `git` binary. If a previous self-update got
// interrupted before its rebuild finished, the currently-running image can
// be left stale and missing git entirely — that would otherwise permanently
// deadlock self-update (can't check for updates without git, and can't fix
// git without a successful update). -c safe.directory replaces a persisted
// `git config --global`, since each invocation is a fresh, disposable
// container that wouldn't retain it anyway.
//
// alpine/git's default image runs as root, so every write (fetch, reset)
// used to leave new .git/objects owned by root:root on the host — the next
// git command (from here or run by hand over SSH) would then fail with
// "insufficient permission for adding an object to repository database".
// /app/repo inside THIS container is the same bind mount as hostRepoPath,
// so run the git container as whatever UID:GID already owns it instead of
// root, which stops new mismatched-ownership objects from being created
// at all. If a mismatch happens anyway (e.g. left over from before this
// fix), retry once after realigning ownership rather than surfacing a
// permission error that would otherwise need a manual SSH fix every time.
async function gitExec(hostRepoPath, args, _retried = false) {
  await pullImage('alpine/git:latest').catch(() => {});
  let owner = null;
  try {
    const st = fs.statSync('/app/repo');
    owner = { uid: st.uid, gid: st.gid };
  } catch (e) {
    // Not fatal (falls through to running as root, the pre-v1.5.14
    // behavior) but silently swallowing this previously meant a stat
    // failure ALSO disabled the self-heal retry below (it required a
    // successful owner detection first) — logged now so a recurrence is
    // diagnosable from `docker logs hearth` instead of needing to
    // reproduce the exact command by hand over SSH again.
    console.warn('[UPDATE] could not stat /app/repo for UID matching:', e.message);
  }

  try {
    return await new Promise((resolve, reject) => {
      let out = '';
      const p = _spawn('docker', [
        'run', '--rm',
        ...(owner ? ['--user', `${owner.uid}:${owner.gid}`] : []),
        '-e', 'HOME=/tmp',
        '-v', `${hostRepoPath}:/app/repo`,
        'alpine/git:latest',
        '-c', 'safe.directory=/app/repo',
        '-C', '/app/repo',
        ...args,
      ], { stdio: 'pipe' });
      p.stdout.on('data', (d) => out += d);
      p.stderr.on('data', (d) => out += d);
      p.on('close', (code) => code === 0
        ? resolve(out.trim())
        : reject(new Error(out.trim() || `git exited with code ${code}`)));
    });
  } catch (e) {
    // Un-gated on the initial owner detection having succeeded — that was
    // the actual gap: a stat failure above meant `owner` was null, which
    // ALSO silently skipped this retry entirely, so a real permission
    // error just propagated as a hard failure with nothing to fix it or
    // even explain why. Re-stat fresh here instead of trusting the
    // earlier value, since the failure itself may be why it was stale.
    if (!_retried && /permission|read-only|denied/i.test(e.message)) {
      console.warn('[UPDATE] git permission error, attempting self-heal:', e.message);
      try {
        const st = fs.statSync('/app/repo');
        await fixRepoOwnership(hostRepoPath, st.uid, st.gid);
      } catch (statErr) {
        console.warn('[UPDATE] self-heal stat failed:', statErr.message);
      }
      return gitExec(hostRepoPath, args, true);
    }
    throw e;
  }
}

async function resolveUpdateBranch(branch, emit = () => {}) {
  if (!branch || branch === 'main') return 'main';
  try {
    const res = await fetch(
      `https://api.github.com/repos/MarioundMB/Hearth/branches/${encodeURIComponent(branch)}`,
      { headers: { 'User-Agent': 'Hearth-Panel' }, signal: AbortSignal.timeout(5000) }
    );
    if (res.status === 404) {
      const msg = `Branch '${branch}' nicht gefunden → wechsle zu main`;
      console.log(`[UPDATE] ${msg}`);
      emit('log', msg);
      if (runtimeConfig.updateBranch === branch) saveConfig({ updateBranch: 'main' });
      return 'main';
    }
    return branch;
  } catch (_) {
    return branch;
  }
}

async function runHearthSelfUpdate(emit = () => {}) {
  emit('log', 'Branch wird geprüft…');
  const branch      = await resolveUpdateBranch((runtimeConfig.updateBranch || 'main').trim(), emit);
  const GITHUB_REPO = 'https://github.com/MarioundMB/Hearth.git';
  const UPDATE_VOL  = 'hearth-update-src';

  // Find self container
  const allC = await docker.listContainers({ all: true }).catch(() => []);
  const self  = allC.find(c =>
    c.Labels?.['hearth.self'] === 'true' &&
    (c.Names || []).some(n => n.includes('/hearth') && !n.includes('firewall') && !n.includes('vpn') && !n.includes('updater') && !n.includes('cloudflared'))
  );
  const selfImage   = self?.Image || 'hearth-hearth';
  const projectName = self?.Labels?.['com.docker.compose.project'] || 'hearth';

  // Check if /app/repo is bind-mounted from HOST
  let repoHostPath = null;
  try {
    if (self) {
      const info  = await docker.getContainer(self.Id).inspect();
      const mount = (info.Mounts || []).find(m => m.Destination === '/app/repo' && m.Type === 'bind');
      if (mount?.Source) repoHostPath = mount.Source;
    }
  } catch (_) {}

  const hasVolume = !!repoHostPath && fs.existsSync(path.join(_REPO, '.git'));

  // ── Helper: spawn the updater container ──────────────────────────────────
  function spawnUpdater(repoMount) {
    // Kill any leftover updater first
    _spawn('docker', ['rm', '-f', 'hearth-updater'], { stdio: 'ignore' });
    // `docker compose` runs here inside a container that shares the HOST's
    // docker.sock (Docker-outside-of-Docker) — relative paths in the compose
    // file's volumes (the `.` in `- .:/app/repo`) resolve against this
    // container's OWN cwd (/app/repo) by default, but that resolved string
    // still gets sent to the host daemon AS a host path. The host then
    // happily creates/mounts a bogus /app/repo directory instead of the
    // real repo checkout — every subsequent self-update re-detects THAT
    // wrong path from the recreated container and perpetuates it, which is
    // why this kept recurring. --project-directory forces relative-path
    // resolution to use the real host path (repoMount) instead — only
    // meaningful when repoMount actually IS a host path (PATH A); the
    // named-volume fallback (PATH B) has no host directory to reference.
    //
    // --project-directory ALSO changes where compose looks for the compose
    // file itself, to that same (host-real, container-phantom) path — so
    // without an explicit -f pointing at the container-local, actually
    // readable /app/repo/docker-compose.yml, compose fails immediately with
    // "no configuration file provided: not found". That failure was
    // completely invisible before: stdio 'ignore' below discarded it, so
    // self-update just silently did nothing past the git checkout step.
    //
    // --project-directory ALSO changes what the build context (`context: .`
    // in docker-compose.yml) resolves to — but unlike the volume mount
    // source (just a string handed to the daemon, which reads its OWN
    // filesystem), the build context is read directly by this compose CLI
    // process, which can only see /app/repo, not the host path string. The
    // compose file's context now reads ${HEARTH_BUILD_CONTEXT:-.} specifically
    // so this can be overridden here without fighting the volume-mount fix.
    //
    // --project-directory ALSO changes where compose looks for the top-level
    // .env file used for ${VAR:-default} substitution in docker-compose.yml
    // — same container-can't-read-the-host-path problem a third time. When
    // it can't be found, compose doesn't error, it just silently falls back
    // to each field's literal default (FILES_ROOT reverting to /mnt instead
    // of .env's /host is exactly this — confirmed live after the previous
    // two fixes alone still weren't enough). --env-file points explicitly
    // at the container-readable copy.
    const usingRealHostPath = repoMount.startsWith('/');
    const projectDirFlag = usingRealHostPath
      ? `--env-file /app/repo/.env -f /app/repo/docker-compose.yml --project-directory ${repoMount} `
      : '';
    // Redirect into the repo checkout (visible on the host afterward,
    // gitignored) instead of discarding output entirely — the previous
    // silent-failure mode of this exact command is what made this bug take
    // this long to actually diagnose.
    _spawn('docker', [
      'run', '--rm', '--name', 'hearth-updater',
      '--label', 'hearth.self=true',
      '--label', 'hearth.hide=true',
      '--label', 'hearth.ephemeral=true',
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-v', `${repoMount}:/app/repo`,
      ...(usingRealHostPath ? ['-e', 'HEARTH_BUILD_CONTEXT=/app/repo'] : []),
      selfImage,
      'sh', '-c',
      `(sleep 3 && git config --global --add safe.directory /app/repo 2>/dev/null; cd /app/repo && docker compose -p ${projectName} ${projectDirFlag}up -d --build hearth; docker image prune -f 2>/dev/null; docker builder prune -af 2>/dev/null; docker volume rm hearth-update-src 2>/dev/null; true) > /app/repo/.hearth-update.log 2>&1`,
    ], { detached: true, stdio: 'ignore' }).unref();
  }

  // ── PATH A: bind-mount present — update in-place ──────────────────────────
  if (hasVolume) {
    console.log('[UPDATE] Volume mounted — updating in-place');
    emit('log', 'Änderungen von GitHub laden…');
    await gitExec(repoHostPath, ['fetch', '--quiet']).catch(() => {});
    const remote = await gitExec(repoHostPath, ['rev-parse', '--short', `origin/${branch}`]);
    const local  = await gitExec(repoHostPath, ['rev-parse', '--short', 'HEAD']);
    emit('log', `Lokal: ${local} → Remote: ${remote}`);
    if (local !== remote) {
      emit('log', 'Code wird aktualisiert…');
      await gitExec(repoHostPath, ['reset', '--hard', `origin/${branch}`]);
      await gitExec(repoHostPath, ['clean', '-fd']).catch(() => {});
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(_REPO, 'package.json'), 'utf8'));
    if (pkg.version === VERSION) {
      emit('upToDate', VERSION);
      return { upToDate: true, version: VERSION };
    }
    emit('log', `v${VERSION} → v${pkg.version}`);
    _updateCache = { ts: 0, data: null };
    emit('restarting', pkg.version);
    spawnUpdater(repoHostPath);
    return { upToDate: false, version: pkg.version };
  }

  // ── PATH B: no bind-mount — clone via named volume ─────────────────────────
  // Uses a dedicated alpine/git image rather than selfImage — selfImage is
  // whatever the currently-running container happens to be, which (same as
  // PATH A) could be a stale image from an interrupted previous update.
  console.log('[UPDATE] No bind-mount — using named-volume fallback');
  emit('log', 'Kein Volume-Mount — klone Repository…');
  await pullImage('alpine/git:latest').catch(() => {});

  // Ensure named volume exists
  await new Promise((resolve, reject) => {
    const p = _spawn('docker', ['volume', 'create', UPDATE_VOL], { stdio: 'ignore' });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`docker volume create fehlgeschlagen (code ${code})`)));
  });

  // Clean up any leftover clone container from a previous failed run
  _spawn('docker', ['rm', '-f', 'hearth-git-clone'], { stdio: 'ignore' });

  // Clone into named volume
  emit('log', `Klone Branch '${branch}' von GitHub…`);
  const cloneLog = await new Promise((resolve, reject) => {
    let out = '';
    const p = _spawn('docker', [
      'run', '--rm', '--name', 'hearth-git-clone',
      '--label', 'hearth.hide=true',
      '--label', 'hearth.ephemeral=true',
      '-v', `${UPDATE_VOL}:/dst`,
      '--entrypoint', 'sh',
      'alpine/git:latest',
      '-c',
      `git config --global --add safe.directory /dst 2>/dev/null; rm -rf /dst/* /dst/.[^.]* 2>/dev/null; git clone --depth=1 --branch ${branch} ${GITHUB_REPO} /dst 2>&1`,
    ], { stdio: 'pipe' });
    p.stdout?.on('data', d => { out += d; });
    p.stderr?.on('data', d => { out += d; });
    p.on('close', code => code === 0
      ? resolve(out)
      : reject(new Error(`git clone fehlgeschlagen (code ${code}): ${out.slice(-400)}`))
    );
  });
  console.log('[UPDATE] Clone:', cloneLog.slice(-120));
  emit('log', 'Repository geklont');

  // Read version from cloned repo (use selfImage — already local)
  const pkgJson = await new Promise(resolve => {
    let out = '';
    const p = _spawn('docker', [
      'run', '--rm', '--label', 'hearth.hide=true', '--label', 'hearth.ephemeral=true',
      '-v', `${UPDATE_VOL}:/src`, selfImage, 'cat', '/src/package.json',
    ], { stdio: 'pipe' });
    p.stdout?.on('data', d => { out += d; });
    p.on('close', () => resolve(out));
  }).catch(() => '{}');

  let newVersion = null;
  try { newVersion = JSON.parse(pkgJson).version; } catch (_) {}
  if (newVersion && newVersion === VERSION) {
    emit('upToDate', newVersion);
    return { upToDate: true, version: newVersion };
  }
  emit('log', `v${VERSION} → v${newVersion}`);
  _updateCache = { ts: 0, data: null };
  emit('restarting', newVersion);
  spawnUpdater(UPDATE_VOL);
  return { upToDate: false, version: newVersion };
}

// Recreating a container (stop → remove → create) to apply an edit, image
// update, or tag change used to remove the old container FIRST — if the
// create step then failed for any reason (bad image ref, port conflict,
// invalid mount, registry timeout, ...), the container was just gone with
// no way back. Rename the old one out of the way instead of removing it,
// so a failed create can be reported as an error while the original
// container is restored untouched, instead of silently disappearing.
async function safeRecreateContainer(oldC, originalName, createOpts, wasRunning) {
  const tempName = `${originalName}-recreate-${Date.now()}`;
  await oldC.rename({ name: tempName });
  try {
    const newC = await docker.createContainer(createOpts);
    if (wasRunning) await newC.start();
    await oldC.remove({ force: true }).catch(() => {});
    return newC;
  } catch (e) {
    await docker.getContainer(createOpts.name).remove({ force: true }).catch(() => {});
    await oldC.rename({ name: originalName }).catch(() => {});
    if (wasRunning) await oldC.start().catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Container Auto-Update — per-container scheduled updates
// ---------------------------------------------------------------------------
// A container can be attached to multiple Docker networks (e.g. via a manual
// `docker network connect`, often done to work around one container being
// unable to reach another through the host's own published port), but only
// ONE network can be specified at container-creation time (HostConfig
// .NetworkMode). Recreating a container for an update previously silently
// dropped every network beyond that primary one — reconnect the rest here so
// they survive image updates instead of reverting on every recreate.
async function reconnectExtraNetworks(containerId, originalNetworks, primaryNetworkMode) {
  const extra = Object.keys(originalNetworks || {}).filter((n) => n !== primaryNetworkMode);
  for (const netName of extra) {
    try {
      await docker.getNetwork(netName).connect({ Container: containerId });
    } catch (e) {
      console.warn(`[UPDATE] Konnte Netzwerk '${netName}' nicht wieder verbinden:`, e.message);
    }
  }
}

async function runContainerAutoUpdate(name) {
  const list = await docker.listContainers({ all: true, filters: { name: [name] } });
  const match = list.find(c => (c.Names || []).some(n => n.replace(/^\//, '') === name));
  if (!match) throw new Error(`Container not found: ${name}`);

  const c = docker.getContainer(match.Id);
  const info = await c.inspect();
  const image = info.Config.Image;

  const check = await checkImageUpdate(image);
  if (!check.hasUpdate) return { updated: false, name };

  const wasRunning = info.State.Running;
  await pullImage(image);
  if (wasRunning) await c.stop().catch(() => {});

  const hc = info.HostConfig;
  const cc = info.Config;
  const portBindings = hc.PortBindings || {};
  const exposedPorts = {};
  for (const key of Object.keys(portBindings)) exposedPorts[key] = {};

  // See the identical comment in /api/updates/container/:id — HostConfig.Binds
  // misses Compose long-form volume mounts; rebuild from the normalized
  // info.Mounts view instead so scheduled updates don't silently drop mounts.
  const mounts = (info.Mounts || []).map(m => ({
    Type:     m.Type,
    Source:   m.Type === 'volume' ? m.Name : m.Source,
    Target:   m.Destination,
    ReadOnly: !m.RW,
  }));

  const newC = await safeRecreateContainer(c, name, {
    Image: image,
    name,
    Env:   cc.Env    || [],
    Labels: cc.Labels || {},
    ExposedPorts: exposedPorts,
    HostConfig: {
      PortBindings: portBindings,
      Mounts:       mounts,
      RestartPolicy: hc.RestartPolicy || { Name: 'unless-stopped' },
      Privileged:   hc.Privileged   || false,
      NetworkMode:  hc.NetworkMode  || 'bridge',
    },
  }, wasRunning);
  await reconnectExtraNetworks(newC.id, info.NetworkSettings?.Networks, hc.NetworkMode || 'bridge');
  _updateCache = { ts: 0, data: null };
  return { updated: true, name };
}

let _containerUpdateInterval = null;

function startContainerAutoUpdater() {
  if (_containerUpdateInterval) return;
  _containerUpdateInterval = setInterval(async () => {
    const updates = runtimeConfig.containerAutoUpdates || {};
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const due = Object.entries(updates).filter(([, c]) => c.enabled && c.hour === h && c.minute === m);
    if (!due.length) return;

    console.log(`[CONTAINER-UPDATE] Running auto-update for: ${due.map(([n]) => n).join(', ')}`);
    const results = await Promise.allSettled(due.map(([n]) => runContainerAutoUpdate(n)));

    const updated = [], failed = [];
    results.forEach((r, i) => {
      const name = due[i][0];
      if (r.status === 'fulfilled' && r.value?.updated) updated.push(name);
      else if (r.status === 'rejected') failed.push(name);
    });

    if (updated.length) addNotif('update-done', 'Container Auto-Update', `Updated: ${updated.join(', ')}.`, { section: 'updates' });
    if (failed.length)  addNotif('error', 'Container Auto-Update failed', `Failed: ${failed.join(', ')}.`);
  }, 60000);
  console.log('[CONTAINER-UPDATE] Auto-updater started.');
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
    if (runtimeConfig.autoUpdateLinux?.enabled) {
      console.log('[LINUX-UPDATE] Running scheduled auto-update…');
      const jobId = String(_sysUpdateJobSeq++);
      const job = { id: jobId, status: 'running', output: [], done: false, rebootRequired: false, isAuto: true };
      _sysUpdateJobs.set(jobId, job);
      _runLinuxUpdateJob(job);
    }
    scheduleNightlyUpdate();
  }, next - now);
  console.log(`[UPDATE] Next auto-update scheduled at ${next.toLocaleString()}`);
}

// Manual trigger endpoint
app.post(
  '/api/updates/hearth',
  requireAdmin,
  asyncHandler(async (req, res) => {
    try {
      const result = await runHearthSelfUpdate();
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  })
);

// SSE streaming endpoint — runs update and streams progress to the client
app.get('/api/updates/hearth/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (type, msg) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, msg })}\n\n`);
  };

  runHearthSelfUpdate(emit)
    .catch(e => emit('error', e.message))
    .finally(() => { if (!res.writableEnded) res.end(); });
});

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
        .filter((c) => {
          const l = c.labels;
          if (String(l['hearth.self']).toLowerCase() === 'true') return false;
          if (String(l['hearth.hide']).toLowerCase() === 'true') return false;
          return true;
        })
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
  requireAdmin,
  asyncHandler(async (req, res) => {
    const c = docker.getContainer(req.params.id);
    await c[req.params.action]();
    res.json({ ok: true });
  })
);

app.delete(
  '/api/containers/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const force = req.query.force === 'true';
    await docker.getContainer(req.params.id).remove({ force, v: false });
    res.json({ ok: true });
  })
);

// Container bearbeiten (stop → remove → neu erstellen mit neuen Einstellungen)
app.put(
  '/api/containers/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.image) { res.status(400); throw new Error('Image is required'); }

    const oldC = docker.getContainer(req.params.id);
    const info = await oldC.inspect();
    const wasRunning = info.State.Running;
    const originalName = info.Name.replace(/^\//, '');

    if (wasRunning) await oldC.stop().catch(() => {});

    // Port-Bindings aufbauen (mit automatischer Konflikt-Auflösung)
    const resolvedPorts = await resolvePortConflicts(b.ports);
    const portBindings = {}, exposedPorts = {};
    resolvedPorts.forEach((p) => {
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
      // Falls back to the original name (not undefined) — otherwise a
      // blank name field would let Docker auto-assign a random one,
      // silently "losing" the container from the user's perspective.
      name: b.name || originalName,
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

    const newC = await safeRecreateContainer(oldC, originalName, createOpts, wasRunning);
    const autoAssigned = resolvedPorts.filter(p => p._autoAssigned).map(p => ({ container: p.container, host: p.host }));
    res.json({ ok: true, id: newC.id, ...(autoAssigned.length ? { autoAssigned } : {}) });
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
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.image) {
      res.status(400);
      throw new Error('Image ist erforderlich');
    }

    if (b.pull) {
      await pullImage(b.image);
    }

    // Port-Bindings aufbauen (mit automatischer Konflikt-Auflösung)
    const resolvedPorts = await resolvePortConflicts(b.ports);
    const portBindings = {};
    const exposedPorts = {};
    resolvedPorts.forEach((p) => {
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
        const proto = String(p.proto || 'tcp').toLowerCase().replace(/[^a-z]/g, '');
        const hostPort = String(p.host).replace(/[^0-9:]/g, '');
        const safeName = String(b.name || b.image).replace(/[^a-zA-Z0-9_.-]/g, '');
        if (hostPort) {
          await fwExec(`ufw allow ${hostPort}/${proto} comment "hearth: ${safeName}"`).catch(() => {});
        }
      }
    }

    const autoAssigned = resolvedPorts.filter(p => p._autoAssigned).map(p => ({ container: p.container, host: p.host }));
    res.json({ ok: true, id: container.id, ...(autoAssigned.length ? { autoAssigned } : {}) });
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
  requireAdmin,
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
  requireAdmin,
  asyncHandler(async (req, res) => {
    await docker.getImage(req.params.id).remove({ force: req.query.force === 'true' });
    res.json({ ok: true });
  })
);

// Images prune (dangling <none>:<none> images)
app.post('/api/images/prune', requireAdmin, asyncHandler(async (req, res) => {
  const result = await docker.pruneImages({ filters: JSON.stringify({ dangling: ['true'] }) });
  res.json({ ok: true, deleted: result.ImagesDeleted?.length || 0, freed: result.SpaceReclaimed || 0 });
}));

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
  requireAdmin,
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
  requireAdmin,
  upload.array('files'),
  asyncHandler(async (req, res) => {
    const destDir = safeResolve(req.body.path || '/');
    for (const f of req.files || []) {
      let target;
      try {
        target = safeResolve(path.relative(FILES_ROOT, path.join(destDir, f.originalname)));
      } catch (_) {
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
  requireAdmin,
  asyncHandler(async (req, res) => {
    const target = safeResolve(path.join(req.body.path || '/', req.body.name || ''));
    await fsp.mkdir(target, { recursive: true });
    res.json({ ok: true });
  })
);

app.post(
  '/api/files/rename',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const from = safeResolve(req.body.from);
    const to = safeResolve(req.body.to);
    await fsp.rename(from, to);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/files',
  requireAdmin,
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
  requireAdmin,
  asyncHandler(async (req, res) => {
    const from = safeResolve(req.body.from);
    const toDir = safeResolve(req.body.toDir || '/');
    const name = req.body.name || path.basename(from);
    const target = safeResolve(path.relative(FILES_ROOT, path.join(toDir, name)));
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
              execFile('df', ['-k', p], (err, stdout) => {
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
// Prefer the live git-repo mount (/app/repo/public) so static file changes
// take effect immediately after git reset --hard, without a Docker rebuild.
// Falls back to the baked /app/public if no repo mount is present.
const _REPO_PUBLIC = path.join('/app/repo', 'public');
const _STATIC_DIR  = fs.existsSync(path.join(_REPO_PUBLIC, 'index.html'))
  ? _REPO_PUBLIC
  : path.join(__dirname, 'public');
console.log('[STATIC] Serving from:', _STATIC_DIR);

// Inject ?v=VERSION into all JS/CSS references in HTML pages so CDN caches
// are automatically busted on every version bump.
const _VER_RE = /(src|href)="(\/(?:js|css)\/[^"]+\.(?:js|css))"/g;
function injectVersion(html) {
  return html.replace(_VER_RE, (_, attr, url) => `${attr}="${url}?v=${VERSION}"`);
}
// Replace <link href="/custom.css"> with an inline <style> carrying the active
// theme CSS so page reloads always show the correct theme — even behind a CDN.
function _injectTheme(html) {
  const css = runtimeConfig.customTheme?.css || '';
  return html.replace(
    /<link\s+rel="stylesheet"\s+href="\/custom\.css"[^>]*>/,
    `<style id="custom-theme">${css}</style>`
  );
}
function _serveHtml(html, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(_injectTheme(injectVersion(html)));
}
for (const page of ['index.html', 'login.html', 'setup.html']) {
  app.get('/' + page.replace('index.html', ''), (req, res, next) => {
    const file = path.join(_STATIC_DIR, page);
    fs.readFile(file, 'utf8', (err, html) => { if (err) return next(); _serveHtml(html, res); });
  });
}
// admin.html is deliberately NOT in the loop above, and is excluded from the
// express.static mount below — it must never be served without checking the
// session first. A direct /admin.html request is redirected through the
// guarded /admin route (further down), the only place that actually sends it.
app.get('/admin.html', (req, res) => res.redirect('/admin'));

app.use(express.static(_STATIC_DIR));

// ---------------------------------------------------------------------------
// VPN (WireGuard via hearth-vpn container)
// ---------------------------------------------------------------------------
async function vpnAvailable() {
  try { await docker.getContainer(VPN_CONTAINER).inspect(); return true; } catch (_) { return false; }
}

async function vpnExec(cmd) {
  const c = docker.getContainer(VPN_CONTAINER);
  const exec = await c.exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({});
  const chunks = [];
  const demuxed = new PassThrough();
  demuxed.on('data', (d) => chunks.push(d));
  c.modem.demuxStream(stream, demuxed, demuxed);
  return new Promise((resolve, reject) => {
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
    stream.on('error', reject);
  });
}

// Recreates hearth-vpn with one or more Env values overridden (e.g. a new
// SERVERPORT) and/or a new published port — Docker doesn't allow changing
// port bindings or env on a running container, so this is unavoidable for a
// port change. Everything else (image, volumes, capabilities, sysctls,
// labels, restart policy, network) is carried over from the current
// container's own inspect data rather than hardcoded, so it stays correct
// even if someone customized their docker-compose.yml.
async function recreateVpnContainer(envOverrides, newPort) {
  const byName = docker.getContainer(VPN_CONTAINER);
  const info = await byName.inspect();
  // safeRecreateContainer renames this container mid-flight, then later
  // removes it by re-dialing whatever identifier we handed it — dockerode
  // Container objects don't re-resolve after a rename, they just keep using
  // the exact string they were constructed with. Passing the NAME here
  // would mean that final "remove the old one" call re-resolves "hearth-vpn"
  // AFTER the new container has already claimed that name, deleting the
  // wrong (brand new) container instead. Resolve to the immutable container
  // ID first so the reference stays correct across the rename.
  const c = docker.getContainer(info.Id);
  const wasRunning = info.State.Running;
  const cc = info.Config;
  const hc = info.HostConfig;

  const env = (cc.Env || []).map((e) => {
    const key = e.split('=')[0];
    return Object.prototype.hasOwnProperty.call(envOverrides, key) ? `${key}=${envOverrides[key]}` : e;
  });

  const mounts = (info.Mounts || []).map((m) => ({
    Type: m.Type,
    Source: m.Type === 'volume' ? m.Name : m.Source,
    Target: m.Destination,
    ReadOnly: !m.RW,
  }));

  // docker inspect reports capabilities as "CAP_NET_ADMIN"; container
  // creation expects them without that prefix (as with `--cap-add`).
  const capAdd = (hc.CapAdd || []).map((cap) => cap.replace(/^CAP_/, ''));

  const portKey = `${newPort}/udp`;

  // Must stop the old container before creating the new one — renaming
  // alone doesn't release its port binding, so if the port ISN'T changing
  // (peer add/rename/delete, or a host-only settings change), the new
  // container's start() fails with "port is already allocated" against the
  // still-running old one. Only matters to notice when the port stays the
  // same, which is why the port-change-only path this was first written
  // against never hit it.
  if (wasRunning) await c.stop().catch(() => {});

  const newC = await safeRecreateContainer(c, VPN_CONTAINER, {
    Image: cc.Image,
    name: VPN_CONTAINER,
    Env: env,
    Labels: cc.Labels || {},
    ExposedPorts: { [portKey]: {} },
    HostConfig: {
      Mounts: mounts,
      PortBindings: { [portKey]: [{ HostPort: String(newPort) }] },
      RestartPolicy: hc.RestartPolicy || { Name: 'unless-stopped' },
      CapAdd: capAdd,
      Sysctls: hc.Sysctls || {},
      NetworkMode: hc.NetworkMode || 'bridge',
    },
  }, wasRunning);

  // The recreated container needs a few seconds for its own entrypoint
  // (package install checks, wg-quick up) before `wg`/`sh` are usable —
  // poll instead of guessing a fixed delay.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { await vpnExec('wg show >/dev/null 2>&1'); return newC; } catch (_) { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return newC;
}

app.get('/api/vpn/status', requireAuth, asyncHandler(async (req, res) => {
  if (!await vpnAvailable()) return res.json({ available: false });
  try {
    const info = await docker.getContainer(VPN_CONTAINER).inspect();
    const running = info.State.Running;
    const wgStatus = running ? await vpnExec('wg show 2>/dev/null') : '';

    // Directory-based peers (linuxserver/wireguard names these "peer1", "peer2", ...
    // for numeric PEERS=<n>, or "peer_<name>" for named PEERS=<name1,name2,...>).
    // Keep the directory name verbatim — it doubles as the file basename inside it
    // (peer1/peer1.conf, peer_phone/peer_phone.conf), so we must not reconstruct it.
    const peerList = running
      ? await vpnExec('ls /config 2>/dev/null | grep "^peer"')
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

    const env = info.Config?.Env || [];
    const envVal = (key, fallback) => env.find(e => e.startsWith(`${key}=`))?.slice(key.length + 1) || fallback;
    const port = parseInt(envVal('SERVERPORT', '51820'), 10);
    const host = runtimeConfig.vpnHost || (envVal('SERVERURL', 'auto') !== 'auto' ? envVal('SERVERURL', 'auto') : null);

    res.json({ available: true, running, status: wgStatus, peers, port, host });
  } catch (e) {
    res.json({ available: true, running: false, error: e.message, peers: [] });
  }
}));

// VPN tab settings: server address (used for newly created peers, no
// restart needed) and port (needs a hearth-vpn recreation, since Docker
// can't change a running container's published port). Either change also
// rewrites existing peers' Endpoint line so a fresh QR-scan/download shows
// the right values — devices that already imported the old config still
// need to be re-added manually, there's no way around that for a real
// network-level change.
// The linuxserver/wireguard entrypoint regenerates wg_confs/wg0.conf from
// scratch — keeping only whatever's listed in $PEERS — every time it starts
// and ANY of SERVERURL/SERVERPORT/PEERDNS/PEERS/INTERNAL_SUBNET/ALLOWEDIPS
// changed since the last boot (tracked in /config/.donoteditthisfile). A
// peer added by hand-editing wg0.conf (the previous approach here) is
// invisible to that comparison and silently disappears the next time ANY of
// those variables changes for an unrelated reason — including SERVERURL
// re-resolving to a different IP on every boot when it's "auto" and the
// host's public IP has simply changed. Routing every add/rename/delete
// through $PEERS instead keeps peers tracked by the mechanism that survives
// restarts, at the cost of a brief reconnect on every change (same as a
// port change) instead of none.
function expandPeersEnv(peersEnv) {
  const val = String(peersEnv || '').trim();
  if (!val) return [];
  if (/^\d+$/.test(val)) return Array.from({ length: parseInt(val, 10) }, (_, i) => String(i + 1));
  return val.split(',').map((s) => s.trim()).filter(Boolean);
}
function peerTokenToDir(token) {
  return /^\d+$/.test(token) ? `peer${token}` : `peer_${token}`;
}
async function applyVpnPeersEnv(tokens, extraEnvOverrides = {}) {
  const info = await docker.getContainer(VPN_CONTAINER).inspect();
  const env = info.Config?.Env || [];
  const currentPort = parseInt(env.find(e => e.startsWith('SERVERPORT='))?.slice('SERVERPORT='.length), 10) || 51820;
  await recreateVpnContainer({ PEERS: tokens.join(','), ...extraEnvOverrides }, currentPort);
}

app.post('/api/vpn/settings', requireAdmin, asyncHandler(async (req, res) => {
  const newHost = String(req.body?.host || '').trim();
  const newPort = parseInt(req.body?.port, 10);
  if (!newHost) return res.status(400).json({ error: 'Server-Adresse darf nicht leer sein' });
  if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) {
    return res.status(400).json({ error: 'Ungültiger Port' });
  }
  if (!await vpnAvailable()) return res.status(400).json({ error: 'VPN-Container nicht verfügbar' });

  const info = await docker.getContainer(VPN_CONTAINER).inspect();
  const env = info.Config?.Env || [];
  const envVal = (key, fallback) => env.find(e => e.startsWith(`${key}=`))?.slice(key.length + 1) || fallback;
  const currentPort = parseInt(envVal('SERVERPORT', '51820'), 10);
  const portChanged = newPort !== currentPort;

  // SERVERURL is also one of the tracked variables, so setting an explicit
  // host (instead of leaving "auto") causes the same brief reconnect as a
  // port change, even when the port itself doesn't change.
  await recreateVpnContainer({ SERVERPORT: newPort, SERVERURL: newHost }, newPort);

  if (portChanged) {
    await fwExec(`echo y | ufw delete allow ${currentPort}/udp`).catch(() => {});
    await fwExec(`ufw allow ${newPort}/udp comment hearth-vpn-port`).catch(() => {});
  }

  saveConfig({ vpnHost: newHost });
  res.json({ ok: true, host: newHost, port: newPort });
}));

// Add a new VPN client by appending its name to $PEERS and recreating the
// container — the entrypoint generates its keys/conf itself (since no
// privatekey-<dir> exists yet for a new name) using the same layout the
// QR/conf routes already expect: /config/<dirName>/<dirName>.conf.
app.post('/api/vpn/peers', requireAdmin, asyncHandler(async (req, res) => {
  const rawName = String(req.body?.name || '').trim();
  // The image's own peer-name check is `[[:alnum:]]+` — no underscore/hyphen —
  // anything else gets silently skipped during generation, producing no peer
  // at all with no clear error. Match that constraint here so failures show
  // up as a clear 400 instead of a client that never appears.
  const safeName = rawName.replace(/[^a-zA-Z0-9]/g, '');
  if (!safeName) return res.status(400).json({ error: 'Ungültiger Name (nur Buchstaben und Zahlen)' });
  const dirName = peerTokenToDir(safeName);

  if (!await vpnAvailable()) return res.status(400).json({ error: 'VPN-Container nicht verfügbar' });
  const info = await docker.getContainer(VPN_CONTAINER).inspect();
  if (!info.State.Running) return res.status(400).json({ error: 'VPN-Container läuft nicht' });

  const exists = (await vpnExec(`test -d "/config/${dirName}" && echo yes || echo no`)).trim() === 'yes';
  if (exists) return res.status(409).json({ error: `Client "${safeName}" existiert bereits` });

  const env = info.Config?.Env || [];
  const envVal = (key, fallback) => env.find(e => e.startsWith(`${key}=`))?.slice(key.length + 1) || fallback;
  const tokens = expandPeersEnv(envVal('PEERS', '0'));
  tokens.push(safeName);

  const extraOverrides = {};
  if (runtimeConfig.vpnHost) extraOverrides.SERVERURL = runtimeConfig.vpnHost;
  await applyVpnPeersEnv(tokens, extraOverrides);

  const stillMissing = (await vpnExec(`test -f "/config/${dirName}/${dirName}.conf" && echo no || echo yes`).catch(() => 'yes')).trim() === 'yes';
  if (stillMissing) return res.status(500).json({ error: 'Client wurde angelegt, aber die Config ist noch nicht bereit — bitte kurz warten und Seite neu laden' });

  res.json({ name: dirName });
}));

// Rename a VPN client. Moves its files BEFORE recreating so the entrypoint
// finds privatekey-<newDir> already there and reuses it instead of
// generating a fresh keypair — which would silently invalidate every device
// that already scanned/imported the old config. Also folds it into $PEERS
// if it wasn't tracked there yet (peers created before this fix).
app.patch('/api/vpn/peers/:name', requireAdmin, asyncHandler(async (req, res) => {
  const oldDir = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const newSafe = String(req.body?.name || '').trim().replace(/[^a-zA-Z0-9]/g, '');
  if (!newSafe) return res.status(400).json({ error: 'Ungültiger Name (nur Buchstaben und Zahlen)' });
  const newDir = peerTokenToDir(newSafe);
  if (newDir === oldDir) return res.json({ name: oldDir });

  const oldExists = (await vpnExec(`test -d "/config/${oldDir}" && echo yes || echo no`)).trim() === 'yes';
  if (!oldExists) return res.status(404).json({ error: 'Client nicht gefunden' });
  const newExists = (await vpnExec(`test -d "/config/${newDir}" && echo yes || echo no`)).trim() === 'yes';
  if (newExists) return res.status(409).json({ error: `Client "${newSafe}" existiert bereits` });

  await vpnExec(`mv "/config/${oldDir}" "/config/${newDir}" && mv "/config/${newDir}/${oldDir}.conf" "/config/${newDir}/${newDir}.conf"`);

  const info = await docker.getContainer(VPN_CONTAINER).inspect();
  const env = info.Config?.Env || [];
  const envVal = (key, fallback) => env.find(e => e.startsWith(`${key}=`))?.slice(key.length + 1) || fallback;
  const currentTokens = expandPeersEnv(envVal('PEERS', '0'));
  const tokens = currentTokens.some((t) => peerTokenToDir(t) === oldDir)
    ? currentTokens.map((t) => (peerTokenToDir(t) === oldDir ? newSafe : t))
    : [...currentTokens, newSafe];

  const extraOverrides = {};
  if (runtimeConfig.vpnHost) extraOverrides.SERVERURL = runtimeConfig.vpnHost;
  await applyVpnPeersEnv(tokens, extraOverrides);

  res.json({ name: newDir });
}));

// Remove a VPN client: pull it off the live interface immediately (so
// access is revoked right away rather than waiting for the recreate below),
// drop it from $PEERS and recreate so it doesn't come back on the next
// restart, then delete its /config directory.
app.delete('/api/vpn/peers/:name', requireAdmin, asyncHandler(async (req, res) => {
  const dirName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const exists = (await vpnExec(`test -d "/config/${dirName}" && echo yes || echo no`)).trim() === 'yes';
  if (!exists) return res.status(404).json({ error: 'Client nicht gefunden' });

  const conf = await vpnExec(`cat "/config/${dirName}/${dirName}.conf" 2>/dev/null`);
  const privKey = conf.match(/PrivateKey\s*=\s*(\S+)/i)?.[1];
  if (privKey) {
    const pubKey = (await vpnExec(`echo '${privKey}' | wg pubkey`)).trim();
    await vpnExec(`wg set wg0 peer '${pubKey}' remove`).catch(() => {});
  }

  const info = await docker.getContainer(VPN_CONTAINER).inspect();
  const env = info.Config?.Env || [];
  const envVal = (key, fallback) => env.find(e => e.startsWith(`${key}=`))?.slice(key.length + 1) || fallback;
  const tokens = expandPeersEnv(envVal('PEERS', '0')).filter((t) => peerTokenToDir(t) !== dirName);

  const extraOverrides = {};
  if (runtimeConfig.vpnHost) extraOverrides.SERVERURL = runtimeConfig.vpnHost;
  await applyVpnPeersEnv(tokens, extraOverrides);

  await vpnExec(`rm -rf "/config/${dirName}"`).catch(() => {});

  res.json({ ok: true });
}));

// Render a peer's QR code as PNG, generated from its .conf (not the
// linuxserver-baked PNG, which is a fixed ~207x207px and looks blurry
// once the browser scales it up to the QR modal's display size).
app.get('/api/vpn/peers/:name/qr', requireAuth, asyncHandler(async (req, res) => {
  // `name` is the exact /config directory name (e.g. "peer1" or "peer_phone"),
  // which also doubles as the file basename inside it — see /api/vpn/status.
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  try {
    const conf = await vpnExec(`cat /config/${name}/${name}.conf 2>/dev/null`);
    if (!conf) return res.status(404).json({ error: 'QR not found' });
    const buf = await QRCode.toBuffer(conf, { width: 440 });
    res.setHeader('Content-Type', 'image/png');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// Download a peer's .conf file
app.get('/api/vpn/peers/:name/conf', requireAuth, asyncHandler(async (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  try {
    const conf = await vpnExec(`cat /config/${name}/${name}.conf 2>/dev/null`);
    if (!conf) return res.status(404).json({ error: 'Config not found' });
    // application/octet-stream (not text/plain) so browsers don't append ".txt"
    // to the ".conf" filename we set below.
    res.setHeader('Content-Type', 'application/octet-stream');
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
app.get('/admin', (req, res, next) => {
  if (!(req.session && req.session.authed)) return res.redirect('/login');
  const file = path.join(_STATIC_DIR, 'admin.html');
  fs.readFile(file, 'utf8', (err, html) => { if (err) return next(); _serveHtml(html, res); });
});
app.get('/login', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
);
app.get('/setup-access', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'setup-access.html'))
);

// Admin server — keep this behind your firewall / VPN
const adminHttpServer = http.createServer(app);

// WebSocket terminal
const wss = new WebSocketServer({ noServer: true });
adminHttpServer.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/ws/terminal')) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws, req) => {
  const url = new URL('http://x' + req.url);
  const token = url.searchParams.get('token');
  const info = _termTokens.get(token);
  if (!info || Date.now() - info.ts > 30000) {
    ws.close(4001, 'Invalid or expired token');
    return;
  }
  _termTokens.delete(token);

  const cols = Math.max(10, Math.min(500, parseInt(url.searchParams.get('cols') || '80', 10)));
  const rows = Math.max(5,  Math.min(200, parseInt(url.searchParams.get('rows') || '24', 10)));

  let container, containerStream;
  try {
    // Spin up a privileged container using the same Hearth image (has nsenter/util-linux).
    // nsenter -t 1 with --pid=host enters the HOST's namespaces → real host shell.
    container = await docker.createContainer({
      Image: _hearthImage,
      Cmd: ['nsenter', '-t', '1', '-m', '-u', '-n', '-i', '-p', '--', 'su', '-l', info.username],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      OpenStdin: true,
      StdinOnce: false,
      // hearth.hide only — see the comment on the cloudflared tunnel
      // container's Labels for why hearth.self must stay reserved for the
      // actual main hearth container.
      Labels: { 'hearth.hide': 'true' },
      HostConfig: {
        Privileged: true,
        PidMode: 'host',
        NetworkMode: 'host',
        AutoRemove: true,
      },
    });

    containerStream = await new Promise((resolve, reject) => {
      container.attach(
        { stream: true, stdin: true, stdout: true, stderr: true, hijack: true },
        (err, s) => (err ? reject(err) : resolve(s))
      );
    });

    await container.start();
    await container.resize({ w: cols, h: rows }).catch(() => {});

  } catch (err) {
    console.error('[terminal] container start error:', err.message);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mFehler: ${err.message}\x1b[0m\r\n` }));
      ws.close();
    }
    return;
  }

  containerStream.on('data', chunk => {
    if (ws.readyState === ws.OPEN)
      ws.send(JSON.stringify({ type: 'output', data: chunk.toString('utf8') }));
  });
  containerStream.on('end', () => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit' }));
      ws.close();
    }
  });

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input' && containerStream) containerStream.write(msg.data);
      if (msg.type === 'resize' && container)
        container.resize({ w: msg.cols || 80, h: msg.rows || 24 }).catch(() => {});
    } catch (_) {}
  });

  ws.on('close', () => {
    try { containerStream?.end(); } catch (_) {}
    if (container) container.kill().catch(() => {});
  });
});

adminHttpServer.listen(PORT, () => {
  console.log(`\x1b[32m✓ Admin panel   http://localhost:${PORT}/admin\x1b[0m`);
  console.log(`  File manager root: ${FILES_ROOT}`);
  scheduleNightlyUpdate();
  startContainerAutoUpdater();
  // Remove leftover ephemeral update containers from previous runs
  docker.listContainers({ all: true }).then(list => {
    for (const c of list) {
      const ephemeral = String((c.Labels || {})['hearth.ephemeral']).toLowerCase() === 'true';
      const knownName = (c.Names || []).some(n => ['hearth-git-clone', 'hearth-updater'].includes(n.replace(/^\//, '')));
      if (ephemeral || knownName) {
        docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
      }
    }
  }).catch(() => {});
  startAdminHttpsServer();
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
