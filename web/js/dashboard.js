import { api, clearToken, guardAuthenticatedPage } from '/js/api.js';

if (guardAuthenticatedPage()) {
  init();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function starString(rating) {
  const full = Math.round(rating);
  return `<span class="rating-stars">${'★'.repeat(full)}<span class="empty">${'★'.repeat(5 - full)}</span></span> ${rating.toFixed(1)}`;
}

function renderTopRatedFaculty(list) {
  const container = document.getElementById('top-faculty-list');
  if (!container) return;
  if (!list || list.length === 0) {
    container.innerHTML = `<p class="text-muted" style="font-size: var(--text-sm)">No approved reviews yet — be the first to rate a faculty member.</p>`;
    return;
  }
  container.innerHTML = '';
  for (const f of list) {
    const row = document.createElement('a');
    row.className = 'faculty-list-item';
    row.href = '/faculty.html';
    row.innerHTML = `
      <div>
        <div class="faculty-list-item__name">${escapeHtml(f.fullName)}</div>
        <div class="faculty-list-item__dept">${escapeHtml(f.department)}</div>
      </div>
      <div class="faculty-list-item__rating">
        <div>${starString(f.avgRating)}</div>
        <div class="faculty-list-item__count">${f.reviewCount} review${f.reviewCount === 1 ? '' : 's'}</div>
      </div>
    `;
    container.appendChild(row);
  }
}

async function init() {
  try {
    const result = await api('/api/dashboard/summary');
    document.getElementById('greeting').textContent = `Welcome, ${result.user.fullName.split(' ')[0]}`;
    document.getElementById('subgreeting').textContent = result.user.email;
    document.getElementById('stat-timetables').textContent = result.stats.savedTimetables;
    document.getElementById('stat-notes').textContent = result.stats.notesUploaded;
    document.getElementById('stat-reviews').textContent = result.stats.reviewsWritten;
    renderTopRatedFaculty(result.topRatedFaculty);
    if (result.user.role === 'admin') {
      const link = document.getElementById('nav-admin-link');
      if (link) link.hidden = false;
    }
    document.getElementById('loading').hidden = true;
    document.getElementById('content').hidden = false;
  } catch (err) {
    if (err.status === 401) {
      window.location.href = '/index.html';
      return;
    }
    document.getElementById('loading').innerHTML =
      `<div class="alert alert-error" role="alert">${err.message}</div>`;
  }
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  clearToken();
  window.location.href = '/index.html';
});
