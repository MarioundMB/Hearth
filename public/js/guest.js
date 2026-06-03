/* Hearth – Guest View */

// Map Docker container state to a display label and pill class
function stateInfo(state) {
  switch (state) {
    case 'running':    return { label: t('status.running'),    cls: 'running' };
    case 'paused':     return { label: t('status.paused'),     cls: 'paused'  };
    case 'restarting': return { label: t('status.restarting'), cls: 'restarting' };
    case 'created':    return { label: t('status.starting'),   cls: 'starting' };
    case 'dead':       return { label: t('status.error'),      cls: 'error'   };
    default:           return { label: t('status.stopped'),    cls: 'stopped' };
  }
}

function appIcon(app) {
  const ic = app.icon || '';
  if (/^https?:\/\//.test(ic)) {
    return `<span class="app-icon"><img src="${esc(ic)}" alt="" onerror="this.parentNode.textContent='▣'"></span>`;
  }
  return `<span class="app-icon">${esc(ic) || '▣'}</span>`;
}

function appCard(app) {
  const si         = stateInfo(app.state || (app.running ? 'running' : 'exited'));
  const isRunning  = app.running;
  const cardClass  = isRunning ? 'running' : 'offline';

  return `
    <a class="app-card ${cardClass}" href="${esc(app.url)}" target="_blank" rel="noopener"
       ${!isRunning ? 'tabindex="-1"' : ''}>
      <div class="app-body">
        ${appIcon(app)}
        <div class="app-name">${esc(app.name)}</div>
        <span class="pill ${si.cls}"><span class="dot"></span>${si.label}</span>
      </div>
      <div class="app-open-bar">
        ${t('btn.open')}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>
      </div>
    </a>`;
}

async function load() {
  const grid  = document.getElementById('grid');
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

    // Staggered fade-in
    [...grid.children].forEach((el, i) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      el.style.transition = 'opacity .35s ease, transform .35s ease';
      setTimeout(() => { el.style.opacity = '1'; el.style.transform = 'none'; }, 40 * i);
    });

    // Count only running ones for the online badge; show total if some are offline
    const running = data.apps.filter(a => a.running).length;
    const total   = data.apps.length;
    const onlineLabel = running === 1
      ? t('guest.onlineSingle')
      : t('guest.online', { n: running });
    stats.innerHTML = `<span class="pill running"><span class="dot"></span>${onlineLabel}</span>` +
      (total > running
        ? ` <span class="pill stopped"><span class="dot"></span>${total - running} offline</span>`
        : '');

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
setInterval(load, 30000);
