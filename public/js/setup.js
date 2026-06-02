let currentStep = 0;

function goTo(step) {
  const prev = currentStep;
  currentStep = step;

  // Schritte ein-/ausblenden
  document.querySelectorAll('.step-view').forEach((el, i) => {
    el.classList.toggle('active', i === step);
  });

  // Punkte und Linien aktualisieren
  for (let i = 0; i <= 3; i++) {
    const dot = document.getElementById('dot-' + i);
    dot.classList.toggle('active', i === step);
    dot.classList.toggle('done', i < step);
  }
  for (let i = 0; i <= 2; i++) {
    const line = document.getElementById('line-' + i);
    line.classList.toggle('done', i < step);
  }
}

// Passwort-Stärke berechnen (0–4)
function pwStrength(pw) {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw) || /\d/.test(pw)) score++;
  return score;
}

const STRENGTH_COLORS = ['', '#ff6b5e', '#f5c451', '#f5c451', '#c4f042'];
const STRENGTH_LABELS = ['', 'Schwach', 'Mäßig', 'Gut', 'Stark'];

document.getElementById('adminPassword').addEventListener('input', function () {
  const score = pwStrength(this.value);
  const color = STRENGTH_COLORS[score] || 'var(--border-bright)';
  for (let i = 0; i < 4; i++) {
    document.getElementById('bar' + i).style.background = i < score ? color : '';
  }
  const label = document.getElementById('pwLabel');
  label.textContent = this.value ? STRENGTH_LABELS[score] : '–';
  label.style.color = this.value ? color : '';
});

function nextFromAccount() {
  const user = document.getElementById('adminUser').value.trim();
  const pw = document.getElementById('adminPassword').value;
  const pw2 = document.getElementById('adminPasswordConfirm').value;

  if (!user) { toast('Benutzername darf nicht leer sein.', 'error'); return; }
  if (pw.length < 8) { toast('Passwort muss mindestens 8 Zeichen haben.', 'error'); return; }
  if (pw !== pw2) { toast('Passwörter stimmen nicht überein.', 'error'); return; }

  goTo(2);
}

async function finish() {
  const btn = document.getElementById('finishBtn');
  btn.disabled = true;
  btn.textContent = 'Speichere …';

  try {
    await api('POST', '/api/setup', {
      adminUser: document.getElementById('adminUser').value.trim(),
      adminPassword: document.getElementById('adminPassword').value,
      serverName: document.getElementById('serverName').value.trim() || 'Hearth',
    });
    goTo(3);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Einrichtung abschließen';
  }
}

// Wenn Setup bereits abgeschlossen, direkt weiterleiten
api('GET', '/api/setup/status').then((data) => {
  if (!data.needed) location.href = '/';
}).catch(() => {});
