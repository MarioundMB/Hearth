const TOTAL_STEPS = 5; // 0=lang, 1=welcome, 2=account, 3=name, 4=done
let currentStep = 0;

// ── Language selection ────────────────────────────────────────────────────────
let selectedLang = localStorage.getItem('hearth-lang') || 'en';

function pickLang(code) {
  selectedLang = code;
  applyLang(code);
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.lang === code);
  });
}

// Highlight stored lang on load
(function initLang() {
  const stored = localStorage.getItem('hearth-lang') || 'en';
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.lang === stored);
  });
})();

// ── Step navigation ───────────────────────────────────────────────────────────
function goTo(step) {
  currentStep = step;

  document.querySelectorAll('.step-view').forEach((el, i) => {
    el.classList.toggle('active', i === step);
  });

  for (let i = 0; i < TOTAL_STEPS; i++) {
    const dot = document.getElementById('dot-' + i);
    dot.classList.toggle('active', i === step);
    dot.classList.toggle('done', i < step);
  }
  for (let i = 0; i < TOTAL_STEPS - 1; i++) {
    const line = document.getElementById('line-' + i);
    line.classList.toggle('done', i < step);
  }
}

// ── Password strength ─────────────────────────────────────────────────────────
function pwStrength(pw) {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8)  score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw) || /\d/.test(pw)) score++;
  return score;
}

const STRENGTH_COLORS = ['', 'var(--danger)', 'var(--warn)', 'var(--warn)', 'var(--accent)'];
const STRENGTH_LABELS = () => ['', t('setup.pwWeak'), t('setup.pwFair'), t('setup.pwGood'), t('setup.pwStrong')];

document.getElementById('adminPassword').addEventListener('input', function () {
  const score = pwStrength(this.value);
  const color = STRENGTH_COLORS[score] || 'var(--border-bright)';
  for (let i = 0; i < 4; i++) {
    document.getElementById('bar' + i).style.background = i < score ? color : '';
  }
  const label = document.getElementById('pwLabel');
  label.textContent = this.value ? STRENGTH_LABELS()[score] : '–';
  label.style.color = this.value ? color : '';
});

// ── Step 2: account validation ────────────────────────────────────────────────
function nextFromAccount() {
  const user = document.getElementById('adminUser').value.trim();
  const pw   = document.getElementById('adminPassword').value;
  const pw2  = document.getElementById('adminPasswordConfirm').value;

  if (!user)       { toast(t('setup.errUser'),    'error'); return; }
  if (pw.length < 8) { toast(t('setup.errPwShort'), 'error'); return; }
  if (pw !== pw2)  { toast(t('setup.errPwMatch'), 'error'); return; }

  goTo(3);
}

// ── Step 3: finish ────────────────────────────────────────────────────────────
async function finish() {
  const btn = document.getElementById('finishBtn');
  btn.disabled = true;
  btn.textContent = t('setup.saving');

  try {
    await api('POST', '/api/setup', {
      adminUser:    document.getElementById('adminUser').value.trim(),
      adminPassword: document.getElementById('adminPassword').value,
      serverName:   document.getElementById('serverName').value.trim() || 'Hearth',
      lang:         selectedLang,
    });
    goTo(4);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = t('setup.finish');
  }
}

// ── Redirect if setup already done ───────────────────────────────────────────
api('GET', '/api/setup/status').then((data) => {
  if (!data.needed) location.href = '/';
}).catch(() => {});
