/* Hearth – gemeinsame Frontend-Hilfsfunktionen */

async function api(method, url, body, isForm) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body && !isForm) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (isForm) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    // Session abgelaufen -> zum Login
    if (!location.pathname.endsWith('/login') && location.pathname !== '/') {
      location.href = '/login';
    }
    throw new Error('Nicht angemeldet');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    throw new Error((data && data.error) || data || `Fehler ${res.status}`);
  }
  return data;
}

function toast(msg, type = 'ok') {
  const box = document.getElementById('toast');
  if (!box) return alert(msg);
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'error' ? 'error' : type === 'info' ? '' : 'ok');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 300);
  }, 3600);
}

function fmtBytes(n) {
  if (!n && n !== 0) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtTime(ms) {
  if (!ms) return '–';
  return new Date(ms).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// Only http(s) URLs are safe to place in an href — container labels like
// hearth.url are attacker-controlled (any image can set them), and esc()
// alone doesn't stop a "javascript:" URI from executing in our origin.
function safeUrl(u) {
  try {
    const parsed = new URL(String(u ?? ''), location.href);
    return ['http:', 'https:'].includes(parsed.protocol) ? String(u) : '#';
  } catch (_) {
    return '#';
  }
}

// ── Hearth Mini-Spinner ─────────────────────────────────────────────────────
// Returns an inline SVG with the looping running-light triangle.
// size: pixel size (default 22). Works wherever innerHTML is set.
function hearthSpinner(size) {
  size = size || 22;
  return `<svg class="hearth-spin" width="${size}" height="${size}" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><polygon class="hs-bg" points="16,4 29,27 3,27"/><polygon class="hs-run" points="16,4 29,27 3,27"/></svg>`;
}

// Returns a flex row with spinner + optional label (replaces "Lädt…" placeholders).
function hearthLoading(text) {
  return `<div class="hearth-loading">${hearthSpinner(20)}<span>${text || 'Lädt…'}</span></div>`;
}
