import { api, setToken } from '/js/api.js';

const form = document.getElementById('login-form');
const alertRegion = document.getElementById('alert-region');
const submitBtn = document.getElementById('submit-btn');

function showAlert(message, kind = 'error') {
  alertRegion.innerHTML = `<div class="alert alert-${kind}">${escapeHtml(message)}</div>`;
}
function clearFieldErrors() {
  document.querySelectorAll('.field').forEach((f) => {
    f.classList.remove('has-error');
    f.querySelector('.field-error').hidden = true;
  });
}
function showFieldError(field, message) {
  const el = document.getElementById(`field-${field}`);
  if (!el) return;
  el.classList.add('has-error');
  const err = el.querySelector('.field-error');
  err.textContent = message;
  err.hidden = false;
}
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
function setLoading(loading) {
  submitBtn.disabled = loading;
  submitBtn.querySelector('.btn-label').innerHTML = loading
    ? '<span class="spinner" aria-hidden="true"></span> Logging in\u2026'
    : 'Log in';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  alertRegion.innerHTML = '';
  clearFieldErrors();

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email) return showFieldError('email', 'Enter your VIT email.');
  if (!password) return showFieldError('password', 'Enter your password.');

  setLoading(true);
  try {
    const result = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    setToken(result.token);
    window.location.href = '/dashboard.html';
  } catch (err) {
    if (err.field) showFieldError(err.field, err.message);
    else showAlert(err.message);
  } finally {
    setLoading(false);
  }
});
