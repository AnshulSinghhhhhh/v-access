import { api } from '/js/api.js';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
function showAlert(region, message, kind = 'error') {
  region.innerHTML = `<div class="alert alert-${kind}">${escapeHtml(message)}</div>`;
}
function clearFieldErrors(root) {
  root.querySelectorAll('.field').forEach((f) => {
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

let resetEmail = '';

// --- Step 1: request a code -------------------------------------------

const requestForm = document.getElementById('request-form');
const requestAlert = document.getElementById('request-alert-region');
const requestBtn = document.getElementById('request-submit-btn');

requestForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  requestAlert.innerHTML = '';
  clearFieldErrors(requestForm);

  const email = document.getElementById('email').value.trim();
  if (!email) return showFieldError('email', 'Enter your VIT email.');

  requestBtn.disabled = true;
  requestBtn.querySelector('.btn-label').innerHTML = '<span class="spinner" aria-hidden="true"></span> Sending\u2026';
  try {
    const result = await api('/api/auth/forgot-password', { method: 'POST', body: { email } });
    resetEmail = email;
    document.getElementById('reset-email-display').textContent = email;
    document.getElementById('request-step').hidden = true;
    document.getElementById('reset-step').hidden = false;
    showAlert(document.getElementById('reset-alert-region'), result.message, 'info');
  } catch (err) {
    if (err.field) showFieldError(err.field, err.message);
    else showAlert(requestAlert, err.message);
  } finally {
    requestBtn.disabled = false;
    requestBtn.querySelector('.btn-label').textContent = 'Send reset code';
  }
});

// --- Step 2: submit code + new password ---------------------------------

const resetForm = document.getElementById('reset-form');
const resetAlert = document.getElementById('reset-alert-region');
const resetBtn = document.getElementById('reset-submit-btn');

resetForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  resetAlert.innerHTML = '';
  clearFieldErrors(resetForm);

  const otp = document.getElementById('otp').value.trim();
  const newPassword = document.getElementById('newPassword').value;
  if (!/^\d{6}$/.test(otp)) return showFieldError('otp', 'Enter the 6-digit code.');
  if (!newPassword) return showFieldError('newPassword', 'Choose a new password.');

  resetBtn.disabled = true;
  resetBtn.querySelector('.btn-label').innerHTML = '<span class="spinner" aria-hidden="true"></span> Resetting\u2026';
  try {
    await api('/api/auth/reset-password', { method: 'POST', body: { email: resetEmail, otp, newPassword } });
    showAlert(resetAlert, 'Password updated. Redirecting to log in\u2026', 'success');
    setTimeout(() => (window.location.href = '/index.html'), 1200);
  } catch (err) {
    if (err.field) showFieldError(err.field, err.message);
    else showAlert(resetAlert, err.message);
    resetBtn.disabled = false;
    resetBtn.querySelector('.btn-label').textContent = 'Reset password';
  }
});
