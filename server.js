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

// ---------------------------------------------------------------------------
// Konfiguration (über Umgebungsvariablen steuerbar – siehe .env.example)
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '4500', 10);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
// Wurzelverzeichnis für den Dateimanager. Der Manager kann NICHT darüber hinaus.
const FILES_ROOT = path.resolve(process.env.FILES_ROOT || '/mnt/data');
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

if (ADMIN_PASSWORD === 'changeme') {
  console.warn(
    '\x1b[33m[WARNUNG] Standard-Passwort "changeme" ist aktiv. ' +
      'Bitte ADMIN_PASSWORD in der .env setzen!\x1b[0m'
  );
}

// FILES_ROOT anlegen, falls nicht vorhanden
try {
  fs.mkdirSync(FILES_ROOT, { recursive: true });
} catch (e) {
  console.warn(`[WARNUNG] Konnte FILES_ROOT (${FILES_ROOT}) nicht anlegen:`, e.message);
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
    secret: SESSION_SECRET,
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
// Auth-Routen
// ---------------------------------------------------------------------------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  // Konstantzeit-Vergleich, um Timing-Angriffe zu erschweren
  const userOk = username === ADMIN_USER;
  const passBuf = Buffer.from(String(password || ''));
  const refBuf = Buffer.from(ADMIN_PASSWORD);
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
    const containers = await docker.listContainers({ all: false }); // nur laufende
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
    res.json(containers.map(mapContainer));
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
