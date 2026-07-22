/* Hearth – Admin-Logik */

// Sprache sofort aus localStorage anwenden (verhindert Flackern)
if (typeof applyLang === 'function') applyLang(localStorage.getItem('hearth-lang') || 'de');

// ---------- Tab glow (pill highlight) ----------
function updateTabGlow(el) {
  const glow = document.getElementById('tab-glow-inner');
  if (!glow || !el) return;
  const rect = el.getBoundingClientRect();
  glow.style.transform = `translateX(${rect.left + rect.width / 2 - 140}px)`;
}

function initTabGlowPosition() {
  const tabsEl = document.querySelector('.wrap.tabs');
  if (!tabsEl) return;
  const update = () => {
    const r = tabsEl.getBoundingClientRect();
    document.documentElement.style.setProperty('--tab-glow-top', r.bottom + 'px');
  };
  update();
  window.addEventListener('resize', update);
}

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('view-' + t.dataset.view).classList.add('active');
    document.getElementById('btn-community-nav').classList.remove('active');
    closeCommunityHub();
    updateTabGlow(t);
    if (t.dataset.view === 'store')    renderStore();
    if (t.dataset.view === 'images')   loadImages();
    if (t.dataset.view === 'files')    { loadVolumes(); loadFiles(currentPath); }
    if (t.dataset.view === 'proxy')    loadProxyAllViews();
    if (t.dataset.view === 'firewall') loadFirewall();
    if (t.dataset.view === 'vpn')      loadVpn();
  });
});

// ── Community Hub Overlay ────────────────────────────────────────────────────
document.getElementById('btn-community-nav').addEventListener('click', openCommunityHub);

function openCommunityHub() {
  document.getElementById('overlay-community').style.display = 'block';
  document.body.style.overflow = 'hidden';
  document.getElementById('btn-community-nav').classList.add('active');
  updateTabGlow(document.getElementById('btn-community-nav'));
  loadCommunityTab();
}

function closeCommunityHub() {
  document.getElementById('overlay-community').style.display = 'none';
  document.body.style.overflow = '';
  document.getElementById('btn-community-nav').classList.remove('active');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('overlay-community').style.display !== 'none') {
    closeCommunityHub();
  }
});

// Init: position glow line + center on active tab
requestAnimationFrame(() => {
  initTabGlowPosition();
  const activeTab = document.querySelector('.tab.active');
  if (activeTab) updateTabGlow(activeTab);
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
  const seen = new Set();
  const ports = c.ports.filter((p) => {
    if (!p.publicPort) return false;
    const key = `${p.publicPort}→${p.privatePort}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const portBadges = ports.slice(0, 4).map((p) => `<span class="port">${p.publicPort}→${p.privatePort}</span>`).join('') +
    (ports.length > 4 ? `<span class="port" style="opacity:.6">+${ports.length - 4}</span>` : '');
  const webUrl = getContainerWebUrl(c);
  const openBtn = webUrl
    ? `<a href="${esc(safeUrl(webUrl))}" target="_blank" rel="noopener"
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
  const tcpPub = pub.filter((p) => p.type !== 'udp');
  let port = (tcpPub[0] || pub[0]).publicPort;
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
  openBtn.onclick = () => window.open(safeUrl(webUrl), '_blank');

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

  // Web UI port dropdown — one option per published TCP port, auto-detected
  // port pre-selected unless hearth.port already pins a specific one.
  const portSel = document.getElementById('cd-hearth-port');
  portSel.innerHTML = `<option value="">${t('cd.webPortAuto')}</option>`;
  const bindings = Object.entries(ins.HostConfig?.PortBindings || {});
  for (const [key, binds] of bindings) {
    const [containerPort, proto] = key.split('/');
    const hostPort = binds?.[0]?.HostPort;
    if (!hostPort || proto === 'udp') continue;
    const opt = document.createElement('option');
    opt.value = containerPort;
    opt.textContent = `${hostPort} → ${containerPort}`;
    portSel.appendChild(opt);
  }
  portSel.value = l['hearth.port'] || '';

  // Ports
  const portsBox = document.getElementById('cd-ports');
  portsBox.innerHTML = '';
  for (const [key, bindings] of Object.entries(ins.HostConfig?.PortBindings || {})) {
    const [cp, proto] = key.split('/');
    const hp = bindings?.[0]?.HostPort || '';
    portsBox.appendChild(edPortRow(hp, cp, proto || 'tcp'));
  }

  // Volumes — read from the normalized Mounts view, not HostConfig.Binds:
  // Binds only reflects mounts declared with the legacy `-v` syntax, and
  // misses anything set up via Compose's long-form `volumes:` (source/
  // target), which is how CasaOS and most Compose stacks declare them.
  // Building this list from Binds meant submitting the edit form (even
  // just to bump an image tag) silently dropped every such mount.
  const volsBox = document.getElementById('cd-vols');
  volsBox.innerHTML = '';
  for (const m of ins.Mounts || []) {
    const host = m.Type === 'volume' ? m.Name : m.Source;
    volsBox.appendChild(edVolRow(host, m.Destination));
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
  const hp = document.getElementById('cd-hearth-port').value.trim();
  const hu = document.getElementById('cd-hearth-url').value.trim();
  if (hn) hearthLabels.push({ key: 'hearth.name', value: hn });
  if (hi) hearthLabels.push({ key: 'hearth.icon', value: hi });
  if (hp) hearthLabels.push({ key: 'hearth.port', value: hp });
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
async function pruneImages() {
  if (!confirm('Ungenutzte Images (<none>:<none>) löschen? Das spart Speicherplatz.')) return;
  const btn = document.getElementById('prune-images');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Räume auf…'; }
  try {
    const r = await api('POST', '/api/images/prune');
    toast(`${r.deleted} Image(s) gelöscht · ${fmtBytes(r.freed)} freigegeben`);
    loadImages();
  } catch (e) { toast(e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '🧹 Aufräumen'; } }
}

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
        const tags = img.tags.length ? img.tags : ['<untagged>'];
        const tag0 = tags[0];
        const registry = tag0.includes('/') ? tag0.split('/')[0] : 'docker.io';
        const isGhcr = registry.includes('ghcr.io');
        const isGitlab = registry.includes('gitlab');
        const regIcon = isGhcr ? '⬡' : isGitlab ? '🦊' : '🐳';
        const tagDisplay = tags.join(', ');
        return `<div class="row">
          <div class="main">
            <div class="title"><span style="opacity:.5;margin-right:5px">${regIcon}</span>${esc(tagDisplay)}</div>
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
  const btn = document.getElementById('pull-image');
  btn.disabled = true;
  btn.textContent = t('images.pulling');
  toast(t('toast.imagePulling', { image }), 'info');
  try {
    await api('POST', '/api/images/pull', { image });
    toast(t('toast.imagePulled', { image }));
    loadImages();
  } catch (err) {
    showDockerError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = t('images.pull');
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
  box.innerHTML = `<div class="empty" style="padding:24px 20px">${hearthSpinner(28)}</div>`;
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

// Reset update row whenever the settings modal closes
new MutationObserver(() => {
  if (!document.getElementById('modal-settings').classList.contains('open')) {
    setUpdateRowState(null);
  }
}).observe(document.getElementById('modal-settings'), { attributes: true, attributeFilter: ['class'] });

// Branch-Wechsel → Update-Zeile auf "Jetzt prüfen" zurücksetzen
document.getElementById('s-update-branch').addEventListener('change', () => setUpdateRowState(null));

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
    const r = await api('POST', '/api/containers', payload);
    toast(t('toast.containerCreated'));
    if (r?.autoAssigned?.length) toast(`Port conflict resolved: ${r.autoAssigned.map(p => `→ ${p.host}`).join(', ')}`, 'info');
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
  closeSettingsCat();
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

function openSettingsCat(cat) {
  document.getElementById('s-overview').style.display = 'none';
  document.querySelectorAll('.s-detail').forEach(el => el.style.display = 'none');
  const panel = document.getElementById('s-cat-' + cat);
  if (panel) panel.style.display = 'block';
  if (cat === 'appearance')      { loadThemeStatus(); loadSettingsThemePicker(); }
  if (cat === 'news')            loadChangelog();
  if (cat === 'notifications')   loadNotifSettings();
  if (cat === 'storage')         loadRaidStatus();
  if (cat === 'containerUpdates') loadContainerAutoUpdateSettings();
}

function closeSettingsCat() {
  document.querySelectorAll('.s-detail').forEach(el => el.style.display = 'none');
  document.getElementById('s-overview').style.display = 'block';
}

async function loadSettings() {
  try {
    const s = await api('GET', '/api/settings');
    applyLang(s.lang || 'en');
    document.getElementById('s-servername').value       = s.hostname || s.serverName || '';
    document.getElementById('s-lang').value             = s.lang || 'en';
    document.getElementById('s-showoffline').checked    = !!s.showOfflineApps;
    document.getElementById('s-refresh').value          = String(s.refreshInterval ?? 15);
    document.getElementById('s-port').value       = s.configPort      || s.port;
    document.getElementById('s-guest-port').value = s.configGuestPort || s.guestPort;
    const portSub = document.getElementById('s-ports-sub');
    if (portSub) portSub.textContent = `Admin :${s.port} · Gäste :${s.guestPort}`;
    document.getElementById('s-docker-socket').textContent = s.dockerSocket;
    document.getElementById('s-filesroot').textContent  = s.filesRoot;
    document.getElementById('s-filesroot-full').checked = !!s.filesRootFull;
    document.getElementById('s-version').textContent    = `v${s.version}`;

    const au = s.autoUpdate ?? { enabled: true, hour: 0, minute: 0 };
    document.getElementById('s-autoupdate-enabled').checked = !!au.enabled;
    document.getElementById('s-autoupdate-hour').value   = au.hour   ?? 0;
    document.getElementById('s-autoupdate-minute').value = String(au.minute ?? 0).padStart(2, '0');
    document.getElementById('s-autoupdate-time').style.display = au.enabled ? 'flex' : 'none';
    const al = s.autoUpdateLinux ?? { enabled: false };
    document.getElementById('s-autoupdate-linux').checked = !!al.enabled;

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
    const updateBranch    = document.getElementById('s-update-branch').value || 'main';
    const configPort      = parseInt(document.getElementById('s-port').value, 10) || null;
    const configGuestPort = parseInt(document.getElementById('s-guest-port').value, 10) || null;
    const autoUpdateLinux = { enabled: document.getElementById('s-autoupdate-linux').checked };
    const filesRootFull   = document.getElementById('s-filesroot-full').checked;
    await api('POST', '/api/settings', { serverName, lang, showOfflineApps, refreshInterval, autoUpdate, autoUpdateLinux, updateBranch, configPort, configGuestPort, filesRootFull });
    closeModal('modal-settings');
    toast(t('toast.settingsSaved'));
    applyRefreshInterval(refreshInterval);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ---------- Container Auto-Update Settings ----------
async function loadContainerAutoUpdateSettings() {
  const wrap = document.getElementById('container-autoupdate-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="padding:16px;color:var(--text-faint);font-size:13px">Lade…</div>';
  try {
    const [containers, settings] = await Promise.all([
      api('GET', '/api/containers'),
      api('GET', '/api/settings'),
    ]);
    const savedUpdates = settings.containerAutoUpdates || {};

    if (!containers.length) {
      wrap.innerHTML = '<div style="padding:16px;color:var(--text-faint);font-size:13px" data-i18n="containers.empty">Keine Container</div>';
      return;
    }

    const rows = containers.map(c => {
      const name = c.name || c.shortId || '';
      const image = c.image || '';
      const cfg = savedUpdates[name] || { enabled: false, hour: 0, minute: 0 };
      const h = String(cfg.hour ?? 0);
      const m = String(cfg.minute ?? 0).padStart(2, '0');
      return `<tr data-name="${esc(name)}">
        <td><label class="fw-toggle">
          <input type="checkbox" ${cfg.enabled ? 'checked' : ''} onchange="cuToggle('${esc(name)}',this)">
          <span class="fw-toggle-track"></span>
        </label></td>
        <td style="font-weight:500">${esc(name)}</td>
        <td style="color:var(--text-faint);font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(image)}</td>
        <td>
          <div class="cu-time${cfg.enabled ? '' : ' cu-time-disabled'}" id="cu-time-${esc(name)}">
            <input type="number" class="input cu-hour" min="0" max="23" value="${esc(h)}" style="width:50px;text-align:center;padding:4px 6px">
            <span style="color:var(--text-faint)">:</span>
            <input type="number" class="input cu-minute" min="0" max="59" value="${esc(m)}" style="width:50px;text-align:center;padding:4px 6px">
          </div>
        </td>
      </tr>`;
    }).join('');

    wrap.innerHTML = `<table class="fw-table" style="width:100%;table-layout:auto">
      <thead><tr>
        <th style="width:44px"><label class="fw-toggle" title="${t('settings.selectAll')}">
          <input type="checkbox" id="cu-all" onchange="cuToggleAll(this)">
          <span class="fw-toggle-track"></span>
        </label></th>
        <th data-i18n="containers.name">Name</th>
        <th>Image</th>
        <th data-i18n="settings.autoUpdateAt">Zeit</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
    applyTranslations(wrap);

    // Sync master checkbox state
    const allEnabled = Object.values(savedUpdates).length > 0 && containers.every(c => {
      const name = c.name || c.shortId || '';
      return savedUpdates[name]?.enabled;
    });
    const cuAll = document.getElementById('cu-all');
    if (cuAll) cuAll.checked = allEnabled;
  } catch (e) {
    wrap.innerHTML = `<div style="padding:16px;color:var(--danger);font-size:13px">${esc(e.message)}</div>`;
  }
}

function cuToggle(name, checkbox) {
  const timeDiv = document.getElementById(`cu-time-${name}`);
  if (timeDiv) timeDiv.classList.toggle('cu-time-disabled', !checkbox.checked);
}

function cuToggleAll(checkbox) {
  document.querySelectorAll('#container-autoupdate-table-wrap tbody tr').forEach(row => {
    const cb = row.querySelector('input[type=checkbox]');
    if (cb && cb !== checkbox) {
      cb.checked = checkbox.checked;
      cuToggle(row.dataset.name, cb);
    }
  });
}

async function saveContainerAutoUpdates() {
  const containerAutoUpdates = {};
  document.querySelectorAll('#container-autoupdate-table-wrap tbody tr').forEach(row => {
    const name = row.dataset.name;
    if (!name) return;
    const cb     = row.querySelector('input[type=checkbox]');
    const hour   = Math.max(0, Math.min(23, parseInt(row.querySelector('.cu-hour')?.value,   10) || 0));
    const minute = Math.max(0, Math.min(59, parseInt(row.querySelector('.cu-minute')?.value, 10) || 0));
    containerAutoUpdates[name] = { enabled: !!cb?.checked, hour, minute };
  });
  try {
    await api('POST', '/api/settings', { containerAutoUpdates });
    toast(t('toast.settingsSaved'));
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- Notifications ----------
function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  const open  = panel.style.display !== 'none';
  if (open) {
    panel.style.display = 'none';
    return;
  }
  // Position the panel below the bell button
  const btn  = document.getElementById('btn-bell');
  const rect = btn.getBoundingClientRect();
  panel.style.top   = (rect.bottom + 8) + 'px';
  panel.style.right = (window.innerWidth - rect.right) + 'px';
  panel.style.display = 'flex';
  closeNotifArchive();
}

document.addEventListener('click', (e) => {
  if (!e.target.isConnected) return; // element was removed from DOM before event bubbled (e.g. innerHTML replace)
  const wrap  = document.getElementById('notif-wrap');
  const panel = document.getElementById('notif-panel');
  if (panel && panel.style.display !== 'none' &&
      wrap  && !wrap.contains(e.target) &&
      !panel.contains(e.target)) {
    panel.style.display = 'none';
  }
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

  badge.textContent   = list.length;
  badge.style.display = list.length ? '' : 'none';

  if (!list.length) {
    el.innerHTML = `<div class="notif-empty">${t('notif.empty')}</div>`;
    return;
  }
  const icons = { update: '🔼', 'update-done': '✅', error: '⚠️', info: 'ℹ️' };
  el.innerHTML = list.map(n => {
    const actionBtn = n.action?.label
      ? `<button class="btn sm primary" style="margin-top:8px;font-size:12px;padding:4px 10px"
           onclick="event.stopPropagation();_notifAction(${esc(JSON.stringify(n.action))})">${esc(n.action.label)}</button>`
      : '';
    return `
      <div class="notif-item unread" data-id="${n.id}" data-action='${JSON.stringify(n.action || {})}'>
        <div class="notif-item-icon">${icons[n.type] || 'ℹ️'}</div>
        <div class="notif-item-body">
          <div class="notif-item-title">${esc(n.title)}</div>
          <div class="notif-item-msg">${esc(n.body)}</div>
          <div class="notif-item-time">${new Date(n.ts).toLocaleString()}</div>
          ${actionBtn}
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', () => {
      const id     = Number(item.dataset.id);
      const action = JSON.parse(item.dataset.action || '{}');
      api('POST', `/api/notifications/${id}/read`).catch(() => {});
      item.style.transition = 'opacity 0.18s, max-height 0.2s';
      item.style.opacity = '0';
      item.style.overflow = 'hidden';
      item.style.maxHeight = item.offsetHeight + 'px';
      requestAnimationFrame(() => { item.style.maxHeight = '0'; item.style.padding = '0'; });
      setTimeout(() => {
        item.remove();
        const remaining = el.querySelectorAll('.notif-item').length;
        const badge = document.getElementById('notif-badge');
        badge.textContent = remaining;
        badge.style.display = remaining ? '' : 'none';
        if (!remaining) el.innerHTML = `<div class="notif-empty">${t('notif.empty')}</div>`;
      }, 220);

      if (action.section === 'updates') {
        document.getElementById('notif-panel').style.display = 'none';
        openSettings(); openSettingsCat('updates');
      }
    });
  });
}

async function markAllRead() {
  await api('POST', '/api/notifications/read-all').catch(() => {});
  const el = document.getElementById('notif-list');
  el.innerHTML = `<div class="notif-empty">${t('notif.empty')}</div>`;
  const badge = document.getElementById('notif-badge');
  badge.style.display = 'none';
}

function _notifAction(action) {
  document.getElementById('notif-panel').style.display = 'none';
  if (action.section === 'updates') updateHearth();
}

// Archive — switches the panel to archive view in-place (no second popup)
async function openNotifArchive() {
  const panel  = document.getElementById('notif-panel');
  const head   = panel.querySelector('.notif-head');
  const listEl = document.getElementById('notif-list');
  const footer = panel.querySelector('.notif-footer');

  head.innerHTML = `
    <button class="btn ghost sm" onclick="closeNotifArchive()" style="gap:4px;padding:4px 10px;font-size:12px;display:flex;align-items:center">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      ${t('notif.back')}
    </button>
    <span style="font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-dim)">${t('notif.archiveTitle')}</span>`;
  if (footer) footer.style.display = 'none';

  listEl.innerHTML = `<div class="notif-empty">${t('notif.archiveLoading')}</div>`;
  try {
    const data  = await api('GET', '/api/notifications/archive?limit=200');
    const items = data.items || [];
    if (!items.length) {
      listEl.innerHTML = `<div class="notif-empty">${t('notif.archiveEmpty')}</div>`;
      return;
    }
    const icons = { update: '🔼', 'update-done': '✅', error: '⚠️', info: 'ℹ️' };
    listEl.innerHTML = items.map(n => `
      <div class="notif-item notif-archive-item">
        <div class="notif-item-icon">${icons[n.type] || 'ℹ️'}</div>
        <div class="notif-item-body">
          <div class="notif-item-title">${esc(n.title)}</div>
          <div class="notif-item-msg">${esc(n.body)}</div>
          <div class="notif-item-time">${new Date(n.ts).toLocaleString()}</div>
        </div>
      </div>`).join('');
  } catch (_) {
    listEl.innerHTML = `<div class="notif-empty">${t('notif.archiveError')}</div>`;
  }
}

function closeNotifArchive() {
  const panel  = document.getElementById('notif-panel');
  const head   = panel.querySelector('.notif-head');
  const footer = panel.querySelector('.notif-footer');
  head.innerHTML = `
    <span>${t('notif.title')}</span>
    <button class="btn ghost sm" onclick="markAllRead()">${t('notif.markAllRead')}</button>`;
  if (footer) footer.style.display = '';
  loadNotifications();
}

// Settings: load archive stats
async function loadNotifSettings() {
  try {
    const data  = await api('GET', '/api/notifications/archive?limit=0');
    const count = data.total ?? 0;
    const el    = document.getElementById('s-notif-archive-count');
    if (el) el.textContent = `${count} ${t('settings.notif.archivedItems')}`;
    const maxEl = document.getElementById('s-notif-max');
    const cfg   = await api('GET', '/api/settings');
    if (maxEl && cfg.notifArchiveMax) maxEl.value = cfg.notifArchiveMax;
  } catch (_) {}
}

async function clearNotifArchive() {
  if (!confirm(t('settings.notif.clearConfirm'))) return;
  await api('DELETE', '/api/notifications/archive').catch(() => {});
  toast(t('settings.notif.clearDone'), 'ok');
  loadNotifSettings();
}

async function saveNotifMax() {
  const val = parseInt(document.getElementById('s-notif-max')?.value, 10);
  if (!val || val < 50) { toast(t('settings.notif.maxError'), 'error'); return; }
  await api('POST', '/api/notifications/archive/max', { max: val });
  toast(t('settings.save') + ' ✓', 'ok');
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
  el.addEventListener('click', () => { loadUserList(); loadTotpStatus(); loadPasskeys(); });
});
document.querySelectorAll('[onclick*="modal-local-https"]').forEach(el => {
  el.addEventListener('click', () => loadLocalHttpsStatus());
});
document.querySelectorAll('[onclick*="modal-tap-key"]').forEach(el => {
  el.addEventListener('click', () => loadTapKeyStatus());
});

// ── TAP-Key (setup-access bootstrap code) ──────────────────────────────────
async function loadTapKeyStatus() {
  document.getElementById('tapkey-code-area').style.display = 'none';
  const status = document.getElementById('tapkey-status');
  const revokeBtn = document.getElementById('tapkey-revoke-btn');
  try {
    const s = await api('GET', '/api/security/tap-key');
    if (s.active) {
      const mins = Math.max(0, Math.round((s.expiresAt - Date.now()) / 60000));
      const h = Math.floor(mins / 60), m = mins % 60;
      status.textContent = `Aktiver Code für "${s.forUsername}" — noch gültig für ${h}h ${m}min. Der Code selbst wird aus Sicherheitsgründen nicht erneut angezeigt.`;
      revokeBtn.style.display = '';
    } else {
      status.textContent = 'Kein aktiver Code.';
      revokeBtn.style.display = 'none';
    }
  } catch (e) {
    status.textContent = e.message;
  }
}

document.getElementById('tapkey-generate-btn').addEventListener('click', async () => {
  const btn = document.getElementById('tapkey-generate-btn');
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/security/tap-key', {});
    const mins = Math.max(0, Math.round((r.expiresAt - Date.now()) / 60000));
    const h = Math.floor(mins / 60), m = mins % 60;
    // Don't call loadTapKeyStatus() here — it hides tapkey-code-area as its
    // very first action (to not leak a *previous* code on a fresh open),
    // which immediately wiped out the code this same click just displayed.
    document.getElementById('tapkey-status').textContent = `Aktiver Code — noch gültig für ${h}h ${m}min. Der Code selbst wird aus Sicherheitsgründen nicht erneut angezeigt.`;
    document.getElementById('tapkey-revoke-btn').style.display = '';
    document.getElementById('tapkey-code-display').value = r.token;
    document.getElementById('tapkey-code-area').style.display = 'flex';
    toast('Code erstellt — jetzt kopieren, er wird nicht erneut angezeigt');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('tapkey-copy-btn').addEventListener('click', () => {
  const input = document.getElementById('tapkey-code-display');
  const val = input.value;
  if (!val) return;
  navigator.clipboard.writeText(val).then(() => {
    toast('Code kopiert');
  }).catch(() => {
    // navigator.clipboard can silently reject in Safari depending on
    // context — the click still registered, but nothing actually ends up
    // on the clipboard, which is why pasting elsewhere then does nothing.
    // Fall back to the older selection-based copy, which works more broadly.
    input.removeAttribute('readonly');
    input.focus();
    input.setSelectionRange(0, val.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    input.setAttribute('readonly', 'readonly');
    toast(ok ? 'Code kopiert' : 'Kopieren fehlgeschlagen — Code ist markiert, bitte manuell mit Cmd/Strg+C kopieren', ok ? undefined : 'error');
  });
});

document.getElementById('tapkey-revoke-btn').addEventListener('click', async () => {
  try {
    await api('DELETE', '/api/security/tap-key');
    toast('Code widerrufen');
    loadTapKeyStatus();
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ── WebAuthn helpers ────────────────────────────────────────────────────────
function _b64uToBuffer(b64u) {
  const base64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
  const bin = atob(padded);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function _bufToB64u(buf) {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── 2FA / TOTP ──────────────────────────────────────────────────────────────
async function loadTotpStatus() {
  try {
    const { enabled } = await api('GET', '/api/2fa/status');
    const badge   = document.getElementById('totp-status-badge');
    const actions = document.getElementById('totp-actions');
    badge.textContent   = enabled ? 'Aktiviert' : 'Deaktiviert';
    badge.style.cssText = enabled
      ? 'font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;white-space:nowrap;background:rgba(52,199,89,.15);color:#34c759;border:1px solid rgba(52,199,89,.3)'
      : 'font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;white-space:nowrap;background:var(--panel-2);color:var(--text-faint);border:1px solid var(--border)';
    actions.innerHTML = enabled
      ? `<button class="btn sm ghost" id="totp-disable-open-btn" style="color:var(--danger,#e74c3c);border-color:var(--danger,#e74c3c)">2FA deaktivieren</button>`
      : `<button class="btn sm ghost" id="totp-setup-open-btn">2FA einrichten</button>`;
    document.getElementById('totp-setup-open-btn')?.addEventListener('click', startTotpSetup);
    document.getElementById('totp-disable-open-btn')?.addEventListener('click', () => {
      document.getElementById('totp-disable-area').style.display = 'flex';
      document.getElementById('totp-actions').style.display = 'none';
      document.getElementById('totp-disable-code').focus();
    });
  } catch (_) {}
}

async function startTotpSetup() {
  try {
    const { secret, qrDataUrl } = await api('POST', '/api/2fa/setup');
    document.getElementById('totp-qr').src           = qrDataUrl;
    document.getElementById('totp-secret-text').textContent = secret;
    document.getElementById('totp-setup-area').style.display  = 'flex';
    document.getElementById('totp-actions').style.display     = 'none';
    document.getElementById('totp-verify-code').focus();
  } catch (e) { toast(e.message, 'error'); }
}

document.getElementById('totp-confirm-btn').addEventListener('click', async () => {
  const token = document.getElementById('totp-verify-code').value.trim();
  if (!token) { toast('Bitte Code eingeben', 'error'); return; }
  try {
    await api('POST', '/api/2fa/enable', { token });
    toast('2FA aktiviert');
    document.getElementById('totp-setup-area').style.display = 'none';
    document.getElementById('totp-verify-code').value = '';
    loadTotpStatus();
  } catch (e) {
    toast(e.message, 'error');
    document.getElementById('totp-verify-code').value = '';
    document.getElementById('totp-verify-code').focus();
  }
});

document.getElementById('totp-cancel-btn').addEventListener('click', () => {
  document.getElementById('totp-setup-area').style.display = 'none';
  document.getElementById('totp-verify-code').value = '';
  loadTotpStatus();
});

document.getElementById('totp-disable-confirm-btn').addEventListener('click', async () => {
  const token = document.getElementById('totp-disable-code').value.trim();
  if (!token) { toast('Bitte Code eingeben', 'error'); return; }
  try {
    await api('POST', '/api/2fa/disable', { token });
    toast('2FA deaktiviert');
    document.getElementById('totp-disable-area').style.display = 'none';
    document.getElementById('totp-disable-code').value = '';
    document.getElementById('totp-actions').style.display = '';
    loadTotpStatus();
  } catch (e) {
    toast(e.message, 'error');
    document.getElementById('totp-disable-code').value = '';
    document.getElementById('totp-disable-code').focus();
  }
});

document.getElementById('totp-disable-cancel-btn').addEventListener('click', () => {
  document.getElementById('totp-disable-area').style.display = 'none';
  document.getElementById('totp-disable-code').value = '';
  document.getElementById('totp-actions').style.display = '';
});

// ── Local HTTPS (Passkey prerequisite) ────────────────────────────────────
async function loadLocalHttpsStatus() {
  const hostInput = document.getElementById('local-https-host');
  try {
    const s = await api('GET', '/api/security/local-https');
    document.getElementById('local-https-port-hint').textContent = s.port;
    if (!hostInput.value) hostInput.value = s.host || s.suggestedHost || '';
    const result = document.getElementById('local-https-result');
    const downloadArea = document.getElementById('local-https-download-area');
    if (s.enabled) {
      result.style.display = '';
      const url = `https://${s.host}:${s.port}/admin`;
      result.innerHTML = `Aktiv: <a href="${esc(url)}" target="_blank" style="color:var(--accent)">${esc(url)}</a>`;
      downloadArea.style.display = 'flex';
    } else {
      result.style.display = 'none';
      downloadArea.style.display = 'none';
    }
  } catch (_) {}
}

document.getElementById('local-https-btn').addEventListener('click', async () => {
  const host = document.getElementById('local-https-host').value.trim();
  if (!host) { toast('Bitte Hostname eingeben', 'error'); return; }
  const btn = document.getElementById('local-https-btn');
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/security/local-https', { host });
    const result = document.getElementById('local-https-result');
    result.style.display = '';
    result.innerHTML = `Zertifikat erstellt: <a href="${esc(r.url)}" target="_blank" style="color:var(--accent)">${esc(r.url)}</a> — dort öffnen, Zertifikatswarnung bestätigen, dann hier den Passkey einrichten. Falls eine Firewall aktiv ist: Port ${r.port}/tcp im LAN freigeben, sonst ist die Seite nicht erreichbar (unter Firewall → Regeln, gleiches Muster wie beim Admin-Port).`;
    document.getElementById('local-https-download-area').style.display = 'flex';
    toast('Zertifikat erstellt');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('passkey-goto-https-btn').addEventListener('click', () => {
  closeModal('modal-security');
  openModal('modal-local-https');
  loadLocalHttpsStatus();
});

// ── Passkeys ────────────────────────────────────────────────────────────────
async function loadPasskeys() {
  const isSecure = window.isSecureContext && window.PublicKeyCredential;
  const hint = document.getElementById('passkey-unavail-hint');
  const addArea = document.getElementById('passkey-add-area');
  if (!isSecure) {
    hint.style.display = 'flex';
    addArea.style.display = 'none';
    document.getElementById('passkey-list').innerHTML = '';
    return;
  }
  hint.style.display = 'none';
  addArea.style.display = '';
  try {
    const keys = await api('GET', '/api/passkeys');
    const list = document.getElementById('passkey-list');
    if (!keys.length) {
      list.innerHTML = '<div style="font-size:12px;color:var(--text-faint)">Noch keine Passkeys registriert.</div>';
      return;
    }
    list.innerHTML = keys.map(k => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--panel);border:1px solid var(--border);border-radius:6px">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:var(--accent)"><circle cx="8" cy="8" r="3"/><path d="M13 8h8M18 5v6"/><path d="M11 13.5A4 4 0 1 0 7 17h13l3-3-1-1-2 2-1-1 2-2-1-1-2 2-1.5-1.5"/></svg>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k.name)}</div>
          <div style="font-size:11px;color:var(--text-faint)">${new Date(k.createdAt).toLocaleDateString()}</div>
        </div>
        <button class="iconbtn" onclick="deletePasskey('${esc(k.id)}')" title="Passkey löschen" style="flex-shrink:0">✕</button>
      </div>
    `).join('');
  } catch (e) { toast(e.message, 'error'); }
}

async function deletePasskey(id) {
  if (!confirm('Diesen Passkey wirklich löschen?')) return;
  try {
    await api('DELETE', `/api/passkey/${encodeURIComponent(id)}`);
    toast('Passkey gelöscht');
    loadPasskeys();
  } catch (e) { toast(e.message, 'error'); }
}

document.getElementById('passkey-add-btn').addEventListener('click', async () => {
  const btn  = document.getElementById('passkey-add-btn');
  const name = document.getElementById('passkey-name-input').value.trim() || 'Passkey';
  btn.disabled = true;
  btn.textContent = 'Warte auf Authenticator…';
  try {
    const options = await api('POST', '/api/passkey/register-options');
    const publicKey = {
      ...options,
      challenge: _b64uToBuffer(options.challenge),
      user: { ...options.user, id: _b64uToBuffer(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map(c => ({ ...c, id: _b64uToBuffer(c.id) })),
    };
    const credential = await navigator.credentials.create({ publicKey });
    const regJSON = {
      name,
      id:    credential.id,
      rawId: _bufToB64u(credential.rawId),
      type:  credential.type,
      response: {
        clientDataJSON:    _bufToB64u(credential.response.clientDataJSON),
        attestationObject: _bufToB64u(credential.response.attestationObject),
      },
      transports: credential.response.getTransports?.() || [],
      clientExtensionResults: credential.getClientExtensionResults?.() || {},
    };
    await api('POST', '/api/passkey/register-verify', regJSON);
    toast('Passkey erfolgreich registriert');
    document.getElementById('passkey-name-input').value = '';
    loadPasskeys();
  } catch (err) {
    if (err?.name !== 'NotAllowedError') toast(err.message || 'Passkey-Registrierung fehlgeschlagen', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '+ Passkey hinzufügen';
  }
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

    const qiResult = await api('POST', '/api/containers', {
      image, name: name || undefined,
      pull: true, restart: 'unless-stopped',
      ports:   _qiConfig.ports,
      volumes: _qiConfig.volumes.filter(v => v.host && v.container),
      env:     _qiConfig.env.filter(e => e.key),
      labels:  hearthLabels,
    });
    toast(t('qi.installed').replace('{name}', name || image));
    if (qiResult?.autoAssigned?.length) toast(`Port conflict resolved: ${qiResult.autoAssigned.map(p => `→ ${p.host}`).join(', ')}`, 'info');
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
function setUpdateRowState(hi) {
  const icon  = document.getElementById('upd-check-icon');
  const label = document.getElementById('upd-check-label');
  const hint  = document.getElementById('hearth-update-hint');
  const btn   = document.getElementById('btn-check-updates');
  if (!icon || !label || !hint || !btn) return;

  if (hi?.hasUpdate) {
    // Update verfügbar — Zeile wird grün und zeigt Update-Button
    icon.innerHTML = '<svg class="icon icon-md" style="color:var(--accent)"><use href="#icon-arrow-up"/></svg>';
    label.textContent = t('settings.updateAvailable') || 'Update verfügbar';
    label.style.color = 'var(--accent)';
    hint.innerHTML = `v${esc(hi.localVersion)} → <span class="mono">v${esc(hi.remoteVersion)}</span> · ${esc(hi.message)}`;
    hint.style.display = '';
    btn.className = 'btn sm primary';
    btn.textContent = t('settings.updateBtn') || 'Update';
    btn.onclick = updateHearth;
  } else {
    // Aktuell oder noch nicht geprüft — normale Such-Zeile
    icon.innerHTML = '<svg class="icon icon-md"><use href="#icon-search"/></svg>';
    label.textContent = t('settings.checkUpdates') || 'Nach Updates suchen';
    label.style.color = '';
    hint.style.display = 'none';
    btn.className = 'btn sm ghost';
    btn.textContent = t('settings.checkUpdatesBtn') || 'Jetzt prüfen';
    btn.onclick = checkUpdatesManual;
  }
}

async function checkUpdatesManual() {
  const btn  = document.getElementById('btn-check-updates');
  const icon = document.getElementById('upd-check-icon');
  const branch = document.getElementById('s-update-branch')?.value || null;
  if (btn) { btn.disabled = true; btn.innerHTML = hearthSpinner(16); }
  await checkUpdates(true, branch);
  if (btn) btn.disabled = false;
  // setUpdateRowState (called inside checkUpdates) already restores the correct button state
}

async function checkUpdates(force = false, branch = null) {
  const badge = document.getElementById('topbar-updates');
  if (badge) badge.innerHTML = hearthSpinner(14);
  try {
    const params = new URLSearchParams();
    if (force)  params.set('force', 'true');
    if (branch) params.set('branch', branch);
    const qs = params.toString();
    const data = await api('GET', `/api/updates/check${qs ? '?' + qs : ''}`);
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
    // Hearth-Update-Zeile transformieren
    const hi = data.hearth;
    setUpdateRowState(hi);
  } catch (_) {
    if (badge) badge.style.display = 'none';
  }
}

async function updateContainer(id, name) {
  if (!confirm(t('update.confirm').replace('{name}', name))) return;
  const btn = document.querySelector(`[data-cid="${id}"] .update-dot`);
  if (btn) btn.innerHTML = hearthSpinner(14);
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
  if (badge) { badge.innerHTML = hearthSpinner(14); badge.onclick = null; }

  let done = 0, failed = 0;
  for (const [id, info] of pending) {
    const dot = document.querySelector(`[data-cid="${id}"] .update-dot`);
    if (dot) dot.innerHTML = hearthSpinner(12);
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
  const selectedBranch = document.getElementById('s-update-branch')?.value;
  if (selectedBranch) {
    await api('POST', '/api/settings', { updateBranch: selectedBranch }).catch(() => {});
  }
  closeModal('modal-settings');
  showUpdateProgress();
}

function showUpdateProgress() {
  document.getElementById('modal-update-progress').style.display = 'flex';

  const bar    = document.getElementById('upd-bar');
  const status = document.getElementById('upd-status');
  const logEl  = document.getElementById('upd-log');
  const icon   = document.getElementById('upd-head-icon');
  const title  = document.getElementById('upd-head-title');

  let fakePct      = 5;
  let isRestarting = false;

  bar.style.width = '5%';
  status.textContent = 'Verbindung wird hergestellt…';
  if (logEl) { logEl.textContent = ''; logEl.style.display = 'none'; }

  const addLog = msg => {
    if (!logEl) return;
    logEl.style.display = 'block';
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  };

  const es = new EventSource('/api/updates/hearth/stream');

  es.onmessage = ({ data }) => {
    const { type, msg } = JSON.parse(data);
    if (type === 'log') {
      addLog(msg);
      status.textContent = msg;
      if (fakePct < 65) { fakePct = Math.min(65, fakePct + 13); bar.style.width = fakePct + '%'; }
    } else if (type === 'upToDate') {
      es.close();
      bar.style.width = '100%';
      icon.innerHTML = '<span style="font-size:18px;line-height:1;color:var(--ok)">✓</span>';
      title.childNodes[title.childNodes.length - 1].textContent = ' Bereits aktuell';
      status.textContent = `v${msg} ist bereits die neueste Version.`;
    } else if (type === 'restarting') {
      isRestarting = true;
      es.close();
      fakePct = 72;
      bar.style.width = '72%';
      status.textContent = 'Docker-Build läuft…';
      addLog('Docker-Build gestartet — Hearth startet neu…');
      startPolling();
    } else if (type === 'error') {
      es.close();
      status.textContent = `Fehler: ${msg}`;
      addLog(`Fehler: ${msg}`);
      bar.style.background = 'var(--danger)';
    }
  };

  es.onerror = () => {
    es.close();
    if (isRestarting) return; // already handled
    // SSE dropped unexpectedly — Hearth likely restarting mid-update
    fakePct = Math.max(fakePct, 72);
    bar.style.width = fakePct + '%';
    status.textContent = 'Hearth startet neu…';
    startPolling();
  };

  function startPolling() {
    const fakeTimer = setInterval(() => {
      if (fakePct < 90) { fakePct += 0.3; bar.style.width = fakePct + '%'; }
    }, 500);

    let wentOffline = false;
    let failStreak  = 0;
    let elapsed     = 0;
    const TIMEOUT   = 5 * 60 * 1000;

    status.textContent = 'Docker-Build läuft — bitte warten…';
    addLog('Warte auf Server-Neustart…');

    async function poll() {
      elapsed += 2500;
      if (elapsed > TIMEOUT) {
        clearInterval(fakeTimer);
        bar.style.background = 'var(--warn)';
        status.textContent = 'Timeout — bitte Seite manuell neu laden.';
        return;
      }
      try {
        await fetch('/api/public/apps', { signal: AbortSignal.timeout(2000) });
        failStreak = 0;
        if (wentOffline) {
          // Server war weg und ist jetzt wieder da → Update abgeschlossen
          clearInterval(fakeTimer);
          bar.style.width = '100%';
          icon.innerHTML = '<span style="font-size:18px;line-height:1;color:var(--ok)">✓</span>';
          title.childNodes[title.childNodes.length - 1].textContent = ' Fertig!';
          status.textContent = 'Seite wird neu geladen…';
          setTimeout(() => location.reload(), 1500);
        } else {
          // Server noch erreichbar — Build läuft noch, weiter warten
          setTimeout(poll, 2500);
        }
      } catch (_) {
        failStreak++;
        if (failStreak >= 2 && !wentOffline) {
          // 2 aufeinanderfolgende Fehler → Server ist jetzt offline (Build/Neustart)
          wentOffline = true;
          fakePct = Math.max(fakePct, 86);
          bar.style.width = fakePct + '%';
          status.textContent = 'Server startet neu…';
          addLog('Server-Neustart erkannt — warte auf Rückkehr…');
        }
        setTimeout(poll, 2500);
      }
    }
    setTimeout(poll, 5000);
  }
}

// ---------- Reverse Proxy ----------
let _cfConfigured = false;

function _cfUpdateStatus() {
  const statusEl = document.getElementById('cf-settings-status');
  if (!statusEl) return;
  statusEl.textContent   = _cfConfigured ? t('cf.configured') : t('cf.notConfigured');
  statusEl.className     = `cf-settings-status ${_cfConfigured ? 'configured' : 'unconfigured'}`;
}

async function openProxySettingsModal() {
  try {
    const s = await api('GET', '/api/settings');
    document.getElementById('prxs-http-port').value  = s.configHttpPort  || s.httpPort;
    document.getElementById('prxs-proxy-port').value = s.configProxyPort || s.proxyPort;
    document.getElementById('s-cf-token').value  = s.cfApiToken || '';
    document.getElementById('s-cf-zone').value   = s.cfZoneId || '';
    document.getElementById('s-cf-ip').value     = s.serverPublicIp || '';
    document.getElementById('s-cf-tunnel').value = s.cfTunnelToken || '';
  } catch (e) { toast(e.message, 'error'); }
  openModal('modal-proxy-settings');
}

document.getElementById('proxy-settings-btn').addEventListener('click', openProxySettingsModal);

document.getElementById('prxs-save').addEventListener('click', async () => {
  const configHttpPort  = parseInt(document.getElementById('prxs-http-port').value, 10) || null;
  const configProxyPort = parseInt(document.getElementById('prxs-proxy-port').value, 10) || null;
  const cfApiToken     = document.getElementById('s-cf-token').value.trim();
  const cfZoneId       = document.getElementById('s-cf-zone').value.trim();
  const serverPublicIp = document.getElementById('s-cf-ip').value.trim();
  const cfTunnelToken  = document.getElementById('s-cf-tunnel').value.trim();
  const btn = document.getElementById('prxs-save');
  btn.disabled = true;
  try {
    await api('POST', '/api/settings', { configHttpPort, configProxyPort, cfApiToken, cfZoneId, serverPublicIp, cfTunnelToken });
    _cfConfigured = !!(cfApiToken && cfZoneId);
    _cfUpdateStatus();
    toast(t('proxy.saved'));
    closeModal('modal-proxy-settings');
    loadProxyRules();
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

async function loadProxyRules() {
  const [status, rules] = await Promise.all([
    api('GET', '/api/proxy/status').catch(() => ({ running: false, port: 80, rules: 0 })),
    api('GET', '/api/proxy/rules').catch(() => []),
  ]);

  // Load CF settings into the panel on first load
  api('GET', '/api/settings').then(s => {
    const tokenEl  = document.getElementById('s-cf-token');
    if (tokenEl && !tokenEl.value) {
      tokenEl.value = s.cfApiToken || '';
      document.getElementById('s-cf-zone').value   = s.cfZoneId || '';
      document.getElementById('s-cf-ip').value     = s.serverPublicIp || '';
      document.getElementById('s-cf-tunnel').value = s.cfTunnelToken || '';
    }
    _cfConfigured = !!(s.cfApiToken && s.cfZoneId);
    _cfUpdateStatus();
    if (_cfConfigured) {
      const body    = document.getElementById('cf-settings-body');
      const chevron = document.getElementById('cf-settings-chevron');
      if (body && body.style.display === 'none') {
        // keep collapsed but show tunnel card
      }
    }
  }).catch(() => {});

  const badge = document.getElementById('proxy-status-badge');
  if (badge) {
    badge.innerHTML = status.running
      ? `<span class="proxy-status-dot"></span><span style="font-size:12px;color:var(--ok)">${t('proxy.running').replace(':{port}', status.port)}</span>`
      : `<span class="proxy-status-dot off"></span><span style="font-size:12px;color:var(--text-faint)">${t('proxy.stopped')}</span>`;
  }

  // Load CF tunnel status if token is configured
  if (_cfConfigured) loadCfTunnelStatus();

  renderProxyStats(rules);

  const box = document.getElementById('proxy-rules-list');
  if (!rules.length) {
    box.innerHTML = `<div class="empty"><div class="big">⇌</div>${t('proxy.empty')}<br><span class="muted" style="font-size:13px">${t('proxy.emptyHint')}</span></div>`;
    return;
  }
  box.innerHTML = rules.map((r) => {
    const cfBadge = _cfConfigured
      ? `<span class="cf-badge ${r.cfSync && r.cfDnsId ? 'synced' : 'unsynced'}" data-proxy-cf="${esc(r.id)}" title="${r.cfSync && r.cfDnsId ? 'DNS synced' : 'Click to sync DNS'}">CF</span>`
      : '';
    const certType = r.certType || 'self-signed';
    const certBadgeClass = certType === 'letsencrypt' ? 'le' : certType === 'custom' ? 'custom' : 'self';
    const certBadgeLabel = certType === 'letsencrypt' ? '🔒 LE' : certType === 'custom' ? '🔑 Custom' : '⚠ Self';
    const certBadge = `<span class="cert-badge ${certBadgeClass}" data-proxy-cert="${esc(r.id)}" title="Manage certificate">${certBadgeLabel}</span>`;
    const accessClass = (r.ipAllowlist || '').trim() ? 'restricted' : (r.ipDenylist || '').trim() ? 'blocked' : 'public';
    const accessLabel = accessClass === 'restricted' ? t('proxy.accessAllow') : accessClass === 'blocked' ? t('proxy.accessDeny') : t('proxy.accessPublic');
    const accessBadge = `<span class="access-badge ${accessClass}">${accessLabel}</span>`;
    const locCount = (r.locations || []).length;
    const locBadge = locCount ? `<span class="loc-badge">${locCount} location${locCount > 1 ? 's' : ''}</span>` : '';
    const extraDomains = (r.extraDomains || []);
    const extraDomainsHtml = extraDomains.length ? `<span class="proxy-extra-domains">+${extraDomains.length} more</span>` : '';
    return `
    <div class="proxy-row">
      <span class="proxy-status-dot ${r.enabled ? '' : 'off'}" id="proxy-dot-${esc(r.id)}"></span>
      <div class="proxy-main">
        <div class="proxy-domain">${esc(r.domain)}${extraDomainsHtml} ${certBadge} ${cfBadge}</div>
        <div class="proxy-target">→ ${esc(r.target)}</div>
        <div class="proxy-badges">
          ${accessBadge}
          ${locBadge}
          <span class="proxy-status-text checking" id="proxy-status-text-${esc(r.id)}">${t('proxy.checking')}</span>
        </div>
      </div>
      <div class="proxy-actions">
        <button class="btn sm ghost proxy-test-btn" data-proxy-test="${esc(r.id)}" title="Test connection">⚡</button>
        <button class="btn sm ghost" data-proxy-logs="${esc(r.id)}" title="Traffic logs">📊</button>
        <button class="btn sm ghost proxy-copy-btn" data-proxy-copy="${esc(r.domain)}" title="Copy domain">⎘</button>
        <label class="toggle" title="${r.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" ${r.enabled ? 'checked' : ''} data-proxy-toggle="${esc(r.id)}" />
          <span class="toggle-track"></span>
        </label>
        <button class="btn sm ghost" data-proxy-edit="${esc(r.id)}">✎</button>
        <button class="btn sm danger" data-proxy-del="${esc(r.id)}">🗑</button>
      </div>
    </div>`;
  }).join('');

  // Live reachability check per host (parallel, non-blocking)
  rules.forEach((r) => {
    const textEl = document.getElementById(`proxy-status-text-${r.id}`);
    const dotEl  = document.getElementById(`proxy-dot-${r.id}`);
    if (!textEl) return;
    if (!r.enabled) { textEl.textContent = t('proxy.disabled'); textEl.className = 'proxy-status-text off'; return; }
    api('GET', `/api/proxy/test/${r.id}`).then((res) => {
      if (!document.getElementById(`proxy-status-text-${r.id}`)) return; // list re-rendered meanwhile
      textEl.textContent = res.ok ? t('proxy.online') : t('proxy.offline');
      textEl.className = `proxy-status-text ${res.ok ? 'online' : 'offline'}`;
      if (dotEl) dotEl.style.background = res.ok ? '' : 'var(--danger)';
    }).catch(() => { textEl.textContent = t('proxy.offline'); textEl.className = 'proxy-status-text offline'; });
  });
}

function renderProxyStats(rules) {
  const row = document.getElementById('proxy-stats-row');
  if (!row) return;
  const total = rules.length;
  const enabled = rules.filter((r) => r.enabled).length;
  const withLocations = rules.reduce((sum, r) => sum + (r.locations || []).length, 0);
  const restricted = rules.filter((r) => (r.ipAllowlist || '').trim() || (r.ipDenylist || '').trim() || r.basicAuth?.enabled).length;
  row.innerHTML = `
    <div class="proxy-stat-tile"><div class="proxy-stat-icon">⇌</div><div><div class="proxy-stat-num">${total}</div><div class="proxy-stat-label">${t('proxy.statHosts')}</div></div></div>
    <div class="proxy-stat-tile"><div class="proxy-stat-icon info">✓</div><div><div class="proxy-stat-num">${enabled}</div><div class="proxy-stat-label">${t('proxy.statEnabled')}</div></div></div>
    <div class="proxy-stat-tile"><div class="proxy-stat-icon neutral">⛓</div><div><div class="proxy-stat-num">${withLocations}</div><div class="proxy-stat-label">${t('proxy.statLocations')}</div></div></div>
    <div class="proxy-stat-tile"><div class="proxy-stat-icon warn">🔒</div><div><div class="proxy-stat-num">${restricted}</div><div class="proxy-stat-label">${t('proxy.statRestricted')}</div></div></div>
  `;
}

async function loadCfTunnelStatus() {
  const card = document.getElementById('cf-tunnel-card');
  if (!card) return;
  card.style.display = 'flex';
  try {
    const s = await api('GET', '/api/cloudflare/tunnel/status');
    const dot = document.getElementById('cf-tunnel-dot');
    const sub = document.getElementById('cf-tunnel-sub');
    const btn = document.getElementById('cf-tunnel-btn');
    dot.className = `tunnel-status-dot ${s.running ? 'running' : ''}`;
    sub.textContent = s.running ? 'Running — routing via Cloudflare' : (s.status === 'not_found' ? 'Not started' : 'Stopped');
    btn.textContent = s.running ? 'Stop' : 'Start';
    btn.dataset.tunnelRunning = s.running ? '1' : '0';
  } catch(_) {}
}

async function cfTunnelToggle() {
  const btn = document.getElementById('cf-tunnel-btn');
  const running = btn.dataset.tunnelRunning === '1';
  btn.disabled = true;
  try {
    await api('POST', `/api/cloudflare/tunnel/${running ? 'stop' : 'start'}`);
    toast(running ? 'Tunnel stopped' : 'Tunnel starting…');
    setTimeout(loadCfTunnelStatus, 1500);
  } catch(e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
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
  if (editBtn) { openProxyModal(editBtn.dataset.proxyEdit); return; }

  const testBtn = e.target.closest('[data-proxy-test]');
  if (testBtn) {
    testBtn.textContent = '…';
    testBtn.disabled = true;
    try {
      const r = await api('GET', `/api/proxy/test/${testBtn.dataset.proxyTest}`);
      testBtn.textContent = r.ok ? `${r.latency}ms` : '✗';
      testBtn.classList.toggle('proxy-test-ok', r.ok);
      testBtn.classList.toggle('proxy-test-err', !r.ok);
      if (!r.ok) toast(r.error || 'Unreachable', 'error');
    } catch(e) { testBtn.textContent = '✗'; testBtn.classList.add('proxy-test-err'); }
    finally { testBtn.disabled = false; setTimeout(() => { testBtn.textContent = '⚡'; testBtn.classList.remove('proxy-test-ok','proxy-test-err'); }, 4000); }
    return;
  }

  const copyBtn = e.target.closest('[data-proxy-copy]');
  if (copyBtn) {
    navigator.clipboard.writeText(copyBtn.dataset.proxyCopy).then(() => toast('Domain copied'));
    return;
  }

  const cfBadge = e.target.closest('[data-proxy-cf]');
  if (cfBadge) {
    const id = cfBadge.dataset.proxyCf;
    const synced = cfBadge.classList.contains('synced');
    if (synced) {
      if (!confirm('Remove DNS record from Cloudflare?')) return;
      await api('DELETE', `/api/cloudflare/dns-sync/${id}`).catch(e => toast(e.message, 'error'));
    } else {
      try {
        const r = await api('POST', `/api/cloudflare/dns-sync/${id}`);
        toast(`DNS record created → ${r.ip}`);
      } catch(e) { toast(e.message, 'error'); }
    }
    loadProxyRules();
    return;
  }

  const certBadge = e.target.closest('[data-proxy-cert]');
  if (certBadge) { openProxyModal(certBadge.dataset.proxyCert, 'cert'); return; }

  const logsBtn = e.target.closest('[data-proxy-logs]');
  if (logsBtn) { loadProxyLogs(logsBtn.dataset.proxyLogs); return; }
});

document.getElementById('proxy-rules-list').addEventListener('change', async (e) => {
  const toggle = e.target.closest('[data-proxy-toggle]');
  if (!toggle) return;
  await api('PUT', `/api/proxy/rules/${toggle.dataset.proxyToggle}`, { enabled: toggle.checked })
    .catch((err) => { toast(err.message, 'error'); toggle.checked = !toggle.checked; });
  loadProxyRules();
});

let _editingProxyId = null;

// Tab switching in proxy modal
document.querySelectorAll('.prl-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.prl-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.prl-tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`prl-panel-${tab.dataset.tab}`)?.classList.add('active');
  });
});

// Basic Auth toggle
document.getElementById('prl-ba-enabled').addEventListener('change', function() {
  document.getElementById('prl-ba-fields').style.display = this.checked ? 'flex' : 'none';
});

function prlLocationRow(loc = {}) {
  const d = document.createElement('div');
  d.className = 'prl-loc-row';
  d.innerHTML = `
    <input class="input" placeholder="/api" data-k="path" value="${esc(loc.path || '')}" />
    <select class="input" data-k="forwardScheme">
      <option value="http" ${loc.forwardScheme !== 'https' ? 'selected' : ''}>http</option>
      <option value="https" ${loc.forwardScheme === 'https' ? 'selected' : ''}>https</option>
    </select>
    <input class="input" placeholder="192.168.1.51" data-k="forwardHost" value="${esc(loc.forwardHost || '')}" />
    <input class="input" placeholder="8080" data-k="forwardPort" value="${esc(String(loc.forwardPort || ''))}" inputmode="numeric" />
    <span class="rm-btn" onclick="this.parentNode.remove()">✕</span>`;
  return d;
}

document.getElementById('prl-add-location').addEventListener('click', () => {
  document.getElementById('prl-locations').appendChild(prlLocationRow());
});

document.getElementById('prl-access-mode').addEventListener('change', function () {
  document.getElementById('prl-ip-allow').style.display = this.value === 'allow' ? '' : 'none';
  document.getElementById('prl-ip-deny').style.display  = this.value === 'deny'  ? '' : 'none';
});

async function openProxyModal(id, tab = 'general') {
  _editingProxyId = id || null;
  document.getElementById('prl-title').textContent = id ? t('proxy.editTitle') : t('proxy.addTitle');

  // Reset tabs
  document.querySelectorAll('.prl-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.prl-tab-panel').forEach(p => p.classList.toggle('active', p.id === `prl-panel-${tab}`));

  const cfRow = document.getElementById('prl-cf-row');
  if (cfRow) cfRow.style.display = _cfConfigured ? 'flex' : 'none';

  // Reset fields
  document.getElementById('prl-domain').value = '';
  document.getElementById('prl-extra-domains').value = '';
  document.getElementById('prl-fwd-scheme').value = 'http';
  document.getElementById('prl-fwd-host').value = '';
  document.getElementById('prl-fwd-port').value = '';
  document.getElementById('prl-access-mode').value = 'public';
  document.getElementById('prl-ip-allow').value = '';
  document.getElementById('prl-ip-deny').value = '';
  document.getElementById('prl-ip-allow').style.display = 'none';
  document.getElementById('prl-ip-deny').style.display = 'none';
  document.getElementById('prl-enabled').checked = true;
  document.getElementById('prl-cf-sync').checked = false;
  document.getElementById('prl-ba-enabled').checked = false;
  document.getElementById('prl-ba-fields').style.display = 'none';
  document.getElementById('prl-ba-user').value = '';
  document.getElementById('prl-ba-pass').value = '';
  document.getElementById('prl-cache-static').checked = false;
  document.getElementById('prl-block-exploits').checked = false;
  document.getElementById('prl-websockets').checked = true;
  document.getElementById('prl-force-ssl').checked = true;
  document.getElementById('prl-http2').checked = false;
  document.getElementById('prl-hsts-enabled').checked = false;
  document.getElementById('prl-hsts-subdomains').checked = false;
  document.getElementById('prl-sec-headers').checked = false;
  document.getElementById('prl-max-body').value = '';
  document.getElementById('prl-snippet').value = '';
  document.getElementById('prl-locations').innerHTML = '';
  document.getElementById('prl-cert-info').textContent = id ? 'Loading…' : 'Save rule first to manage certificate.';
  document.getElementById('prl-cert-status').textContent = '';

  if (id) {
    api('GET', '/api/proxy/rules').then(rules => {
      const r = rules.find(x => x.id === id);
      if (!r) return;
      document.getElementById('prl-domain').value = r.domain;
      document.getElementById('prl-extra-domains').value = (r.extraDomains || []).join(', ');
      document.getElementById('prl-fwd-scheme').value = r.forwardScheme || 'http';
      document.getElementById('prl-fwd-host').value = r.forwardHost || '';
      document.getElementById('prl-fwd-port').value = r.forwardPort || '';
      document.getElementById('prl-enabled').checked = r.enabled;
      document.getElementById('prl-cf-sync').checked = !!r.cfSync;
      const accessMode = (r.ipAllowlist || '').trim() ? 'allow' : (r.ipDenylist || '').trim() ? 'deny' : 'public';
      document.getElementById('prl-access-mode').value = accessMode;
      document.getElementById('prl-ip-allow').value  = r.ipAllowlist || '';
      document.getElementById('prl-ip-deny').value   = r.ipDenylist || '';
      document.getElementById('prl-ip-allow').style.display = accessMode === 'allow' ? '' : 'none';
      document.getElementById('prl-ip-deny').style.display  = accessMode === 'deny'  ? '' : 'none';
      document.getElementById('prl-sec-headers').checked  = !!r.securityHeaders;
      document.getElementById('prl-cache-static').checked = !!r.cacheStatic;
      document.getElementById('prl-block-exploits').checked = !!r.blockExploits;
      document.getElementById('prl-websockets').checked = r.websockets !== false;
      document.getElementById('prl-force-ssl').checked = r.forceSsl !== false;
      document.getElementById('prl-http2').checked = !!r.http2;
      document.getElementById('prl-hsts-enabled').checked = !!r.hstsEnabled;
      document.getElementById('prl-hsts-subdomains').checked = !!r.hstsSubdomains;
      document.getElementById('prl-max-body').value   = r.maxBodySize || '';
      document.getElementById('prl-snippet').value    = r.customSnippet || '';
      const locBox = document.getElementById('prl-locations');
      (r.locations || []).forEach((loc) => locBox.appendChild(prlLocationRow(loc)));
      if (r.basicAuth?.enabled) {
        document.getElementById('prl-ba-enabled').checked = true;
        document.getElementById('prl-ba-fields').style.display = 'flex';
        document.getElementById('prl-ba-user').value = r.basicAuth.user || '';
      }
    });
    // Load cert info
    api('GET', `/api/proxy/rules/${id}/cert`).then(c => {
      const el = document.getElementById('prl-cert-info');
      if (c.expires) {
        const d = new Date(c.expires);
        const days = c.daysLeft;
        const typeLabel = c.certType === 'letsencrypt' ? "Let's Encrypt" : c.certType === 'custom' ? 'Custom' : 'Self-signed';
        el.innerHTML = `<strong>${typeLabel}</strong> — expires ${d.toLocaleDateString()} <span style="color:${days < 30 ? 'var(--danger)' : 'var(--text-faint)'}">(${days} days)</span>`;
      } else {
        el.textContent = 'Self-signed (no expiry info)';
      }
    }).catch(() => { document.getElementById('prl-cert-info').textContent = 'Could not load cert info.'; });
  }

  // Load running containers for picker
  const picker = document.getElementById('prl-picker');
  const sel = document.getElementById('prl-container-select');
  if (picker && sel) {
    picker.style.display = 'none';
    api('GET', '/api/containers').then(containers => {
      const running = (containers || []).filter(c => c.state === 'running');
      sel.innerHTML = `<option value="">– Pick a container –</option>`;
      let any = false;
      running.forEach(c => {
        // nginx runs inside the hearth container, which usually isn't on the
        // same Docker network as the target — reaching it by container name
        // only works if they happen to share a network. The host's own IP +
        // the container's *published* port always works instead (same
        // reasoning as pointing an external reverse proxy at published
        // ports), so that's what we offer here.
        const ports = (c.ports || []).filter(p => p.publicPort);
        ports.forEach(p => {
          const opt = document.createElement('option');
          opt.value = `${location.hostname}::${p.publicPort}`;
          opt.textContent = `${c.name} :${p.publicPort}`;
          sel.appendChild(opt);
          any = true;
        });
      });
      if (any) picker.style.display = 'flex';
    }).catch(() => {});
  }

  openModal('modal-proxy-rule');
}

document.getElementById('prl-pick-btn').addEventListener('click', () => {
  const val = document.getElementById('prl-container-select').value;
  if (!val) return;
  const [host, , port] = val.split(':');
  document.getElementById('prl-fwd-host').value = host;
  if (port) document.getElementById('prl-fwd-port').value = port;
});

document.getElementById('prl-save').addEventListener('click', async () => {
  const domain      = document.getElementById('prl-domain').value.trim();
  const extraDomains = document.getElementById('prl-extra-domains').value.split(',').map((s) => s.trim()).filter(Boolean);
  const forwardScheme = document.getElementById('prl-fwd-scheme').value;
  const forwardHost  = document.getElementById('prl-fwd-host').value.trim();
  const forwardPort  = document.getElementById('prl-fwd-port').value.trim();
  const enabled = document.getElementById('prl-enabled').checked;
  const cfSync  = document.getElementById('prl-cf-sync')?.checked || false;
  const baEnabled = document.getElementById('prl-ba-enabled').checked;
  const baUser    = document.getElementById('prl-ba-user').value.trim();
  const baPass    = document.getElementById('prl-ba-pass').value;
  if (!domain || !forwardHost || !forwardPort) { toast(t('proxy.requiredFields'), 'error'); return; }

  const accessMode = document.getElementById('prl-access-mode').value;
  const locations = collectEdit('prl-locations', (l) => (l.path && l.forwardHost && l.forwardPort) ? l : null);

  const payload = {
    domain, extraDomains, forwardScheme, forwardHost, forwardPort, locations,
    enabled, cfSync,
    basicAuth: { enabled: baEnabled, user: baUser, ...(baPass ? { password: baPass } : {}) },
    ipAllowlist: accessMode === 'allow' ? document.getElementById('prl-ip-allow').value.trim() : '',
    ipDenylist:  accessMode === 'deny'  ? document.getElementById('prl-ip-deny').value.trim()  : '',
    securityHeaders: document.getElementById('prl-sec-headers').checked,
    hstsEnabled:     document.getElementById('prl-hsts-enabled').checked,
    hstsSubdomains:  document.getElementById('prl-hsts-subdomains').checked,
    forceSsl:        document.getElementById('prl-force-ssl').checked,
    http2:           document.getElementById('prl-http2').checked,
    blockExploits:   document.getElementById('prl-block-exploits').checked,
    websockets:      document.getElementById('prl-websockets').checked,
    cacheStatic:     document.getElementById('prl-cache-static').checked,
    maxBodySize:     document.getElementById('prl-max-body').value.trim(),
    customSnippet:   document.getElementById('prl-snippet').value,
  };

  const btn = document.getElementById('prl-save');
  btn.disabled = true;
  try {
    if (_editingProxyId) {
      await api('PUT', `/api/proxy/rules/${_editingProxyId}`, payload);
    } else {
      await api('POST', '/api/proxy/rules', payload);
    }
    toast(t('proxy.saved'));
    closeModal('modal-proxy-rule');
    loadProxyRules();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// ---------- Cert management ----------
let _currentCertRuleId = null;

async function prlRequestLE() {
  if (!_editingProxyId) return;
  const btn = document.getElementById('prl-le-btn');
  const status = document.getElementById('prl-cert-status');
  btn.disabled = true; btn.innerHTML = `${hearthSpinner(14)} Requesting…`;
  status.textContent = 'Contacting Let\'s Encrypt… this may take up to 60s';
  status.style.color = 'var(--text-faint)';
  try {
    const r = await api('POST', `/api/proxy/rules/${_editingProxyId}/cert/letsencrypt`);
    status.textContent = `✓ Certificate issued! Expires ${new Date(r.expires).toLocaleDateString()} (${r.daysLeft} days)`;
    status.style.color = 'var(--ok)';
    document.getElementById('prl-cert-info').textContent = `Let's Encrypt — expires ${new Date(r.expires).toLocaleDateString()}`;
    loadProxyRules();
  } catch(e) {
    status.textContent = `✗ ${e.message}`;
    status.style.color = 'var(--danger)';
  }
  finally { btn.disabled = false; btn.textContent = '🔒 Let\'s Encrypt'; }
}

async function prlUploadCert() {
  if (!_editingProxyId) { toast('Save rule first', 'error'); return; }
  const certFile = document.getElementById('prl-cert-file').files[0];
  const keyFile  = document.getElementById('prl-key-file').files[0];
  if (!certFile || !keyFile) { toast('Select both cert and key files', 'error'); return; }
  const fd = new FormData();
  fd.append('cert', certFile);
  fd.append('key', keyFile);
  const btn = document.getElementById('prl-upload-btn');
  btn.disabled = true; btn.textContent = 'Uploading…';
  try {
    const res = await fetch(`/api/proxy/rules/${_editingProxyId}/cert/upload`, {
      method: 'POST', body: fd,
    });
    const r = await res.json();
    if (!r.ok) throw new Error(r.error || 'Upload failed');
    toast('Certificate uploaded ✓');
    document.getElementById('prl-cert-status').textContent = '✓ Custom certificate applied';
    document.getElementById('prl-cert-status').style.color = 'var(--ok)';
    loadProxyRules();
  } catch(e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Apply Upload'; }
}

async function prlDeleteCert() {
  if (!_editingProxyId) { toast('Save rule first', 'error'); return; }
  if (!confirm(t('proxy.deleteCertConfirm'))) return;
  const btn = document.getElementById('prl-delete-cert-btn');
  btn.disabled = true;
  try {
    const r = await api('DELETE', `/api/proxy/rules/${_editingProxyId}/cert`);
    toast('Certificate reset to self-signed ✓');
    document.getElementById('prl-cert-info').textContent = 'Self-signed (no expiry info)';
    document.getElementById('prl-cert-status').textContent = '';
    loadProxyRules();
  } catch(e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
}

// ---------- Reverse Proxy sub-navigation ----------
function loadProxyAllViews() {
  loadProxyRules();
  loadRedirectRules();
  loadStreamRules();
  loadNotFoundHosts();
}

const _proxyAddHandlers = {
  hosts: () => openProxyModal(null),
  redirects: () => openRedirectModal(null),
  streams: () => openStreamModal(null),
  '404hosts': () => open404Modal(null),
};

document.querySelectorAll('.proxy-subnav-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.proxy-subnav-tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.proxy-subview').forEach((x) => x.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`proxy-subview-${tab.dataset.proxyView}`)?.classList.add('active');
  });
});

document.getElementById('add-proxy-btn').addEventListener('click', () => {
  const activeView = document.querySelector('.proxy-subnav-tab.active')?.dataset.proxyView || 'hosts';
  (_proxyAddHandlers[activeView] || _proxyAddHandlers.hosts)();
});

// ---------- Redirection Hosts ----------
async function loadRedirectRules() {
  const rules = await api('GET', '/api/proxy/redirects').catch(() => []);
  const box = document.getElementById('redirect-rules-list');
  if (!box) return;
  if (!rules.length) {
    box.innerHTML = `<div class="empty"><div class="big">↪</div>${t('proxy.redirectEmpty')}</div>`;
    return;
  }
  box.innerHTML = rules.map((r) => {
    const certType = r.certType || 'self-signed';
    const certBadgeClass = certType === 'letsencrypt' ? 'le' : certType === 'custom' ? 'custom' : 'self';
    const certBadgeLabel = certType === 'letsencrypt' ? '🔒 LE' : certType === 'custom' ? '🔑 Custom' : '⚠ Self';
    const certBadge = `<span class="cert-badge ${certBadgeClass}" data-rdl-cert="${esc(r.id)}" title="Manage certificate">${certBadgeLabel}</span>`;
    const extraDomains = (r.extraDomains || []);
    const extraDomainsHtml = extraDomains.length ? `<span class="proxy-extra-domains">+${extraDomains.length} more</span>` : '';
    return `
    <div class="proxy-row">
      <span class="proxy-status-dot ${r.enabled ? '' : 'off'}"></span>
      <div class="proxy-main">
        <div class="proxy-domain">${esc(r.domain)}${extraDomainsHtml} ${certBadge}</div>
        <div class="proxy-target">→ ${r.statusCode} ${esc(r.targetUrl)}</div>
      </div>
      <div class="proxy-actions">
        <label class="toggle" title="${r.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" ${r.enabled ? 'checked' : ''} data-rdl-toggle="${esc(r.id)}" />
          <span class="toggle-track"></span>
        </label>
        <button class="btn sm ghost" data-rdl-edit="${esc(r.id)}">✎</button>
        <button class="btn sm danger" data-rdl-del="${esc(r.id)}">🗑</button>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('redirect-rules-list').addEventListener('click', async (e) => {
  const delBtn = e.target.closest('[data-rdl-del]');
  if (delBtn) {
    if (!confirm(t('proxy.deleteConfirm'))) return;
    await api('DELETE', `/api/proxy/redirects/${delBtn.dataset.rdlDel}`).catch((err) => toast(err.message, 'error'));
    loadRedirectRules();
    return;
  }
  const editBtn = e.target.closest('[data-rdl-edit]');
  if (editBtn) { openRedirectModal(editBtn.dataset.rdlEdit); return; }
  const certBadge = e.target.closest('[data-rdl-cert]');
  if (certBadge) { openRedirectModal(certBadge.dataset.rdlCert, 'cert'); return; }
});

document.getElementById('redirect-rules-list').addEventListener('change', async (e) => {
  const toggle = e.target.closest('[data-rdl-toggle]');
  if (!toggle) return;
  await api('PUT', `/api/proxy/redirects/${toggle.dataset.rdlToggle}`, { enabled: toggle.checked })
    .catch((err) => { toast(err.message, 'error'); toggle.checked = !toggle.checked; });
  loadRedirectRules();
});

let _editingRedirectId = null;

document.querySelectorAll('[data-rdl-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#modal-redirect-rule .prl-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('#modal-redirect-rule .prl-tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`rdl-panel-${tab.dataset.rdlTab}`)?.classList.add('active');
  });
});

async function openRedirectModal(id, tab = 'general') {
  _editingRedirectId = id || null;
  document.getElementById('rdl-title').textContent = id ? t('proxy.redirectEditTitle') : t('proxy.redirectAddTitle');

  document.querySelectorAll('[data-rdl-tab]').forEach(t => t.classList.toggle('active', t.dataset.rdlTab === tab));
  document.querySelectorAll('#modal-redirect-rule .prl-tab-panel').forEach(p => p.classList.toggle('active', p.id === `rdl-panel-${tab}`));

  document.getElementById('rdl-domain').value = '';
  document.getElementById('rdl-extra-domains').value = '';
  document.getElementById('rdl-target-url').value = '';
  document.getElementById('rdl-status-code').value = '301';
  document.getElementById('rdl-preserve-path').checked = false;
  document.getElementById('rdl-enabled').checked = true;
  document.getElementById('rdl-force-ssl').checked = true;
  document.getElementById('rdl-http2').checked = false;
  document.getElementById('rdl-hsts-enabled').checked = false;
  document.getElementById('rdl-hsts-subdomains').checked = false;
  document.getElementById('rdl-cert-info').textContent = id ? 'Loading…' : t('proxy.certSaveFirst');
  document.getElementById('rdl-cert-status').textContent = '';

  if (id) {
    api('GET', '/api/proxy/redirects').then(rules => {
      const r = rules.find(x => x.id === id);
      if (!r) return;
      document.getElementById('rdl-domain').value = r.domain;
      document.getElementById('rdl-extra-domains').value = (r.extraDomains || []).join(', ');
      document.getElementById('rdl-target-url').value = r.targetUrl || '';
      document.getElementById('rdl-status-code').value = String(r.statusCode || 301);
      document.getElementById('rdl-preserve-path').checked = !!r.preservePath;
      document.getElementById('rdl-enabled').checked = r.enabled;
      document.getElementById('rdl-force-ssl').checked = r.forceSsl !== false;
      document.getElementById('rdl-http2').checked = !!r.http2;
      document.getElementById('rdl-hsts-enabled').checked = !!r.hstsEnabled;
      document.getElementById('rdl-hsts-subdomains').checked = !!r.hstsSubdomains;
    });
    api('GET', `/api/proxy/redirects/${id}/cert`).then(c => {
      const el = document.getElementById('rdl-cert-info');
      if (c.expires) {
        const d = new Date(c.expires);
        const typeLabel = c.certType === 'letsencrypt' ? "Let's Encrypt" : 'Self-signed';
        el.innerHTML = `<strong>${typeLabel}</strong> — expires ${d.toLocaleDateString()} <span style="color:${c.daysLeft < 30 ? 'var(--danger)' : 'var(--text-faint)'}">(${c.daysLeft} days)</span>`;
      } else {
        el.textContent = 'Self-signed (no expiry info)';
      }
    }).catch(() => { document.getElementById('rdl-cert-info').textContent = 'Could not load cert info.'; });
  }

  openModal('modal-redirect-rule');
}

document.getElementById('rdl-save').addEventListener('click', async () => {
  const domain = document.getElementById('rdl-domain').value.trim();
  const extraDomains = document.getElementById('rdl-extra-domains').value.split(',').map((s) => s.trim()).filter(Boolean);
  const targetUrl = document.getElementById('rdl-target-url').value.trim();
  if (!domain || !targetUrl) { toast(t('proxy.requiredFields'), 'error'); return; }

  const payload = {
    domain, extraDomains, targetUrl,
    statusCode: parseInt(document.getElementById('rdl-status-code').value, 10),
    preservePath: document.getElementById('rdl-preserve-path').checked,
    enabled: document.getElementById('rdl-enabled').checked,
    forceSsl: document.getElementById('rdl-force-ssl').checked,
    http2: document.getElementById('rdl-http2').checked,
    hstsEnabled: document.getElementById('rdl-hsts-enabled').checked,
    hstsSubdomains: document.getElementById('rdl-hsts-subdomains').checked,
  };

  const btn = document.getElementById('rdl-save');
  btn.disabled = true;
  try {
    if (_editingRedirectId) {
      await api('PUT', `/api/proxy/redirects/${_editingRedirectId}`, payload);
    } else {
      await api('POST', '/api/proxy/redirects', payload);
    }
    toast(t('proxy.saved'));
    closeModal('modal-redirect-rule');
    loadRedirectRules();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

async function rdlRequestLE() {
  if (!_editingRedirectId) return;
  const btn = document.getElementById('rdl-le-btn');
  const status = document.getElementById('rdl-cert-status');
  btn.disabled = true; btn.innerHTML = `${hearthSpinner(14)} Requesting…`;
  status.textContent = 'Contacting Let\'s Encrypt… this may take up to 60s';
  status.style.color = 'var(--text-faint)';
  try {
    const r = await api('POST', `/api/proxy/redirects/${_editingRedirectId}/cert/letsencrypt`);
    status.textContent = `✓ Certificate issued! Expires ${new Date(r.expires).toLocaleDateString()} (${r.daysLeft} days)`;
    status.style.color = 'var(--ok)';
    document.getElementById('rdl-cert-info').textContent = `Let's Encrypt — expires ${new Date(r.expires).toLocaleDateString()}`;
    loadRedirectRules();
  } catch(e) {
    status.textContent = `✗ ${e.message}`;
    status.style.color = 'var(--danger)';
  }
  finally { btn.disabled = false; btn.innerHTML = `<span>🔒 Request Let's Encrypt</span>`; }
}

async function rdlDeleteCert() {
  if (!_editingRedirectId) { toast('Save rule first', 'error'); return; }
  if (!confirm(t('proxy.deleteCertConfirm'))) return;
  const btn = document.getElementById('rdl-delete-cert-btn');
  btn.disabled = true;
  try {
    await api('DELETE', `/api/proxy/redirects/${_editingRedirectId}/cert`);
    toast('Certificate reset to self-signed ✓');
    document.getElementById('rdl-cert-info').textContent = 'Self-signed (no expiry info)';
    document.getElementById('rdl-cert-status').textContent = '';
    loadRedirectRules();
  } catch(e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
}

// ---------- 404 Hosts ----------
async function loadNotFoundHosts() {
  const rules = await api('GET', '/api/proxy/404hosts').catch(() => []);
  const box = document.getElementById('notfound-rules-list');
  if (!box) return;
  if (!rules.length) {
    box.innerHTML = `<div class="empty"><div class="big">∅</div>${t('proxy.notFoundEmpty')}</div>`;
    return;
  }
  box.innerHTML = rules.map((r) => {
    const certType = r.certType || 'self-signed';
    const certBadgeClass = certType === 'letsencrypt' ? 'le' : certType === 'custom' ? 'custom' : 'self';
    const certBadgeLabel = certType === 'letsencrypt' ? '🔒 LE' : certType === 'custom' ? '🔑 Custom' : '⚠ Self';
    const certBadge = `<span class="cert-badge ${certBadgeClass}" data-nfh-cert="${esc(r.id)}" title="Manage certificate">${certBadgeLabel}</span>`;
    const extraDomains = (r.extraDomains || []);
    const extraDomainsHtml = extraDomains.length ? `<span class="proxy-extra-domains">+${extraDomains.length} more</span>` : '';
    return `
    <div class="proxy-row">
      <span class="proxy-status-dot ${r.enabled ? '' : 'off'}"></span>
      <div class="proxy-main">
        <div class="proxy-domain">${esc(r.domain)}${extraDomainsHtml} ${certBadge}</div>
        <div class="proxy-target">→ 404</div>
      </div>
      <div class="proxy-actions">
        <label class="toggle" title="${r.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" ${r.enabled ? 'checked' : ''} data-nfh-toggle="${esc(r.id)}" />
          <span class="toggle-track"></span>
        </label>
        <button class="btn sm ghost" data-nfh-edit="${esc(r.id)}">✎</button>
        <button class="btn sm danger" data-nfh-del="${esc(r.id)}">🗑</button>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('notfound-rules-list').addEventListener('click', async (e) => {
  const delBtn = e.target.closest('[data-nfh-del]');
  if (delBtn) {
    if (!confirm(t('proxy.deleteConfirm'))) return;
    await api('DELETE', `/api/proxy/404hosts/${delBtn.dataset.nfhDel}`).catch((err) => toast(err.message, 'error'));
    loadNotFoundHosts();
    return;
  }
  const editBtn = e.target.closest('[data-nfh-edit]');
  if (editBtn) { open404Modal(editBtn.dataset.nfhEdit); return; }
  const certBadge = e.target.closest('[data-nfh-cert]');
  if (certBadge) { open404Modal(certBadge.dataset.nfhCert, 'cert'); return; }
});

document.getElementById('notfound-rules-list').addEventListener('change', async (e) => {
  const toggle = e.target.closest('[data-nfh-toggle]');
  if (!toggle) return;
  await api('PUT', `/api/proxy/404hosts/${toggle.dataset.nfhToggle}`, { enabled: toggle.checked })
    .catch((err) => { toast(err.message, 'error'); toggle.checked = !toggle.checked; });
  loadNotFoundHosts();
});

let _editing404Id = null;

document.querySelectorAll('[data-nfh-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#modal-404host .prl-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('#modal-404host .prl-tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`nfh-panel-${tab.dataset.nfhTab}`)?.classList.add('active');
  });
});

async function open404Modal(id, tab = 'general') {
  _editing404Id = id || null;
  document.getElementById('nfh-title').textContent = id ? t('proxy.notFoundEditTitle') : t('proxy.notFoundAddTitle');

  document.querySelectorAll('[data-nfh-tab]').forEach(t => t.classList.toggle('active', t.dataset.nfhTab === tab));
  document.querySelectorAll('#modal-404host .prl-tab-panel').forEach(p => p.classList.toggle('active', p.id === `nfh-panel-${tab}`));

  document.getElementById('nfh-domain').value = '';
  document.getElementById('nfh-extra-domains').value = '';
  document.getElementById('nfh-enabled').checked = true;
  document.getElementById('nfh-http2').checked = false;
  document.getElementById('nfh-hsts-enabled').checked = false;
  document.getElementById('nfh-hsts-subdomains').checked = false;
  document.getElementById('nfh-cert-info').textContent = id ? 'Loading…' : t('proxy.certSaveFirst');
  document.getElementById('nfh-cert-status').textContent = '';

  if (id) {
    api('GET', '/api/proxy/404hosts').then(rules => {
      const r = rules.find(x => x.id === id);
      if (!r) return;
      document.getElementById('nfh-domain').value = r.domain;
      document.getElementById('nfh-extra-domains').value = (r.extraDomains || []).join(', ');
      document.getElementById('nfh-enabled').checked = r.enabled;
      document.getElementById('nfh-http2').checked = !!r.http2;
      document.getElementById('nfh-hsts-enabled').checked = !!r.hstsEnabled;
      document.getElementById('nfh-hsts-subdomains').checked = !!r.hstsSubdomains;
    });
    api('GET', `/api/proxy/404hosts/${id}/cert`).then(c => {
      const el = document.getElementById('nfh-cert-info');
      if (c.expires) {
        const d = new Date(c.expires);
        const typeLabel = c.certType === 'letsencrypt' ? "Let's Encrypt" : 'Self-signed';
        el.innerHTML = `<strong>${typeLabel}</strong> — expires ${d.toLocaleDateString()} <span style="color:${c.daysLeft < 30 ? 'var(--danger)' : 'var(--text-faint)'}">(${c.daysLeft} days)</span>`;
      } else {
        el.textContent = 'Self-signed (no expiry info)';
      }
    }).catch(() => { document.getElementById('nfh-cert-info').textContent = 'Could not load cert info.'; });
  }

  openModal('modal-404host');
}

document.getElementById('nfh-save').addEventListener('click', async () => {
  const domain = document.getElementById('nfh-domain').value.trim();
  const extraDomains = document.getElementById('nfh-extra-domains').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!domain) { toast(t('proxy.requiredFields'), 'error'); return; }

  const payload = {
    domain, extraDomains,
    enabled: document.getElementById('nfh-enabled').checked,
    http2: document.getElementById('nfh-http2').checked,
    hstsEnabled: document.getElementById('nfh-hsts-enabled').checked,
    hstsSubdomains: document.getElementById('nfh-hsts-subdomains').checked,
  };

  const btn = document.getElementById('nfh-save');
  btn.disabled = true;
  try {
    if (_editing404Id) {
      await api('PUT', `/api/proxy/404hosts/${_editing404Id}`, payload);
    } else {
      await api('POST', '/api/proxy/404hosts', payload);
    }
    toast(t('proxy.saved'));
    closeModal('modal-404host');
    loadNotFoundHosts();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

async function nfhRequestLE() {
  if (!_editing404Id) return;
  const btn = document.getElementById('nfh-le-btn');
  const status = document.getElementById('nfh-cert-status');
  btn.disabled = true; btn.innerHTML = `${hearthSpinner(14)} Requesting…`;
  status.textContent = 'Contacting Let\'s Encrypt… this may take up to 60s';
  status.style.color = 'var(--text-faint)';
  try {
    const r = await api('POST', `/api/proxy/404hosts/${_editing404Id}/cert/letsencrypt`);
    status.textContent = `✓ Certificate issued! Expires ${new Date(r.expires).toLocaleDateString()} (${r.daysLeft} days)`;
    status.style.color = 'var(--ok)';
    document.getElementById('nfh-cert-info').textContent = `Let's Encrypt — expires ${new Date(r.expires).toLocaleDateString()}`;
    loadNotFoundHosts();
  } catch(e) {
    status.textContent = `✗ ${e.message}`;
    status.style.color = 'var(--danger)';
  }
  finally { btn.disabled = false; btn.innerHTML = `<span>🔒 Request Let's Encrypt</span>`; }
}

async function nfhDeleteCert() {
  if (!_editing404Id) { toast('Save rule first', 'error'); return; }
  if (!confirm(t('proxy.deleteCertConfirm'))) return;
  const btn = document.getElementById('nfh-delete-cert-btn');
  btn.disabled = true;
  try {
    await api('DELETE', `/api/proxy/404hosts/${_editing404Id}/cert`);
    toast('Certificate reset to self-signed ✓');
    document.getElementById('nfh-cert-info').textContent = 'Self-signed (no expiry info)';
    document.getElementById('nfh-cert-status').textContent = '';
    loadNotFoundHosts();
  } catch(e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
}

// ---------- Streams ----------
async function loadStreamRules() {
  const rules = await api('GET', '/api/proxy/streams').catch(() => []);
  const box = document.getElementById('stream-rules-list');
  if (!box) return;
  if (!rules.length) {
    box.innerHTML = `<div class="empty"><div class="big">⇄</div>${t('proxy.streamEmpty')}</div>`;
    return;
  }
  box.innerHTML = rules.map((r) => `
    <div class="stream-row">
      <span class="proxy-status-dot ${r.enabled ? '' : 'off'}"></span>
      <div class="proxy-main">
        <div class="proxy-domain">${esc(r.name || ('Port ' + r.listenPort))} <span class="stream-proto-badge">${esc(r.protocol)}</span></div>
        <div class="proxy-target">:${r.listenPort} → ${esc(r.forwardHost)}:${r.forwardPort}</div>
      </div>
      <div class="proxy-actions">
        <label class="toggle" title="${r.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" ${r.enabled ? 'checked' : ''} data-strm-toggle="${esc(r.id)}" />
          <span class="toggle-track"></span>
        </label>
        <button class="btn sm ghost" data-strm-edit="${esc(r.id)}">✎</button>
        <button class="btn sm danger" data-strm-del="${esc(r.id)}">🗑</button>
      </div>
    </div>`).join('');
}

document.getElementById('stream-rules-list').addEventListener('click', async (e) => {
  const delBtn = e.target.closest('[data-strm-del]');
  if (delBtn) {
    if (!confirm(t('proxy.deleteConfirm'))) return;
    await api('DELETE', `/api/proxy/streams/${delBtn.dataset.strmDel}`).catch((err) => toast(err.message, 'error'));
    loadStreamRules();
    return;
  }
  const editBtn = e.target.closest('[data-strm-edit]');
  if (editBtn) { openStreamModal(editBtn.dataset.strmEdit); return; }
});

document.getElementById('stream-rules-list').addEventListener('change', async (e) => {
  const toggle = e.target.closest('[data-strm-toggle]');
  if (!toggle) return;
  await api('PUT', `/api/proxy/streams/${toggle.dataset.strmToggle}`, { enabled: toggle.checked })
    .catch((err) => { toast(err.message, 'error'); toggle.checked = !toggle.checked; });
  loadStreamRules();
});

let _editingStreamId = null;

async function openStreamModal(id) {
  _editingStreamId = id || null;
  document.getElementById('strm-title').textContent = id ? t('proxy.streamEditTitle') : t('proxy.streamAddTitle');

  document.getElementById('strm-name').value = '';
  document.getElementById('strm-listen-port').value = '';
  document.getElementById('strm-protocol').value = 'tcp';
  document.getElementById('strm-forward-host').value = '';
  document.getElementById('strm-forward-port').value = '';
  document.getElementById('strm-enabled').checked = true;

  if (id) {
    const rules = await api('GET', '/api/proxy/streams').catch(() => []);
    const r = rules.find(x => x.id === id);
    if (r) {
      document.getElementById('strm-name').value = r.name || '';
      document.getElementById('strm-listen-port').value = r.listenPort;
      document.getElementById('strm-protocol').value = r.protocol;
      document.getElementById('strm-forward-host').value = r.forwardHost;
      document.getElementById('strm-forward-port').value = r.forwardPort;
      document.getElementById('strm-enabled').checked = r.enabled;
    }
  }

  openModal('modal-stream');
}

document.getElementById('strm-save').addEventListener('click', async () => {
  const name = document.getElementById('strm-name').value.trim();
  const listenPort = document.getElementById('strm-listen-port').value.trim();
  const protocol = document.getElementById('strm-protocol').value;
  const forwardHost = document.getElementById('strm-forward-host').value.trim();
  const forwardPort = document.getElementById('strm-forward-port').value.trim();
  if (!listenPort || !forwardHost || !forwardPort) { toast(t('proxy.requiredFields'), 'error'); return; }

  const payload = { name, listenPort, protocol, forwardHost, forwardPort, enabled: document.getElementById('strm-enabled').checked };

  const btn = document.getElementById('strm-save');
  btn.disabled = true;
  try {
    if (_editingStreamId) {
      await api('PUT', `/api/proxy/streams/${_editingStreamId}`, payload);
    } else {
      await api('POST', '/api/proxy/streams', payload);
    }
    toast(t('proxy.saved'));
    closeModal('modal-stream');
    loadStreamRules();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// ---------- Traffic Logs ----------
let _currentLogRuleId = null;

async function loadProxyLogs(ruleId) {
  _currentLogRuleId = ruleId;
  const rules = await api('GET', '/api/proxy/rules').catch(() => []);
  const rule = (rules || []).find(r => r.id === ruleId);
  document.getElementById('pll-title').textContent = `Traffic Logs — ${rule?.domain || ruleId}`;

  const [logs, stats] = await Promise.all([
    api('GET', `/api/proxy/rules/${ruleId}/logs`).catch(() => ({ entries: [] })),
    api('GET', `/api/proxy/rules/${ruleId}/stats`).catch(() => ({ total: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 })),
  ]);

  document.getElementById('pll-stats').innerHTML = `
    <div class="log-stat-card"><div class="log-stat-num">${stats.total}</div><div class="log-stat-label">Total</div></div>
    <div class="log-stat-card"><div class="log-stat-num s2xx">${stats.s2xx}</div><div class="log-stat-label">2xx OK</div></div>
    <div class="log-stat-card"><div class="log-stat-num s3xx">${stats.s3xx}</div><div class="log-stat-label">3xx Redirect</div></div>
    <div class="log-stat-card"><div class="log-stat-num s4xx">${stats.s4xx}</div><div class="log-stat-label">4xx Client</div></div>
    <div class="log-stat-card"><div class="log-stat-num s5xx">${stats.s5xx}</div><div class="log-stat-label">5xx Error</div></div>
  `;

  const tbody = document.getElementById('pll-body');
  if (!logs.entries.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-faint);padding:20px">No log entries yet</td></tr>`;
  } else {
    tbody.innerHTML = logs.entries.map(e => {
      const cls = e.status >= 500 ? 's5' : e.status >= 400 ? 's4' : e.status >= 300 ? 's3' : 's2';
      const time = e.time ? new Date(e.time).toLocaleTimeString() : '–';
      const uri = esc((e.uri || '').slice(0, 60));
      return `<tr>
        <td><span class="log-status ${cls}"></span>${e.status}</td>
        <td>${esc(e.method || '–')}</td>
        <td title="${esc(e.uri || '')}">${uri}</td>
        <td>${e.bytes > 1024 ? (e.bytes/1024).toFixed(1)+'k' : e.bytes+'b'}</td>
        <td>${esc(e.ip || '–')}</td>
        <td>${time}</td>
      </tr>`;
    }).join('');
  }

  openModal('modal-proxy-logs');
}

// ---------- Cloudflare Settings helpers ----------
async function cfVerifyCredentials(btn) {
  if (!btn) btn = document.getElementById('s-cf-verify');
  if (!btn) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    await api('POST', '/api/cloudflare/verify');
    toast('Cloudflare API: connected ✓');
    btn.textContent = '✓';
  } catch(e) {
    toast(e.message, 'error');
    btn.textContent = 'Verify';
  } finally { btn.disabled = false; }
}

async function cfDetectPublicIp(btn) {
  if (!btn) btn = document.getElementById('s-cf-detect-ip');
  if (!btn) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await api('GET', '/api/system/public-ip');
    if (r.ok) { document.getElementById('s-cf-ip').value = r.ip; toast(`Public IP: ${r.ip}`); }
    else toast(r.error, 'error');
  } catch(e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Detect'; }
}

// ---------- Firewall ----------
const FW_QUICK_PORTS = [
  { name: 'SSH',      port: 22,    proto: 'tcp' },
  { name: 'HTTP',     port: 80,    proto: 'tcp' },
  { name: 'HTTPS',    port: 443,   proto: 'tcp' },
  { name: 'DNS',      port: 53,    proto: 'udp' },
  { name: 'SMB',      port: 445,   proto: 'tcp' },
  { name: 'Plex',     port: 32400, proto: 'tcp' },
  { name: 'Hearth',   port: 4500,  proto: 'tcp' },
];

let _fwAvailable    = false;
let _fwLiveInterval = null;
let _fwStoredRules  = [];
let _fwAliases      = [];
let _fwAllLogs      = [];
let _fwEditId       = null;
let _fwAliasEditId  = null;
let _fwImportData   = null;

// Surfaces per-rule sync failures (e.g. a rule referencing a since-renamed alias)
// that the backend reports as ok:true alongside — those must not go unnoticed.
function fwShowWarnings(result) {
  if (result?.warnings?.length) {
    toast(result.warnings.map(w => w.error).join(' · '), 'error');
  }
}

async function loadFirewall() {
  const info = await api('GET', '/api/firewall/status').catch(() => ({ available: false }));
  _fwAvailable = !!info.available;

  const unavailEl   = document.getElementById('fw-unavail');
  const contentEl   = document.getElementById('fw-normal-content');
  const toggleBtn   = document.getElementById('fw-toggle-btn');
  const addBtn      = document.getElementById('fw-add-rule-btn');
  const exportBtn   = document.getElementById('fw-export-btn');
  const importBtn   = document.getElementById('fw-import-btn');
  const statManaged = document.getElementById('fw-stat-managed');
  const statExt     = document.getElementById('fw-stat-external');

  unavailEl.style.display = _fwAvailable ? 'none' : '';
  contentEl.style.display = _fwAvailable ? '' : 'none';
  if (toggleBtn)  toggleBtn.style.display  = _fwAvailable ? '' : 'none';
  if (addBtn)     addBtn.style.display     = _fwAvailable ? '' : 'none';
  if (exportBtn)  exportBtn.style.display  = _fwAvailable ? '' : 'none';
  if (importBtn)  importBtn.style.display  = _fwAvailable ? '' : 'none';

  const badge = document.getElementById('fw-status-badge');
  if (badge) {
    badge.className   = `fw-status-badge ${info.active ? 'active' : 'inactive'}`;
    badge.textContent = info.active ? t('firewall.active') : t('firewall.inactive');
  }
  if (toggleBtn) {
    const isActive = !!info.active;
    toggleBtn.textContent = isActive ? (t('firewall.disable') || 'Disable') : (t('firewall.enable') || 'Enable');
    toggleBtn.className   = `btn sm ghost${isActive ? ' danger' : ''}`;
  }

  if (!_fwAvailable) return;

  _fwStoredRules    = info.stored  || [];
  _fwAliases        = info.aliases || [];
  const ufwRules    = info.rules   || [];
  const unmanaged   = ufwRules.filter(r => !r.hearthId);

  if (statManaged) {
    statManaged.textContent = `${_fwStoredRules.length} ${t('firewall.managedRules') || 'rules'}`;
    statManaged.style.display = '';
  }
  if (statExt) {
    statExt.textContent   = `${unmanaged.length} external`;
    statExt.style.display = unmanaged.length ? '' : 'none';
  }

  const rawEl = document.getElementById('fw-raw-output');
  if (rawEl) rawEl.textContent = info.raw || '–';

  // Quick preset pills (port active = any ALLOW rule for that port exists in UFW)
  const allowedPorts = new Set(
    ufwRules.filter(r => r.action === 'ALLOW').map(r => {
      const m = r.to.match(/^(\d+)/); return m ? parseInt(m[1]) : null;
    }).filter(Boolean)
  );
  document.getElementById('fw-quick-ports').innerHTML = FW_QUICK_PORTS.map(p => {
    const on = allowedPorts.has(p.port);
    return `<div class="fw-preset-pill${on ? ' active' : ''}" onclick="fwTogglePreset(${p.port},'${p.proto}',${on})">
      <span class="fw-preset-dot"></span>
      ${esc(p.name)}
      <span class="fw-preset-port">${p.port}/${p.proto}</span>
    </div>`;
  }).join('');

  // Managed rules table, Aliases panel + datalists
  fwRenderRulesTable();
  fwRenderAliases();
  fwPopulateAliasDatalists();

  // External rules table
  const extWrap  = document.getElementById('fw-external-wrap');
  const extTbody = document.getElementById('fw-ext-tbody');
  if (unmanaged.length) {
    extWrap.style.display = '';
    extTbody.innerHTML = unmanaged.map(r => `
      <tr>
        <td style="color:var(--text-faint);font-family:var(--font-mono);font-size:11px">${r.num}</td>
        <td><span class="fw-rule-action ${r.action.toLowerCase()}">${r.action}</span></td>
        <td><span class="fw-dir-badge">${r.dir}</span></td>
        <td style="font-family:var(--font-mono);font-size:12px">${esc(r.to)}</td>
        <td style="font-family:var(--font-mono);font-size:12px;color:var(--text-faint)">${esc(r.from)}</td>
        <td><button class="iconbtn danger" onclick="fwDeleteExtRule(${r.num})" title="Delete">🗑</button></td>
      </tr>`).join('');
  } else {
    extWrap.style.display = 'none';
  }
}

// Render a From/To cell — alias tokens get a distinct pill, literal values stay as code
function fwEndpointCell(v) {
  if (!v || v === 'any') return `<span style="color:var(--text-faint)">any</span>`;
  if (String(v).startsWith('@')) return `<span class="fw-alias-pill" title="Alias">${esc(v)}</span>`;
  return `<code style="font-size:11px;font-family:var(--font-mono)">${esc(v)}</code>`;
}

// Render a Port cell — same alias-vs-literal distinction as fwEndpointCell
function fwPortCell(v) {
  if (!v) return `<span style="color:var(--text-faint)">–</span>`;
  if (String(v).startsWith('@')) return `<span class="fw-alias-pill" title="Alias">${esc(v)}</span>`;
  return `<code style="font-family:var(--font-mono);font-size:11px">${esc(v)}</code>`;
}

// Managed rules table — filterable; drag-reorder is disabled while a filter is active
// (reordering only reorders the visible subset, which would drop hidden rules on save)
function fwRenderRulesTable() {
  const tbody   = document.getElementById('fw-rules-tbody');
  const emptyEl = document.getElementById('fw-rules-empty');
  if (!tbody) return;
  const filter = (document.getElementById('fw-rule-filter')?.value || '').trim().toLowerCase();
  const rows = filter
    ? _fwStoredRules.filter(r => [r.action, r.direction, r.proto, r.from, r.to, r.port, r.comment, r.iface]
        .some(v => String(v || '').toLowerCase().includes(filter)))
    : _fwStoredRules;

  if (!_fwStoredRules.length) {
    tbody.innerHTML       = '';
    emptyEl.textContent   = t('firewall.empty');
    emptyEl.style.display = '';
    return;
  }
  if (!rows.length) {
    tbody.innerHTML       = '';
    emptyEl.textContent   = t('firewall.noMatch') || 'No matching rules.';
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';
  tbody.innerHTML = rows.map(r => {
    const enabled = r.enabled !== false;
    const dragTitle = filter ? '' : 'Drag to reorder';
    return `<tr draggable="${filter ? 'false' : 'true'}" data-fw-id="${esc(r.id)}" class="${enabled ? '' : 'fw-row-disabled'}">
      <td><span class="fw-drag-handle" style="${filter ? 'opacity:.3;cursor:default' : ''}" title="${dragTitle}">⠿</span></td>
      <td style="text-align:center">
        <label class="fw-toggle" onclick="event.stopPropagation()" title="${enabled ? 'Disable rule' : 'Enable rule'}">
          <input type="checkbox" ${enabled ? 'checked' : ''} onchange="fwToggleRule('${esc(r.id)}',this)">
          <span class="fw-toggle-track"></span>
        </label>
      </td>
      <td><span class="fw-rule-action ${r.action.toLowerCase()}">${r.action.toUpperCase()}</span></td>
      <td><span class="fw-dir-badge">${(r.direction||'in').toUpperCase()}</span>${r.iface ? ` <span class="fw-dir-badge">${esc(r.iface)}</span>` : ''}</td>
      <td style="color:var(--text-faint);font-size:12px">${r.proto && r.proto !== 'any' ? r.proto : 'any'}</td>
      <td>${fwEndpointCell(r.from)}</td>
      <td>${fwEndpointCell(r.to)}</td>
      <td>${fwPortCell(r.port)}</td>
      <td style="color:var(--text-faint);font-size:12px;font-style:italic;max-width:160px;overflow:hidden;text-overflow:ellipsis">${r.comment ? esc(r.comment) : ''}</td>
      <td>
        <div style="display:flex;gap:4px" onclick="event.stopPropagation()">
          <button class="iconbtn" onclick="fwEditRule('${esc(r.id)}')" title="Edit rule">✏</button>
          <button class="iconbtn danger" onclick="fwDeleteRule('${esc(r.id)}')" title="Delete rule">🗑</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  if (!filter) fwInitDragDrop();
}

// ---------- Firewall Aliases ----------
function fwRenderAliases() {
  const tbody   = document.getElementById('fw-aliases-tbody');
  const emptyEl = document.getElementById('fw-aliases-empty');
  if (!tbody) return;
  if (!_fwAliases.length) {
    tbody.innerHTML       = '';
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';
  tbody.innerHTML = _fwAliases.map(a => `
    <tr>
      <td><code style="font-size:12px;font-family:var(--font-mono)">@${esc(a.name)}</code></td>
      <td><span class="fw-dir-badge">${a.kind === 'port' ? (t('firewall.aliasKindPort') || 'Port') : (t('firewall.aliasKindNetwork') || 'Network')}</span></td>
      <td style="color:var(--text-faint);font-size:12px;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis">${esc(a.members.join(', '))}</td>
      <td>
        <div style="display:flex;gap:4px">
          <button class="iconbtn" onclick="fwOpenAliasModal('${esc(a.id)}')" title="Edit alias">✏</button>
          <button class="iconbtn danger" onclick="fwDeleteAlias('${esc(a.id)}')" title="Delete alias">🗑</button>
        </div>
      </td>
    </tr>`).join('');
}

function fwPopulateAliasDatalists() {
  const netList  = document.getElementById('fw-network-aliases');
  const portList = document.getElementById('fw-port-aliases');
  if (netList)  netList.innerHTML  = _fwAliases.filter(a => a.kind === 'network').map(a => `<option value="@${esc(a.name)}">`).join('');
  if (portList) portList.innerHTML = _fwAliases.filter(a => a.kind === 'port').map(a => `<option value="@${esc(a.name)}">`).join('');
}

function fwUpdateAliasKindHint() {
  const kind  = document.getElementById('fw-alias-kind').value;
  const hint  = document.getElementById('fw-alias-members-hint');
  const input = document.getElementById('fw-alias-members');
  if (kind === 'port') {
    hint.textContent  = t('firewall.aliasMembersHintPort') || 'Comma-separated ports or ranges (e.g. 80, 443, 8000:9000).';
    input.placeholder = '80, 443, 8000:9000';
  } else {
    hint.textContent  = t('firewall.aliasMembersHintNetwork') || 'Comma-separated IPs or CIDR ranges (IPv4 or IPv6).';
    input.placeholder = '192.168.1.0/24, 10.0.0.5';
  }
}

function fwOpenAliasModal(id) {
  const alias = id ? _fwAliases.find(a => a.id === id) : null;
  _fwAliasEditId = id || null;
  document.getElementById('fw-alias-name').value    = alias?.name || '';
  document.getElementById('fw-alias-kind').value     = alias?.kind || 'network';
  document.getElementById('fw-alias-kind').disabled  = !!alias;
  document.getElementById('fw-alias-members').value  = alias?.members?.join(', ') || '';
  fwUpdateAliasKindHint();
  document.getElementById('fw-alias-modal-title').textContent = alias ? (t('firewall.editAliasTitle') || 'Edit Alias') : t('firewall.addAliasTitle');
  document.getElementById('fw-alias-save').textContent        = alias ? (t('firewall.saveChanges') || 'Save Changes') : t('firewall.saveAlias');
  openModal('modal-fw-alias');
}

async function fwDeleteAlias(id) {
  const alias = _fwAliases.find(a => a.id === id);
  if (!confirm(t('firewall.deleteAliasConfirm', { name: alias?.name || '' }) || `Delete alias @${alias?.name}?`)) return;
  try {
    await api('DELETE', `/api/firewall/aliases/${id}`);
    loadFirewall();
  } catch (e) { toast(e.message, 'error'); }
}

document.getElementById('fw-alias-kind').addEventListener('change', fwUpdateAliasKindHint);
document.getElementById('fw-add-alias-btn').addEventListener('click', () => fwOpenAliasModal(null));

document.getElementById('fw-alias-save').addEventListener('click', async () => {
  const btn = document.getElementById('fw-alias-save');
  btn.disabled = true;
  const payload = {
    name:    document.getElementById('fw-alias-name').value.trim(),
    kind:    document.getElementById('fw-alias-kind').value,
    members: document.getElementById('fw-alias-members').value.split(',').map(m => m.trim()).filter(Boolean),
  };
  try {
    if (_fwAliasEditId) {
      fwShowWarnings(await api('PUT', `/api/firewall/aliases/${_fwAliasEditId}`, payload));
      toast(t('firewall.aliasUpdated') || 'Alias updated');
    } else {
      await api('POST', '/api/firewall/aliases', payload);
      toast(t('firewall.aliasAdded') || 'Alias added');
    }
    closeModal('modal-fw-alias');
    loadFirewall();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// ---------- Firewall Export/Import ----------
async function fwExportRules() {
  try {
    const data = await api('GET', '/api/firewall/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `hearth-firewall-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { toast(e.message, 'error'); }
}

// Reads the selected file and opens the mode-confirmation modal — the actual
// import only happens once the user picks Merge/Replace and confirms there,
// so a misclick on the file picker can never silently overwrite the ruleset.
async function fwImportRules(file) {
  const fileInput = document.getElementById('fw-import-file');
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    _fwImportData = data;
    document.getElementById('fw-import-summary').textContent = t('firewall.importSummary', {
      rules: (data.rules || []).length, aliases: (data.aliases || []).length,
    }) || `File contains ${(data.rules || []).length} rule(s) and ${(data.aliases || []).length} alias(es).`;
    document.getElementById('fw-import-mode').value = 'merge';
    document.getElementById('fw-import-replace-warning').style.display = 'none';
    openModal('modal-fw-import');
  } catch (e) {
    toast(t('firewall.importParseError') || 'Could not read file — is it a valid Hearth firewall export?', 'error');
  } finally {
    if (fileInput) fileInput.value = '';
  }
}

document.getElementById('fw-import-mode').addEventListener('change', function () {
  document.getElementById('fw-import-replace-warning').style.display = this.value === 'replace' ? '' : 'none';
});

document.getElementById('fw-import-confirm-btn').addEventListener('click', async () => {
  if (!_fwImportData) return;
  const btn  = document.getElementById('fw-import-confirm-btn');
  const mode = document.getElementById('fw-import-mode').value;
  btn.disabled = true;
  try {
    fwShowWarnings(await api('POST', '/api/firewall/import', { mode, rules: _fwImportData.rules || [], aliases: _fwImportData.aliases || [] }));
    toast(t('firewall.importDone') || 'Firewall ruleset imported');
    closeModal('modal-fw-import');
    loadFirewall();
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

// Toggle UFW on/off
async function fwToggleFirewall() {
  const isActive = document.getElementById('fw-status-badge')?.classList.contains('active');
  try {
    await api('POST', '/api/firewall/toggle', { enable: !isActive });
    loadFirewall();
  } catch (e) { toast(e.message, 'error'); }
}

// Enable/disable a single rule — optimistic UI (slider moves immediately, reverts on error)
async function fwToggleRule(id, checkbox) {
  const row     = checkbox?.closest('tr');
  const nowOn   = checkbox?.checked;
  if (row) row.classList.toggle('fw-row-disabled', !nowOn);
  const rule = _fwStoredRules.find(r => r.id === id);
  if (rule) rule.enabled = nowOn;
  try {
    fwShowWarnings(await api('PATCH', `/api/firewall/rules/${id}/toggle`, {}));
  } catch (e) {
    // Revert on error
    if (checkbox) checkbox.checked = !nowOn;
    if (row) row.classList.toggle('fw-row-disabled', nowOn);
    if (rule) rule.enabled = !nowOn;
    toast(e.message, 'error');
  }
}

// Open modal in edit mode
function fwEditRule(id) {
  const rule = _fwStoredRules.find(r => r.id === id);
  if (!rule) return;
  _fwEditId = id;
  document.getElementById('fw-action').value    = rule.action;
  document.getElementById('fw-direction').value = rule.direction || 'in';
  document.getElementById('fw-port').value      = rule.port || '';
  document.getElementById('fw-proto').value     = rule.proto || 'any';
  document.getElementById('fw-from').value      = rule.from && rule.from !== 'any' ? rule.from : '';
  document.getElementById('fw-to').value        = rule.to   && rule.to   !== 'any' ? rule.to   : '';
  document.getElementById('fw-iface').value     = rule.iface || '';
  document.getElementById('fw-comment').value   = rule.comment || '';
  document.getElementById('fw-limit-hint').style.display  = rule.action === 'limit' ? '' : 'none';
  document.getElementById('fw-modal-title').textContent   = t('firewall.editTitle') || 'Edit Firewall Rule';
  document.getElementById('fw-rule-save').textContent     = t('firewall.saveChanges') || 'Save Changes';
  openModal('modal-fw-rule');
}

// Delete a managed rule
async function fwDeleteRule(id) {
  if (!confirm(t('firewall.deleteConfirm').replace('#{n}', ''))) return;
  try {
    fwShowWarnings(await api('DELETE', `/api/firewall/rules/${id}`));
  } catch (e) { toast(e.message, 'error'); }
  loadFirewall();
}

// Delete an external (unmanaged) UFW rule
async function fwDeleteExtRule(num) {
  if (!confirm(t('firewall.deleteConfirm').replace('#{n}', num))) return;
  await api('DELETE', `/api/firewall/rules/num/${num}`).catch(e => toast(e.message, 'error'));
  loadFirewall();
}

// Toggle a quick preset port on/off
async function fwTogglePreset(port, proto, isActive) {
  try {
    if (isActive) {
      const toDelete = _fwStoredRules.filter(r => String(r.port) === String(port));
      for (const r of toDelete) await api('DELETE', `/api/firewall/rules/${r.id}`);
    } else {
      await api('POST', '/api/firewall/rules', { action: 'allow', port: String(port), proto, direction: 'in', from: 'any' });
    }
    loadFirewall();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- Drag & Drop ----------
let _fwDragId = null;

function fwInitDragDrop() {
  const rows = document.querySelectorAll('#fw-rules-tbody [data-fw-id]');
  rows.forEach(row => {
    row.addEventListener('dragstart', () => { _fwDragId = row.dataset.fwId; row.classList.add('dragging'); });
    row.addEventListener('dragend',   () => { row.classList.remove('dragging'); document.querySelectorAll('#fw-rules-tbody tr').forEach(r => r.classList.remove('drag-over')); });
    row.addEventListener('dragover',  e => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', async e => {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (!_fwDragId || _fwDragId === row.dataset.fwId) return;
      const allRows = [...document.querySelectorAll('#fw-rules-tbody [data-fw-id]')];
      const ids = allRows.map(r => r.dataset.fwId);
      const fromIdx = ids.indexOf(_fwDragId);
      const toIdx   = ids.indexOf(row.dataset.fwId);
      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, _fwDragId);
      try {
        fwShowWarnings(await api('PUT', '/api/firewall/rules/reorder', { ids }));
      } catch (e) { toast(e.message, 'error'); }
      loadFirewall();
    });
  });
}

// Limit hint
document.getElementById('fw-action').addEventListener('change', function() {
  document.getElementById('fw-limit-hint').style.display = this.value === 'limit' ? '' : 'none';
});

// Add rule button — reset to add mode
document.getElementById('fw-add-rule-btn').addEventListener('click', () => {
  _fwEditId = null;
  ['fw-port','fw-from','fw-to','fw-iface','fw-comment'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('fw-action').value    = 'allow';
  document.getElementById('fw-proto').value     = 'tcp';
  document.getElementById('fw-direction').value = 'in';
  document.getElementById('fw-limit-hint').style.display = 'none';
  document.getElementById('fw-modal-title').textContent  = t('firewall.addTitle');
  document.getElementById('fw-rule-save').textContent    = t('firewall.saveRule');
  openModal('modal-fw-rule');
});

// Save rule — add or edit
document.getElementById('fw-rule-save').addEventListener('click', async () => {
  const btn = document.getElementById('fw-rule-save');
  btn.disabled = true;
  const payload = {
    action:    document.getElementById('fw-action').value,
    port:      document.getElementById('fw-port').value.trim(),
    proto:     document.getElementById('fw-proto').value,
    from:      document.getElementById('fw-from').value.trim() || 'any',
    to:        document.getElementById('fw-to').value.trim()   || 'any',
    direction: document.getElementById('fw-direction').value,
    iface:     document.getElementById('fw-iface').value.trim(),
    comment:   document.getElementById('fw-comment').value.trim(),
  };
  try {
    if (_fwEditId) {
      fwShowWarnings(await api('PUT', `/api/firewall/rules/${_fwEditId}`, payload));
      toast(t('firewall.ruleUpdated') || 'Rule updated');
    } else {
      await api('POST', '/api/firewall/rules', payload);
      toast(t('firewall.ruleAdded'));
    }
    closeModal('modal-fw-rule');
    loadFirewall();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// ---------- Live Firewall Logs ----------
function fwToggleLiveLog() {
  const btn = document.getElementById('fw-log-toggle-btn');
  const dot = document.getElementById('fw-log-dot');
  if (_fwLiveInterval) {
    clearInterval(_fwLiveInterval);
    _fwLiveInterval = null;
    btn.textContent = t('firewall.logStart') || 'Start';
    dot.classList.remove('live');
  } else {
    btn.textContent = t('firewall.logStop') || 'Stop';
    dot.classList.add('live');
    fwFetchLogs();
    _fwLiveInterval = setInterval(fwFetchLogs, 3000);
  }
}

async function fwFetchLogs() {
  const data = await api('GET', '/api/firewall/logs?lines=100').catch(() => null);
  if (!data) return;
  _fwAllLogs = data.entries || [];
  fwRenderLogs();
}

function fwRenderLogs() {
  const body   = document.getElementById('fw-log-body');
  const filter = (document.getElementById('fw-log-filter')?.value || '').trim().toLowerCase();
  const entries = filter
    ? _fwAllLogs.filter(e => e.src.toLowerCase().includes(filter) || e.dst.toLowerCase().includes(filter))
    : _fwAllLogs;
  if (!entries.length) {
    body.innerHTML = `<div style="padding:12px 14px;color:var(--text-faint);font-size:12px">${filter ? 'No matching entries.' : (t('firewall.logHint') || 'Press "Start" to begin monitoring.')}</div>`;
    return;
  }
  body.innerHTML = entries.slice(0, 80).map(e => {
    const cls = e.action === 'BLOCK' ? 'BLOCK' : 'ALLOW';
    return `<div class="fw-log-entry">
      <span class="fw-log-action ${cls}">${e.action}</span>
      <span style="font-family:var(--font-mono);font-size:11px;overflow:hidden;text-overflow:ellipsis">${esc(e.src)}${e.spt?':'+e.spt:''}</span>
      <span class="fw-log-meta">→ :${esc(e.dpt)} ${esc(e.proto)} ${esc(e.iface)}</span>
      <span class="fw-log-meta" style="text-align:right">${esc(e.time)}</span>
    </div>`;
  }).join('');
}

// ---------- VPN ----------
let _vpnLastStatus = null;

async function loadVpn() {
  const data = await api('GET', '/api/vpn/status').catch(() => ({ available: false }));
  _vpnLastStatus = data;

  document.getElementById('vpn-unavail').style.display  = data.available ? 'none' : '';
  document.getElementById('vpn-content').style.display  = data.available ? '' : 'none';

  const badge = document.getElementById('vpn-status-badge');
  if (badge) {
    badge.className = `vpn-status-badge ${data.running ? 'active' : 'inactive'}`;
    badge.textContent = data.running ? 'Running' : 'Stopped';
  }

  if (!data.available) return;

  document.getElementById('vpn-server').textContent = data.host ? `${data.host}:${data.port}` : 'In den VPN-Einstellungen konfigurieren';
  document.getElementById('vpn-peer-count').textContent = (data.peers || []).length + ' configured';

  const list = document.getElementById('vpn-peers-list');
  if (!(data.peers || []).length) {
    list.innerHTML = '<div class="empty" style="padding:20px"><div class="big" style="font-size:32px">📱</div>No VPN clients yet.<br><span class="muted" style="font-size:13px">Click "+ Client" above to add one.</span></div>';
    return;
  }

  list.innerHTML = (data.peers || []).map(p => `
    <div class="vpn-peer-row row-clickable" data-peer-name="${esc(p.name)}">
      <span class="vpn-peer-name" title="${esc(p.name)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">📱 ${esc(p.name)}</span>
      <span class="row-chevron">›</span>
    </div>`).join('');
}

document.getElementById('vpn-peers-list').addEventListener('click', (e) => {
  const row = e.target.closest('[data-peer-name]');
  if (row) openVpnQr(row.dataset.peerName);
});

let _vpnCurrentPeer = null;

async function openVpnQr(name) {
  _vpnCurrentPeer = name;
  document.getElementById('vpn-qr-title').textContent = `VPN Client: ${name}`;
  document.getElementById('vpn-edit-name').value = name.replace(/^peer_/, '');
  document.getElementById('vpn-qr-png').src = `/api/vpn/peers/${encodeURIComponent(name)}/qr?t=${Date.now()}`;
  document.getElementById('vpn-qr-download').href = `/api/vpn/peers/${encodeURIComponent(name)}/conf`;
  document.getElementById('vpn-qr-download').setAttribute('download', `${name}.conf`);
  openModal('modal-vpn-qr');
}

document.getElementById('vpn-add-peer-btn')?.addEventListener('click', async function () {
  const name = prompt('Name für den neuen VPN-Client (nur Buchstaben/Zahlen, z.B. iPhone, Laptop):');
  if (!name) return;
  const btn = this;
  btn.disabled = true;
  btn.textContent = 'Starte VPN neu…';
  try {
    const { name: dirName } = await api('POST', '/api/vpn/peers', { name });
    toast(`Client "${name}" hinzugefügt`);
    await loadVpn();
    openVpnQr(dirName);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '+ Client';
  }
});

document.getElementById('vpn-rename-btn')?.addEventListener('click', async function () {
  const newName = document.getElementById('vpn-edit-name').value.trim();
  if (!newName || !_vpnCurrentPeer) return;
  const btn = this;
  btn.disabled = true;
  btn.textContent = 'Starte VPN neu…';
  try {
    const { name: newDir } = await api('PATCH', `/api/vpn/peers/${encodeURIComponent(_vpnCurrentPeer)}`, { name: newName });
    toast('Client umbenannt');
    await loadVpn();
    openVpnQr(newDir);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Speichern';
  }
});

document.getElementById('vpn-delete-btn')?.addEventListener('click', async function () {
  if (!_vpnCurrentPeer) return;
  if (!confirm(`Client "${_vpnCurrentPeer}" wirklich löschen? Der Zugang wird sofort entzogen und der VPN-Container kurz neu gestartet.`)) return;
  const btn = this;
  btn.disabled = true;
  btn.textContent = 'Starte VPN neu…';
  try {
    await api('DELETE', `/api/vpn/peers/${encodeURIComponent(_vpnCurrentPeer)}`);
    toast('Client gelöscht');
    closeModal('modal-vpn-qr');
    await loadVpn();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🗑 Löschen';
  }
});

document.getElementById('vpn-settings-btn')?.addEventListener('click', () => {
  document.getElementById('vpn-settings-host').value = _vpnLastStatus?.host || '';
  document.getElementById('vpn-settings-port').value = _vpnLastStatus?.port || 51820;
  openModal('modal-vpn-settings');
});

document.getElementById('vpn-settings-save-btn')?.addEventListener('click', async function () {
  const host = document.getElementById('vpn-settings-host').value.trim();
  const port = parseInt(document.getElementById('vpn-settings-port').value, 10);
  if (!host) return toast('Server-Adresse darf nicht leer sein', 'error');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return toast('Ungültiger Port', 'error');

  const btn = this;
  btn.disabled = true;
  btn.textContent = 'Starte VPN neu…';
  try {
    await api('POST', '/api/vpn/settings', { host, port });
    toast('Gespeichert — VPN wurde neu gestartet');
    closeModal('modal-vpn-settings');
    await loadVpn();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Speichern';
  }
});

// ---------- Setup Assistant ----------
const SETUP_ICONS = { ok: '✓', warn: '⚠', error: '✗', info: 'ℹ', checking: '…' };

function renderSetupChecks(box, checks) {
  box.innerHTML = checks.map((c) => {
    const hint = c.status !== 'ok' ? t(`setup.check.${c.id}.hint`, c.data || {}) : '';
    return `
    <div class="check-item ${c.status}">
      <span class="check-icon">${SETUP_ICONS[c.status] || '?'}</span>
      <div>
        <div class="check-label">${t(`setup.check.${c.id}.label`)}</div>
        ${hint ? `<div class="check-hint">${esc(hint)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function runSetupCheck(section) {
  const box = document.getElementById(`setup-checks-${section}`);
  const btn = document.querySelector(`[data-setup-run="${section}"]`);
  if (btn) btn.disabled = true;
  box.innerHTML = `<div class="check-item checking"><span class="check-icon">…</span><div class="check-label">${t('setup.checking')}</div></div>`;
  try {
    const { checks } = await api('GET', `/api/setup-assistant/${section}`);
    renderSetupChecks(box, checks);
  } catch (e) {
    box.innerHTML = `<div class="check-item error"><span class="check-icon">✗</span><div class="check-label">${esc(e.message)}</div></div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.querySelectorAll('[data-setup-run]').forEach((btn) => {
  btn.addEventListener('click', () => runSetupCheck(btn.dataset.setupRun));
});

document.getElementById('setup-run-all-btn').addEventListener('click', async () => {
  const allBtn = document.getElementById('setup-run-all-btn');
  allBtn.disabled = true;
  try {
    await Promise.all(['proxy', 'firewall', 'vpn'].map(runSetupCheck));
  } finally {
    allBtn.disabled = false;
  }
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

  // Category jump bar (mobile)
  const catKeys = Object.keys(bycat);
  let html = `<div class="store-cat-bar" id="store-cat-bar">${catKeys.map(k =>
    `<button class="store-cat-chip" onclick="document.getElementById('store-cat-${k}')?.scrollIntoView({behavior:'smooth',block:'start'})">${STORE_CATEGORIES[k] || k}</button>`
  ).join('')}</div>`;

  for (const [catKey, apps] of Object.entries(bycat)) {
    html += `<div class="store-category" data-cat="${catKey}" id="store-cat-${catKey}">
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

// ── Stacks ──────────────────────────────────────────────────────────────────

let _stacksData = [];
let _stackModalId = null;

async function loadStackGroups() {
  try {
    _stacksData = await api('GET', '/api/stacks');
    renderStackGroups();
  } catch (_) {}
}

function renderStackGroups() {
  const box = document.getElementById('stack-groups');
  const detected = _stacksData.filter(s => s.detected);
  if (!detected.length) { box.innerHTML = ''; return; }

  box.innerHTML = detected.map(stack => {
    const badge = stackStatusBadge(stack);
    const pills = stack.services.map(svc =>
      `<span class="stack-pill ${svc.status}${svc.optional ? ' optional' : ''}" title="${esc(svc.name)}">${esc(svc.name)}</span>`
    ).join('');
    return `
      <div class="stack-group" onclick="openStackModal('${esc(stack.id)}')">
        <div class="stack-group-icon">${stack.icon}</div>
        <div class="stack-group-info">
          <div class="stack-group-name">${esc(stack.name)}</div>
          <div class="stack-group-desc stack-pills" style="margin-top:6px">${pills}</div>
        </div>
        <div class="stack-group-right">
          <span class="stack-status-badge ${badge.cls}">${badge.label}</span>
          <span style="color:var(--text-faint);font-size:16px">›</span>
        </div>
      </div>`;
  }).join('');
}

function stackStatusBadge(stack) {
  const req = stack.services.filter(s => !s.optional);
  const reqRunning = req.filter(s => s.status === 'running').length;
  if (reqRunning === req.length) return { cls: 'ok', label: `${stack.runningCount}/${stack.totalCount} ✓` };
  if (reqRunning > 0) return { cls: 'partial', label: `${stack.runningCount}/${stack.totalCount}` };
  return { cls: 'missing', label: `${stack.runningCount}/${stack.totalCount}` };
}

function openStackModal(stackId) {
  const stack = _stacksData.find(s => s.id === stackId);
  if (!stack) return;
  _stackModalId = stackId;

  document.getElementById('stack-modal-title').innerHTML = `${stack.icon} ${esc(stack.name)}`;
  document.getElementById('stack-modal-desc').textContent = stack.description;

  // Path inputs
  const pathsDiv = document.getElementById('stack-modal-paths');
  pathsDiv.innerHTML = Object.entries(stack.paths || {}).map(([key, p]) => `
    <div class="field" style="margin:0 0 10px">
      <label style="font-size:12px;font-weight:600">${esc(p.label)}</label>
      <div style="font-size:11px;color:var(--text-faint);margin-bottom:4px">${esc(p.description || '')}</div>
      <input class="input" id="stack-path-${esc(key)}" value="${esc(p.default)}" placeholder="${esc(p.default)}">
    </div>`).join('');

  // Service rows
  const svcsDiv = document.getElementById('stack-modal-services');
  svcsDiv.innerHTML = stack.services.map(svc => {
    const dotCls = svc.status === 'running' ? 'running' : svc.status === 'exited' ? 'stopped' : 'missing';
    const statusText = svc.status === 'running' ? 'Läuft' : svc.status === 'exited' ? 'Gestoppt' : 'Nicht installiert';
    const portBadge = svc.hostPort ? `<span class="port">:${svc.hostPort}</span>` : '';
    let actionBtn = '';
    if (svc.status === 'missing') {
      actionBtn = `<button class="btn sm ghost" onclick="deployStackService('${esc(stack.id)}','${esc(svc.key)}')">Installieren</button>`;
    } else if (svc.status === 'exited' && svc.containerId) {
      actionBtn = `<button class="btn sm ghost" onclick="startStackContainer('${esc(svc.containerId)}')">Starten</button>`;
    } else if (svc.status === 'running' && svc.hostPort) {
      actionBtn = `<a class="btn sm ghost" href="http://${location.hostname}:${svc.hostPort}" target="_blank" rel="noopener">Öffnen ↗</a>`;
    }
    const optBadge = svc.optional ? '<span style="font-size:10px;color:var(--text-faint);margin-left:4px">(optional)</span>' : '';
    return `
      <div class="stack-svc-row">
        <span class="stack-svc-dot ${dotCls}"></span>
        <div class="stack-svc-info">
          <div class="stack-svc-name">${esc(svc.name)}${optBadge}</div>
          <div class="stack-svc-meta">${esc(svc.description)} · ${esc(svc.image)} ${portBadge}</div>
        </div>
        <span style="font-size:11px;color:var(--text-faint)">${statusText}</span>
        ${actionBtn}
      </div>`;
  }).join('');

  const hasMissing = stack.services.some(s => s.status === 'missing' && !s.optional);
  document.getElementById('stack-deploy-missing-btn').style.display = hasMissing ? '' : 'none';
  openModal('modal-stack');
}

function getStackPaths(stackId) {
  const stack = _stacksData.find(s => s.id === stackId);
  if (!stack) return {};
  const paths = {};
  Object.keys(stack.paths || {}).forEach(key => {
    const el = document.getElementById(`stack-path-${key}`);
    paths[key] = el ? el.value.trim() : (stack.paths[key]?.default || '');
  });
  return paths;
}

async function deployStackService(stackId, serviceKey) {
  const paths = getStackPaths(stackId);
  try {
    toast(`Installiere ${serviceKey}…`, 'info');
    await api('POST', `/api/stacks/${stackId}/services/${serviceKey}/deploy`, { paths });
    toast(`${serviceKey} installiert`);
    _stacksData = await api('GET', '/api/stacks');
    renderStackGroups();
    openStackModal(stackId);
  } catch (e) { toast(e.message, 'error'); }
}

async function startStackContainer(containerId) {
  try {
    await api('POST', `/api/containers/${containerId}/start`);
    toast('Container gestartet');
    _stacksData = await api('GET', '/api/stacks');
    renderStackGroups();
    openStackModal(_stackModalId);
  } catch (e) { toast(e.message, 'error'); }
}

document.getElementById('stack-export-btn').addEventListener('click', () => {
  if (_stackModalId) exportStack(_stackModalId);
});

document.getElementById('stack-deploy-missing-btn').addEventListener('click', async () => {
  if (!_stackModalId) return;
  const stack = _stacksData.find(s => s.id === _stackModalId);
  if (!stack) return;
  const missing = stack.services.filter(s => s.status === 'missing' && !s.optional);
  if (!missing.length) return;
  const paths = getStackPaths(_stackModalId);
  for (const svc of missing) {
    try {
      toast(`Installiere ${svc.name}…`, 'info');
      await api('POST', `/api/stacks/${_stackModalId}/services/${svc.key}/deploy`, { paths });
      toast(`${svc.name} installiert`);
    } catch (e) { toast(`${svc.name}: ${e.message}`, 'error'); }
  }
  _stacksData = await api('GET', '/api/stacks');
  renderStackGroups();
  openStackModal(_stackModalId);
});

// ── Custom Stack Import ──────────────────────────────────────────────────────

function openStackImport(existingId = null) {
  const title = document.getElementById('stack-import-title');
  const jsonTA = document.getElementById('stack-import-json');
  const urlIn  = document.getElementById('stack-import-url');
  const errDiv = document.getElementById('stack-import-error');

  title.textContent = existingId ? '📦 Custom Stack bearbeiten' : '📦 Custom Stack importieren';
  urlIn.value  = '';
  errDiv.style.display = 'none';

  if (existingId) {
    const stack = _stacksData.find(s => s.id === existingId);
    const raw   = (runtimeConfig_customStacks || []).find(s => s.id === existingId);
    jsonTA.value = JSON.stringify(raw || { id: existingId }, null, 2);
    document.getElementById('stack-import-save-btn').dataset.editId = existingId;
  } else {
    jsonTA.value = '';
    delete document.getElementById('stack-import-save-btn').dataset.editId;
  }
  openModal('modal-stack-import');
}

let runtimeConfig_customStacks = [];

async function refreshCustomStacksCache() {
  try { runtimeConfig_customStacks = await api('GET', '/api/stacks/custom'); } catch (_) {}
}

document.getElementById('stack-import-fetch-btn').addEventListener('click', async () => {
  const url = document.getElementById('stack-import-url').value.trim();
  if (!url) return;
  const btn = document.getElementById('stack-import-fetch-btn');
  btn.disabled = true; btn.textContent = '…';
  const errDiv = document.getElementById('stack-import-error');
  errDiv.style.display = 'none';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    document.getElementById('stack-import-json').value = JSON.stringify(json, null, 2);
  } catch (e) {
    errDiv.textContent = `Fehler beim Laden: ${e.message}`;
    errDiv.style.display = '';
  } finally { btn.disabled = false; btn.textContent = 'Laden'; }
});

document.getElementById('stack-import-save-btn').addEventListener('click', async () => {
  const jsonText = document.getElementById('stack-import-json').value.trim();
  const editId   = document.getElementById('stack-import-save-btn').dataset.editId;
  const errDiv   = document.getElementById('stack-import-error');
  errDiv.style.display = 'none';
  try {
    const parsed = JSON.parse(jsonText);
    if (editId) {
      await api('PUT', `/api/stacks/custom/${editId}`, { json: parsed });
      toast('Stack aktualisiert');
    } else {
      await api('POST', '/api/stacks/custom', { json: parsed });
      toast('Stack importiert');
    }
    closeModal('modal-stack-import');
    await refreshCustomStacksCache();
    _stacksData = await api('GET', '/api/stacks');
    renderStackGroups();
    _storeRendered = false;
    if (document.getElementById('view-store').classList.contains('active')) renderStore();
  } catch (e) {
    errDiv.textContent = e.message;
    errDiv.style.display = '';
  }
});

async function deleteCustomStack(id) {
  if (!confirm(`Custom Stack "${id}" wirklich löschen?`)) return;
  try {
    await api('DELETE', `/api/stacks/custom/${id}`);
    toast('Stack gelöscht');
    await refreshCustomStacksCache();
    _stacksData = await api('GET', '/api/stacks');
    renderStackGroups();
    _storeRendered = false;
    if (document.getElementById('view-store').classList.contains('active')) renderStore();
  } catch (e) { toast(e.message, 'error'); }
}

// Stacks-Sektion im Store
const _origRenderStore = renderStore;
renderStore = async function () {
  await _origRenderStore();
  // Prepend stacks section
  const container = document.getElementById('store-categories');
  if (document.getElementById('store-stacks-section') || !_stacksData.length) {
    if (!_stacksData.length) {
      try { _stacksData = await api('GET', '/api/stacks'); } catch (_) { return; }
    }
    if (document.getElementById('store-stacks-section')) return;
  }
  if (!_stacksData.length) {
    try { _stacksData = await api('GET', '/api/stacks'); } catch (_) { return; }
  }

  const cards = _stacksData.map(stack => {
    const svcChips = stack.services.map(svc =>
      `<span class="stack-svc-chip${svc.optional ? ' optional' : ''}">${esc(svc.name)}</span>`
    ).join('');
    const customBadge = stack.custom
      ? `<span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:rgba(249,130,52,.15);color:#f98234;border:1px solid rgba(249,130,52,.3);margin-left:6px">Custom</span>`
      : '';
    const customActions = stack.custom ? `
      <div style="display:flex;gap:6px;margin-top:6px" onclick="event.stopPropagation()">
        <button class="btn sm ghost" style="font-size:11px;padding:3px 8px" onclick="openStackImport('${esc(stack.id)}')">Bearbeiten</button>
        <button class="btn sm ghost" style="font-size:11px;padding:3px 8px;color:var(--danger,#e74c3c);border-color:var(--danger,#e74c3c)" onclick="deleteCustomStack('${esc(stack.id)}')">Löschen</button>
      </div>` : '';
    return `
      <div class="stack-store-card" onclick="openStackModal('${esc(stack.id)}')">
        <div class="stack-store-head">
          <div class="stack-store-icon">${stack.icon}</div>
          <div class="stack-store-title">${esc(stack.name)}${customBadge}</div>
        </div>
        <div class="stack-store-desc">${esc(stack.description)}</div>
        <div class="stack-store-services">${svcChips}</div>
        ${customActions}
      </div>`;
  }).join('');

  const section = document.createElement('div');
  section.id = 'store-stacks-section';
  section.innerHTML = `
    <div class="store-category-title" style="margin-top:0;display:flex;align-items:center;gap:10px">
      📦 Stacks
      <button class="btn sm ghost" style="margin-left:auto;font-size:12px" onclick="openStackImport()">+ Custom Stack</button>
    </div>
    <div class="stack-store-grid">${cards}</div>`;
  container.insertBefore(section, container.firstChild);
};

// Stacks beim Öffnen des Container-Tabs laden
document.querySelectorAll('[data-view]').forEach(btn => {
  if (btn.dataset.view === 'containers') {
    btn.addEventListener('click', () => loadStackGroups());
  }
});

// (Community tab removed from tab row — navigation via #btn-community-nav in topbar)

// ── Community Tab ────────────────────────────────────────────────────────────

let _communityLoaded = false;

async function loadCommunityTab(force = false) {
  if (_communityLoaded && !force) return;
  _communityLoaded = true;
  await Promise.all([loadCommunityStacks(force), loadCommunityThemes(force)]);
}

async function loadCommunityStacks(force = false) {
  const grid = document.getElementById('community-stacks-grid');
  grid.innerHTML = hearthLoading();
  try {
    const url = force ? '/api/community/stacks?refresh=1' : '/api/community/stacks';
    const stacks = await api('GET', url);
    const existingIds = new Set(_stacksData.map(s => s.id));
    if (!stacks.length) { grid.innerHTML = '<span style="font-size:13px;color:var(--text-faint)">Keine Community-Stacks gefunden.</span>'; return; }
    grid.innerHTML = stacks.map(stack => {
      const already = existingIds.has(stack.id);
      const chips = (stack.services || []).map(s =>
        `<span class="stack-svc-chip${s.optional ? ' optional' : ''}">${esc(s.name)}</span>`
      ).join('');
      const tagBadges = (stack.tags || []).map(t =>
        `<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--panel-2);border:1px solid var(--border);color:var(--text-faint)">${esc(t)}</span>`
      ).join('');
      return `
        <div class="stack-store-card">
          <div class="stack-store-head">
            <div class="stack-store-icon">${stack.icon || '📦'}</div>
            <div>
              <div class="stack-store-title">${esc(stack.name)}</div>
              <div style="font-size:11px;color:var(--text-faint);margin-top:2px">by ${esc(stack.author || 'community')}</div>
            </div>
          </div>
          <div class="stack-store-desc">${esc(stack.description || '')}</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap">${tagBadges}</div>
          <div class="stack-store-services">${chips}</div>
          <div style="margin-top:6px">
            ${already
              ? `<span style="font-size:12px;color:var(--text-faint)">✓ Bereits importiert</span>`
              : `<button class="btn sm primary" onclick="importCommunityStack(${esc(JSON.stringify(stack))})">Importieren</button>`}
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    grid.innerHTML = `<span style="font-size:13px;color:var(--danger,#e74c3c)">${esc(e.message)}</span>`;
  }
}

async function importCommunityStack(stackDef) {
  try {
    await api('POST', '/api/stacks/custom', { json: stackDef });
    toast(`"${stackDef.name}" importiert`);
    await refreshCustomStacksCache();
    _stacksData = await api('GET', '/api/stacks');
    renderStackGroups();
    _storeRendered = false;
    loadCommunityStacks();
  } catch (e) { toast(e.message, 'error'); }
}

function _themePreviewHtml(theme) {
  const c = theme.colors || {};
  const bg  = c.bg     || theme.preview || '#1e1e2e';
  const pnl = c.panel  || '#333';
  const acc = c.accent || '#888';
  const txt = c.text   || '#eee';
  const bdr = c.border || '#555';
  return `<div style="width:84px;height:58px;border-radius:7px;overflow:hidden;border:1px solid ${bdr};flex-shrink:0">
    <div style="background:${bg};height:100%;display:flex">
      <div style="background:${pnl};width:23px;border-right:1px solid ${bdr};padding:5px 3px;display:flex;flex-direction:column;gap:4px">
        <div style="background:${acc};height:4px;border-radius:2px"></div>
        <div style="background:${txt};height:3px;border-radius:2px;opacity:0.25"></div>
        <div style="background:${txt};height:3px;border-radius:2px;opacity:0.18"></div>
        <div style="background:${txt};height:3px;border-radius:2px;opacity:0.18"></div>
      </div>
      <div style="flex:1;padding:5px 4px;display:flex;flex-direction:column;gap:4px">
        <div style="background:${txt};height:3px;border-radius:2px;opacity:0.6;width:65%"></div>
        <div style="background:${pnl};height:16px;border-radius:4px;border:1px solid ${bdr}"></div>
        <div style="background:${acc};height:4px;border-radius:2px;width:45%"></div>
      </div>
    </div>
  </div>`;
}

async function loadCommunityThemes(force = false) {
  const grid = document.getElementById('community-themes-grid');
  grid.innerHTML = hearthLoading();
  try {
    const url = force ? '/api/community/themes?refresh=1' : '/api/community/themes';
    const themes = await api('GET', url);
    if (!themes.length) { grid.innerHTML = '<span style="font-size:13px;color:var(--text-faint)">Keine Themes gefunden.</span>'; return; }
    grid.innerHTML = themes.map(theme => `
      <div style="background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:14px;display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;align-items:flex-start;gap:12px">
          ${_themePreviewHtml(theme)}
          <div style="min-width:0">
            <div style="font-size:13px;font-weight:600;margin-bottom:2px">${esc(theme.name)}</div>
            <div style="font-size:11px;color:var(--text-faint);margin-bottom:6px">by ${esc(theme.author || 'community')}</div>
            <div style="font-size:12px;color:var(--text-dim);line-height:1.4">${esc(theme.description || '')}</div>
          </div>
        </div>
        <button class="btn sm ghost" onclick="applyCommunityTheme(${esc(JSON.stringify(theme))})">Anwenden</button>
      </div>`).join('');
  } catch (e) {
    grid.innerHTML = `<span style="font-size:13px;color:var(--danger,#e74c3c)">${esc(e.message)}</span>`;
  }
}

function _applyThemeCss(css) {
  let el = document.getElementById('custom-theme');
  if (!el) {
    el = document.createElement('style');
    el.id = 'custom-theme';
    document.head.appendChild(el);
  }
  el.textContent = css || '';
}

async function applyCommunityTheme(theme) {
  try {
    await api('POST', '/api/theme', { css: theme.css, id: theme.id, name: theme.name });
    toast(`Theme "${theme.name}" angewendet`);
    loadThemeStatus();
    _applyThemeCss(theme.css);
  } catch (e) { toast(e.message, 'error'); }
}

document.getElementById('community-refresh-btn').addEventListener('click', () => {
  loadCommunityTab(true);
});

// ── Contribute Modal ──────────────────────────────────────────────────────────

let _contribType = 'stack';

function setContribType(type) {
  _contribType = type;
  document.getElementById('contrib-stack-form').style.display = type === 'stack' ? '' : 'none';
  document.getElementById('contrib-theme-form').style.display = type === 'theme' ? '' : 'none';
  document.getElementById('contrib-type-stack').className = type === 'stack' ? 'btn sm' : 'btn sm ghost';
  document.getElementById('contrib-type-theme').className = type === 'theme' ? 'btn sm' : 'btn sm ghost';
}

document.getElementById('btn-contribute').addEventListener('click', () => {
  _contribType = 'stack';
  setContribType('stack');
  const sel = document.getElementById('contrib-stack-select');
  sel.innerHTML = '<option value="">— Eigenen Stack auswählen (optional) —</option>';
  (runtimeConfig_customStacks || []).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sel.appendChild(opt);
  });
  ['contrib-stack-name','contrib-stack-desc','contrib-stack-json',
   'contrib-theme-name','contrib-theme-desc','contrib-theme-author','contrib-theme-css'
  ].forEach(id => { document.getElementById(id).value = ''; });
  openModal('modal-contribute');
});

document.getElementById('contrib-stack-select').addEventListener('change', () => {
  const id = document.getElementById('contrib-stack-select').value;
  if (!id) return;
  const stack = (runtimeConfig_customStacks || []).find(s => s.id === id);
  if (!stack) return;
  document.getElementById('contrib-stack-name').value = stack.name || '';
  document.getElementById('contrib-stack-desc').value = stack.description || '';
  document.getElementById('contrib-stack-json').value = JSON.stringify(stack, null, 2);
});

document.getElementById('btn-contrib-submit').addEventListener('click', () => {
  if (_contribType === 'stack') {
    const name = document.getElementById('contrib-stack-name').value.trim();
    const desc = document.getElementById('contrib-stack-desc').value.trim();
    const json = document.getElementById('contrib-stack-json').value.trim();
    if (!name || !json) { toast('Bitte Name und JSON ausfüllen', 'error'); return; }
    let parsed;
    try { parsed = JSON.parse(json); } catch { toast('Ungültiges JSON', 'error'); return; }
    const body = `## Community Stack Submission\n\n**Name:** ${name}\n**Description:** ${desc}\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\`\n\n---\n*Submitted via Hearth*`;
    window.open(
      `https://github.com/MarioundMB/Hearth/issues/new?title=${encodeURIComponent('[Community Stack] ' + name)}&body=${encodeURIComponent(body)}&labels=community-stack`,
      '_blank'
    );
  } else {
    const name   = document.getElementById('contrib-theme-name').value.trim();
    const desc   = document.getElementById('contrib-theme-desc').value.trim();
    const author = document.getElementById('contrib-theme-author').value.trim();
    const css    = document.getElementById('contrib-theme-css').value.trim();
    if (!name || !css) { toast('Bitte Name und CSS ausfüllen', 'error'); return; }
    const body = `## Community Theme Submission\n\n**Name:** ${name}\n**Description:** ${desc}\n**Author:** ${author || 'anonymous'}\n\n\`\`\`css\n${css}\n\`\`\`\n\n---\n*Submitted via Hearth*`;
    window.open(
      `https://github.com/MarioundMB/Hearth/issues/new?title=${encodeURIComponent('[Community Theme] ' + name)}&body=${encodeURIComponent(body)}&labels=community-theme`,
      '_blank'
    );
  }
});

// ── Theme Management (in Settings) ───────────────────────────────────────────

async function loadThemeStatus() {
  try {
    const theme = await api('GET', '/api/theme');
    const nameEl  = document.getElementById('theme-active-name');
    const resetBtn = document.getElementById('theme-reset-btn');
    if (theme) {
      nameEl.textContent = theme.name + (theme.sourceUrl ? ' (via URL)' : '');
      resetBtn.style.display = '';
    } else {
      nameEl.textContent = 'Standard (kein Custom Theme)';
      resetBtn.style.display = 'none';
    }
  } catch (_) {}
}

async function loadSettingsThemePicker() {
  const list = document.getElementById('theme-community-list');
  try {
    const themes = await api('GET', '/api/community/themes');
    list.innerHTML = themes.map(t => `
      <button onclick="applyCommunityTheme(${esc(JSON.stringify(t))})"
        style="display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:var(--panel-2);cursor:pointer;font-size:12px;color:var(--text)">
        <span style="width:14px;height:14px;border-radius:3px;background:${esc(t.preview || '#333')};display:inline-block;flex-shrink:0;border:1px solid var(--border)"></span>
        ${esc(t.name)}
      </button>`).join('');
  } catch (_) { list.innerHTML = '<span style="font-size:12px;color:var(--text-faint)">Nicht verfügbar</span>'; }
}

document.getElementById('theme-reset-btn').addEventListener('click', async () => {
  await api('DELETE', '/api/theme');
  toast('Theme zurückgesetzt');
  loadThemeStatus();
  _applyThemeCss('');
});

document.getElementById('theme-css-toggle').addEventListener('click', () => {
  const area = document.getElementById('theme-css-area');
  const btn  = document.getElementById('theme-css-toggle');
  const open = area.style.display === 'none';
  area.style.display = open ? 'flex' : 'none';
  btn.textContent = open ? 'Ausblenden ▴' : 'Anzeigen ▾';
});

document.getElementById('theme-apply-btn').addEventListener('click', async () => {
  const css = document.getElementById('theme-css-input').value.trim();
  const url = document.getElementById('theme-url-input').value.trim();
  if (!css && !url) { toast('CSS oder URL eingeben', 'error'); return; }
  try {
    await api('POST', '/api/theme', url ? { url, name: 'Custom (URL)' } : { css, name: 'Custom CSS' });
    toast('Theme angewendet');
    loadThemeStatus();
    if (css) {
      _applyThemeCss(css);
    } else {
      fetch('/custom.css?_=' + Date.now()).then(r => r.text()).then(_applyThemeCss);
    }
  } catch (e) { toast(e.message, 'error'); }
});

// Laden wenn Settings-Modal öffnet
document.getElementById('modal-settings').addEventListener('click', e => {
  if (e.target.closest('.modal') && !document.getElementById('theme-active-name').dataset.loaded) {
    document.getElementById('theme-active-name').dataset.loaded = '1';
    loadThemeStatus();
    loadSettingsThemePicker();
    loadChangelog();
  }
});
document.querySelectorAll('[onclick*="modal-settings"], #open-settings, #btn-settings').forEach(el => {
  el.addEventListener('click', () => { loadThemeStatus(); loadSettingsThemePicker(); loadChangelog(); });
});

// ── Changelog ────────────────────────────────────────────────────────────────

async function loadChangelog(force = false) {
  const list = document.getElementById('changelog-list');
  list.innerHTML = hearthLoading();
  try {
    const url = force ? '/api/changelog?refresh=1' : '/api/changelog';
    const releases = await api('GET', url);
    if (!releases.length) { list.innerHTML = '<span style="font-size:12px;color:var(--text-faint)">Keine Releases gefunden.</span>'; return; }
    list.innerHTML = releases.map((rel, i) => {
      const date = new Date(rel.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const preTag = rel.prerelease ? `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(255,159,10,.15);color:#ff9f0a;border:1px solid rgba(255,159,10,.3)">pre</span> ` : '';
      const bodyHtml = rel.body
        ? rel.body
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/^## (.+)$/gm, '<strong style="font-size:12px;display:block;margin:6px 0 2px">$1</strong>')
            .replace(/^### (.+)$/gm, '<strong style="font-size:11px;display:block;margin:4px 0 2px;color:var(--text-dim)">$1</strong>')
            .replace(/^- (.+)$/gm, '<span style="display:block;padding-left:10px">· $1</span>')
            .replace(/\n/g, '')
        : '';
      const isFirst = i === 0;
      return `
        <div style="padding:10px 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:${bodyHtml ? '6px' : '0'}">
            <span style="font-size:13px;font-weight:700">${preTag}${esc(rel.name)}</span>
            ${isFirst ? `<span style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(52,199,89,.15);color:#34c759;border:1px solid rgba(52,199,89,.3)">Aktuell</span>` : ''}
            <span style="margin-left:auto;font-size:11px;color:var(--text-faint)">${date}</span>
            <a href="${esc(rel.url)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent)" onclick="event.stopPropagation()">↗</a>
          </div>
          ${bodyHtml ? `<div style="font-size:12px;color:var(--text-dim);line-height:1.6;max-height:120px;overflow:hidden;position:relative" id="cl-body-${i}">
            ${bodyHtml}
            <button onclick="document.getElementById('cl-body-${i}').style.maxHeight='none';this.remove()" style="position:absolute;bottom:0;right:0;background:var(--panel);border:none;color:var(--accent);font-size:11px;cursor:pointer;padding:0 4px">mehr…</button>
          </div>` : ''}
        </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<span style="font-size:12px;color:var(--danger,#e74c3c)">${esc(e.message)}</span>`;
  }
}

document.getElementById('changelog-refresh-btn').addEventListener('click', () => loadChangelog(true));

// ── Stack Export ──────────────────────────────────────────────────────────────

function exportStack(stackId) {
  window.open(`/api/stacks/${encodeURIComponent(stackId)}/export`, '_blank');
}

loadContainers();
loadStackGroups();
refreshCustomStacksCache();
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

// ─── Linux System Updates ────────────────────────────────────────────────────

async function checkLinuxUpdates() {
  const btn   = document.getElementById('btn-linux-check');
  const label = document.getElementById('linux-upd-label');
  const hint  = document.getElementById('linux-upd-hint');
  if (btn) { btn.disabled = true; btn.innerHTML = hearthSpinner(14); }
  try {
    const d = await api('GET', '/api/system-updates/check');
    if (d.pkgMgr) {
      if (label) label.textContent = `${t('settings.linuxPackages')} (${d.pkgMgr})`;
      let hintText = '';
      if (d.pending === 0 || d.pending === '0') {
        hintText = t('settings.linuxAllGood');
        const ir = document.getElementById('linux-install-row');
        if (ir) ir.style.display = 'none';
      } else {
        const n = d.pending;
        hintText = typeof n === 'number' ? `${n} ${t('settings.linuxUpdatesAvail')}` : t('settings.linuxUpdatesAvail');
        const ir = document.getElementById('linux-install-row');
        const ih = document.getElementById('linux-install-hint');
        if (ir) ir.style.display = '';
        if (ih) ih.textContent = typeof n === 'number' ? `${n} ${t('settings.linuxInstallLabel')}` : t('settings.linuxInstallLabel');
      }
      if (d.rebootRequired) hintText += ' · ' + t('settings.serverRebootLabel');
      if (hint) hint.textContent = hintText;
    } else {
      if (hint) hint.textContent = d.error || t('settings.linuxNotChecked');
    }
  } catch (e) {
    if (hint) hint.textContent = e.message || t('settings.linuxNotChecked');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('settings.linuxCheckBtn'); }
  }
}

let _linuxUpdatePollTimer = null;

async function installLinuxUpdates() {
  if (!confirm(t('settings.linuxConfirmInstall'))) return;
  const btn     = document.getElementById('btn-linux-install');
  const logWrap = document.getElementById('linux-log-wrap');
  const log     = document.getElementById('linux-log');
  if (btn) { btn.disabled = true; btn.innerHTML = hearthSpinner(14); }
  if (logWrap) logWrap.style.display = '';
  if (log) log.textContent = t('settings.linuxStarting');

  try {
    const { jobId } = await api('POST', '/api/system-updates/install');

    const poll = async () => {
      try {
        const job = await api('GET', `/api/system-updates/job/${jobId}`);
        if (log) { log.textContent = job.output.join(''); log.scrollTop = log.scrollHeight; }
        if (!job.done) {
          _linuxUpdatePollTimer = setTimeout(poll, 1500);
          return;
        }
        if (btn) { btn.disabled = false; btn.textContent = job.status === 'done' ? '✓ ' + t('settings.linuxAllGood') : '⚠ Fehler'; }
        if (job.rebootRequired) {
          if (confirm(t('settings.linuxRebootRequired'))) systemReboot();
        } else {
          checkLinuxUpdates();
        }
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = t('settings.linuxInstallBtn'); }
        toast(e.message, 'error');
      }
    };
    _linuxUpdatePollTimer = setTimeout(poll, 1500);
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = t('settings.linuxInstallBtn'); }
  }
}

// ─── System: Reboot / Shutdown ────────────────────────────────────────────────

async function systemReboot() {
  if (!confirm(t('settings.rebootConfirm'))) return;
  const btn = document.getElementById('s-reboot');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    await api('POST', '/api/system/reboot');
    toast(t('settings.serverRebootLabel') + '…', 'info');
  } catch (_) {
    toast(t('settings.serverRebootLabel'), 'info');
  }
}

async function systemShutdown() {
  if (!confirm(t('settings.shutdownConfirm'))) return;
  const btn = document.getElementById('s-shutdown');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    await api('POST', '/api/system/shutdown');
    toast(t('settings.serverShutdownLabel') + '…', 'info');
  } catch (_) {
    toast(t('settings.serverShutdownLabel'), 'info');
  }
}

// ─── Terminal ────────────────────────────────────────────────────────────────

let _term = null, _termWs = null, _termFit = null;

function openTerminalLogin() {
  closeModal('modal-settings');
  const el = document.getElementById('modal-terminal-login');
  el.style.display = 'flex';
  setTimeout(() => document.getElementById('terminal-username').focus(), 50);
  document.getElementById('terminal-username').onkeydown = e => { if (e.key === 'Enter') connectTerminal(); };
}

function closeTerminalLogin() {
  document.getElementById('modal-terminal-login').style.display = 'none';
}

async function connectTerminal() {
  const usernameEl = document.getElementById('terminal-username');
  const username = (usernameEl.value || 'root').trim();
  if (!username) { usernameEl.focus(); return; }

  closeTerminalLogin();

  let token;
  try {
    const data = await api('POST', '/api/terminal/token', { username });
    token = data.token;
  } catch (e) {
    toast(e.message || 'Terminal nicht verfügbar', 'error');
    return;
  }

  // Show overlay
  const overlay = document.getElementById('modal-terminal');
  overlay.classList.add('open');
  document.getElementById('term-title').textContent = username + '@hearth';

  // Init xterm if not ready
  if (!_term) {
    _term = new Terminal({
      theme: { background: '#0c0c0c', foreground: '#e0e0e0', cursor: '#39ff6d', selectionBackground: '#ffffff33' },
      fontFamily: 'Menlo, "DejaVu Sans Mono", monospace',
      fontSize: 14,
      lineHeight: 1.3,
      cursorBlink: true,
      allowTransparency: true,
      scrollback: 2000,
    });
    _termFit = new FitAddon.FitAddon();
    _term.loadAddon(_termFit);
    _term.open(document.getElementById('term-container'));
    _termFit.fit();
    window.addEventListener('resize', () => { if (_termFit) { _termFit.fit(); _sendTermResize(); } });
  } else {
    _term.reset();
    _termFit.fit();
  }

  const cols = _term.cols || 80;
  const rows = _term.rows || 24;
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsProto}://${location.host}/ws/terminal?token=${token}&cols=${cols}&rows=${rows}`;
  _termWs = new WebSocket(wsUrl);

  _termWs.onopen = () => { _sendTermResize(); };
  _termWs.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output') _term.write(msg.data);
      if (msg.type === 'exit') { _term.write('\r\n\x1b[2m[Session beendet]\x1b[0m\r\n'); }
    } catch (_) {}
  };
  _termWs.onclose = () => {};
  _termWs.onerror = () => { toast('WebSocket-Fehler', 'error'); };

  _term.onData(data => {
    if (_termWs && _termWs.readyState === WebSocket.OPEN) {
      _termWs.send(JSON.stringify({ type: 'input', data }));
    }
  });

  _term.focus();
}

function _sendTermResize() {
  if (_termWs && _termWs.readyState === WebSocket.OPEN && _term) {
    _termWs.send(JSON.stringify({ type: 'resize', cols: _term.cols, rows: _term.rows }));
  }
}

function closeTerminal() {
  document.getElementById('modal-terminal').classList.remove('open');
  if (_termWs) { _termWs.close(); _termWs = null; }
}

// ─── Software-RAID ────────────────────────────────────────────────────────────

async function loadRaidStatus() {
  const avail = await api('GET', '/api/raid/available').catch(() => ({ available: false }));
  document.getElementById('raid-unavailable').style.display = avail.available ? 'none' : '';
  document.getElementById('raid-main').style.display        = avail.available ? ''    : 'none';
  if (!avail.available) return;
  const data = await api('GET', '/api/raid/status').catch(() => ({ arrays: [] }));
  _renderRaidArrays(data.arrays || []);
}

function _raidStateColor(arr) {
  if (arr.rebuilding)           return 'var(--warn)';
  if (arr.degraded)             return '#f66';
  if (arr.activity === 'inactive') return 'var(--text-faint)';
  return 'var(--accent)';
}
function _raidStateLabel(arr) {
  if (arr.rebuilding)              return 'wird wiederhergestellt';
  if (arr.degraded)                return 'degradiert';
  if (arr.activity === 'inactive') return 'inaktiv';
  return 'aktiv';
}

function _renderRaidArrays(arrays) {
  const el = document.getElementById('raid-arrays');
  if (!arrays.length) {
    el.innerHTML = `<div class="s-group"><div style="padding:20px 14px;text-align:center;color:var(--text-faint);font-size:12px">Keine RAID-Arrays vorhanden.<br><span style="font-size:11px">Erstelle dein erstes Array mit „+ RAID erstellen".</span></div></div>`;
    return;
  }

  el.innerHTML = arrays.map(arr => {
    const stateColor = _raidStateColor(arr);
    const stateLabel = _raidStateLabel(arr);
    const sizeGb     = arr.blocks ? (arr.blocks * 1024 / 1e9).toFixed(1) : '?';
    const devTags    = arr.devices.map(d =>
      `<span style="background:rgba(255,255,255,.07);border-radius:4px;padding:2px 7px;font-size:10px;font-family:monospace">${d}</span>`
    ).join(' ');

    let syncBar = '';
    if (arr.syncProgress) {
      const pct = arr.syncProgress.percent.toFixed(1);
      syncBar = `
        <div style="margin-top:8px">
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-faint);margin-bottom:3px">
            <span>Wiederherstellung läuft…</span><span>${pct}% · noch ${arr.syncProgress.finish} min</span>
          </div>
          <div style="height:3px;background:rgba(255,255,255,.1);border-radius:2px">
            <div style="height:100%;width:${pct}%;background:var(--warn);border-radius:2px;transition:width .4s"></div>
          </div>
        </div>`;
    }

    const diskDetail = (arr.detail?.disks || []).map(d => {
      const isFaulty = d.state.includes('faulty');
      const isSpare  = d.state.includes('spare');
      const dotColor = isFaulty ? '#f66' : isSpare ? 'var(--warn)' : 'var(--accent)';
      const faultBtn = !isFaulty && !isSpare
        ? `<button class="btn ghost" style="font-size:10px;padding:2px 7px;line-height:1.4" onclick="raidFailDisk('${arr.name}','${d.path}')">Fault</button>` : '';
      const removeBtn = isFaulty
        ? `<button class="btn ghost" style="font-size:10px;padding:2px 7px;line-height:1.4" onclick="raidRemoveDisk('${arr.name}','${d.path}')">Entfernen</button>` : '';
      return `
        <div style="display:flex;align-items:center;gap:8px;font-size:10px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04)">
          <span style="color:${dotColor}">●</span>
          <span style="font-family:monospace;flex:1">${d.path}</span>
          <span style="color:var(--text-faint)">${d.state}</span>
          ${faultBtn}${removeBtn}
        </div>`;
    }).join('');

    return `
    <div class="s-group" style="margin-bottom:0;border-radius:0;border-top:1px solid rgba(255,255,255,.06)">
      <div style="padding:12px 14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:13px;font-weight:600;font-family:monospace;color:var(--text)">/dev/${arr.name}</span>
            <span style="background:rgba(255,255,255,.08);border-radius:4px;padding:2px 8px;font-size:10px;font-weight:600;color:var(--text-muted)">${arr.level}</span>
            <span style="font-size:10px;font-weight:600;color:${stateColor}">${stateLabel}</span>
          </div>
          <div style="display:flex;gap:5px">
            <button class="btn ghost" style="font-size:10px;padding:3px 8px" onclick="raidAddDiskShow('${arr.name}')">+ Disk</button>
            <button class="btn ghost" style="font-size:10px;padding:3px 8px" onclick="raidStop('${arr.name}')">Stoppen</button>
            <button class="btn ghost" style="font-size:10px;padding:3px 8px;color:#f88;border-color:rgba(255,80,80,.3)" onclick="raidDestroy('${arr.name}')">Löschen</button>
          </div>
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:5px">${devTags}</div>
        <div style="font-size:10px;color:var(--text-faint)">${sizeGb} GB · [${arr.statusStr}]</div>
        ${syncBar}
        ${diskDetail ? `<div style="margin-top:8px;border-top:1px solid rgba(255,255,255,.06);padding-top:6px">${diskDetail}</div>` : ''}
        <div id="raid-add-disk-${arr.name}" style="display:none;margin-top:8px;border-top:1px solid rgba(255,255,255,.06);padding-top:8px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Festplatte hinzufügen</div>
          <div style="display:flex;gap:8px">
            <select class="s-select" id="raid-add-dev-${arr.name}" style="flex:1"></select>
            <button class="btn primary" style="font-size:11px;padding:4px 10px" onclick="raidAddDisk('${arr.name}')">Hinzufügen</button>
            <button class="btn ghost" style="font-size:11px;padding:4px 8px" onclick="document.getElementById('raid-add-disk-${arr.name}').style.display='none'">✕</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

async function raidToggleCreate() {
  const form = document.getElementById('raid-create-form');
  const showing = form.style.display !== 'none';
  form.style.display = showing ? 'none' : '';
  if (!showing) await _raidLoadCreateDisks();
}

async function _raidLoadCreateDisks() {
  const listEl = document.getElementById('raid-disk-list');
  listEl.innerHTML = '<span style="color:var(--text-faint)">Lade Festplatten…</span>';
  const data  = await api('GET', '/api/raid/disks').catch(() => ({ disks: [] }));
  const disks = data.disks || [];
  if (!disks.length) {
    listEl.innerHTML = '<span style="color:var(--text-faint)">Keine Festplatten gefunden.</span>';
    return;
  }
  listEl.innerHTML = disks.map(d => {
    const gb    = d.size ? (parseInt(d.size) / 1e9).toFixed(1) : '?';
    const inUse = !!d.mountpoint;
    const path  = `/dev/${d.name}`;
    return `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:${inUse ? 'default' : 'pointer'};${inUse ? 'opacity:.45' : ''}">
      <input type="checkbox" class="raid-disk-cb" value="${path}" ${inUse ? 'disabled title="Gerät ist eingehängt"' : ''}>
      <span style="font-family:monospace;font-size:11px">${path}</span>
      <span style="font-size:10px;color:var(--text-faint)">${gb} GB${d.model ? ' · ' + d.model.trim() : ''}${inUse ? ' · in Verwendung' : ''}</span>
    </label>`;
  }).join('');
}

async function raidCreate() {
  const level   = document.getElementById('raid-level').value;
  const mddev   = document.getElementById('raid-mddev').value;
  const devices = [...document.querySelectorAll('.raid-disk-cb:checked')].map(cb => cb.value);
  const minDisks = { '0': 2, '1': 2, '4': 3, '5': 3, '6': 4, '10': 4 };
  if (devices.length < (minDisks[level] || 2)) {
    toast(`RAID ${level} benötigt mindestens ${minDisks[level] || 2} Geräte.`, 'error'); return;
  }
  const btn = document.querySelector('#raid-create-form .btn.primary');
  btn.disabled = true; btn.textContent = 'Erstelle Array…';
  try {
    await api('POST', '/api/raid/create', { level, mddev, devices });
    toast('/dev/' + mddev + ' erfolgreich erstellt.');
    raidToggleCreate();
    await loadRaidStatus();
  } catch (e) {
    toast('Fehler: ' + (e.message || e), 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Array erstellen';
  }
}

async function raidStop(name) {
  if (!confirm(`/dev/${name} stoppen?\nDas Array wird deaktiviert, Daten bleiben erhalten.`)) return;
  try {
    await api('POST', `/api/raid/array/${name}/stop`);
    toast(`/dev/${name} gestoppt.`);
    loadRaidStatus();
  } catch (e) { toast('Fehler: ' + e.message, 'error'); }
}

async function raidDestroy(name) {
  if (!confirm(`RAID-Array /dev/${name} wirklich unwiderruflich löschen?\n\nAlle Daten gehen verloren!`)) return;
  try {
    await api('DELETE', `/api/raid/array/${name}`);
    toast(`/dev/${name} gelöscht.`);
    loadRaidStatus();
  } catch (e) { toast('Fehler: ' + e.message, 'error'); }
}

async function raidAddDiskShow(name) {
  const panel   = document.getElementById(`raid-add-disk-${name}`);
  const showing = panel.style.display !== 'none';
  panel.style.display = showing ? 'none' : '';
  if (!showing) {
    const data = await api('GET', '/api/raid/disks').catch(() => ({ disks: [] }));
    const sel  = document.getElementById(`raid-add-dev-${name}`);
    sel.innerHTML = (data.disks || []).filter(d => !d.mountpoint)
      .map(d => `<option value="/dev/${d.name}">/dev/${d.name} · ${(parseInt(d.size||0)/1e9).toFixed(1)} GB</option>`)
      .join('') || '<option disabled>Keine freien Geräte</option>';
  }
}

async function raidAddDisk(name) {
  const disk = document.getElementById(`raid-add-dev-${name}`).value;
  if (!disk) return;
  try {
    await api('POST', `/api/raid/array/${name}/add-disk`, { disk });
    toast(`${disk} zu /dev/${name} hinzugefügt.`);
    document.getElementById(`raid-add-disk-${name}`).style.display = 'none';
    loadRaidStatus();
  } catch (e) { toast('Fehler: ' + e.message, 'error'); }
}

async function raidFailDisk(name, disk) {
  if (!confirm(`${disk} als fehlerhaft markieren?\nDas Array kann danach mit einer Ersatzfestplatte wiederhergestellt werden.`)) return;
  try {
    await api('POST', `/api/raid/array/${name}/fail-disk`, { disk });
    toast(`${disk} als fehlerhaft markiert.`);
    loadRaidStatus();
  } catch (e) { toast('Fehler: ' + e.message, 'error'); }
}

async function raidRemoveDisk(name, disk) {
  if (!confirm(`${disk} aus /dev/${name} entfernen?`)) return;
  try {
    await api('POST', `/api/raid/array/${name}/remove-disk`, { disk });
    toast(`${disk} entfernt.`);
    loadRaidStatus();
  } catch (e) { toast('Fehler: ' + e.message, 'error'); }
}
