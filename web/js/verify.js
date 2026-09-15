import { api } from '/js/api.js';

const params = new URLSearchParams(window.location.search);
const email = params.get('email') || '';
document.getElementById('email-display').textContent = email || '(no email provided)';

const form = document.getElementById('verify-form');
const alertRegion = document.getElementById('alert-region');
const submitBtn = document.getElementById('submit-btn');
const resendBtn = document.getElementById('resend-btn');

function showAlert(message, kind = 'error') {
  alertRegion.innerHTML = `<div class="alert alert-${kind}">${escapeHtml(message)}</div>`;
}
function showFieldError(field, message) {
  const el = document.getElementById(`field-${field}`);
  if (!el) return;
  el.classList.add('has-error');
  const err = el.querySelector('.field-error');
  err.textContent = message;
  err.hidden = false;
}
function clearFieldErrors() {
  document.querySelectorAll('.field').forEach((f) => {
    f.classList.remove('has-error');
    f.querySelector('.field-error').hidden = true;
  });
}
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  alertRegion.innerHTML = '';
  clearFieldErrors();
  const otp = document.getElementById('otp').value.trim();
  if (!/^\d{6}$/.test(otp)) return showFieldError('otp', 'Enter the 6-digit code.');

  submitBtn.disabled = true;
  try {
    await api('/api/auth/verify-otp', { method: 'POST', body: { email, otp } });
    showAlert('Email verified. Redirecting to log in\u2026', 'success');
    setTimeout(() => (window.location.href = '/index.html'), 1200);
  } catch (err) {
    if (err.field) showFieldError(err.field, err.message);
    else showAlert(err.message);
    submitBtn.disabled = false;
  }
});

resendBtn.addEventListener('click', async () => {
  resendBtn.disabled = true;
  try {
    const result = await api('/api/auth/resend-otp', { method: 'POST', body: { email } });
    showAlert(result.message, 'info');
  } catch (err) {
    showAlert(err.message);
  } finally {
    resendBtn.disabled = false;
  }
});
