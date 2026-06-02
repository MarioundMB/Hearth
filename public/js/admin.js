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
    if (t.dataset.view === 'images')   loadImages();
    if (t.dataset.view === 'files')    loadFiles(currentPath);
    if (t.dataset.view === 'proxy')    loadProxyRules();
    if (t.dataset.view === 'firewall') loadFirewall();
  });
});

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  location.href = '/login';
});

// ---------- Monitoring-Sidebar ----------
const MON_HISTORY = 60; // Datenpunkte im Chart (je 2s = 2 Minuten)
const netRxHistory = Array(MON_HISTORY).fill(0);
const netTxHistory = Array(MON_HISTORY).fill(0);

// Uptime in lesbares Format
function fmtUptime(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// SVG-Liniendiagramm aus einem Wertearray erzeugen
function buildChartPoints(data, W, H, maxVal) {
  if (maxVal <= 0) maxVal = 1;
  const step = W / (data.length - 1);
  return data.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / maxVal) * H).toFixed(1)}`).join(' ');
}

function updateNetChart() {
  const W = 248, H = 52;
  const maxVal = Math.max(...netRxHistory, ...netTxHistory, 0.01);
  const rxPts = buildChartPoints(netRxHistory, W, H, maxVal);
  const txPts = buildChartPoints(netTxHistory, W, H, maxVal);

  document.getElementById('mon-rx-line').setAttribute('points', rxPts);
  document.getElementById('mon-tx-line').setAttribute('points', txPts);

  // Flächen (polyline → polygon, untere Kante schließen)
  const rxArea = `${rxPts} ${W},${H} 0,${H}`;
  const txArea = `${txPts} ${W},${H} 0,${H}`;
  document.getElementById('mon-rx-area').setAttribute('points', rxArea);
  document.getElementById('mon-tx-area').setAttribute('points', txArea);
}

// Disk-Widgets rendern
let diskData = [];
let activeDiskTab = 'total';

function renderDisks() {
  if (!diskData.length) {
    document.getElementById('mon-disk-total').innerHTML = '<div class="mon-sub">No disk data</div>';
    document.getElementById('mon-disk-each').innerHTML = '';
    return;
  }

  // Gesamtansicht: Summe aller Festplatten
  const totalBytes = diskData.reduce((a, d) => a + d.total, 0);
  const usedBytes  = diskData.reduce((a, d) => a + d.used, 0);
  const totalPct   = totalBytes ? Math.round((usedBytes / totalBytes) * 100) : 0;
  const fillClass  = totalPct > 90 ? 'crit' : totalPct > 75 ? 'warn' : '';
  document.getElementById('mon-disk-total').innerHTML = `
    <div class="mon-disk-row">
      <div class="mon-disk-label">
        <span>All disks</span>
        <span>${fmtBytes(usedBytes)} / ${fmtBytes(totalBytes)} · ${totalPct}%</span>
      </div>
      <div class="mon-bar"><div class="mon-bar-fill ${fillClass}" style="width:${totalPct}%"></div></div>
    </div>`;

  // Einzelansicht: jede Partition
  document.getElementById('mon-disk-each').innerHTML = diskData.map((d) => {
    const pct = d.total ? Math.round((d.used / d.total) * 100) : 0;
    const fc  = pct > 90 ? 'crit' : pct > 75 ? 'warn' : '';
    return `<div class="mon-disk-row">
      <div class="mon-disk-label">
        <span style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.mount)}</span>
        <span>${fmtBytes(d.used)} / ${fmtBytes(d.total)} · ${pct}%</span>
      </div>
      <div class="mon-bar"><div class="mon-bar-fill ${fc}" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}

// Disk-Tab-Wechsel
document.querySelectorAll('[data-disktab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeDiskTab = btn.dataset.disktab;
    document.querySelectorAll('[data-disktab]').forEach((b) => b.classList.toggle('active', b === btn));
    document.getElementById('mon-disk-total').style.display = activeDiskTab === 'total' ? '' : 'none';
    document.getElementById('mon-disk-each').style.display  = activeDiskTab === 'each'  ? '' : 'none';
  });
});

// Haupt-Monitoring-Update (wird alle 2s aufgerufen)
async function updateMonitor() {
  let m;
  try { m = await api('GET', '/api/monitor'); } catch (_) { return; }

  // CPU
  const cpuPct = m.cpu.percent ?? 0;
  document.getElementById('mon-cpu-pct').textContent   = cpuPct + '%';
  document.getElementById('mon-cpu-bar').style.width   = cpuPct + '%';
  document.getElementById('mon-cpu-bar').className     = 'mon-bar-fill' + (cpuPct > 90 ? ' crit' : cpuPct > 75 ? ' warn' : '');
  document.getElementById('mon-cpu-cores').textContent = `${m.cpu.cores} cores`;

  // RAM
  const ramPct = Math.round((m.mem.used / m.mem.total) * 100);
  document.getElementById('mon-ram-pct').textContent    = ramPct + '%';
  document.getElementById('mon-ram-bar').style.width    = ramPct + '%';
  document.getElementById('mon-ram-bar').className      = 'mon-bar-fill' + (ramPct > 90 ? ' crit' : ramPct > 75 ? ' warn' : '');
  document.getElementById('mon-ram-detail').textContent = fmtBytes(m.mem.used) + ' / ' + fmtBytes(m.mem.total);

  // Network
  const rx = m.net.rxMbps, tx = m.net.txMbps;
  netRxHistory.push(rx); netRxHistory.shift();
  netTxHistory.push(tx); netTxHistory.shift();
  document.getElementById('mon-rx').textContent = '↓ ' + rx.toFixed(2);
  document.getElementById('mon-tx').textContent = '↑ ' + tx.toFixed(2);
  updateNetChart();

  // Disks
  diskData = m.disks || [];
  renderDisks();

  // Temperaturen
  const tempsBox = document.getElementById('mon-temps-body');
  if (m.temps && m.temps.length) {
    tempsBox.innerHTML = m.temps.map((t) => {
      const cls = t.value > 80 ? 'hot' : t.value > 60 ? 'warm' : '';
      return `<div class="mon-temp-row">
        <span class="mon-temp-key">${esc(t.label)}</span>
        <span class="mon-temp-val ${cls}">${t.value}°C</span>
      </div>`;
    }).join('');
  } else {
    tempsBox.innerHTML = '<div class="mon-sub">No sensors found</div>';
  }

  // System-Info
  const sys = m.system || {};
  document.getElementById('mon-hostname').textContent  = sys.hostname || '–';
  document.getElementById('mon-uptime').textContent    = sys.uptime ? fmtUptime(sys.uptime) : '–';
  const la = sys.loadavg || [];
  document.getElementById('mon-load').textContent      = la.length ? la.map((v) => v.toFixed(2)).join(' ') : '–';
  document.getElementById('mon-ctr-stat').textContent  = sys.running != null ? `${sys.running} / ${sys.containers} running` : '–';
  document.getElementById('mon-docker-ver').textContent = sys.dockerVersion || '–';
}

// ---------- Container ----------
async function loadContainers() {
  const box = document.getElementById('containers');
  try {
    const list = await api('GET', '/api/containers');
    _cdListData = list;
    if (!list.length) {
      box.innerHTML = `<div class="empty"><div class="big">▣</div>${t('containers.empty')}<br><span class="muted">${t('containers.emptyHint')}</span></div>`;
      return;
    }
    box.innerHTML = list.map(containerRow).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty"><div class="big">⚠</div>${esc(e.message)}</div>`;
  }
}

// Update-Cache: { containerId → { hasUpdate, image } }
let _updateMap = {};

// Container-Zeile: kein Aktionsbutton, nur klickbar
function containerRow(c) {
  const running = c.state === 'running';
  const ports = c.ports.filter((p) => p.publicPort);
  const portBadges = ports.map((p) => `<span class="port">${p.publicPort}→${p.privatePort}</span>`).join('');
  const webUrl = getContainerWebUrl(c);
  const openBtn = webUrl
    ? `<a href="${esc(webUrl)}" target="_blank" rel="noopener"
         class="btn sm ghost row-open-btn" title="Open in new tab"
         onclick="event.stopPropagation()">↗</a>`
    : '';
  const upd = _updateMap[c.id];
  const updateBadge = upd?.hasUpdate
    ? `<span class="update-dot" title="Update available" data-update-id="${esc(c.id)}" data-update-name="${esc(c.name)}">↑</span>`
    : '';
  return `
    <div class="row row-clickable" data-cid="${esc(c.id)}" data-cname="${esc(c.name)}">
      <div class="main">
        <div class="title">
          ${esc(c.name)}
          <span class="pill ${running ? 'running' : 'stopped'}"><span class="dot"></span>${running ? t('containers.running') : esc(c.state)}</span>
          ${updateBadge}
        </div>
        <div class="meta">${esc(c.image)} · ${esc(c.status)}</div>
        <div class="ports">${portBadges}</div>
      </div>
      ${openBtn}
      <span class="row-chevron">›</span>
    </div>`;
}

document.getElementById('containers').addEventListener('click', (e) => {
  // Update badge clicked
  const upd = e.target.closest('[data-update-id]');
  if (upd) { e.stopPropagation(); updateContainer(upd.dataset.updateId, upd.dataset.updateName); return; }
  // Row click → open detail
  const row = e.target.closest('[data-cid]');
  if (row) openContainerDetail(row.dataset.cid, row.dataset.cname);
});

// ---------- Container-Detail-Modal ----------
let _cdCurrentId = null;
let _cdListData  = null;

function getContainerWebUrl(c) {
  const l = c.labels || {};
  if (l['hearth.url']) return l['hearth.url'];
  const pub = (c.ports || []).filter((p) => p.publicPort);
  if (!pub.length) return null;
  let port = pub[0].publicPort;
  if (l['hearth.port']) {
    const m = pub.find((p) => String(p.privatePort) === l['hearth.port']);
    if (m) port = m.publicPort;
  }
  const scheme = l['hearth.scheme'] || 'http';
  return `${scheme}://${location.hostname}:${port}`;
}

function openContainerDetail(id, name) {
  _cdCurrentId = id;
  // Info aus der Liste nehmen (schnell, kein Extra-Request)
  const c = (_cdListData || []).find((x) => x.id === id) || { id, name, state: '?', image: '?', status: '?', ports: [], labels: {} };
  const running = c.state === 'running';

  document.getElementById('cd-title').textContent = c.name;
  document.getElementById('cd-name-label').textContent = c.name;

  const pill = document.getElementById('cd-pill');
  pill.className = `pill ${running ? 'running' : 'stopped'}`;
  pill.innerHTML = `<span class="dot"></span>${running ? 'running' : c.state}`;

  document.getElementById('cd-m-image').textContent  = c.image;
  document.getElementById('cd-m-status').textContent = c.status;
  document.getElementById('cd-m-id').textContent     = c.shortId || id.slice(0, 12);
  const portText = (c.ports || []).filter((p) => p.publicPort).map((p) => `${p.publicPort}→${p.privatePort}`).join(', ') || '–';
  document.getElementById('cd-m-ports').textContent  = portText;

  // Stop/Start-Button
  const toggleBtn = document.getElementById('cd-toggle-btn');
  if (running) { toggleBtn.textContent = '■ Stop'; toggleBtn.className = 'btn sm'; }
  else         { toggleBtn.textContent = '▶ Start'; toggleBtn.className = 'btn sm primary'; }

  // Öffnen-Button
  const openBtn = document.getElementById('cd-open-btn');
  const webUrl  = getContainerWebUrl(c);
  openBtn.style.display = webUrl ? '' : 'none';
  openBtn.onclick = () => window.open(webUrl, '_blank');

  // Edit-View ausblenden
  document.getElementById('cd-info-view').style.display  = '';
  document.getElementById('cd-edit-view').style.display  = 'none';

  openModal('modal-cd');
}

// Helfer für Edit-Form-Zeilen (mit Pre-fill)
function edPortRow(host = '', container = '', proto = 'tcp') {
  const d = document.createElement('div');
  d.style.cssText = 'display:grid;grid-template-columns:1fr 1fr auto auto;gap:8px;margin-bottom:8px';
  d.innerHTML = `
    <input class="input" placeholder="Host Port" data-k="host" value="${esc(String(host))}" />
    <input class="input" placeholder="Container Port" data-k="container" value="${esc(String(container))}" />
    <select class="input" data-k="proto" style="padding:10px 6px">
      <option value="tcp" ${proto === 'tcp' ? 'selected' : ''}>TCP</option>
      <option value="udp" ${proto === 'udp' ? 'selected' : ''}>UDP</option>
    </select>
    <button class="iconbtn danger" type="button" onclick="this.parentNode.remove()">✕</button>`;
  return d;
}

function edVolRow(host = '', container = '') {
  const d = document.createElement('div');
  d.className = 'pair'; d.style.marginBottom = '8px';
  d.innerHTML = `
    <input class="input" placeholder="/host/path" data-k="host" value="${esc(host)}" />
    <input class="input" placeholder="/container/path" data-k="container" value="${esc(container)}" />
    <button class="iconbtn danger" type="button" onclick="this.parentNode.remove()">✕</button>`;
  return d;
}

function edKvRow(k = '', v = '', kPh = 'KEY', vPh = 'value') {
  const d = document.createElement('div');
  d.className = 'pair'; d.style.marginBottom = '8px';
  d.innerHTML = `
    <input class="input" placeholder="${kPh}" data-k="key" value="${esc(k)}" />
    <input class="input" placeholder="${vPh}" data-k="value" value="${esc(v)}" />
    <button class="iconbtn danger" type="button" onclick="this.parentNode.remove()">✕</button>`;
  return d;
}

function collectEdit(builderId, mapper) {
  return [...document.getElementById(builderId).children]
    .map((row) => { const o = {}; row.querySelectorAll('[data-k]').forEach((i) => (o[i.dataset.k] = i.value.trim())); return mapper(o); })
    .filter(Boolean);
}

// "Bearbeiten" — lädt vollständige Container-Inspektion und füllt Formular
document.getElementById('cd-edit-btn').addEventListener('click', async () => {
  const btn = document.getElementById('cd-edit-btn');
  btn.textContent = 'Loading…'; btn.disabled = true;
  try {
    const inspect = await api('GET', `/api/containers/${_cdCurrentId}`);
    populateEditForm(inspect);
    document.getElementById('cd-info-view').style.display = 'none';
    document.getElementById('cd-edit-view').style.display = '';
  } catch (e) {
    showDockerError(e.message);
  } finally {
    btn.textContent = '✎ Bearbeiten'; btn.disabled = false;
  }
});

function populateEditForm(ins) {
  const [imgName, imgTag] = (ins.Config?.Image || '').split(':');
  document.getElementById('cd-image').value    = imgName || '';
  document.getElementById('cd-tag').value      = imgTag  || 'latest';
  document.getElementById('cd-cname').value    = (ins.Name || '').replace(/^\//, '');
  document.getElementById('cd-hostname').value = ins.Config?.Hostname || '';
  document.getElementById('cd-restart').value  = ins.HostConfig?.RestartPolicy?.Name || 'unless-stopped';
  document.getElementById('cd-privileged').checked = !!ins.HostConfig?.Privileged;

  // Network mode (strip leading / for custom networks)
  const nm = ins.HostConfig?.NetworkMode || 'bridge';
  const netSel = document.getElementById('cd-network');
  const knownNets = ['bridge','host','none'];
  if (!knownNets.includes(nm)) {
    // Custom network — add as option if not there
    if (![...netSel.options].some((o) => o.value === nm)) {
      const opt = document.createElement('option');
      opt.value = nm; opt.textContent = nm;
      netSel.appendChild(opt);
    }
  }
  netSel.value = nm;

  // Hearth-Labels
  const l = ins.Config?.Labels || {};
  document.getElementById('cd-hearth-name').value = l['hearth.name'] || '';
  document.getElementById('cd-hearth-icon').value = l['hearth.icon'] || '';
  document.getElementById('cd-hearth-url').value  = l['hearth.url']  || '';

  // Ports
  const portsBox = document.getElementById('cd-ports');
  portsBox.innerHTML = '';
  for (const [key, bindings] of Object.entries(ins.HostConfig?.PortBindings || {})) {
    const [cp, proto] = key.split('/');
    const hp = bindings?.[0]?.HostPort || '';
    portsBox.appendChild(edPortRow(hp, cp, proto || 'tcp'));
  }

  // Volumes
  const volsBox = document.getElementById('cd-vols');
  volsBox.innerHTML = '';
  for (const bind of ins.HostConfig?.Binds || []) {
    const [h, c] = bind.split(':');
    volsBox.appendChild(edVolRow(h, c));
  }

  // Env
  const envBox = document.getElementById('cd-envs');
  envBox.innerHTML = '';
  for (const e of ins.Config?.Env || []) {
    const idx = e.indexOf('=');
    envBox.appendChild(edKvRow(idx >= 0 ? e.slice(0, idx) : e, idx >= 0 ? e.slice(idx + 1) : ''));
  }

  // Custom labels (skip internal Docker/hearth ones)
  const labelsBox = document.getElementById('cd-labels');
  labelsBox.innerHTML = '';
  const skipPrefixes = ['org.opencontainers', 'hearth.', 'maintainer', 'com.docker'];
  for (const [k, v] of Object.entries(l)) {
    if (skipPrefixes.some((p) => k.startsWith(p))) continue;
    labelsBox.appendChild(edKvRow(k, v, 'label key', 'value'));
  }
}

// Add-Buttons im Edit-Formular
document.getElementById('cd-add-port').onclick  = () => document.getElementById('cd-ports').appendChild(edPortRow());
document.getElementById('cd-add-vol').onclick   = () => document.getElementById('cd-vols').appendChild(edVolRow());
document.getElementById('cd-add-env').onclick   = () => document.getElementById('cd-envs').appendChild(edKvRow());
document.getElementById('cd-add-label').onclick = () => document.getElementById('cd-labels').appendChild(edKvRow('', '', 'label key', 'value'));

// Cancel Edit → zurück zur Info-View
document.getElementById('cd-edit-cancel').addEventListener('click', () => {
  document.getElementById('cd-info-view').style.display = '';
  document.getElementById('cd-edit-view').style.display = 'none';
});

// Speichern & neu starten
document.getElementById('cd-save-btn').addEventListener('click', async () => {
  const imgName = document.getElementById('cd-image').value.trim();
  const imgTag  = document.getElementById('cd-tag').value.trim() || 'latest';
  if (!imgName) { toast('Image name is required', 'error'); return; }

  // Hearth-Labels aus den Form-Feldern + custom labels
  const hearthLabels = [];
  const hn = document.getElementById('cd-hearth-name').value.trim();
  const hi = document.getElementById('cd-hearth-icon').value.trim();
  const hu = document.getElementById('cd-hearth-url').value.trim();
  if (hn) hearthLabels.push({ key: 'hearth.name', value: hn });
  if (hi) hearthLabels.push({ key: 'hearth.icon', value: hi });
  if (hu) hearthLabels.push({ key: 'hearth.url',  value: hu });

  const customLabels = collectEdit('cd-labels', (l) => l.key ? l : null);
  const allLabels = [...hearthLabels, ...customLabels];

  const payload = {
    image:      `${imgName}:${imgTag}`,
    name:       document.getElementById('cd-cname').value.trim() || undefined,
    hostname:   document.getElementById('cd-hostname').value.trim() || undefined,
    network:    document.getElementById('cd-network').value,
    restart:    document.getElementById('cd-restart').value,
    privileged: document.getElementById('cd-privileged').checked,
    ports:   collectEdit('cd-ports',  (p) => p.container ? p : null),
    volumes: collectEdit('cd-vols',   (v) => v.host && v.container ? v : null),
    env:     collectEdit('cd-envs',   (e) => e.key ? e : null),
    labels:  allLabels,
  };

  const btn = document.getElementById('cd-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await api('PUT', `/api/containers/${_cdCurrentId}`, payload);
    toast('Container recreated successfully');
    closeModal('modal-cd');
    loadContainers();
  } catch (e) {
    showDockerError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = '💾 Save & Restart';
  }
});

// Stop/Start/Restart/Delete aus dem Info-Footer
async function cdContainerAction(act) {
  try {
    if (act === 'delete') {
      const name = document.getElementById('cd-name-label').textContent;
      if (!confirm(t('containers.confirmRemove', { name }))) return;
      await api('DELETE', `/api/containers/${_cdCurrentId}?force=true`);
      toast(t('toast.containerDeleted'));
      closeModal('modal-cd');
    } else {
      await api('POST', `/api/containers/${_cdCurrentId}/${act}`);
      toast(t('toast.actionDone', { act }));
      closeModal('modal-cd');
    }
    loadContainers();
  } catch (e) { showDockerError(e.message); }
}

document.getElementById('cd-toggle-btn').addEventListener('click', () => {
  const running = document.getElementById('cd-pill').classList.contains('running');
  cdContainerAction(running ? 'stop' : 'start');
});
document.getElementById('cd-restart-btn').addEventListener('click', () => cdContainerAction('restart'));
document.getElementById('cd-logs-btn').addEventListener('click', () => {
  const name = document.getElementById('cd-name-label').textContent;
  closeModal('modal-cd');
  openLogs(_cdCurrentId, name);
});
document.getElementById('cd-delete-btn').addEventListener('click', () => cdContainerAction('delete'));

document.getElementById('refresh-containers').addEventListener('click', () => {
  loadContainers();
  updateMonitor();
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
    showDockerError(err.message);
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
    showDockerError(err.message);
  }
});

// ---------- Dateimanager ----------
let currentPath = '/';

// Navigationsverlauf für Maus-Zurück/Vorwärts-Tasten
const fileNav = { history: ['/'], idx: 0 };

function navigate(path) {
  if (path === currentPath) return;
  fileNav.history = fileNav.history.slice(0, fileNav.idx + 1);
  fileNav.history.push(path);
  fileNav.idx = fileNav.history.length - 1;
  loadFiles(path);
}

function navigateBack() {
  if (fileNav.idx <= 0) return;
  fileNav.idx--;
  loadFiles(fileNav.history[fileNav.idx]);
}

function navigateForward() {
  if (fileNav.idx >= fileNav.history.length - 1) return;
  fileNav.idx++;
  loadFiles(fileNav.history[fileNav.idx]);
}

// Maus-Seitentasten (Button 3 = Zurück, Button 4 = Vorwärts)
// nur wenn der Dateimanager-Tab aktiv ist
document.addEventListener('mousedown', (e) => {
  if (!document.getElementById('view-files').classList.contains('active')) return;
  if (e.button === 3 || e.button === 4) e.preventDefault();
});
document.addEventListener('mouseup', (e) => {
  if (!document.getElementById('view-files').classList.contains('active')) return;
  if (e.button === 3) { e.preventDefault(); navigateBack(); }
  if (e.button === 4) { e.preventDefault(); navigateForward(); }
});

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
  navigate(a.dataset.path);
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
  if (dir) return navigate(dir.dataset.dir);

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

function portRow(host = '', container = '', proto = 'tcp') {
  const d = document.createElement('div');
  d.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 80px auto;gap:8px;margin-bottom:8px';
  d.innerHTML = `
    <input class="input" placeholder="Host Port" data-k="host" value="${host}" />
    <input class="input" placeholder="Container Port" data-k="container" value="${container}" />
    <select class="input" data-k="proto" style="padding:10px 6px">
      <option value="tcp" ${proto === 'tcp' ? 'selected' : ''}>TCP</option>
      <option value="udp" ${proto === 'udp' ? 'selected' : ''}>UDP</option>
    </select>
    <button class="iconbtn danger" type="button" onclick="this.parentNode.remove()">✕</button>`;
  return d;
}
function volRow(host = '', container = '') {
  const d = document.createElement('div');
  d.style.cssText = 'display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:8px';
  d.innerHTML = `
    <input class="input" placeholder="/host/path" data-k="host" value="${host}" />
    <input class="input" placeholder="/container/path" data-k="container" value="${container}" />
    <button class="iconbtn danger" type="button" onclick="this.parentNode.remove()">✕</button>`;
  return d;
}
function kvRow(kPh, vPh) {
  const d = document.createElement('div');
  d.style.cssText = 'display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:8px';
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
  ['c-image', 'c-name', 'c-display-name', 'c-icon-field', 'c-web-url'].forEach((id) => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  ['c-ports', 'c-vols', 'c-envs', 'c-labels'].forEach(
    (id) => (document.getElementById(id).innerHTML = '')
  );
  document.getElementById('c-ports').appendChild(portRow());
  document.getElementById('c-pull').checked = true;
  // Icon-Vorschau zurücksetzen
  ['c-icon-preview', 'c-icon-preview-sm'].forEach((id) => {
    const el = document.getElementById(id); if (el) el.textContent = '🐳';
  });
  // Auf Form-Tab wechseln
  switchCreateTab('form');
  ['docker-run-input', 'compose-input'].forEach((id) => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
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

  // App-Settings → Hearth-Labels
  const appLabels = [];
  const dispName = document.getElementById('c-display-name')?.value.trim();
  const iconVal  = document.getElementById('c-icon-field')?.value.trim();
  const webUrl   = document.getElementById('c-web-url')?.value.trim();
  if (dispName) appLabels.push({ key: 'hearth.name', value: dispName });
  if (iconVal)  appLabels.push({ key: 'hearth.icon', value: iconVal });
  if (webUrl)   appLabels.push({ key: 'hearth.url',  value: webUrl });

  const payload = {
    image,
    name: document.getElementById('c-name').value.trim(),
    restart: document.getElementById('c-restart').value,
    pull: document.getElementById('c-pull').checked,
    ports: collect('c-ports', (p) => (p.container ? { host: p.host, container: p.container, proto: p.proto || 'tcp' } : null)),
    volumes: collect('c-vols', (v) =>
      v.host && v.container ? { host: v.host, container: v.container } : null
    ),
    env: collect('c-envs', (e) => (e.key ? { key: e.key, value: e.value } : null)),
    labels: [
      ...appLabels,
      ...collect('c-labels', (l) => (l.key ? { key: l.key, value: l.value } : null)),
    ],
  };

  const btn = document.getElementById('c-submit');
  btn.disabled = true;
  btn.textContent = t('modal.creating');
  try {
    await api('POST', '/api/containers', payload);
    toast(t('toast.containerCreated'));
    closeModal('modal-create');
    loadContainers();
  } catch (err) {
    showDockerError(err.message);
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

// ---------- Quick Install (Drag & Drop / Paste) ----------

function parseDockerInput(text) {
  text = (text || '').trim();
  // Docker Hub URL: hub.docker.com/_/nginx oder hub.docker.com/r/ns/name
  try {
    const u = new URL(text);
    if (u.hostname === 'hub.docker.com') {
      const m1 = u.pathname.match(/^\/_\/([a-z0-9_.-]+)/i);
      if (m1) return m1[1];
      const m2 = u.pathname.match(/^\/r\/([a-z0-9_.-]+\/[a-z0-9_.-]+)/i);
      if (m2) return m2[1];
    }
  } catch (_) {}
  // Einfacher Image-Name (nginx, nginx:latest, ns/name, ns/name:tag)
  if (/^[a-z0-9._/-]+(:[a-z0-9._-]+)?$/i.test(text) && !text.includes('://')) {
    return text.replace(/^docker\.io\//, '').replace(/^library\//, '');
  }
  return null;
}

function imageToName(image) {
  return image.split(':')[0].split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function fmtPulls(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(0) + 'B+';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + 'M+';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K+';
  return String(n);
}

async function openQuickInstall(image) {
  // Overlay schließen, falls noch sichtbar
  document.getElementById('drop-overlay').classList.remove('active');

  // Modal öffnen, Ladestate zeigen
  document.getElementById('qi-loading').style.display = 'flex';
  document.getElementById('qi-info').style.display    = 'none';
  document.getElementById('qi-image').value           = image;
  document.getElementById('qi-name').value            = imageToName(image);
  document.getElementById('qi-install').disabled      = false;
  document.getElementById('qi-install').textContent   = '⚡ Install';
  openModal('modal-qi');

  // Metadaten von Docker Hub holen
  try {
    const info = await api('GET', `/api/dockerhub/info?image=${encodeURIComponent(image)}`);
    document.getElementById('qi-loading').style.display = 'none';
    if (info.found) {
      document.getElementById('qi-info').style.display   = 'flex';
      document.getElementById('qi-meta-name').textContent = info.image;
      document.getElementById('qi-meta-desc').textContent = info.description || '';
      document.getElementById('qi-official').style.display = info.isOfficial ? '' : 'none';
      document.getElementById('qi-stats').textContent =
        `↓ ${fmtPulls(info.pullCount)} pulls  ⭐ ${fmtPulls(info.starCount)} stars`;
      const logoEl = document.getElementById('qi-logo');
      if (info.logoUrl) {
        logoEl.innerHTML = `<img src="${esc(info.logoUrl)}" alt="" onerror="this.parentNode.textContent='🐳'">`;
      } else {
        logoEl.textContent = '🐳';
      }
      // Image-Feld auf kanonischen Namen aktualisieren
      if (!document.getElementById('qi-image').value.includes(':')) {
        document.getElementById('qi-image').value = info.image;
        document.getElementById('qi-name').value  = imageToName(info.image);
      }
    }
  } catch (_) {
    document.getElementById('qi-loading').style.display = 'none';
  }
}

document.getElementById('qi-install').addEventListener('click', async () => {
  const image = document.getElementById('qi-image').value.trim();
  if (!image) { toast('Image name required', 'error'); return; }
  const name  = document.getElementById('qi-name').value.trim();
  const btn   = document.getElementById('qi-install');
  btn.disabled = true;
  btn.textContent = 'Installing…';
  try {
    await api('POST', '/api/containers', {
      image, name: name || undefined,
      pull: true, restart: 'unless-stopped',
      ports: [], volumes: [], env: [], labels: [],
    });
    toast('Installed: ' + (name || image));
    closeModal('modal-qi');
    loadContainers();
  } catch (err) {
    showDockerError(err.message);
    btn.disabled = false;
    btn.textContent = '⚡ Install';
  }
});

document.getElementById('qi-open-full').addEventListener('click', () => {
  const image = document.getElementById('qi-image').value.trim();
  const name  = document.getElementById('qi-name').value.trim();
  closeModal('modal-qi');
  // Existierendes Create-Modal mit Werten vorausfüllen
  document.getElementById('c-image').value = image;
  document.getElementById('c-name').value  = name;
  ['c-ports','c-vols','c-envs','c-labels'].forEach((id) => (document.getElementById(id).innerHTML = ''));
  document.getElementById('c-ports').appendChild(portRow());
  document.getElementById('c-pull').checked = true;
  openModal('modal-create');
});

// Live-Update des Container-Namens wenn Image geändert wird
document.getElementById('qi-image').addEventListener('input', function () {
  const parsed = parseDockerInput(this.value);
  if (parsed) document.getElementById('qi-name').value = imageToName(parsed);
});

// ── Drag & Drop ──────────────────────────────────────────────────────────────
let _dragActive = false;

document.addEventListener('dragover', (e) => {
  const types = Array.from(e.dataTransfer?.types || []);
  if (types.includes('text/uri-list') || types.includes('text/plain')) {
    e.preventDefault();
    if (!_dragActive) {
      _dragActive = true;
      document.getElementById('drop-overlay').classList.add('active');
    }
  }
});

document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) {
    _dragActive = false;
    document.getElementById('drop-overlay').classList.remove('active');
  }
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  _dragActive = false;
  document.getElementById('drop-overlay').classList.remove('active');
  const raw = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
  const image = parseDockerInput(raw.split('\n')[0].trim());
  if (image) {
    openQuickInstall(image);
  } else {
    toast('No Docker image found in dropped content', 'error');
  }
});

// ── Paste (Ctrl+V außerhalb von Inputs) ──────────────────────────────────────
document.addEventListener('paste', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const text = e.clipboardData?.getData('text') || '';
  const image = parseDockerInput(text.split('\n')[0].trim());
  if (image) openQuickInstall(image);
});

// ---------- Fehler-Klassifizierung & Modal ----------
const DOCKER_ERRORS = [
  {
    pattern: /port.*already.*allocated|address already in use|bind.*address.*already/i,
    code: 'PORT_CONFLICT',
    title: 'Port already in use',
    desc: 'Another container or process is already listening on the requested port. Two services cannot share the same host port.',
    steps: [
      'Choose a different host port in the port mapping (e.g. <code>8081:80</code> instead of <code>8080:80</code>)',
      'Find what is using the port: <code>lsof -i :PORT</code> (Linux/Mac) or <code>netstat -ano | findstr :PORT</code> (Windows)',
      'Stop the conflicting container or service first',
    ],
    link: 'https://docs.docker.com/config/containers/container-networking/',
  },
  {
    pattern: /no such image|manifest.*unknown|repository.*does not exist|name.*not known|not found in registry/i,
    code: 'IMAGE_NOT_FOUND',
    title: 'Image not found',
    desc: 'The Docker image could not be found — either it does not exist on Docker Hub, the name is misspelled, or the tag is wrong.',
    steps: [
      'Double-check the image name and tag on <code>hub.docker.com</code>',
      'Enable "Pull image before start" so Docker fetches it automatically',
      'If it is a private image, log in first: <code>docker login</code>',
    ],
    link: 'https://hub.docker.com',
  },
  {
    pattern: /conflict.*name.*already.*use|container.*already.*exists/i,
    code: 'NAME_CONFLICT',
    title: 'Container name already in use',
    desc: 'A container with this exact name already exists on this Docker host (even if it is stopped).',
    steps: [
      'Choose a different container name',
      'Or delete the existing container with the same name first',
    ],
    link: null,
  },
  {
    pattern: /permission denied.*docker|cannot connect.*daemon|dial unix.*docker\.sock|no such file.*docker\.sock/i,
    code: 'DOCKER_UNREACHABLE',
    title: 'Cannot connect to Docker',
    desc: 'Hearth cannot communicate with the Docker daemon. The socket is either missing, inaccessible, or Docker is not running.',
    steps: [
      'Make sure Docker is running on the host',
      'Verify the Docker socket is mounted: <code>/var/run/docker.sock:/var/run/docker.sock</code>',
      'On Linux, the user may need to be in the docker group: <code>sudo usermod -aG docker $USER</code>',
    ],
    link: 'https://docs.docker.com/engine/install/linux-postinstall/',
  },
  {
    pattern: /no space left|out of.*space|disk.*quota/i,
    code: 'DISK_FULL',
    title: 'Disk full',
    desc: 'Docker ran out of disk space. This can happen when pulling large images or creating volumes.',
    steps: [
      'Remove unused images: <code>docker image prune -a</code>',
      'Remove stopped containers: <code>docker container prune</code>',
      'Full cleanup: <code>docker system prune --volumes</code>',
    ],
    link: 'https://docs.docker.com/config/pruning/',
  },
  {
    pattern: /pull access denied|unauthorized|authentication required|403 forbidden/i,
    code: 'AUTH_REQUIRED',
    title: 'Authentication required',
    desc: 'The image is from a private registry or requires a Docker Hub login. Pulling was denied.',
    steps: [
      'Log into Docker Hub on the host: <code>docker login</code>',
      'For private registries: <code>docker login registry.example.com</code>',
      'Make sure the image name and credentials are correct',
    ],
    link: 'https://docs.docker.com/engine/reference/commandline/login/',
  },
  {
    pattern: /invalid.*reference|invalid.*image.*name|invalid.*tag|repository name.*invalid/i,
    code: 'INVALID_IMAGE_NAME',
    title: 'Invalid image name or tag',
    desc: 'The image name or tag contains invalid characters or does not follow Docker naming conventions.',
    steps: [
      'Image names must be lowercase and can contain letters, digits, dots, hyphens and slashes',
      'Tags can contain letters, digits, underscores, hyphens and dots',
      'Valid example: <code>my-registry.io/myapp:1.0.0</code>',
    ],
    link: null,
  },
  {
    pattern: /path.*must be absolute|bind.*source.*invalid|invalid.*bind.*mount|no.*such.*file.*directory/i,
    code: 'INVALID_VOLUME_PATH',
    title: 'Invalid volume path',
    desc: 'A volume mount path is invalid. Host paths must exist and be absolute (starting with /).',
    steps: [
      'Use absolute paths: <code>/data/myapp</code> not <code>./data</code>',
      'Make sure the host directory exists before starting the container',
      'Check for typos in the path',
    ],
    link: null,
  },
  {
    pattern: /network.*not found|network.*does not exist/i,
    code: 'NETWORK_NOT_FOUND',
    title: 'Docker network not found',
    desc: 'The specified Docker network does not exist on this host.',
    steps: [
      'Create the network first: <code>docker network create my-network</code>',
      'Or use the default <code>bridge</code> network mode',
      'List existing networks: <code>docker network ls</code>',
    ],
    link: 'https://docs.docker.com/network/',
  },
  {
    pattern: /oci runtime.*error|failed.*start.*container|container.*start.*failed|exec.*format error/i,
    code: 'RUNTIME_START_FAILED',
    title: 'Container failed to start',
    desc: 'The container process could not be started. This is often caused by a wrong entrypoint, missing files, or an architecture mismatch.',
    steps: [
      'Check container logs for the actual error message',
      'Verify the image supports your platform (arm64 vs amd64)',
      'Make sure all required environment variables and volumes are set',
    ],
    link: null,
  },
  {
    pattern: /cannot.*stop.*container|container.*already.*stopped|no.*such.*container/i,
    code: 'CONTAINER_NOT_RUNNING',
    title: 'Container not running',
    desc: 'The operation requires the container to be running, but it is already stopped or does not exist.',
    steps: [
      'Refresh the container list and try again',
      'The container may have already stopped or been removed',
    ],
    link: null,
  },
  {
    pattern: /image.*used.*by.*stopped|conflict.*unable.*delete/i,
    code: 'IMAGE_IN_USE',
    title: 'Image is in use',
    desc: 'The image cannot be deleted because one or more containers (even stopped ones) are still using it.',
    steps: [
      'Remove all containers that use this image first',
      'Use "force delete" if you want to remove it regardless: this will also remove dependent containers',
    ],
    link: null,
  },
];

function classifyDockerError(message) {
  for (const e of DOCKER_ERRORS) {
    if (e.pattern.test(message)) return e;
  }
  return {
    code: 'DOCKER_ERROR',
    title: 'Docker operation failed',
    desc: 'An unexpected error occurred while communicating with Docker.',
    steps: [
      'Check the raw error message below for details',
      'Consult the Docker documentation or community forums',
    ],
    link: 'https://docs.docker.com',
  };
}

function renderStep(html) {
  // Backtick → <code>, danach plain text
  return html.replace(/`([^`]+)`/g, '<code>$1</code>');
}

function showDockerError(rawMessage) {
  const info = classifyDockerError(rawMessage || '');

  document.getElementById('err-code').textContent        = info.code;
  document.getElementById('err-title').textContent       = info.title;
  document.getElementById('err-description').textContent = info.desc;
  document.getElementById('err-raw').textContent         = rawMessage || '–';

  // Fix-Schritte
  const stepsBox  = document.getElementById('err-steps-box');
  const stepsDiv  = document.getElementById('err-steps');
  if (info.steps?.length) {
    stepsDiv.innerHTML = info.steps.map((s) =>
      `<div class="err-step"><span class="err-step-arrow">→</span><span>${renderStep(esc(s).replace(/&lt;code&gt;/g, '<code>').replace(/&lt;\/code&gt;/g, '</code>'))}</span></div>`
    ).join('');
    stepsBox.style.display = '';
  } else {
    stepsBox.style.display = 'none';
  }

  // Docs-Link
  const linkEl = document.getElementById('err-link');
  if (info.link) { linkEl.href = info.link; linkEl.style.display = ''; }
  else           { linkEl.style.display = 'none'; }

  // "Search fix"-Link → Google/DuckDuckGo
  document.getElementById('err-search-link').href =
    `https://duckduckgo.com/?q=docker+${encodeURIComponent(info.code.toLowerCase().replace(/_/g, '+'))}+fix`;

  openModal('modal-error');
}

// ---------- Create-Modal: Methoden-Tabs ----------
function switchCreateTab(tab) {
  ['form', 'run', 'compose'].forEach((t) => {
    document.getElementById(`ctab-${t}`).style.display = t === tab ? '' : 'none';
  });
  document.querySelectorAll('.cm-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.ctab === tab);
  });
  // Foot nur bei Form-Tab zeigen
  document.getElementById('create-modal-foot').style.display = tab === 'form' ? '' : 'none';
}

document.querySelectorAll('.cm-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchCreateTab(btn.dataset.ctab));
});

// ---------- docker run Parser ----------
function tokenizeRun(str) {
  const tokens = [];
  let buf = '', inQ = false, qChar = '';
  for (const ch of str.replace(/\\\s*\n/g, ' ').replace(/\\\s+/g, ' ')) {
    if (!inQ && (ch === '"' || ch === "'")) { inQ = true; qChar = ch; }
    else if (inQ && ch === qChar) { inQ = false; }
    else if (!inQ && ch === ' ') { if (buf) { tokens.push(buf); buf = ''; } }
    else buf += ch;
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function parseDockerRun(cmd) {
  const tokens = tokenizeRun(
    cmd.replace(/^(?:sudo\s+)?docker\s+(?:container\s+)?run\s+/, '').trim()
  );
  const r = { image: '', name: '', ports: [], volumes: [], env: [], restart: 'unless-stopped', privileged: false, labels: [], hostname: '', network: 'bridge' };
  const NEEDS_VAL = { '-p': 'port', '--publish': 'port', '-v': 'vol', '--volume': 'vol', '-e': 'env', '--env': 'env', '--name': 'name', '--restart': 'restart', '-h': 'hn', '--hostname': 'hn', '--network': 'net', '--net': 'net', '-l': 'label', '--label': 'label', '--memory': 'skip', '-m': 'skip', '--cpus': 'skip' };
  const IGNORE   = new Set(['-d', '--detach', '-it', '-i', '-t', '--rm', '-P', '--read-only', '--init']);

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const kind = NEEDS_VAL[t];
    if (IGNORE.has(t)) { i++; continue; }

    if (kind) {
      const v = tokens[++i] || '';
      if (kind === 'port') {
        const pts = v.split(':');
        const host = pts.length >= 2 ? pts[pts.length - 2] : pts[0];
        const contProto = pts[pts.length - 1];
        const [cp, proto = 'tcp'] = contProto.split('/');
        r.ports.push({ host, container: cp, proto });
      } else if (kind === 'vol') {
        const [h, c] = v.split(':');
        if (h && c) r.volumes.push({ host: h, container: c });
      } else if (kind === 'env') {
        const idx = v.indexOf('=');
        if (idx >= 0) r.env.push({ key: v.slice(0, idx), value: v.slice(idx + 1) });
      } else if (kind === 'label') {
        const idx = v.indexOf('=');
        if (idx >= 0) r.labels.push({ key: v.slice(0, idx), value: v.slice(idx + 1) });
      } else if (kind === 'name')    r.name     = v;
        else if (kind === 'restart') r.restart  = v;
        else if (kind === 'hn')      r.hostname = v;
        else if (kind === 'net')     r.network  = v;
    } else if (t === '--privileged') {
      r.privileged = true;
    } else if (!t.startsWith('-') && !r.image) {
      r.image = t;
    }
    i++;
  }
  return r;
}

// ---------- docker-compose Parser ----------
function parseDockerCompose(yaml) {
  const r = { image: '', name: '', ports: [], volumes: [], env: [], restart: 'unless-stopped', privileged: false, labels: [] };
  const lines = yaml.split('\n');
  let inSvc = false, serviceIndent = -1, curSec = '';

  for (const raw of lines) {
    const trimmed = raw.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - trimmed.length;

    if (!inSvc) {
      // Find first service name (indent 2, ends with :, follows 'services:' block)
      if (trimmed === 'services:') continue;
      if (indent === 2 && trimmed.endsWith(':')) {
        r.name = trimmed.slice(0, -1);
        serviceIndent = 2;
        inSvc = true;
      }
      continue;
    }

    // End of service block
    if (indent <= serviceIndent && trimmed !== '' && !trimmed.startsWith('-')) break;

    if (indent === serviceIndent + 2 && !trimmed.startsWith('-')) {
      const colon = trimmed.indexOf(':');
      const key = colon >= 0 ? trimmed.slice(0, colon).trim() : trimmed;
      const val = colon >= 0 ? trimmed.slice(colon + 1).trim().replace(/^["']|["']$/g, '') : '';
      curSec = key;
      if (key === 'image')      r.image     = val;
      if (key === 'restart')    r.restart   = val;
      if (key === 'privileged') r.privileged = val === 'true';
    } else if (trimmed.startsWith('- ')) {
      const val = trimmed.slice(2).trim().replace(/^["']|["']$/g, '');
      if (curSec === 'ports') {
        const [h, c] = val.split(':');
        if (h && c) r.ports.push({ host: h, container: c.split('/')[0], proto: c.includes('/udp') ? 'udp' : 'tcp' });
      } else if (curSec === 'volumes') {
        const [h, c] = val.split(':');
        if (h && c) r.volumes.push({ host: h, container: c });
      } else if (curSec === 'environment') {
        const idx = val.indexOf('=');
        if (idx >= 0) r.env.push({ key: val.slice(0, idx), value: val.slice(idx + 1) });
      } else if (curSec === 'labels') {
        const idx = val.indexOf('=');
        if (idx >= 0) r.labels.push({ key: val.slice(0, idx), value: val.slice(idx + 1) });
      }
    } else if (indent === serviceIndent + 4 && !trimmed.startsWith('-')) {
      // key: value map format (e.g. under environment:)
      const colon = trimmed.indexOf(':');
      if (colon >= 0) {
        const k = trimmed.slice(0, colon).trim();
        const v = trimmed.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
        if (curSec === 'environment') r.env.push({ key: k, value: v });
        if (curSec === 'labels')      r.labels.push({ key: k, value: v });
      }
    }
  }
  return r;
}

// Formular aus geparsten Daten befüllen und zu "Form"-Tab wechseln
function fillCreateForm(data) {
  document.getElementById('c-image').value = data.image || '';
  document.getElementById('c-name').value  = data.name  || '';

  // Restart
  const rs = document.getElementById('c-restart');
  if (data.restart && [...rs.options].some((o) => o.value === data.restart)) rs.value = data.restart;

  // Ports
  const pb = document.getElementById('c-ports'); pb.innerHTML = '';
  (data.ports?.length ? data.ports : [{}]).forEach((p) => {
    const row = portRow();
    if (p.host)      row.querySelector('[data-k="host"]').value      = p.host;
    if (p.container) row.querySelector('[data-k="container"]').value = p.container;
    pb.appendChild(row);
  });

  // Volumes
  const vb = document.getElementById('c-vols'); vb.innerHTML = '';
  data.volumes?.forEach((v) => {
    const row = volRow();
    row.querySelector('[data-k="host"]').value      = v.host      || '';
    row.querySelector('[data-k="container"]').value = v.container || '';
    vb.appendChild(row);
  });

  // Env
  const eb = document.getElementById('c-envs'); eb.innerHTML = '';
  data.env?.forEach((e) => {
    const row = kvRow('KEY', 'wert');
    row.querySelector('[data-k="key"]').value   = e.key   || '';
    row.querySelector('[data-k="value"]').value = e.value || '';
    eb.appendChild(row);
  });

  // Labels
  const lb = document.getElementById('c-labels'); lb.innerHTML = '';
  data.labels?.filter(l => !l.key?.startsWith('hearth.')).forEach((l) => {
    const row = kvRow('key', 'value');
    row.querySelector('[data-k="key"]').value   = l.key   || '';
    row.querySelector('[data-k="value"]').value = l.value || '';
    lb.appendChild(row);
  });

  switchCreateTab('form');
  if (data.image) autoFetchIcon(data.image);
}

document.getElementById('parse-run-btn').addEventListener('click', () => {
  const cmd = document.getElementById('docker-run-input').value.trim();
  if (!cmd) { toast('Please paste a docker run command', 'error'); return; }
  try { fillCreateForm(parseDockerRun(cmd)); toast('Command parsed successfully'); }
  catch (e) { toast('Parse error: ' + e.message, 'error'); }
});

document.getElementById('parse-compose-btn').addEventListener('click', () => {
  const yaml = document.getElementById('compose-input').value.trim();
  if (!yaml) { toast('Please paste a docker-compose service block', 'error'); return; }
  try { fillCreateForm(parseDockerCompose(yaml)); toast('Compose parsed successfully'); }
  catch (e) { toast('Parse error: ' + e.message, 'error'); }
});

// ---------- Auto-Icon-Fetch ----------
let _iconTimer = null;

async function autoFetchIcon(image) {
  clearTimeout(_iconTimer);
  _iconTimer = setTimeout(async () => {
    const baseImg = image.split(':')[0];
    if (!baseImg) return;
    const previews = [
      document.getElementById('c-icon-preview'),
      document.getElementById('c-icon-preview-sm'),
    ].filter(Boolean);

    previews.forEach((el) => el.classList.add('loading'));

    try {
      const r = await fetch(`/api/dockerhub/logo?image=${encodeURIComponent(baseImg)}`, { credentials: 'same-origin' });
      if (!r.ok) { previews.forEach((el) => { el.classList.remove('loading'); el.textContent = '🐳'; }); return; }

      const url = `/api/dockerhub/logo?image=${encodeURIComponent(baseImg)}`;
      previews.forEach((el) => {
        el.classList.remove('loading');
        el.innerHTML = `<img src="${esc(url)}" onerror="this.parentNode.textContent='🐳'">`;
      });

      // Icon-Feld nur füllen wenn leer
      const iconField = document.getElementById('c-icon-field');
      if (iconField && !iconField.value) iconField.value = url;

    } catch (_) {
      previews.forEach((el) => { el.classList.remove('loading'); el.textContent = '🐳'; });
    }
  }, 700);
}

// Auto-fetch wenn Image-Feld verändert wird
document.getElementById('c-image').addEventListener('input', function () {
  autoFetchIcon(this.value.trim());
});

// Icon-Feld Vorschau bei manueller Eingabe
document.getElementById('c-icon-field').addEventListener('input', function () {
  const val = this.value.trim();
  const prev = document.getElementById('c-icon-preview-sm');
  if (!prev) return;
  if (val.startsWith('http')) {
    prev.innerHTML = `<img src="${esc(val)}" onerror="this.parentNode.textContent='🐳'">`;
  } else {
    prev.textContent = val || '🐳';
  }
});

// Edit-Formular: Auto-fetch wenn Image-Feld geändert
document.getElementById('cd-image')?.addEventListener('input', function () {
  const img = this.value.trim() + ':' + (document.getElementById('cd-tag')?.value || 'latest');
  autoFetchCdIcon(img);
});
document.getElementById('cd-tag')?.addEventListener('input', function () {
  autoFetchCdIcon(document.getElementById('cd-image')?.value.trim());
});

async function autoFetchCdIcon(image) {
  if (!image) return;
  const iconField = document.getElementById('cd-hearth-icon');
  if (!iconField || iconField.value) return; // nur wenn leer
  try {
    const r = await fetch(`/api/dockerhub/logo?image=${encodeURIComponent(image.split(':')[0])}`, { credentials: 'same-origin' });
    if (r.ok && !iconField.value) iconField.value = `/api/dockerhub/logo?image=${encodeURIComponent(image.split(':')[0])}`;
  } catch (_) {}
}

// ---------- Update-Checker ----------
async function checkUpdates(force = false) {
  const badge = document.getElementById('topbar-updates');
  if (badge) badge.textContent = '⟳';
  try {
    const data = await api('GET', `/api/updates/check${force ? '?force=true' : ''}`);
    // Map aufbauen
    _updateMap = {};
    let pending = 0;
    for (const c of data.containers || []) {
      _updateMap[c.containerId] = c;
      if (c.hasUpdate) pending++;
    }
    // Update-Indikator in Topbar
    if (badge) {
      if (pending > 0) {
        badge.textContent  = `↑ ${pending} update${pending > 1 ? 's' : ''}`;
        badge.className    = 'btn sm update-available';
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
    // Container-Liste neu rendern damit Badges sichtbar werden
    if (_cdListData) loadContainers();
    // Hearth-Update-Hinweis
    const hi = data.hearth;
    if (hi && document.getElementById('hearth-update-hint')) {
      document.getElementById('hearth-update-hint').innerHTML = hi.sha
        ? `Latest GitHub commit: <span class="mono">${esc(hi.sha)}</span> · ${esc(hi.message)}`
        : '';
    }
  } catch (_) {
    if (badge) badge.style.display = 'none';
  }
}

async function updateContainer(id, name) {
  if (!confirm(`Update "${name}"? The container will be briefly stopped.`)) return;
  const btn = document.querySelector(`[data-cid="${id}"] .update-dot`);
  if (btn) btn.textContent = '⟳';
  try {
    await api('POST', `/api/updates/container/${id}`);
    toast(`Updated: ${name}`);
    _updateMap[id] = { hasUpdate: false };
    loadContainers();
    checkUpdates();
  } catch (e) { showDockerError(e.message); }
}

// ---------- Reverse Proxy ----------
async function loadProxyRules() {
  const [status, rules] = await Promise.all([
    api('GET', '/api/proxy/status').catch(() => ({ running: false, port: 80, rules: 0 })),
    api('GET', '/api/proxy/rules').catch(() => []),
  ]);

  // Status-Badge in der Toolbar
  const badge = document.getElementById('proxy-status-badge');
  if (badge) {
    badge.innerHTML = status.running
      ? `<span class="proxy-status-dot"></span><span style="font-size:12px;color:var(--ok)">Running on :${status.port}</span>`
      : `<span class="proxy-status-dot off"></span><span style="font-size:12px;color:var(--text-faint)">Stopped</span>`;
  }

  const box = document.getElementById('proxy-rules-list');
  if (!rules.length) {
    box.innerHTML = `<div class="empty"><div class="big">⇌</div>No proxy rules yet.<br><span class="muted" style="font-size:13px">Add a rule to route a domain to a container port.</span></div>`;
    return;
  }
  box.innerHTML = rules.map((r) => `
    <div class="proxy-row">
      <div class="proxy-main">
        <div class="proxy-domain">${esc(r.domain)}</div>
        <div class="proxy-target">→ ${esc(r.target)}</div>
      </div>
      <label class="toggle" title="${r.enabled ? 'Enabled' : 'Disabled'}">
        <input type="checkbox" ${r.enabled ? 'checked' : ''} data-proxy-toggle="${esc(r.id)}" />
        <span class="toggle-track"></span>
      </label>
      <button class="btn sm ghost" data-proxy-edit="${esc(r.id)}">✎</button>
      <button class="btn sm danger" data-proxy-del="${esc(r.id)}">🗑</button>
    </div>`).join('');
}

// Proxy-Tab Events
document.getElementById('proxy-rules-list').addEventListener('click', async (e) => {
  const delBtn = e.target.closest('[data-proxy-del]');
  if (delBtn) {
    if (!confirm('Delete proxy rule?')) return;
    await api('DELETE', `/api/proxy/rules/${delBtn.dataset.proxyDel}`).catch((err) => toast(err.message, 'error'));
    loadProxyRules();
    return;
  }
  const editBtn = e.target.closest('[data-proxy-edit]');
  if (editBtn) openProxyModal(editBtn.dataset.proxyEdit);
});

document.getElementById('proxy-rules-list').addEventListener('change', async (e) => {
  const toggle = e.target.closest('[data-proxy-toggle]');
  if (!toggle) return;
  await api('PUT', `/api/proxy/rules/${toggle.dataset.proxyToggle}`, { enabled: toggle.checked })
    .catch((err) => { toast(err.message, 'error'); toggle.checked = !toggle.checked; });
  loadProxyRules();
});

let _editingProxyId = null;

function openProxyModal(id) {
  _editingProxyId = id || null;
  const title = document.getElementById('prl-title');
  title.textContent = id ? 'Edit Proxy Rule' : 'Add Proxy Rule';

  if (id) {
    api('GET', '/api/proxy/rules').then((rules) => {
      const r = rules.find((x) => x.id === id);
      if (!r) return;
      document.getElementById('prl-domain').value  = r.domain;
      document.getElementById('prl-target').value  = r.target;
      document.getElementById('prl-enabled').checked = r.enabled;
    });
  } else {
    document.getElementById('prl-domain').value  = '';
    document.getElementById('prl-target').value  = '';
    document.getElementById('prl-enabled').checked = true;
  }
  openModal('modal-proxy-rule');
}

document.getElementById('add-proxy-btn').addEventListener('click', () => openProxyModal(null));

document.getElementById('prl-save').addEventListener('click', async () => {
  const domain  = document.getElementById('prl-domain').value.trim();
  const target  = document.getElementById('prl-target').value.trim();
  const enabled = document.getElementById('prl-enabled').checked;
  if (!domain || !target) { toast('Domain and target are required', 'error'); return; }

  const btn = document.getElementById('prl-save');
  btn.disabled = true;
  try {
    if (_editingProxyId) {
      await api('PUT', `/api/proxy/rules/${_editingProxyId}`, { domain, target, enabled });
    } else {
      await api('POST', '/api/proxy/rules', { domain, target, enabled });
    }
    toast('Proxy rule saved');
    closeModal('modal-proxy-rule');
    loadProxyRules();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// ---------- Firewall ----------
const FW_QUICK_PORTS = [
  { name: 'SSH',      port: 22,   proto: 'tcp' },
  { name: 'HTTP',     port: 80,   proto: 'tcp' },
  { name: 'HTTPS',    port: 443,  proto: 'tcp' },
  { name: 'DNS',      port: 53,   proto: 'udp' },
  { name: 'SMB',      port: 445,  proto: 'tcp' },
  { name: 'Plex',     port: 32400, proto: 'tcp' },
  { name: 'Hearth',   port: 4500, proto: 'tcp' },
];

let _fwAvailable = false;

async function loadFirewall() {
  const info = await api('GET', '/api/firewall/status').catch(() => ({ available: false }));
  _fwAvailable = !!info.available;

  document.getElementById('fw-unavail').style.display    = _fwAvailable ? 'none' : '';
  document.getElementById('fw-normal-content').style.display = _fwAvailable ? '' : 'none';

  if (!_fwAvailable) return;

  // Status-Badge
  const badge = document.getElementById('fw-status-badge');
  if (badge) {
    badge.className = `fw-status-badge ${info.active ? 'active' : 'inactive'}`;
    badge.textContent = info.active ? 'Active' : 'Inactive';
  }

  // Advanced: raw output
  const rawEl = document.getElementById('fw-raw-output');
  if (rawEl) rawEl.textContent = info.raw || '–';

  // Normal: Quick-Port-Karten
  const rules = info.rules || [];
  const allowedPorts = new Set(rules.filter((r) => r.action === 'ALLOW').map((r) => {
    const m = r.to.match(/^(\d+)/);
    return m ? parseInt(m[1]) : null;
  }).filter(Boolean));

  document.getElementById('fw-quick-ports').innerHTML = FW_QUICK_PORTS.map((p) => {
    const allowed = allowedPorts.has(p.port);
    return `<div class="fw-port-card">
      <div>
        <div class="fw-port-name">${esc(p.name)}</div>
        <div class="fw-port-num">${p.port}/${p.proto}</div>
      </div>
      <label class="toggle" title="${allowed ? 'Allowed' : 'Denied'}">
        <input type="checkbox" ${allowed ? 'checked' : ''} data-fw-port="${p.port}" data-fw-proto="${p.proto}" />
        <span class="toggle-track"></span>
      </label>
    </div>`;
  }).join('');

  // Normal: Rule-Liste
  const box = document.getElementById('fw-rules-list');
  if (!rules.length) {
    box.innerHTML = '<div class="empty"><div class="big" style="font-size:32px">○</div>No rules configured.</div>';
    return;
  }
  box.innerHTML = rules.map((r) => `
    <div class="fw-rule-row">
      <span class="fw-rule-num">${r.num}</span>
      <span class="fw-rule-action ${r.action.toLowerCase()}">${r.action}</span>
      <span style="flex:1">${esc(r.to)}</span>
      <span style="color:var(--text-faint);font-size:12px">from ${esc(r.from)}</span>
      <button class="iconbtn danger" data-fw-del="${r.num}" title="Delete rule">🗑</button>
    </div>`).join('');
}

// Quick-Port-Toggles
document.getElementById('fw-quick-ports').addEventListener('change', async (e) => {
  const inp = e.target.closest('[data-fw-port]');
  if (!inp) return;
  const action = inp.checked ? 'allow' : 'deny';
  await api('POST', '/api/firewall/rules', { action, port: inp.dataset.fwPort, proto: inp.dataset.fwProto })
    .catch((err) => { toast(err.message, 'error'); inp.checked = !inp.checked; });
  setTimeout(loadFirewall, 800);
});

// Rule löschen
document.getElementById('fw-rules-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-fw-del]');
  if (!btn) return;
  if (!confirm(`Delete rule #${btn.dataset.fwDel}?`)) return;
  await api('DELETE', `/api/firewall/rules/${btn.dataset.fwDel}`).catch((err) => toast(err.message, 'error'));
  loadFirewall();
});

// Firewall-Regel hinzufügen
document.getElementById('fw-add-rule-btn').addEventListener('click', () => {
  document.getElementById('fw-port').value  = '';
  document.getElementById('fw-from').value  = '';
  document.getElementById('fw-action').value = 'allow';
  document.getElementById('fw-proto').value  = 'tcp';
  openModal('modal-fw-rule');
});

document.getElementById('fw-rule-save').addEventListener('click', async () => {
  const btn = document.getElementById('fw-rule-save');
  btn.disabled = true;
  try {
    await api('POST', '/api/firewall/rules', {
      action: document.getElementById('fw-action').value,
      port:   document.getElementById('fw-port').value.trim(),
      proto:  document.getElementById('fw-proto').value || undefined,
      from:   document.getElementById('fw-from').value.trim() || undefined,
    });
    toast('Firewall rule added');
    closeModal('modal-fw-rule');
    loadFirewall();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// Normal / Advanced Toggle
document.getElementById('fw-mode-normal').addEventListener('click', () => {
  document.getElementById('fw-normal').style.display   = '';
  document.getElementById('fw-advanced').style.display = 'none';
  document.getElementById('fw-mode-normal').classList.add('active');
  document.getElementById('fw-mode-advanced').classList.remove('active');
});
document.getElementById('fw-mode-advanced').addEventListener('click', () => {
  document.getElementById('fw-normal').style.display   = 'none';
  document.getElementById('fw-advanced').style.display = '';
  document.getElementById('fw-mode-advanced').classList.add('active');
  document.getElementById('fw-mode-normal').classList.remove('active');
  loadFirewall();
});

// ---------- Init ----------

// Container-Liste: interval aus Einstellungen (Standard 15s)
let containerTimer = null;
function applyRefreshInterval(seconds) {
  clearInterval(containerTimer);
  if (seconds > 0) containerTimer = setInterval(loadContainers, seconds * 1000);
}
api('GET', '/api/settings').then((s) => applyRefreshInterval(s.refreshInterval ?? 15)).catch(() => {});

// Monitoring: immer alle 2s aktualisieren (für Echtzeitgraphen)
updateMonitor();
setInterval(updateMonitor, 2000);

loadContainers();
applyRefreshInterval(15);

// Update-Check: beim Start und dann alle 30 Minuten
checkUpdates();
setInterval(checkUpdates, 30 * 60 * 1000);
