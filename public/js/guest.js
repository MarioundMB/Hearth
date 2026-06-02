/* Hearth – Gäste-Ansicht */

function appIcon(app) {
  const ic = app.icon || '';
  if (/^https?:\/\//.test(ic)) {
    return `<span class="app-icon"><img src="${esc(ic)}" alt="" onerror="this.parentNode.textContent='▣'"></span>`;
  }
  return `<span class="app-icon">${esc(ic) || '▣'}</span>`;
}

function appCard(app) {
  return `
    <a class="app-card" href="${esc(app.url)}" target="_blank" rel="noopener">
      <div class="app-top">
        ${appIcon(app)}
        <div>
          <div class="app-name">${esc(app.name)}</div>
          <span class="pill ${app.running ? 'running' : 'stopped'}"><span class="dot"></span>${app.running ? t('status.running') : t('status.stopped')}</span>
        </div>
      </div>
      <div class="app-desc">${esc(app.description)}</div>
      <div class="app-foot">
        <span class="mono muted" style="font-size:12px">:${app.ports.join(' :')}</span>
        <span class="open">${t('btn.open')}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>
        </span>
      </div>
    </a>`;
}

async function load() {
  const grid = document.getElementById('grid');
  const stats = document.getElementById('stats');
  try {
    const data = await api('GET', '/api/public/apps');
    if (!data.apps.length) {
      grid.innerHTML = `<div class="empty"><div class="big">◌</div>
        ${t('guest.empty')}<br>
        <span class="muted" style="font-size:13px">${t('guest.emptyHint')}</span></div>`;
      stats.innerHTML = '';
      return;
    }
    grid.innerHTML = data.apps.map(appCard).join('');
    // gestaffelte Einblendung
    [...grid.children].forEach((el, i) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(10px)';
      el.style.transition = 'opacity .4s ease, transform .4s ease';
      setTimeout(() => {
        el.style.opacity = '1';
        el.style.transform = 'none';
      }, 40 * i);
    });
    stats.innerHTML = `
      <span class="pill running"><span class="dot"></span>${t('guest.online', { n: data.apps.length })}</span>
      <span class="pill"><span class="dot"></span>Host: ${esc(data.host)}</span>`;
  } catch (e) {
    grid.innerHTML = `<div class="empty"><div class="big">⚠</div>${t('guest.error')}<br><span class="muted">${esc(e.message)}</span></div>`;
  }
}

document.getElementById('reload').addEventListener('click', (e) => {
  const b = e.currentTarget;
  b.classList.add('spin');
  setTimeout(() => b.classList.remove('spin'), 800);
  load();
});

load();
setInterval(load, 30000); // alle 30s aktualisieren
