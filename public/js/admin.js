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
    ? `<span class="update-dot" title="Update available" onclick="event.stopPropagation();updateContainer('${esc(c.id)}','${esc(c.name)}')">↑</span>`
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
    toast(e.message, 'error');
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
    toast(e.message, 'error');
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
  } catch (e) { toast(e.message, 'error'); }
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
    toast(err.message, 'error');
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
  } catch (e) { toast(e.message, 'error'); }
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
    box.innerHTML = `<div class="empty"><div class="big">⇌</div>No proxy rules yet.<br>
      <span class="muted">Add a rule to route a domain to a container port.</span></div>`;
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
    box.innerHTML = '<div class="empty" style="padding:24px">No rules configured.</div>';
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
