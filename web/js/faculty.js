import { api, clearToken, guardAuthenticatedPage, revealAdminNavIfApplicable } from '/js/api.js';

const state = {
  currentUser: null,
  faculty: [],
  selectedRating: 0,
};

if (guardAuthenticatedPage()) {
  init();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
function showAlert(region, message, kind = 'error') {
  region.innerHTML = `<div class="alert alert-${kind}">${escapeHtml(message)}</div>`;
}
function clearAlert(region) {
  region.innerHTML = '';
}
function starString(rating) {
  if (rating === null || rating === undefined) return '<span class="text-muted">No ratings yet</span>';
  const full = Math.round(rating);
  return `<span class="rating-stars">${'★'.repeat(full)}<span class="empty">${'★'.repeat(5 - full)}</span></span> ${rating.toFixed(1)}`;
}

async function init() {
  document.getElementById('logout-btn').addEventListener('click', logout);

  state.currentUser = await revealAdminNavIfApplicable();
  if (state.currentUser?.role === 'admin') {
    document.getElementById('tab-moderation').hidden = false;
  }

  setupTabs();
  setupAddFacultyDialog();
  document.getElementById('back-to-list').addEventListener('click', (e) => {
    e.preventDefault();
    showListView();
  });

  let searchDebounce;
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => loadFacultyList(e.target.value.trim()), 250);
  });

  await loadFacultyList();
}

function setupAddFacultyDialog() {
  const dialog = document.getElementById('add-faculty-dialog');
  const openBtn = document.getElementById('add-faculty-btn');
  const cancelBtn = document.getElementById('add-faculty-cancel');
  const submitBtn = document.getElementById('add-faculty-submit');
  const nameInput = document.getElementById('add-faculty-name');
  const deptInput = document.getElementById('add-faculty-department');
  const designationInput = document.getElementById('add-faculty-designation');
  const alertRegion = document.getElementById('add-faculty-alert-region');

  openBtn.addEventListener('click', () => {
    clearAlert(alertRegion);
    nameInput.value = '';
    deptInput.value = '';
    designationInput.value = '';
    dialog.showModal();
    nameInput.focus();
  });

  cancelBtn.addEventListener('click', () => dialog.close());

  submitBtn.addEventListener('click', async () => {
    clearAlert(alertRegion);
    const fullName = nameInput.value.trim();
    const department = deptInput.value.trim();
    const designation = designationInput.value.trim();
    if (!fullName || !department) {
      showAlert(alertRegion, 'Name and department are required.');
      return;
    }
    submitBtn.disabled = true;
    try {
      const result = await api('/api/faculty', {
        method: 'POST',
        body: { fullName, department, designation: designation || undefined },
      });
      dialog.close();
      await loadFacultyList(document.getElementById('search-input').value.trim());
      await openFacultyDetail(result.id);
    } catch (err) {
      showAlert(alertRegion, err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  clearToken();
  window.location.href = '/index.html';
}

function setupTabs() {
  const tabBrowse = document.getElementById('tab-browse');
  const tabModeration = document.getElementById('tab-moderation');
  const panelBrowse = document.getElementById('panel-browse');
  const panelModeration = document.getElementById('panel-moderation');

  tabBrowse.addEventListener('click', () => {
    tabBrowse.setAttribute('aria-selected', 'true');
    tabModeration.setAttribute('aria-selected', 'false');
    panelBrowse.hidden = false;
    panelModeration.hidden = true;
  });

  tabModeration.addEventListener('click', () => {
    tabBrowse.setAttribute('aria-selected', 'false');
    tabModeration.setAttribute('aria-selected', 'true');
    panelBrowse.hidden = true;
    panelModeration.hidden = false;
    loadModerationQueue();
  });
}

// ------------------------------------------------------------- List -----

function showListView() {
  document.getElementById('list-view').hidden = false;
  document.getElementById('detail-view').hidden = true;
}
function showDetailView() {
  document.getElementById('list-view').hidden = true;
  document.getElementById('detail-view').hidden = false;
}

async function loadFacultyList(search) {
  const alertRegion = document.getElementById('browse-alert-region');
  clearAlert(alertRegion);
  const loading = document.getElementById('faculty-loading');
  const listEl = document.getElementById('faculty-list');
  loading.hidden = false;

  try {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    const result = await api(`/api/faculty${query}`);
    state.faculty = result.faculty;
    loading.hidden = true;

    if (result.faculty.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><h3>No faculty found</h3><p>Try a different search, or check back once an administrator adds faculty records.</p></div>`;
      return;
    }

    listEl.innerHTML = '';
    for (const f of result.faculty) {
      const item = document.createElement('div');
      item.className = 'faculty-list-item';
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.innerHTML = `
        <div>
          <div class="faculty-list-item__name">${escapeHtml(f.fullName)}</div>
          <div class="faculty-list-item__dept">${escapeHtml(f.department)}${f.designation ? ' &middot; ' + escapeHtml(f.designation) : ''}</div>
        </div>
        <div class="faculty-list-item__rating">
          <div>${starString(f.averageRating)}</div>
          <div class="faculty-list-item__count">${f.reviewCount} review${f.reviewCount === 1 ? '' : 's'}</div>
        </div>
      `;
      const open = () => openFacultyDetail(f.id);
      item.addEventListener('click', open);
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      listEl.appendChild(item);
    }
  } catch (err) {
    loading.hidden = true;
    showAlert(alertRegion, err.message);
  }
}

// ------------------------------------------------------------ Detail -----

async function openFacultyDetail(facultyId) {
  showDetailView();
  const content = document.getElementById('detail-content');
  content.innerHTML = '<div class="loading-row"><span class="spinner" aria-hidden="true"></span> Loading&hellip;</div>';

  try {
    const [detailResult, myReviewResult] = await Promise.all([
      api(`/api/faculty/${facultyId}`),
      api(`/api/faculty/${facultyId}/my-review`),
    ]);
    renderFacultyDetail(detailResult.faculty, myReviewResult.review);
  } catch (err) {
    content.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

function renderFacultyDetail(faculty, myReview) {
  const content = document.getElementById('detail-content');
  content.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'card';
  header.style.marginBottom = 'var(--sp-5)';
  header.innerHTML = `
    <h2 style="margin-bottom: var(--sp-1)">${escapeHtml(faculty.fullName)}</h2>
    <p class="text-muted mt-0">${escapeHtml(faculty.department)}${faculty.designation ? ' &middot; ' + escapeHtml(faculty.designation) : ''}</p>
    ${faculty.bio ? `<p>${escapeHtml(faculty.bio)}</p>` : ''}
    <div style="margin-top: var(--sp-3)">${starString(faculty.averageRating)} <span class="text-muted">(${faculty.reviewCount} review${faculty.reviewCount === 1 ? '' : 's'})</span></div>
  `;
  content.appendChild(header);

  // Review form or "already reviewed" notice
  const formCard = document.createElement('div');
  formCard.className = 'card';
  formCard.style.marginBottom = 'var(--sp-5)';
  if (myReview) {
    formCard.innerHTML = `
      <h3 style="font-size: var(--text-md)">Your review</h3>
      <div>${starString(myReview.rating)}</div>
      ${myReview.reviewText ? `<p>${escapeHtml(myReview.reviewText)}</p>` : ''}
      <span class="badge ${myReview.status === 'approved' ? 'badge-success' : myReview.status === 'rejected' ? '' : 'badge-warn'}">${escapeHtml(myReview.status)}</span>
    `;
  } else {
    formCard.innerHTML = `<h3 style="font-size: var(--text-md)">Write a review</h3>`;
    const alertRegion = document.createElement('div');
    alertRegion.setAttribute('role', 'alert');
    formCard.appendChild(alertRegion);

    const ratingPicker = document.createElement('div');
    ratingPicker.className = 'rating-picker';
    ratingPicker.style.marginBottom = 'var(--sp-4)';
    state.selectedRating = 0;
    for (let i = 1; i <= 5; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = String(i);
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        state.selectedRating = i;
        [...ratingPicker.children].forEach((b, idx) => b.setAttribute('aria-pressed', String(idx < i)));
      });
      ratingPicker.appendChild(btn);
    }

    const textarea = document.createElement('textarea');
    textarea.rows = 3;
    textarea.maxLength = 2000;
    textarea.placeholder = 'Share specifics that would help other students (optional).';
    textarea.style.width = '100%';
    textarea.style.marginTop = 'var(--sp-3)';
    textarea.style.padding = 'var(--sp-3)';
    textarea.style.border = '1px solid var(--color-line)';
    textarea.style.borderRadius = 'var(--radius-md)';
    textarea.style.fontFamily = 'var(--font-ui)';

    const anonLabel = document.createElement('label');
    anonLabel.style.display = 'flex';
    anonLabel.style.alignItems = 'center';
    anonLabel.style.gap = 'var(--sp-2)';
    anonLabel.style.margin = 'var(--sp-3) 0';
    anonLabel.innerHTML = `<input type="checkbox" id="anon-checkbox" style="width:auto" /> Post anonymously`;

    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = 'Submit review';
    submitBtn.addEventListener('click', async () => {
      clearAlert(alertRegion);
      if (state.selectedRating === 0) {
        showAlert(alertRegion, 'Choose a rating from 1 to 5.');
        return;
      }
      submitBtn.disabled = true;
      try {
        await api(`/api/faculty/${faculty.id}/reviews`, {
          method: 'POST',
          body: {
            rating: state.selectedRating,
            reviewText: textarea.value.trim() || undefined,
            isAnonymous: document.getElementById('anon-checkbox').checked,
          },
        });
        showAlert(alertRegion, 'Submitted — it will appear publicly once an administrator approves it.', 'success');
        setTimeout(() => openFacultyDetail(faculty.id), 1200);
      } catch (err) {
        showAlert(alertRegion, err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });

    formCard.appendChild(ratingPicker);
    formCard.appendChild(textarea);
    formCard.appendChild(anonLabel);
    formCard.appendChild(submitBtn);
  }
  content.appendChild(formCard);

  // Approved reviews list
  const reviewsCard = document.createElement('div');
  reviewsCard.className = 'card';
  reviewsCard.innerHTML = `<h3 style="font-size: var(--text-md)">Student reviews</h3>`;
  if (faculty.reviews.length === 0) {
    reviewsCard.innerHTML += `<p class="text-muted">No approved reviews yet.</p>`;
  } else {
    for (const r of faculty.reviews) {
      const item = document.createElement('div');
      item.className = 'review-card';
      item.innerHTML = `
        <div class="review-card__head">
          <span class="review-card__author">${escapeHtml(r.reviewerName)}</span>
          <span class="review-card__date">${new Date(r.createdAt).toLocaleDateString()}</span>
        </div>
        <div>${starString(r.rating)}</div>
        ${r.reviewText ? `<p class="mt-0">${escapeHtml(r.reviewText)}</p>` : ''}
      `;
      reviewsCard.appendChild(item);
    }
  }
  content.appendChild(reviewsCard);
}

// -------------------------------------------------------- Moderation -----

async function loadModerationQueue() {
  const alertRegion = document.getElementById('moderation-alert-region');
  clearAlert(alertRegion);
  const loading = document.getElementById('moderation-loading');
  const listEl = document.getElementById('moderation-list');
  loading.hidden = false;
  listEl.innerHTML = '';

  try {
    const result = await api('/api/faculty-reviews/pending');
    loading.hidden = true;
    if (result.reviews.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><h3>Nothing pending</h3><p>All submitted reviews have been moderated.</p></div>`;
      return;
    }
    for (const r of result.reviews) {
      listEl.appendChild(renderModerationRow(r));
    }
  } catch (err) {
    loading.hidden = true;
    showAlert(alertRegion, err.message);
  }
}

function renderModerationRow(review) {
  const row = document.createElement('div');
  row.className = 'moderation-row';
  row.innerHTML = `
    <div class="moderation-row__meta">
      For <strong>${escapeHtml(review.facultyName)}</strong> &middot;
      submitted by ${escapeHtml(review.submittedBy)} (${escapeHtml(review.submittedByEmail)})
      ${review.isAnonymous ? ' &middot; <span class="badge badge-warn">posts anonymously</span>' : ''}
      &middot; ${new Date(review.createdAt).toLocaleDateString()}
    </div>
    <div>${starString(review.rating)}</div>
    ${review.reviewText ? `<p class="mt-0">${escapeHtml(review.reviewText)}</p>` : '<p class="text-muted mt-0">No written comment.</p>'}
  `;

  const actions = document.createElement('div');
  actions.className = 'moderation-row__actions';

  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn btn-primary btn-sm';
  approveBtn.textContent = 'Approve';
  approveBtn.addEventListener('click', () => moderate(review.id, 'approved', row));

  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'btn btn-secondary btn-sm';
  rejectBtn.textContent = 'Reject';
  rejectBtn.addEventListener('click', () => moderate(review.id, 'rejected', row));

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn btn-danger btn-sm';
  removeBtn.textContent = 'Remove entirely';
  removeBtn.addEventListener('click', () => removeReview(review.id, row));

  actions.append(approveBtn, rejectBtn, removeBtn);
  row.appendChild(actions);
  return row;
}

async function moderate(reviewId, status, row) {
  const alertRegion = document.getElementById('moderation-alert-region');
  try {
    await api(`/api/faculty-reviews/${reviewId}`, { method: 'PATCH', body: { status } });
    row.remove();
  } catch (err) {
    showAlert(alertRegion, err.message);
  }
}

async function removeReview(reviewId, row) {
  const alertRegion = document.getElementById('moderation-alert-region');
  if (!confirm('Remove this review entirely? This cannot be undone.')) return;
  try {
    await api(`/api/faculty-reviews/${reviewId}`, { method: 'DELETE' });
    row.remove();
  } catch (err) {
    showAlert(alertRegion, err.message);
  }
}
