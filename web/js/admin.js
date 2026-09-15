import { api, clearToken, guardAuthenticatedPage } from '/js/api.js';

const state = {
  currentUser: null,
  auditCursor: null,
};

if (guardAuthenticatedPage()) {
  init();
}

const STAT_LABELS = {
  totalStudents: 'Students',
  totalFaculty: 'Faculty',
  totalReviews: 'Reviews',
  pendingReviews: 'Pending reviews',
  totalPosts: 'Posts',
  reportedPosts: 'Reported posts',
  totalNotes: 'Notes',
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
function showAlert(region, message, kind = 'error') {
  region.innerHTML = `<div class="alert alert-${kind}">${escapeHtml(message)}</div>`;
}

async function init() {
  document.getElementById('logout-btn').addEventListener('click', logout);

  try {
    const me = await api('/api/auth/me');
    state.currentUser = me.user;
    if (me.user.role !== 'admin') {
      window.location.href = '/dashboard.html';
      return;
    }
  } catch {
    return; // 401 path already clears the token and the guard will redirect on next load
  }

  document.getElementById('access-check').hidden = true;
  document.getElementById('admin-content').hidden = false;

  setupTabs();
  setupSuspendDialog();

  let searchDebounce;
  document.getElementById('user-search').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadUsers, 250);
  });
  document.getElementById('user-role-filter').addEventListener('change', loadUsers);
  document.getElementById('audit-load-more-btn').addEventListener('click', () => loadAuditLogs({ append: true }));

  await loadStats();
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  clearToken();
  window.location.href = '/index.html';
}

function setupTabs() {
  const tabs = [
    ['tab-overview', 'panel-overview', null],
    ['tab-users', 'panel-users', loadUsers],
    ['tab-audit', 'panel-audit', () => loadAuditLogs({ reset: true })],
  ];
  for (const [tabId] of tabs) {
    document.getElementById(tabId).addEventListener('click', () => {
      for (const [id, panelId] of tabs) {
        const isActive = id === tabId;
        document.getElementById(id).setAttribute('aria-selected', String(isActive));
        document.getElementById(panelId).hidden = !isActive;
      }
      const [, , onActivate] = tabs.find(([id]) => id === tabId);
      if (onActivate) onActivate();
    });
  }
}

// ------------------------------------------------------------ Overview -----

async function loadStats() {
  const alertRegion = document.getElementById('overview-alert-region');
  const loading = document.getElementById('stats-loading');
  const grid = document.getElementById('stat-grid');
  try {
    const result = await api('/api/admin/stats');
    loading.hidden = true;
    grid.hidden = false;
    grid.innerHTML = '';
    for (const [key, label] of Object.entries(STAT_LABELS)) {
      const plate = document.createElement('div');
      plate.className = 'stat-plate';
      plate.innerHTML = `<span class="stat-plate__value mono">${result.stats[key]}</span><span class="stat-plate__label">${label}</span>`;
      grid.appendChild(plate);
    }
  } catch (err) {
    loading.hidden = true;
    showAlert(alertRegion, err.message);
  }
}

// --------------------------------------------------------------- Users -----

async function loadUsers() {
  const alertRegion = document.getElementById('users-alert-region');
  const loading = document.getElementById('users-loading');
  const listEl = document.getElementById('users-list');
  loading.hidden = false;

  const search = document.getElementById('user-search').value.trim();
  const role = document.getElementById('user-role-filter').value;
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (role) params.set('role', role);

  try {
    const result = await api(`/api/admin/users${params.toString() ? '?' + params.toString() : ''}`);
    loading.hidden = true;
    listEl.innerHTML = '';
    if (result.users.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><h3>No users found</h3></div>`;
      return;
    }
    for (const user of result.users) {
      listEl.appendChild(renderUserRow(user));
    }
  } catch (err) {
    loading.hidden = true;
    showAlert(alertRegion, err.message);
  }
}

function renderUserRow(user) {
  const row = document.createElement('div');
  row.className = 'user-row';
  const isSelf = user.id === state.currentUser.id;

  row.innerHTML = `
    <div class="user-row__main">
      <div class="user-row__name">${escapeHtml(user.fullName)} ${isSelf ? '<span class="badge">You</span>' : ''}</div>
      <div class="user-row__email">${escapeHtml(user.email)}</div>
    </div>
    <div class="user-row__badges">
      <span class="badge ${user.role === 'admin' ? 'badge-success' : ''}">${escapeHtml(user.role)}</span>
      <span class="badge ${user.isActive ? 'badge-success' : 'badge-warn'}">${user.isActive ? 'active' : 'suspended'}</span>
      ${!user.isVerified ? '<span class="badge badge-warn">unverified</span>' : ''}
    </div>
  `;

  if (!isSelf) {
    const actions = document.createElement('div');
    actions.className = 'user-row__actions';

    const toggleActiveBtn = document.createElement('button');
    toggleActiveBtn.className = user.isActive ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm';
    toggleActiveBtn.textContent = user.isActive ? 'Suspend' : 'Reactivate';
    toggleActiveBtn.addEventListener('click', () => {
      if (user.isActive) openSuspendDialog(user, row);
      else applyUserUpdate(user.id, { isActive: true }, row);
    });

    const toggleRoleBtn = document.createElement('button');
    toggleRoleBtn.className = 'btn btn-secondary btn-sm';
    toggleRoleBtn.textContent = user.role === 'admin' ? 'Demote to student' : 'Promote to admin';
    toggleRoleBtn.addEventListener('click', () => {
      const newRole = user.role === 'admin' ? 'student' : 'admin';
      if (!confirm(`Change ${user.fullName}'s role to ${newRole}?`)) return;
      applyUserUpdate(user.id, { role: newRole }, row);
    });

    actions.append(toggleActiveBtn, toggleRoleBtn);
    row.appendChild(actions);
  }

  return row;
}

async function applyUserUpdate(userId, patch, row) {
  try {
    const result = await api(`/api/admin/users/${userId}`, { method: 'PATCH', body: patch });
    row.replaceWith(renderUserRow(result.user));
  } catch (err) {
    showAlert(document.getElementById('users-alert-region'), err.message);
  }
}

let pendingSuspendUser = null;
let pendingSuspendRow = null;
const suspendDialog = document.getElementById('suspend-dialog');

function openSuspendDialog(user, row) {
  pendingSuspendUser = user;
  pendingSuspendRow = row;
  document.getElementById('suspend-dialog-title').textContent = `Suspend ${user.fullName}?`;
  suspendDialog.showModal();
}
function setupSuspendDialog() {
  document.getElementById('suspend-dialog-cancel').addEventListener('click', () => suspendDialog.close());
  document.getElementById('suspend-dialog-confirm').addEventListener('click', async () => {
    suspendDialog.close();
    if (pendingSuspendUser) {
      await applyUserUpdate(pendingSuspendUser.id, { isActive: false }, pendingSuspendRow);
    }
  });
}

// ---------------------------------------------------------- Audit log -----

async function loadAuditLogs({ reset = false, append = false } = {}) {
  const alertRegion = document.getElementById('audit-alert-region');
  const loading = document.getElementById('audit-loading');
  const listEl = document.getElementById('audit-list');
  const loadMoreRow = document.getElementById('audit-load-more-row');

  if (reset) {
    state.auditCursor = null;
    listEl.innerHTML = '';
    loading.hidden = false;
  }

  try {
    const query = state.auditCursor && append ? `?before=${state.auditCursor}&limit=25` : '?limit=25';
    const result = await api(`/api/admin/audit-logs${query}`);
    loading.hidden = true;

    if (result.logs.length === 0 && !append) {
      listEl.innerHTML = `<div class="empty-state"><h3>No audit log entries yet</h3></div>`;
      loadMoreRow.hidden = true;
      return;
    }

    for (const log of result.logs) {
      const row = document.createElement('div');
      row.className = 'audit-row';
      row.innerHTML = `
        <span><span class="audit-row__action">${escapeHtml(log.action)}</span> by ${escapeHtml(log.actorName)}${log.targetType ? ` &middot; ${escapeHtml(log.targetType)} #${log.targetId}` : ''}</span>
        <span class="audit-row__meta">${new Date(log.createdAt).toLocaleString()}</span>
      `;
      listEl.appendChild(row);
    }
    state.auditCursor = result.nextCursor;
    loadMoreRow.hidden = !result.nextCursor;
  } catch (err) {
    loading.hidden = true;
    showAlert(alertRegion, err.message);
  }
}
