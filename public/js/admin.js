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
    if (t.dataset.view === 'store')    renderStore();
    if (t.dataset.view === 'images')   loadImages();
    if (t.dataset.view === 'files')    { loadVolumes(); loadFiles(currentPath); }
    if (t.dataset.view === 'proxy')    loadProxyRules();
    if (t.dataset.view === 'firewall') loadFirewall();
    if (t.dataset.view === 'vpn')      loadVpn();
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
    document.getElementById('mon-disk-total').innerHTML = `<div class="mon-sub">${t('mon.noDisks')}</div>`;
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
        <span>${t('mon.allDisks')}</span>
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
  document.getElementById('mon-cpu-cores').textContent = t('mon.cores').replace('{n}', m.cpu.cores);

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
    tempsBox.innerHTML = `<div class="mon-sub">${t('mon.noSensors')}</div>`;
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
  // Icon: hearth.icon label takes priority; fallback to Docker Hub logo
  const iconSrc = (c.labels || {})['hearth.icon']
    || `/api/dockerhub/logo?image=${encodeURIComponent(c.image.split(':')[0])}`;
  const iconEl = `<div class="c-row-icon" data-cid-icon="${esc(c.id)}">
    <img src="${esc(iconSrc)}" alt="" loading="lazy"
         onerror="this.style.display='none';this.parentNode.textContent='🐳'">
  </div>`;
  return `
    <div class="row row-clickable" data-cid="${esc(c.id)}" data-cname="${esc(c.name)}">
      ${iconEl}
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

  // Guest visibility toggle
  document.getElementById('cd-guest-visible').checked = c.guestVisible !== false;

  document.getElementById('cd-m-image').textContent  = c.image;
  document.getElementById('cd-m-status').textContent = c.status;
  document.getElementById('cd-m-id').textContent     = c.shortId || id.slice(0, 12);
  const portText = (c.ports || []).filter((p) => p.publicPort).map((p) => `${p.publicPort}→${p.privatePort}`).join(', ') || '–';
  document.getElementById('cd-m-ports').textContent  = portText;

  // Stop/Start-Button
  const toggleBtn = document.getElementById('cd-toggle-btn');
  if (running) { toggleBtn.textContent = t('cd.stop'); toggleBtn.className = 'btn sm'; }
  else         { toggleBtn.textContent = t('cd.start'); toggleBtn.className = 'btn sm primary'; }

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
  btn.textContent = t('mon.loading'); btn.disabled = true;
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
  if (!imgName) { toast(t('cd.imageRequired'), 'error'); return; }

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
    toast(t('cd.saved'));
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

document.getElementById('cd-guest-visible').addEventListener('change', async function () {
  try {
    await api('POST', `/api/containers/${_cdCurrentId}/guest-visibility`, { visible: this.checked });
    toast(this.checked ? 'Visible on guest page' : 'Hidden from guest page');
  } catch (e) { toast(e.message, 'error'); this.checked = !this.checked; }
});

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

// ---------- ANSI → HTML ----------
function ansiToHtml(text) {
  const FG = { 30:'#555',31:'#e06c75',32:'#98c379',33:'#e5c07b',34:'#61afef',35:'#c678dd',36:'#56b6c2',37:'#abb2bf',
                90:'#666',91:'#ff6b6b',92:'#a9ff68',93:'#ffe168',94:'#74b9ff',95:'#fd79a8',96:'#81ecec',97:'#fff' };
  const BG = { 40:'#000',41:'#800',42:'#080',43:'#880',44:'#008',45:'#808',46:'#088',47:'#ccc' };
  const parts = text.split(/\x1b\[([0-9;]*)m/);
  let out = '', bold = false, fg = null, bg = null;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) { out += esc(parts[i]); continue; }
    for (const code of parts[i].split(';').map(Number)) {
      if (code === 0) { bold = false; fg = bg = null; }
      else if (code === 1) bold = true;
      else if (FG[code]) fg = FG[code];
      else if (BG[code]) bg = BG[code];
      else if (code === 39) fg = null;
      else if (code === 49) bg = null;
    }
    const style = [fg ? `color:${fg}` : '', bg ? `background:${bg}` : '', bold ? 'font-weight:bold' : ''].filter(Boolean).join(';');
    out += `</span><span style="${style}">`;
  }
  return `<span>${out}</span>`;
}

// ---------- Logs-Modal ----------
let _logsInterval = null;
let _logsCurrentId = null;

function _stopLogsPolling() {
  if (_logsInterval) { clearInterval(_logsInterval); _logsInterval = null; }
}

async function _fetchAndRenderLogs(id) {
  try {
    const txt = await api('GET', `/api/containers/${id}/logs?tail=300`);
    const pre = document.getElementById('logs-body');
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.innerHTML = ansiToHtml(txt || '(keine Ausgabe)');
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch (e) {
    document.getElementById('logs-body').textContent = 'Fehler: ' + e.message;
  }
}

async function openLogs(id, name) {
  _stopLogsPolling();
  _logsCurrentId = id;
  document.getElementById('logs-title').textContent = 'Logs · ' + name;
  document.getElementById('logs-body').innerHTML = '<span style="opacity:.5">Lade…</span>';
  document.getElementById('logs-live').checked = false;
  openModal('modal-logs');
  await _fetchAndRenderLogs(id);
}

document.getElementById('logs-live').addEventListener('change', (e) => {
  _stopLogsPolling();
  if (e.target.checked && _logsCurrentId) {
    _logsInterval = setInterval(() => {
      if (!document.getElementById('modal-logs').classList.contains('open')) {
        _stopLogsPolling();
        document.getElementById('logs-live').checked = false;
        return;
      }
      _fetchAndRenderLogs(_logsCurrentId);
    }, 2000);
  }
});

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
let fileClipboard = null; // { action: 'copy'|'cut', path, name }
const fileNav = { history: ['/'], idx: 0 };

function navigate(p) {
  if (p === currentPath) return;
  fileNav.history = fileNav.history.slice(0, fileNav.idx + 1);
  fileNav.history.push(p);
  fileNav.idx = fileNav.history.length - 1;
  loadFiles(p);
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

function navigateUp() {
  if (currentPath === '/') return;
  const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
  navigate(parent);
}

document.addEventListener('mousedown', (e) => {
  if (!document.getElementById('view-files').classList.contains('active')) return;
  if (e.button === 3 || e.button === 4) e.preventDefault();
});
document.addEventListener('mouseup', (e) => {
  if (!document.getElementById('view-files').classList.contains('active')) return;
  if (e.button === 3) { e.preventDefault(); navigateBack(); }
  if (e.button === 4) { e.preventDefault(); navigateForward(); }
});

document.getElementById('fm-back').addEventListener('click', navigateBack);
document.getElementById('fm-forward').addEventListener('click', navigateForward);
document.getElementById('fm-up').addEventListener('click', navigateUp);

function renderCrumbs() {
  const parts = currentPath.split('/').filter(Boolean);
  let acc = '';
  let html = `<a href="#" data-path="/">&#x2302;</a>`;
  parts.forEach((p) => {
    acc += '/' + p;
    html += ` <span class="crumb-sep">/</span> <a href="#" data-path="${esc(acc)}">${esc(p)}</a>`;
  });
  document.getElementById('crumbs').innerHTML = html;
}

document.getElementById('crumbs').addEventListener('click', (e) => {
  const a = e.target.closest('[data-path]');
  if (!a) return;
  e.preventDefault();
  navigate(a.dataset.path);
});

function updateSidebarActive() {
  document.querySelectorAll('.fm-vol-item').forEach((item) => {
    const vp = item.dataset.volPath;
    item.classList.toggle('active', vp && (currentPath === vp || currentPath.startsWith(vp + '/')));
  });
}

async function loadVolumes() {
  const box = document.getElementById('fm-volumes');
  try {
    const data = await api('GET', '/api/files/volumes');
    if (!data.volumes || !data.volumes.length) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = data.volumes.map((v) => {
      const pct = v.total > 0 ? Math.min(100, Math.round((v.used / v.total) * 100)) : 0;
      const usedStr = v.total > 0 ? fmtBytes(v.used) + ' / ' + fmtBytes(v.total) : '';
      const bar = v.total > 0
        ? `<div class="fm-vol-bar"><div class="fm-vol-bar-fill" style="width:${pct}%"></div></div>`
        : '';
      const isActive = currentPath === v.path || currentPath.startsWith(v.path + '/');
      return `<div class="fm-vol-item${isActive ? ' active' : ''}" data-vol-path="${esc(v.path)}">
        <svg class="fm-vol-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M20 8H4V6h16v2zm-2-4H6v2h12V4zm4 10v6c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2v-6c0-1.1.9-2 2-2h16c1.1 0 2 .9 2 2zm-3 3c0-.55-.45-1-1-1s-1 .45-1 1 .45 1 1 1 1-.45 1-1z"/></svg>
        <div class="fm-vol-info">
          <div class="fm-vol-name">${esc(v.name)}</div>
          ${usedStr ? `<div class="fm-vol-usage">${usedStr}</div>` : ''}
          ${bar}
        </div>
      </div>`;
    }).join('');
  } catch (_) {
    document.getElementById('fm-volumes').innerHTML = '';
  }
}

document.getElementById('fm-volumes').addEventListener('click', (e) => {
  const item = e.target.closest('[data-vol-path]');
  if (!item) return;
  navigate(item.dataset.volPath);
});

function getFileIconClass(name, isDir) {
  if (isDir) return 'dir';
  const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
  if (['jpg','jpeg','png','gif','svg','webp','bmp','ico','tiff','avif','heic'].includes(ext)) return 'img';
  if (['mp4','mkv','avi','mov','webm','flv','wmv','m4v','ts'].includes(ext)) return 'vid';
  if (['mp3','flac','wav','ogg','m4a','aac','opus','wma'].includes(ext)) return 'aud';
  if (['zip','tar','gz','bz2','7z','rar','xz','zst','lz4','tgz'].includes(ext)) return 'arc';
  if (['js','ts','jsx','tsx','py','go','sh','bash','zsh','json','yaml','yml','toml','php','rb','c','cpp','h','hpp','html','css','java','rs','lua','r','swift','kt','cs','vue','xml','env','conf','cfg'].includes(ext)) return 'code';
  if (['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','csv','rtf','odt','ods'].includes(ext)) return 'doc';
  return '';
}

const FILE_ICONS = {
  dir:  `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>`,
  img:  `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`,
  vid:  `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`,
  aud:  `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`,
  arc:  `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20 6h-2.18c.07-.44.18-.88.18-1.36C18 2.98 16.76 2 15.36 2c-.86 0-1.6.36-2.1.93l-.26.29-.26-.29C12.24 2.36 11.5 2 10.64 2 9.24 2 8 2.98 8 4.64c0 .48.11.92.18 1.36H6c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 10h-4v-2h4v2zm1-4H9v-2h6v2z"/></svg>`,
  code: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  doc:  `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zM8 13h8v2H8zm0-4h3v2H8z"/></svg>`,
  '':   `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`,
};

async function loadFiles(p) {
  currentPath = p || '/';
  renderCrumbs();
  updateSidebarActive();
  const box = document.getElementById('files');
  box.innerHTML = `<div class="empty" style="padding:24px 20px"><span style="opacity:.3;font-size:22px">⟳</span></div>`;
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

const _EDITABLE_EXT = new Set([
  'txt','md','json','yaml','yml','env','conf','cfg','ini','sh','bash','py','js','ts',
  'html','css','xml','toml','nginx','gitignore','dockerfile','log','properties','htaccess',
]);

function isEditable(name, isDir) {
  if (isDir) return false;
  const ext = name.split('.').pop().toLowerCase();
  return _EDITABLE_EXT.has(ext) || !name.includes('.');
}

function fileRow(f) {
  const full = (currentPath === '/' ? '' : currentPath) + '/' + f.name;
  const ic = getFileIconClass(f.name, f.isDir);
  const meta = f.isDir ? t('files.folder') : fmtBytes(f.size);
  const editBtn = isEditable(f.name, f.isDir)
    ? `<button class="iconbtn" title="Bearbeiten" data-edit="${esc(full)}" data-name="${esc(f.name)}">&#9997;</button>`
    : '';
  return `
    <div class="fm-file-row" data-path="${esc(full)}" data-isdir="${f.isDir}" data-name="${esc(f.name)}">
      <div class="fm-file-icon ${ic}">${FILE_ICONS[ic] || FILE_ICONS['']}</div>
      <div class="fm-file-name">${esc(f.name)}</div>
      <div class="fm-file-meta">${esc(meta)}&nbsp;·&nbsp;${fmtTime(f.mtime)}</div>
      <div class="fm-file-actions">
        <button class="iconbtn" title="${f.isDir ? 'Als .tar.gz herunterladen' : 'Download'}" data-dl="${esc(full)}">&#8595;</button>
        ${editBtn}
        <button class="iconbtn" title="${t('files.copy')}" data-cp="${esc(full)}" data-name="${esc(f.name)}">&#9138;</button>
        <button class="iconbtn" title="${t('files.cut')}" data-cut="${esc(full)}" data-name="${esc(f.name)}">&#9988;</button>
        <button class="iconbtn" title="${t('files.rename')}" data-rn="${esc(full)}" data-name="${esc(f.name)}">&#9998;</button>
        <button class="iconbtn danger" title="${t('files.delete')}" data-del="${esc(full)}" data-name="${esc(f.name)}">&#128465;</button>
      </div>
    </div>`;
}

document.getElementById('files').addEventListener('click', async (e) => {
  const row = e.target.closest('.fm-file-row');
  if (!row) return;

  if (!e.target.closest('button')) {
    if (row.dataset.isdir === 'true') return navigate(row.dataset.path);
    return;
  }

  const dl = e.target.closest('[data-dl]');
  if (dl) {
    window.location = '/api/files/download?path=' + encodeURIComponent(dl.dataset.dl);
    return;
  }

  const ed = e.target.closest('[data-edit]');
  if (ed) {
    openFileEditor(ed.dataset.edit, ed.dataset.name);
    return;
  }

  const cp = e.target.closest('[data-cp]');
  if (cp) {
    fileClipboard = { action: 'copy', path: cp.dataset.cp, name: cp.dataset.name };
    document.getElementById('fm-paste-btn').style.display = '';
    toast(t('toast.copied') + ': ' + cp.dataset.name);
    return;
  }

  const cut = e.target.closest('[data-cut]');
  if (cut) {
    fileClipboard = { action: 'cut', path: cut.dataset.cut, name: cut.dataset.name };
    document.getElementById('fm-paste-btn').style.display = '';
    toast(t('toast.cut') + ': ' + cut.dataset.name);
    return;
  }

  const rn = e.target.closest('[data-rn]');
  if (rn) {
    const newName = prompt(t('files.renamePrompt'), rn.dataset.name);
    if (!newName || newName === rn.dataset.name) return;
    const to = (currentPath === '/' ? '' : currentPath) + '/' + newName;
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

document.getElementById('fm-paste-btn').addEventListener('click', async () => {
  if (!fileClipboard) return;
  try {
    if (fileClipboard.action === 'copy') {
      await api('POST', '/api/files/copy', { from: fileClipboard.path, toDir: currentPath, name: fileClipboard.name });
      toast(t('toast.pasted'));
    } else {
      const to = (currentPath === '/' ? '' : currentPath) + '/' + fileClipboard.name;
      await api('POST', '/api/files/rename', { from: fileClipboard.path, to });
      toast(t('toast.moved'));
      fileClipboard = null;
      document.getElementById('fm-paste-btn').style.display = 'none';
    }
    loadFiles(currentPath);
  } catch (err) {
    toast(err.message, 'error');
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

// Upload
const dz = document.getElementById('dropzone');
const fileInput = document.getElementById('fileinput');
document.getElementById('fm-upload-btn').addEventListener('click', () => fileInput.click());
dz.addEventListener('click', (e) => { if (e.target !== fileInput) fileInput.click(); });
fileInput.addEventListener('change', () => uploadFiles(fileInput.files));
['dragover', 'dragenter'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); })
);
['dragleave', 'drop'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); })
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

// ---------- Settings ----------
let _currentRole = null;

function openSettings() {
  openModal('modal-settings');
  loadSettings();
}
document.getElementById('open-settings').addEventListener('click', openSettings);
document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('s-lang').addEventListener('change', function () { applyLang(this.value); });

// Show/hide auto-update time fields based on toggle
document.getElementById('s-autoupdate-enabled').addEventListener('change', function () {
  document.getElementById('s-autoupdate-time').style.display = this.checked ? 'flex' : 'none';
});

async function loadSettings() {
  try {
    const s = await api('GET', '/api/settings');
    applyLang(s.lang || 'en');
    document.getElementById('s-servername').value       = s.serverName || '';
    document.getElementById('s-lang').value             = s.lang || 'en';
    document.getElementById('s-showoffline').checked    = !!s.showOfflineApps;
    document.getElementById('s-refresh').value          = String(s.refreshInterval ?? 15);
    document.getElementById('s-port').textContent       = s.port;
    document.getElementById('s-docker-socket').textContent = s.dockerSocket;
    document.getElementById('s-filesroot').textContent  = s.filesRoot;
    document.getElementById('s-version').textContent    = `v${s.version}${s.sha && s.sha !== 'unknown' ? ` (${s.sha})` : ''}`;

    const au = s.autoUpdate ?? { enabled: true, hour: 0, minute: 0 };
    document.getElementById('s-autoupdate-enabled').checked = !!au.enabled;
    document.getElementById('s-autoupdate-hour').value   = au.hour   ?? 0;
    document.getElementById('s-autoupdate-minute').value = String(au.minute ?? 0).padStart(2, '0');
    document.getElementById('s-autoupdate-time').style.display = au.enabled ? 'flex' : 'none';

    // Branch-Selector befüllen
    const branchSel = document.getElementById('s-update-branch');
    const currentBranch = s.updateBranch || 'main';
    branchSel.innerHTML = '<option value="main">main</option>';
    try {
      const { branches } = await api('GET', '/api/updates/branches');
      branchSel.innerHTML = branches.map(b =>
        `<option value="${esc(b)}"${b === currentBranch ? ' selected' : ''}>${esc(b)}</option>`
      ).join('');
    } catch (_) {
      branchSel.value = currentBranch;
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

document.getElementById('s-save').addEventListener('click', async () => {
  const serverName      = document.getElementById('s-servername').value.trim();
  const lang            = document.getElementById('s-lang').value;
  const showOfflineApps = document.getElementById('s-showoffline').checked;
  const refreshInterval = Number(document.getElementById('s-refresh').value);
  const autoUpdate = {
    enabled: document.getElementById('s-autoupdate-enabled').checked,
    hour:    parseInt(document.getElementById('s-autoupdate-hour').value)   || 0,
    minute:  parseInt(document.getElementById('s-autoupdate-minute').value) || 0,
  };

  const btn = document.getElementById('s-save');
  btn.disabled = true;
  try {
    const updateBranch = document.getElementById('s-update-branch').value || 'main';
    await api('POST', '/api/settings', { serverName, lang, showOfflineApps, refreshInterval, autoUpdate, updateBranch });
    closeModal('modal-settings');
    toast(t('toast.settingsSaved'));
    applyRefreshInterval(refreshInterval);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ---------- Notifications ----------
function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  const open  = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'flex';
  if (!open) loadNotifications();
}

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('notif-wrap');
  if (wrap && !wrap.contains(e.target)) document.getElementById('notif-panel').style.display = 'none';
});

async function loadNotifications() {
  try {
    const list = await api('GET', '/api/notifications');
    renderNotifications(list);
  } catch (_) {}
}

function renderNotifications(list) {
  const badge = document.getElementById('notif-badge');
  const el    = document.getElementById('notif-list');
  const unread = list.filter(n => !n.read).length;
  badge.textContent   = unread;
  badge.style.display = unread ? '' : 'none';

  if (!list.length) {
    el.innerHTML = `<div class="notif-empty">${t('notif.empty')}</div>`;
    return;
  }
  const icons = { update: '🔼', 'update-done': '✅', error: '⚠️', info: 'ℹ️' };
  el.innerHTML = list.map(n => `
    <div class="notif-item ${n.read ? '' : 'unread'}" data-id="${n.id}" data-action='${JSON.stringify(n.action || {})}'>
      <div class="notif-item-icon">${icons[n.type] || 'ℹ️'}</div>
      <div class="notif-item-body">
        <div class="notif-item-title">${esc(n.title)}</div>
        <div class="notif-item-msg">${esc(n.body)}</div>
        <div class="notif-item-time">${new Date(n.ts).toLocaleString()}</div>
      </div>
    </div>`).join('');

  el.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = Number(item.dataset.id);
      api('POST', `/api/notifications/${id}/read`).catch(() => {});
      item.classList.remove('unread');
      const unreadNow = el.querySelectorAll('.unread').length;
      const badge = document.getElementById('notif-badge');
      badge.textContent = unreadNow;
      badge.style.display = unreadNow ? '' : 'none';

      const action = JSON.parse(item.dataset.action || '{}');
      if (action.section === 'updates') { document.getElementById('notif-panel').style.display = 'none'; openSettings(); }
    });
  });
}

async function markAllRead() {
  await api('POST', '/api/notifications/read-all').catch(() => {});
  document.getElementById('notif-badge').style.display = 'none';
  document.querySelectorAll('.notif-item.unread').forEach(el => el.classList.remove('unread'));
}

// Poll for notifications every 30s
setInterval(async () => {
  try { const list = await api('GET', '/api/notifications'); renderNotifications(list); } catch (_) {}
}, 30000);
loadNotifications();

// ---------- Security modal ----------
document.getElementById('sec-save-own').addEventListener('click', async () => {
  const newUsername = document.getElementById('sec-new-username').value.trim();
  const newPassword = document.getElementById('sec-new-password').value;
  const currentPassword = document.getElementById('sec-cur-password').value;

  if (!newUsername && !newPassword) { toast(t('security.nothingToChange'), 'error'); return; }
  if (!currentPassword) { toast(t('security.currentRequired'), 'error'); return; }
  if (newPassword && newPassword.length < 8) { toast(t('security.pwTooShort'), 'error'); return; }

  const me = await api('GET', '/api/me');
  const payload = { currentPassword };
  if (newUsername) payload.newUsername = newUsername;
  if (newPassword) payload.newPassword = newPassword;

  try {
    await api('PATCH', `/api/users/${me.user}`, payload);
    toast(t('security.saved'));
    ['sec-new-username', 'sec-new-password', 'sec-cur-password'].forEach(id => document.getElementById(id).value = '');
    if (newUsername) toast(t('security.usernameChanged'));
  } catch (e) { toast(e.message, 'error'); }
});

async function loadUserList() {
  const section = document.getElementById('sec-users-section');
  if (_currentRole !== 'admin') { section.style.display = 'none'; return; }
  section.style.display = '';
  try {
    const users = await api('GET', '/api/users');
    const me    = (await api('GET', '/api/me')).user;
    const list  = document.getElementById('sec-user-list');
    list.innerHTML = users.map(u => `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="flex:1;font-size:13px">${esc(u.username)}${u.username===me?' <span style="color:var(--text-dim)">(you)</span>':''}</span>
        <span class="s-badge" style="font-size:11px">${esc(u.role)}</span>
        ${u.username !== me ? `<button class="btn sm danger" data-del="${esc(u.username)}">✕</button>` : ''}
      </div>`).join('');
    list.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete user "${btn.dataset.del}"?`)) return;
        try { await api('DELETE', `/api/users/${btn.dataset.del}`); loadUserList(); } catch (e) { toast(e.message, 'error'); }
      });
    });
  } catch (e) { toast(e.message, 'error'); }
}

document.getElementById('sec-add-btn').addEventListener('click', async () => {
  const username = document.getElementById('sec-add-username').value.trim();
  const password = document.getElementById('sec-add-password').value;
  const role     = document.getElementById('sec-add-role').value;
  if (!username || !password) { toast(t('security.fillAll'), 'error'); return; }
  try {
    await api('POST', '/api/users', { username, password, role });
    document.getElementById('sec-add-username').value = '';
    document.getElementById('sec-add-password').value = '';
    toast(t('security.userAdded'));
    loadUserList();
  } catch (e) { toast(e.message, 'error'); }
});

// Load user list whenever security modal opens
document.getElementById('modal-security').addEventListener('click', e => {
  if (e.target.closest('.modal') && !document.getElementById('sec-user-list').children.length) loadUserList();
});
// Also load when first opened
document.querySelectorAll('[onclick*="modal-security"]').forEach(el => {
  el.addEventListener('click', loadUserList);
});

// Fetch own role on page load
api('GET', '/api/me').then(me => { _currentRole = me.role; }).catch(() => {});

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

// Erkannte Konfiguration für den aktuellen Quick-Install-Dialog
let _qiConfig  = { ports: [], volumes: [], env: [] };
let _qiSnippet = { compose: null, run: null };
let _dataDir   = '/srv/hearth-data';

// dataDir beim ersten Öffnen laden
api('GET', '/api/settings').then(s => { if (s.dataDir) _dataDir = s.dataDir; }).catch(() => {});

function renderQiChips(cfg) {
  const el = document.getElementById('qi-detected-chips');
  const detected = document.getElementById('qi-detected');
  el.innerHTML = '';
  const chips = [];
  cfg.ports.forEach(p => {
    const s = document.createElement('span');
    s.className = 'pill';
    s.style.cssText = 'background:var(--accent-dim);color:var(--accent);font-size:12px';
    s.textContent = '⇄ ' + p.container;
    chips.push(s);
  });
  if (cfg.volumes.length) {
    const s = document.createElement('span');
    s.className = 'pill';
    s.style.cssText = 'font-size:12px';
    s.textContent = `📁 ${cfg.volumes.length} volume${cfg.volumes.length > 1 ? 's' : ''}`;
    chips.push(s);
  }
  cfg.env.forEach(e => {
    const s = document.createElement('span');
    s.className = 'pill';
    s.style.cssText = 'font-size:12px';
    s.textContent = '$ ' + e.key;
    chips.push(s);
  });
  if (chips.length) {
    chips.forEach(c => el.appendChild(c));
    detected.style.display = '';
  } else {
    detected.style.display = 'none';
  }
}

async function openQuickInstall(image, storeApp) {
  document.getElementById('drop-overlay').classList.remove('active');
  _qiConfig  = storeApp
    ? { ports: storeApp.ports || [], volumes: (storeApp.volumes || []).map(v => ({ ...v, host: v.host.replace('{data}', _dataDir) })), env: storeApp.env || [], logoUrl: null, displayName: storeApp.name || null, icon: storeApp.icon || null }
    : { ports: [], volumes: [], env: [], logoUrl: null, displayName: null, icon: null };
  _qiSnippet = { compose: null, run: null };

  document.getElementById('qi-loading').style.display  = 'flex';
  document.getElementById('qi-info').style.display     = 'none';
  document.getElementById('qi-detected').style.display = 'none';
  document.getElementById('qi-image').value            = image;
  document.getElementById('qi-name').value             = imageToName(image);
  document.getElementById('qi-install').disabled       = false;
  document.getElementById('qi-install').textContent    = '⚡ Install';
  openModal('modal-qi');

  try {
    const info = await api('GET', `/api/dockerhub/info?image=${encodeURIComponent(image)}`);
    document.getElementById('qi-loading').style.display = 'none';
    if (!info.found) return;

    document.getElementById('qi-info').style.display    = 'flex';
    document.getElementById('qi-meta-name').textContent  = info.image;
    document.getElementById('qi-meta-desc').textContent  = info.description || '';
    document.getElementById('qi-official').style.display = info.isOfficial ? '' : 'none';
    document.getElementById('qi-stats').textContent =
      `↓ ${fmtPulls(info.pullCount)} pulls  ⭐ ${fmtPulls(info.starCount)} stars`;
    const logoEl = document.getElementById('qi-logo');
    logoEl.innerHTML = info.logoUrl
      ? `<img src="${esc(info.logoUrl)}" alt="" onerror="this.parentNode.textContent='🐳'">`
      : '🐳';
    // Store logo URL so the install handler can set hearth.icon automatically.
    // Include the icon slug if available (from store catalog entry).
    const imgBase  = encodeURIComponent(image.split(':')[0]);
    const slugPart = _qiConfig.icon ? `&slug=${encodeURIComponent(_qiConfig.icon)}` : '';
    _qiConfig.logoUrl = `/api/dockerhub/logo?image=${imgBase}${slugPart}`;
    _qiConfig.displayName = _qiConfig.displayName || info.image || null;

    if (!document.getElementById('qi-image').value.includes(':')) {
      document.getElementById('qi-image').value = info.image;
      document.getElementById('qi-name').value  = imageToName(info.image);
    }

    // Konfiguration aus Registry-Manifest aufbauen
    const cname = document.getElementById('qi-name').value || imageToName(info.image);
    _qiConfig.ports = (info.ports || []).map(p => {
      const [port, proto = 'tcp'] = p.split('/');
      return { host: port, container: port, proto };
    });
    _qiConfig.volumes = (info.volumes || []).map(v => {
      const basename = v.replace(/\/$/, '').split('/').pop() || 'data';
      return { host: `${_dataDir}/${cname}/${basename}`, container: v };
    });
    _qiConfig.env = (info.env || []).map(e => {
      const idx = e.indexOf('=');
      return idx >= 0 ? { key: e.slice(0, idx), value: e.slice(idx + 1) } : { key: e, value: '' };
    });

    // Compose-Snippet als Fallback / für Full-Editor
    _qiSnippet.compose = info.composeSnippet  || null;
    _qiSnippet.run     = info.dockerRunSnippet || null;

    // Falls Manifest keine Ports/Volumes lieferte, Compose-Snippet parsen
    if (!_qiConfig.ports.length && !_qiConfig.volumes.length && _qiSnippet.compose) {
      const parsed = parseDockerCompose(_qiSnippet.compose);
      if (parsed.ports?.length)   _qiConfig.ports   = parsed.ports;
      if (parsed.volumes?.length) _qiConfig.volumes  = parsed.volumes;
      if (parsed.env?.length && !_qiConfig.env.length) _qiConfig.env = parsed.env;
    }

    renderQiChips(_qiConfig);

    const hint = document.getElementById('qi-hint');
    if (_qiConfig.ports.length || _qiConfig.volumes.length) {
      hint.setAttribute('data-i18n', '');
      hint.textContent = `Configuration detected. Install will set up ${_qiConfig.ports.length} port(s) and ${_qiConfig.volumes.length} volume(s) automatically.`;
    }
  } catch (_) {
    document.getElementById('qi-loading').style.display = 'none';
  }
}

document.getElementById('qi-install').addEventListener('click', async () => {
  const image = document.getElementById('qi-image').value.trim();
  if (!image) { toast(t('cd.imageRequired'), 'error'); return; }
  const name  = document.getElementById('qi-name').value.trim();
  const btn   = document.getElementById('qi-install');
  btn.disabled = true;
  btn.textContent = t('qi.installing');
  try {
    // Build hearth.* labels for icon + display name automatically
    const hearthLabels = [];
    const displayName = _qiConfig.displayName || name || null;
    if (displayName) hearthLabels.push({ key: 'hearth.name', value: displayName });
    if (_qiConfig.logoUrl) hearthLabels.push({ key: 'hearth.icon', value: _qiConfig.logoUrl });
    // Set hearth.port to the first mapped TCP port so the guest view builds a URL
    const firstTcpPort = (_qiConfig.ports || []).find(p => (p.proto || 'tcp') === 'tcp' && p.host);
    if (firstTcpPort) hearthLabels.push({ key: 'hearth.port', value: String(firstTcpPort.container) });

    await api('POST', '/api/containers', {
      image, name: name || undefined,
      pull: true, restart: 'unless-stopped',
      ports:   _qiConfig.ports,
      volumes: _qiConfig.volumes.filter(v => v.host && v.container),
      env:     _qiConfig.env.filter(e => e.key),
      labels:  hearthLabels,
    });
    toast(t('qi.installed').replace('{name}', name || image));
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

  // Wenn Compose-Snippet vorhanden → direkt in Compose-Tab einfügen
  if (_qiSnippet.compose) {
    document.getElementById('c-image').value = image;
    document.getElementById('c-name').value  = name;
    document.getElementById('compose-input').value = _qiSnippet.compose;
    const parsed = parseDockerCompose(_qiSnippet.compose);
    // Image + Name aus QI behalten (ist genauer als was im Snippet steht)
    parsed.image = image;
    parsed.name  = name;
    fillCreateForm(parsed);
    openModal('modal-create');
    return;
  }

  // Sonst: erkannte Registry-Daten vorausfüllen (Host-Pfade leer lassen)
  fillCreateForm({
    image,
    name,
    ports:   _qiConfig.ports,
    volumes: _qiConfig.volumes.map(v => ({ host: '', container: v.container })),
    env:     _qiConfig.env,
    labels:  [],
  });
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
    toast(t('misc.noDockerInDrop'), 'error');
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
  if (!cmd) { toast(t('parse.runRequired'), 'error'); return; }
  try { fillCreateForm(parseDockerRun(cmd)); toast(t('parse.runSuccess')); }
  catch (e) { toast(t('parse.error') + e.message, 'error'); }
});

document.getElementById('parse-compose-btn').addEventListener('click', () => {
  const yaml = document.getElementById('compose-input').value.trim();
  if (!yaml) { toast(t('parse.composeRequired'), 'error'); return; }
  try { fillCreateForm(parseDockerCompose(yaml)); toast(t('parse.composeSuccess')); }
  catch (e) { toast(t('parse.error') + e.message, 'error'); }
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
async function checkUpdatesManual() {
  const btn = document.getElementById('btn-check-updates');
  if (btn) { btn.disabled = true; btn.textContent = '⟳'; }
  await checkUpdates(true);
  if (btn) {
    btn.disabled = false;
    btn.setAttribute('data-i18n', 'settings.checkUpdatesBtn');
    btn.textContent = t('settings.checkUpdatesBtn');
  }
}

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
    const updateRow  = document.getElementById('hearth-update-row');
    const updateHint = document.getElementById('hearth-update-hint');
    if (hi && updateRow && updateHint) {
      if (hi.hasUpdate) {
        updateHint.innerHTML = `${esc(hi.localSha)} → <span class="mono">${esc(hi.sha)}</span> · ${esc(hi.message)}`;
        updateRow.style.display = '';
      } else {
        updateRow.style.display = 'none';
      }
    }
  } catch (_) {
    if (badge) badge.style.display = 'none';
  }
}

async function updateContainer(id, name) {
  if (!confirm(t('update.confirm').replace('{name}', name))) return;
  const btn = document.querySelector(`[data-cid="${id}"] .update-dot`);
  if (btn) btn.textContent = '⟳';
  toast(t('update.pulling').replace('{name}', name), 'info');
  try {
    await api('POST', `/api/updates/container/${id}`);
    toast(t('update.done').replace('{name}', name));
    _updateMap[id] = { hasUpdate: false };
    loadContainers();
    checkUpdates(true);
  } catch (e) { showDockerError(e.message); }
}

async function updateAllContainers() {
  const pending = Object.entries(_updateMap).filter(([, v]) => v.hasUpdate);
  if (!pending.length) return;
  if (!confirm(`${pending.length} Container updaten?\n\n${pending.map(([, v]) => v.name).join(', ')}`)) return;

  const badge = document.getElementById('topbar-updates');
  if (badge) { badge.textContent = '⟳'; badge.onclick = null; }

  let done = 0, failed = 0;
  for (const [id, info] of pending) {
    const dot = document.querySelector(`[data-cid="${id}"] .update-dot`);
    if (dot) dot.textContent = '⟳';
    try {
      await api('POST', `/api/updates/container/${id}`);
      _updateMap[id] = { hasUpdate: false };
      done++;
    } catch (e) {
      failed++;
      toast(`${info.name}: ${e.message}`, 'error');
    }
    loadContainers();
  }

  toast(failed ? `${done} updated, ${failed} fehlgeschlagen` : `${done} Container erfolgreich aktualisiert`);
  checkUpdates(true);
  if (badge) badge.onclick = updateAllContainers;
}

async function updateHearth() {
  if (!confirm(t('settings.updateConfirm'))) return;
  const btn = document.getElementById('btn-hearth-update');
  if (btn) { btn.disabled = true; btn.textContent = '⟳'; }
  try {
    const data = await api('POST', '/api/updates/hearth');
    if (data.upToDate) {
      toast(t('settings.alreadyUpToDate'));
      if (btn) { btn.disabled = false; btn.textContent = t('settings.updateBtn'); }
      return;
    }
    toast(t('settings.updateStarted'));
    // Server rebuilds and restarts — reload after a short wait
    setTimeout(() => location.reload(), 15000);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = t('settings.updateBtn'); }
    showDockerError(e.message);
  }
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
      ? `<span class="proxy-status-dot"></span><span style="font-size:12px;color:var(--ok)">${t('proxy.running').replace(':{port}', status.port)}</span>`
      : `<span class="proxy-status-dot off"></span><span style="font-size:12px;color:var(--text-faint)">${t('proxy.stopped')}</span>`;
  }

  const box = document.getElementById('proxy-rules-list');
  if (!rules.length) {
    box.innerHTML = `<div class="empty"><div class="big">⇌</div>${t('proxy.empty')}<br><span class="muted" style="font-size:13px">${t('proxy.emptyHint')}</span></div>`;
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
    if (!confirm(t('proxy.deleteConfirm'))) return;
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
  title.textContent = id ? t('proxy.editTitle') : t('proxy.addTitle');

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
  if (!domain || !target) { toast(t('proxy.requiredFields'), 'error'); return; }

  const btn = document.getElementById('prl-save');
  btn.disabled = true;
  try {
    if (_editingProxyId) {
      await api('PUT', `/api/proxy/rules/${_editingProxyId}`, { domain, target, enabled });
    } else {
      await api('POST', '/api/proxy/rules', { domain, target, enabled });
    }
    toast(t('proxy.saved'));
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
    badge.textContent = info.active ? t('firewall.active') : t('firewall.inactive');
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
      <label class="toggle" title="${allowed ? t('firewall.allowed') : t('firewall.denied')}">
        <input type="checkbox" ${allowed ? 'checked' : ''} data-fw-port="${p.port}" data-fw-proto="${p.proto}" />
        <span class="toggle-track"></span>
      </label>
    </div>`;
  }).join('');

  // Normal: Rule-Liste
  const box = document.getElementById('fw-rules-list');
  if (!rules.length) {
    box.innerHTML = `<div class="empty"><div class="big" style="font-size:32px">○</div>${t('firewall.empty')}</div>`;
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
  if (!confirm(t('firewall.deleteConfirm').replace('#{n}', btn.dataset.fwDel))) return;
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
    toast(t('firewall.ruleAdded'));
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

// ---------- VPN ----------
async function loadVpn() {
  const data = await api('GET', '/api/vpn/status').catch(() => ({ available: false }));

  document.getElementById('vpn-unavail').style.display  = data.available ? 'none' : '';
  document.getElementById('vpn-content').style.display  = data.available ? '' : 'none';

  const badge = document.getElementById('vpn-status-badge');
  if (badge) {
    badge.className = `vpn-status-badge ${data.running ? 'active' : 'inactive'}`;
    badge.textContent = data.running ? 'Running' : 'Stopped';
  }

  if (!data.available) return;

  // Parse server URL from wg show output or status string
  const serverLine = (data.status || '').split('\n').find(l => l.includes('endpoint')) || '';
  document.getElementById('vpn-server').textContent = serverLine || 'Configure VPN_HOST in .env';
  document.getElementById('vpn-peer-count').textContent = (data.peers || []).length + ' configured';

  const list = document.getElementById('vpn-peers-list');
  if (!(data.peers || []).length) {
    list.innerHTML = '<div class="empty" style="padding:20px"><div class="big" style="font-size:32px">📱</div>No VPN clients found.<br><span class="muted" style="font-size:13px">Set VPN_PEERS in your .env and restart.</span></div>';
    return;
  }

  list.innerHTML = (data.peers || []).map(p => `
    <div class="vpn-peer-row">
      <span class="vpn-peer-name">📱 ${esc(p.name)}</span>
      <button class="btn sm ghost" onclick="openVpnQr('${esc(p.name)}')">🔲 QR Code</button>
      <a class="btn sm ghost" href="/api/vpn/peers/${encodeURIComponent(p.name)}/conf" download>⬇ .conf</a>
    </div>`).join('');
}

async function openVpnQr(name) {
  document.getElementById('vpn-qr-title').textContent = `VPN Client: ${name}`;
  document.getElementById('vpn-qr-png').src = `/api/vpn/peers/${encodeURIComponent(name)}/qr?t=${Date.now()}`;
  document.getElementById('vpn-qr-download').href = `/api/vpn/peers/${encodeURIComponent(name)}/conf`;
  document.getElementById('vpn-qr-download').setAttribute('download', `${name}.conf`);
  openModal('modal-vpn-qr');
}

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

// ── App Store ─────────────────────────────────────────────────────────────────

// icon: slug for selfhst/dashboard-icons CDN. Only needed when the image
// name doesn't auto-resolve (e.g. portainer-ce → portainer, server → vaultwarden).
const STORE_CATALOG = [
  // Media
  { cat: 'media', name: 'Jellyfin',        icon: 'jellyfin',       image: 'linuxserver/jellyfin',            desc: 'Free open-source media server. Stream movies, TV, music & photos.',     ports: [{host:'8096',container:'8096',proto:'tcp'}], env: [{key:'PUID',value:'1000'},{key:'PGID',value:'1000'},{key:'TZ',value:'Europe/Berlin'}], volumes: [{host:'{data}/jellyfin/config',container:'/config'},{host:'/media',container:'/data'}] },
  { cat: 'media', name: 'Plex',            icon: 'plex',           image: 'linuxserver/plex',                desc: 'Organise and stream your personal media collection.',                   ports: [{host:'32400',container:'32400',proto:'tcp'}], env: [{key:'PUID',value:'1000'},{key:'PGID',value:'1000'},{key:'TZ',value:'Europe/Berlin'},{key:'VERSION',value:'docker'}], volumes: [{host:'{data}/plex/config',container:'/config'},{host:'/media',container:'/media'}] },
  { cat: 'media', name: 'Navidrome',       icon: 'navidrome',      image: 'deluan/navidrome',                desc: 'Modern music server. Compatible with Subsonic/Airsonic apps.',           ports: [{host:'4533',container:'4533',proto:'tcp'}], env: [{key:'ND_SCANSCHEDULE',value:'1h'},{key:'ND_LOGLEVEL',value:'info'}], volumes: [{host:'{data}/navidrome',container:'/data'},{host:'/music',container:'/music:ro'}] },
  { cat: 'media', name: 'Immich',          icon: 'immich',         image: 'ghcr.io/immich-app/immich-server', desc: 'High-performance self-hosted photo and video management.',             ports: [{host:'2283',container:'3001',proto:'tcp'}], env: [{key:'DB_PASSWORD',value:'postgres'},{key:'DB_USERNAME',value:'postgres'},{key:'DB_DATABASE_NAME',value:'immich'}], volumes: [{host:'{data}/immich/upload',container:'/usr/src/app/upload'}] },

  // Arr-Stack
  { cat: 'arr',   name: 'Sonarr',          icon: 'sonarr',         image: 'linuxserver/sonarr',              desc: 'Automatic TV show downloader — tracks, grabs and sorts episodes.',       ports: [{host:'8989',container:'8989',proto:'tcp'}], env: [{key:'PUID',value:'1000'},{key:'PGID',value:'1000'},{key:'TZ',value:'Europe/Berlin'}], volumes: [{host:'{data}/sonarr/config',container:'/config'},{host:'/media',container:'/media'}] },
  { cat: 'arr',   name: 'Radarr',          icon: 'radarr',         image: 'linuxserver/radarr',              desc: 'Automatic movie downloader — finds, grabs and manages your films.',      ports: [{host:'7878',container:'7878',proto:'tcp'}], env: [{key:'PUID',value:'1000'},{key:'PGID',value:'1000'},{key:'TZ',value:'Europe/Berlin'}], volumes: [{host:'{data}/radarr/config',container:'/config'},{host:'/media',container:'/media'}] },
  { cat: 'arr',   name: 'Prowlarr',        icon: 'prowlarr',       image: 'linuxserver/prowlarr',            desc: 'Indexer manager & proxy for the *arr stack.',                            ports: [{host:'9696',container:'9696',proto:'tcp'}], env: [{key:'PUID',value:'1000'},{key:'PGID',value:'1000'},{key:'TZ',value:'Europe/Berlin'}], volumes: [{host:'{data}/prowlarr/config',container:'/config'}] },
  { cat: 'arr',   name: 'Lidarr',          icon: 'lidarr',         image: 'linuxserver/lidarr',              desc: 'Music collection manager — automatically downloads missing albums.',      ports: [{host:'8686',container:'8686',proto:'tcp'}], env: [{key:'PUID',value:'1000'},{key:'PGID',value:'1000'},{key:'TZ',value:'Europe/Berlin'}], volumes: [{host:'{data}/lidarr/config',container:'/config'},{host:'/music',container:'/music'}] },

  // Downloads
  { cat: 'download', name: 'qBittorrent',  icon: 'qbittorrent',    image: 'linuxserver/qbittorrent',         desc: 'Lightweight torrent client with a clean web UI.',                        ports: [{host:'8080',container:'8080',proto:'tcp'},{host:'6881',container:'6881',proto:'tcp'}], env: [{key:'PUID',value:'1000'},{key:'PGID',value:'1000'},{key:'TZ',value:'Europe/Berlin'},{key:'WEBUI_PORT',value:'8080'}], volumes: [{host:'{data}/qbittorrent/config',container:'/config'},{host:'/downloads',container:'/downloads'}] },
  { cat: 'download', name: 'Transmission', icon: 'transmission',   image: 'linuxserver/transmission',        desc: 'Simple, lightweight torrent client.',                                    ports: [{host:'9091',container:'9091',proto:'tcp'}], env: [{key:'PUID',value:'1000'},{key:'PGID',value:'1000'},{key:'TZ',value:'Europe/Berlin'}], volumes: [{host:'{data}/transmission/config',container:'/config'},{host:'/downloads',container:'/downloads'}] },

  // Tools
  { cat: 'tools',  name: 'Portainer',      icon: 'portainer',      image: 'portainer/portainer-ce',          desc: 'Visual Docker management UI — manage containers, images, volumes.',     ports: [{host:'9000',container:'9000',proto:'tcp'},{host:'9443',container:'9443',proto:'tcp'}], env: [], volumes: [{host:'/var/run/docker.sock',container:'/var/run/docker.sock'},{host:'{data}/portainer',container:'/data'}] },
  { cat: 'tools',  name: 'Uptime Kuma',    icon: 'uptime-kuma',    image: 'louislam/uptime-kuma',            desc: 'Self-hosted uptime monitoring tool with a fancy dashboard.',             ports: [{host:'3001',container:'3001',proto:'tcp'}], env: [], volumes: [{host:'{data}/uptime-kuma',container:'/app/data'}] },
  { cat: 'tools',  name: 'Watchtower',     icon: 'watchtower',     image: 'containrrr/watchtower',           desc: 'Automatically updates running Docker containers.',                       ports: [], env: [{key:'WATCHTOWER_CLEANUP',value:'true'},{key:'TZ',value:'Europe/Berlin'}], volumes: [{host:'/var/run/docker.sock',container:'/var/run/docker.sock'}] },
  { cat: 'tools',  name: 'Dozzle',         icon: 'dozzle',         image: 'amir20/dozzle',                   desc: 'Real-time Docker log viewer — simple, lightweight, no storage.',         ports: [{host:'8888',container:'8080',proto:'tcp'}], env: [], volumes: [{host:'/var/run/docker.sock',container:'/var/run/docker.sock:ro'}] },

  // Security
  { cat: 'security', name: 'Vaultwarden',  icon: 'vaultwarden',    image: 'vaultwarden/server',              desc: 'Lightweight Bitwarden-compatible password manager server.',              ports: [{host:'3012',container:'80',proto:'tcp'}], env: [{key:'WEBSOCKET_ENABLED',value:'true'}], volumes: [{host:'{data}/vaultwarden',container:'/data'}] },
  { cat: 'security', name: 'AdGuard Home', icon: 'adguard-home',   image: 'adguard/adguardhome',             desc: 'Network-wide ad & tracker blocking DNS server.',                        ports: [{host:'3000',container:'3000',proto:'tcp'},{host:'53',container:'53',proto:'udp'}], env: [], volumes: [{host:'{data}/adguard/workdir',container:'/opt/adguardhome/work'},{host:'{data}/adguard/confdir',container:'/opt/adguardhome/conf'}] },
  { cat: 'security', name: 'Pi-hole',      icon: 'pi-hole',        image: 'pihole/pihole',                   desc: 'DNS sinkhole that blocks ads for all devices on your network.',          ports: [{host:'8053',container:'80',proto:'tcp'},{host:'53',container:'53',proto:'udp'}], env: [{key:'TZ',value:'Europe/Berlin'},{key:'WEBPASSWORD',value:'changeme'}], volumes: [{host:'{data}/pihole/etc',container:'/etc/pihole'},{host:'{data}/pihole/dnsmasq',container:'/etc/dnsmasq.d'}] },

  // Cloud & Home
  { cat: 'cloud',  name: 'Nextcloud',      icon: 'nextcloud',      image: 'nextcloud',                       desc: 'Self-hosted cloud — files, calendars, contacts and collaboration.',      ports: [{host:'8081',container:'80',proto:'tcp'}], env: [], volumes: [{host:'{data}/nextcloud',container:'/var/www/html'}] },
  { cat: 'cloud',  name: 'Home Assistant', icon: 'home-assistant', image: 'homeassistant/home-assistant',    desc: 'Open-source home automation platform.',                                 ports: [{host:'8123',container:'8123',proto:'tcp'}], env: [{key:'TZ',value:'Europe/Berlin'}], volumes: [{host:'{data}/homeassistant/config',container:'/config'}] },
  { cat: 'cloud',  name: 'Gitea',          icon: 'gitea',          image: 'gitea/gitea',                     desc: 'Lightweight self-hosted Git service — like GitHub at home.',             ports: [{host:'3030',container:'3000',proto:'tcp'},{host:'222',container:'22',proto:'tcp'}], env: [{key:'USER_UID',value:'1000'},{key:'USER_GID',value:'1000'}], volumes: [{host:'{data}/gitea',container:'/data'}] },
  { cat: 'cloud',  name: 'Grafana',        icon: 'grafana',        image: 'grafana/grafana',                 desc: 'Open-source metrics dashboard and monitoring platform.',                 ports: [{host:'3030',container:'3000',proto:'tcp'}], env: [], volumes: [{host:'{data}/grafana',container:'/var/lib/grafana'}] },
]

const STORE_CATEGORIES = {
  media:    '🎬  Media',
  arr:      '🔍  Download Management',
  download: '⬇️  Download Clients',
  tools:    '🛠  Tools & Management',
  security: '🔒  Security & Privacy',
  cloud:    '☁️  Cloud & Home',
};

let _storeRendered = false;

function filterStore(query) {
  const q = (query || '').toLowerCase();
  document.querySelectorAll('.store-card').forEach((card) => {
    const match = !q || card.dataset.search.includes(q);
    card.style.display = match ? '' : 'none';
  });
  document.querySelectorAll('.store-category').forEach((cat) => {
    const hasVisible = [...cat.querySelectorAll('.store-card')].some(c => c.style.display !== 'none');
    cat.style.display = hasVisible ? '' : 'none';
  });
}

async function renderStore() {
  if (_storeRendered) return;
  _storeRendered = true;

  const container = document.getElementById('store-categories');
  const bycat = {};
  STORE_CATALOG.forEach((app) => {
    (bycat[app.cat] = bycat[app.cat] || []).push(app);
  });

  let html = '';
  for (const [catKey, apps] of Object.entries(bycat)) {
    html += `<div class="store-category" data-cat="${catKey}">
      <div class="store-category-title">${STORE_CATEGORIES[catKey] || catKey}</div>
      <div class="store-grid">`;
    for (const app of apps) {
      const imgKey = encodeURIComponent(app.image.split(':')[0]);
      html += `<div class="store-card" data-search="${(app.name + ' ' + app.desc + ' ' + app.image).toLowerCase()}" data-image="${esc(app.image)}">
        <div class="store-card-head">
          <div class="store-icon" id="si-${esc(app.name.replace(/\s/g,''))}">🐳</div>
          <div class="store-name">${esc(app.name)}</div>
        </div>
        <div class="store-desc">${esc(app.desc)}</div>
        <button class="btn sm primary" onclick="storeInstall(${esc(JSON.stringify(app.image))})">
          <svg class="icon icon-sm"><use href="#icon-zap"/></svg> Install
        </button>
      </div>`;
    }
    html += `</div></div>`;
  }
  container.innerHTML = html;

  // Lazy-load icons — pass explicit icon slug so the backend skips Docker Hub
  // (rarely has logos for community images) and goes straight to selfhst/icons.
  STORE_CATALOG.forEach((app) => {
    const el = document.getElementById('si-' + app.name.replace(/\s/g, ''));
    if (!el) return;
    const imgKey   = encodeURIComponent(app.image.split(':')[0]);
    const slugPart = app.icon ? `&slug=${encodeURIComponent(app.icon)}` : '';
    const url = `/api/dockerhub/logo?image=${imgKey}${slugPart}`;
    const img = new Image();
    img.onload = () => { el.innerHTML = `<img src="${url}" alt="">`; };
    img.src = url;
  });
}

function storeInstall(image) {
  const app = STORE_CATALOG.find(a => a.image === image);
  openQuickInstall(image, app);
}

loadContainers();
applyRefreshInterval(15);

// Update-Check: beim Start und dann alle 30 Minuten
checkUpdates();
setInterval(checkUpdates, 30 * 60 * 1000);

// ---------- Text-Datei-Editor ----------
let _editorPath = null;

async function openFileEditor(filePath, name) {
  _editorPath = filePath;
  document.getElementById('editor-title').textContent = 'Bearbeiten · ' + name;
  const body = document.getElementById('editor-body');
  body.value = 'Lade…';
  body.disabled = true;
  openModal('modal-editor');
  try {
    const txt = await fetch('/api/files/content?path=' + encodeURIComponent(filePath), { credentials: 'same-origin' });
    if (!txt.ok) { const e = await txt.json(); throw new Error(e.error || txt.statusText); }
    body.value = await txt.text();
    body.disabled = false;
    body.focus();
  } catch (e) {
    body.value = 'Fehler: ' + e.message;
  }
}

document.getElementById('editor-save-btn').addEventListener('click', async () => {
  if (!_editorPath) return;
  const btn = document.getElementById('editor-save-btn');
  btn.disabled = true;
  btn.textContent = 'Speichern…';
  try {
    const r = await fetch('/api/files/content', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: _editorPath, content: document.getElementById('editor-body').value }),
    });
    if (!r.ok) { const e = await r.json(); throw new Error(e.error || r.statusText); }
    toast('Datei gespeichert');
    closeModal('modal-editor');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Speichern';
  }
});
