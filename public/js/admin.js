/* Hearth – Admin-Logik */

// Sprache sofort aus localStorage anwenden (verhindert Flackern)
if (typeof applyLang === 'function') applyLang(localStorage.getItem('hearth-lang') || 'de');

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('view-' + t.dataset.view).classList.add('active');
    if (t.dataset.view === 'images') loadImages();
    if (t.dataset.view === 'files') loadFiles(currentPath);
  });
});

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  location.href = '/login';
});

// ---------- System-Leiste ----------
async function loadSystem() {
  try {
    const s = await api('GET', '/api/system');
    const usedMem = s.memory.total - s.memory.free;
    document.getElementById('sysbar').innerHTML = `
      <div class="cell"><div class="k">Host</div><div class="v">${esc(s.hostname)}</div></div>
      <div class="cell"><div class="k">Container aktiv</div><div class="v">${s.docker.running ?? '–'} / ${s.docker.containers ?? '–'}</div></div>
      <div class="cell"><div class="k">Images</div><div class="v">${s.docker.images ?? '–'}</div></div>
      <div class="cell"><div class="k">RAM belegt</div><div class="v">${fmtBytes(usedMem)}</div></div>
      <div class="cell"><div class="k">Docker</div><div class="v" style="font-size:16px">${esc(s.docker.version || s.docker.error || '–')}</div></div>`;
  } catch (e) {
    document.getElementById('sysbar').innerHTML =
      `<div class="cell"><div class="k">Fehler</div><div class="v" style="font-size:14px;color:var(--danger)">${esc(e.message)}</div></div>`;
  }
}

// ---------- Container ----------
async function loadContainers() {
  const box = document.getElementById('containers');
  try {
    const list = await api('GET', '/api/containers');
    if (!list.length) {
      box.innerHTML = `<div class="empty"><div class="big">▣</div>${t('containers.empty')}<br><span class="muted">${t('containers.emptyHint')}</span></div>`;
      return;
    }
    box.innerHTML = list.map(containerRow).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty"><div class="big">⚠</div>${esc(e.message)}</div>`;
  }
}

function containerRow(c) {
  const running = c.state === 'running';
  const ports = c.ports
    .filter((p) => p.publicPort)
    .map((p) => `<span class="port">${p.publicPort}→${p.privatePort}</span>`)
    .join('');
  const toggle = running
    ? `<button class="btn sm" data-act="stop" data-id="${c.id}">■ ${t('containers.stop')}</button>`
    : `<button class="btn sm primary" data-act="start" data-id="${c.id}">▶ ${t('containers.start')}</button>`;
  return `
    <div class="row">
      <div class="main">
        <div class="title">
          ${esc(c.name)}
          <span class="pill ${running ? 'running' : 'stopped'}"><span class="dot"></span>${running ? t('containers.running') : esc(c.state)}</span>
        </div>
        <div class="meta">${esc(c.image)} · ${esc(c.status)}</div>
        <div class="ports">${ports}</div>
      </div>
      <div class="actions">
        ${toggle}
        <button class="btn sm ghost" data-act="restart" data-id="${c.id}" title="Neustart">⟳</button>
        <button class="btn sm ghost" data-act="logs" data-id="${c.id}" data-name="${esc(c.name)}">${t('containers.logs')}</button>
        <button class="btn sm danger" data-act="remove" data-id="${c.id}" data-name="${esc(c.name)}">🗑</button>
      </div>
    </div>`;
}

document.getElementById('containers').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, id, name } = btn.dataset;
  try {
    if (act === 'logs') {
      openLogs(id, name);
      return;
    }
    if (act === 'remove') {
      if (!confirm(t('containers.confirmRemove', { name }))) return;
      await api('DELETE', `/api/containers/${id}?force=true`);
      toast(t('toast.containerDeleted'));
    } else {
      btn.disabled = true;
      await api('POST', `/api/containers/${id}/${act}`);
      toast(t('toast.actionDone', { act }));
    }
    loadContainers();
    loadSystem();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
});

document.getElementById('refresh-containers').addEventListener('click', () => {
  loadContainers();
  loadSystem();
});

// ---------- Logs-Modal ----------
async function openLogs(id, name) {
  document.getElementById('logs-title').textContent = 'Logs · ' + name;
  document.getElementById('logs-body').textContent = 'Lade…';
  openModal('modal-logs');
  try {
    const txt = await api('GET', `/api/containers/${id}/logs?tail=300`);
    document.getElementById('logs-body').textContent = txt || '(keine Ausgabe)';
    const pre = document.getElementById('logs-body');
    pre.scrollTop = pre.scrollHeight;
  } catch (e) {
    document.getElementById('logs-body').textContent = 'Fehler: ' + e.message;
  }
}

// ---------- Images ----------
async function loadImages() {
  const box = document.getElementById('images');
  try {
    const list = await api('GET', '/api/images');
    if (!list.length) {
      box.innerHTML = `<div class="empty"><div class="big">◳</div>${t('images.empty')}</div>`;
      return;
    }
    box.innerHTML = list
      .map((img) => {
        const tags = img.tags.length ? img.tags.join(', ') : '<untagged>';
        return `<div class="row">
          <div class="main">
            <div class="title">${esc(tags)}</div>
            <div class="meta">${esc(img.id.replace('sha256:', '').slice(0, 12))} · ${fmtBytes(img.size)}</div>
          </div>
          <div class="actions">
            <button class="btn sm danger" data-img="${esc(img.id)}">🗑</button>
          </div>
        </div>`;
      })
      .join('');
  } catch (e) {
    box.innerHTML = `<div class="empty"><div class="big">⚠</div>${esc(e.message)}</div>`;
  }
}

document.getElementById('images').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-img]');
  if (!btn) return;
  if (!confirm(t('images.confirmRemove'))) return;
  try {
    await api('DELETE', `/api/images/${encodeURIComponent(btn.dataset.img)}?force=true`);
    toast(t('toast.imageDeleted'));
    loadImages();
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('pull-image').addEventListener('click', async () => {
  const image = prompt(t('images.pullPrompt'));
  if (!image) return;
  toast(t('toast.imagePulling', { image }), 'info');
  try {
    await api('POST', '/api/images/pull', { image });
    toast(t('toast.imagePulled', { image }));
    loadImages();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- Dateimanager ----------
let currentPath = '/';

function renderCrumbs() {
  const parts = currentPath.split('/').filter(Boolean);
  let acc = '';
  let html = `<a href="#" data-path="/">⌂ root</a>`;
  parts.forEach((p) => {
    acc += '/' + p;
    html += ` / <a href="#" data-path="${esc(acc)}">${esc(p)}</a>`;
  });
  document.getElementById('crumbs').innerHTML = html;
}

document.getElementById('crumbs').addEventListener('click', (e) => {
  const a = e.target.closest('[data-path]');
  if (!a) return;
  e.preventDefault();
  loadFiles(a.dataset.path);
});

async function loadFiles(p) {
  currentPath = p || '/';
  renderCrumbs();
  const box = document.getElementById('files');
  try {
    const data = await api('GET', '/api/files?path=' + encodeURIComponent(currentPath));
    if (!data.items.length) {
      box.innerHTML = `<div class="empty"><div class="big">∅</div>${t('files.empty')}</div>`;
      return;
    }
    box.innerHTML = data.items.map(fileRow).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty"><div class="big">⚠</div>${esc(e.message)}</div>`;
  }
}

function fileRow(f) {
  const full = (currentPath === '/' ? '' : currentPath) + '/' + f.name;
  const icon = f.isDir ? '📁' : '📄';
  const meta = f.isDir ? t('files.folder') : fmtBytes(f.size);
  return `
    <div class="file-row">
      <div class="fname ${f.isDir ? 'dir' : ''}" ${f.isDir ? `data-dir="${esc(full)}"` : ''}>
        <span class="ficon">${icon}</span>${esc(f.name)}
      </div>
      <span class="fmeta">${meta} · ${fmtTime(f.mtime)}</span>
      <div class="fileops">
        ${
          f.isDir
            ? ''
            : `<button class="iconbtn" title="Download" data-dl="${esc(full)}">⬇</button>`
        }
        <button class="iconbtn" title="Umbenennen" data-rn="${esc(full)}" data-name="${esc(f.name)}">✎</button>
        <button class="iconbtn danger" title="Löschen" data-del="${esc(full)}" data-name="${esc(f.name)}">🗑</button>
      </div>
    </div>`;
}

document.getElementById('files').addEventListener('click', async (e) => {
  const dir = e.target.closest('[data-dir]');
  if (dir) return loadFiles(dir.dataset.dir);

  const dl = e.target.closest('[data-dl]');
  if (dl) {
    window.location = '/api/files/download?path=' + encodeURIComponent(dl.dataset.dl);
    return;
  }

  const rn = e.target.closest('[data-rn]');
  if (rn) {
    const newName = prompt(t('files.renamePrompt'), rn.dataset.name);
    if (!newName || newName === rn.dataset.name) return;
    const to =
      (currentPath === '/' ? '' : currentPath) + '/' + newName;
    try {
      await api('POST', '/api/files/rename', { from: rn.dataset.rn, to });
      toast(t('toast.renamed'));
      loadFiles(currentPath);
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }

  const del = e.target.closest('[data-del]');
  if (del) {
    if (!confirm(t('files.confirmRemove', { name: del.dataset.name }))) return;
    try {
      await api('DELETE', '/api/files?path=' + encodeURIComponent(del.dataset.del));
      toast(t('toast.fileDeleted'));
      loadFiles(currentPath);
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

document.getElementById('mkdir').addEventListener('click', async () => {
  const name = prompt(t('files.newFolderPrompt'));
  if (!name) return;
  try {
    await api('POST', '/api/files/mkdir', { path: currentPath, name });
    toast(t('toast.folderCreated'));
    loadFiles(currentPath);
  } catch (err) {
    toast(err.message, 'error');
  }
});

// Upload (Drag & Drop + Klick)
const dz = document.getElementById('dropzone');
const fileInput = document.getElementById('fileinput');
dz.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => uploadFiles(fileInput.files));
['dragover', 'dragenter'].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add('drag');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
  })
);
dz.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

async function uploadFiles(fileList) {
  if (!fileList || !fileList.length) return;
  const fd = new FormData();
  fd.append('path', currentPath);
  [...fileList].forEach((f) => fd.append('files', f));
  toast(t('files.uploading', { count: fileList.length }), 'info');
  try {
    const r = await api('POST', '/api/files/upload', fd, true);
    toast(t('toast.filesUploaded', { count: r.count }));
    loadFiles(currentPath);
  } catch (err) {
    toast(err.message, 'error');
  }
  fileInput.value = '';
}

// ---------- Container-Erstellen-Modal ----------
function openModal(id) {
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => b.closest('.modal-backdrop').classList.remove('open'))
);
document.querySelectorAll('.modal-backdrop').forEach((m) =>
  m.addEventListener('click', (e) => {
    if (e.target === m) m.classList.remove('open');
  })
);

function portRow() {
  const d = document.createElement('div');
  d.className = 'triple';
  d.innerHTML = `
    <input class="input" placeholder="Host-Port" data-k="host" />
    <input class="input" placeholder="Container-Port" data-k="container" />
    <button class="iconbtn danger" type="button" onclick="this.parentNode.remove()">✕</button>`;
  return d;
}
function volRow() {
  const d = document.createElement('div');
  d.className = 'triple';
  d.innerHTML = `
    <input class="input" placeholder="/host/pfad" data-k="host" />
    <input class="input" placeholder="/container/pfad" data-k="container" />
    <button class="iconbtn danger" type="button" onclick="this.parentNode.remove()">✕</button>`;
  return d;
}
function kvRow(kPh, vPh) {
  const d = document.createElement('div');
  d.className = 'pair';
  d.innerHTML = `
    <input class="input" placeholder="${kPh}" data-k="key" />
    <input class="input" placeholder="${vPh}" data-k="value" />
    <button class="iconbtn danger" type="button" onclick="this.parentNode.remove()">✕</button>`;
  return d;
}

document.getElementById('add-port').onclick = () =>
  document.getElementById('c-ports').appendChild(portRow());
document.getElementById('add-vol').onclick = () =>
  document.getElementById('c-vols').appendChild(volRow());
document.getElementById('add-env').onclick = () =>
  document.getElementById('c-envs').appendChild(kvRow('KEY', 'wert'));
document.getElementById('add-label').onclick = () =>
  document.getElementById('c-labels').appendChild(kvRow('hearth.name', 'Mein Dienst'));

document.getElementById('new-container').addEventListener('click', () => {
  // Formular zurücksetzen
  ['c-image', 'c-name'].forEach((id) => (document.getElementById(id).value = ''));
  ['c-ports', 'c-vols', 'c-envs', 'c-labels'].forEach(
    (id) => (document.getElementById(id).innerHTML = '')
  );
  document.getElementById('c-ports').appendChild(portRow());
  document.getElementById('c-pull').checked = true;
  openModal('modal-create');
});

function collect(builderId, mapper) {
  return [...document.getElementById(builderId).children]
    .map((row) => {
      const o = {};
      row.querySelectorAll('[data-k]').forEach((inp) => (o[inp.dataset.k] = inp.value.trim()));
      return o;
    })
    .map(mapper)
    .filter(Boolean);
}

document.getElementById('c-submit').addEventListener('click', async () => {
  const image = document.getElementById('c-image').value.trim();
  if (!image) return toast('Image ist erforderlich', 'error');

  const payload = {
    image,
    name: document.getElementById('c-name').value.trim(),
    restart: document.getElementById('c-restart').value,
    pull: document.getElementById('c-pull').checked,
    ports: collect('c-ports', (p) => (p.container ? { host: p.host, container: p.container } : null)),
    volumes: collect('c-vols', (v) =>
      v.host && v.container ? { host: v.host, container: v.container } : null
    ),
    env: collect('c-envs', (e) => (e.key ? { key: e.key, value: e.value } : null)),
    labels: collect('c-labels', (l) => (l.key ? { key: l.key, value: l.value } : null)),
  };

  const btn = document.getElementById('c-submit');
  btn.disabled = true;
  btn.textContent = t('modal.creating');
  try {
    await api('POST', '/api/containers', payload);
    toast(t('toast.containerCreated'));
    closeModal('modal-create');
    loadContainers();
    loadSystem();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = t('modal.createStart');
  }
});

// ---------- Hearth-Einstellungen ----------
function openSettings() {
  openModal('modal-settings');
  loadSettings();
}
document.getElementById('open-settings').addEventListener('click', openSettings);
document.getElementById('btn-settings').addEventListener('click', openSettings);

document.getElementById('s-lang').addEventListener('change', function () {
  applyLang(this.value);
});

document.getElementById('pw-toggle').addEventListener('click', () => {
  const fields = document.getElementById('pw-fields');
  const btn = document.getElementById('pw-toggle');
  const open = fields.style.display === 'none';
  fields.style.display = open ? 'block' : 'none';
  btn.textContent = open ? '− Passwort ändern' : '+ Passwort ändern';
  if (!open) ['s-curpw', 's-newpw', 's-newpw2'].forEach((id) => (document.getElementById(id).value = ''));
});

async function loadSettings() {
  // Passwort-Bereich zurücksetzen
  document.getElementById('pw-fields').style.display = 'none';
  document.getElementById('pw-toggle').textContent = '+ Passwort ändern';
  ['s-curpw', 's-newpw', 's-newpw2'].forEach((id) => (document.getElementById(id).value = ''));

  try {
    const s = await api('GET', '/api/settings');
    applyLang(s.lang || 'de');
    document.getElementById('s-servername').value = s.serverName;
    document.getElementById('s-username').value = s.adminUser;
    document.getElementById('s-lang').value = s.lang || 'de';
    document.getElementById('s-showoffline').checked = !!s.showOfflineApps;
    document.getElementById('s-refresh').value = String(s.refreshInterval ?? 15);
    document.getElementById('s-port').textContent = s.port;
    document.getElementById('s-docker-socket').textContent = s.dockerSocket;
    document.getElementById('s-filesroot').textContent = s.filesRoot;
    document.getElementById('s-version').textContent = 'v' + s.version;
  } catch (e) {
    toast(e.message, 'error');
  }
}

document.getElementById('s-save').addEventListener('click', async () => {
  const serverName = document.getElementById('s-servername').value.trim();
  const adminUser = document.getElementById('s-username').value.trim();
  const lang = document.getElementById('s-lang').value;
  const showOfflineApps = document.getElementById('s-showoffline').checked;
  const refreshInterval = Number(document.getElementById('s-refresh').value);
  const curpw = document.getElementById('s-curpw').value;
  const newpw = document.getElementById('s-newpw').value;
  const newpw2 = document.getElementById('s-newpw2').value;

  if (!adminUser) { toast('Benutzername darf nicht leer sein', 'error'); return; }

  const pwOpen = document.getElementById('pw-fields').style.display !== 'none';
  if (pwOpen && newpw) {
    if (newpw.length < 8) { toast('Neues Passwort muss mindestens 8 Zeichen haben', 'error'); return; }
    if (newpw !== newpw2) { toast('Passwörter stimmen nicht überein', 'error'); return; }
    if (!curpw) { toast('Bitte aktuelles Passwort eingeben', 'error'); return; }
  }

  const payload = { serverName, adminUser, lang, showOfflineApps, refreshInterval };
  if (pwOpen && newpw) { payload.newPassword = newpw; payload.currentPassword = curpw; }

  const btn = document.getElementById('s-save');
  btn.disabled = true;
  try {
    await api('POST', '/api/settings', payload);
    closeModal('modal-settings');
    toast(t('toast.settingsSaved'));
    // Auto-Refresh neu starten mit neuem Intervall
    applyRefreshInterval(refreshInterval);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('s-restart').addEventListener('click', async () => {
  if (!confirm(t('settings.restart') + '?')) return;
  try {
    await api('POST', '/api/system/restart');
    toast(t('toast.restarting'), 'info');
    setTimeout(() => location.reload(), 4000);
  } catch (e) {
    // Verbindungsfehler ist erwartet, da der Server neu startet
    toast(t('toast.restarting'), 'info');
    setTimeout(() => location.reload(), 4000);
  }
});

// ---------- Init ----------
let refreshTimer = null;

function applyRefreshInterval(seconds) {
  clearInterval(refreshTimer);
  if (seconds > 0) refreshTimer = setInterval(loadSystem, seconds * 1000);
}

// Startwert aus gespeicherter Einstellung laden
api('GET', '/api/settings').then((s) => applyRefreshInterval(s.refreshInterval ?? 15)).catch(() => {});

loadSystem();
loadContainers();
applyRefreshInterval(15); // Default bis Settings geladen
