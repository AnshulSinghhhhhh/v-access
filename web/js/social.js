import { api, clearToken, guardAuthenticatedPage, fetchAuthenticatedImageUrl, revealAdminNavIfApplicable } from '/js/api.js';

const state = {
  currentUser: null,
  nextCursor: null,
  composerImageDataUrl: null,
  composerVideoDataUrl: null,
};

if (guardAuthenticatedPage()) {
  init();
}

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_VIDEO_BYTES = 15 * 1024 * 1024;

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
function timeAgo(iso) {
  return new Date(iso).toLocaleString();
}

// Deterministic per-name color so the same person's avatar always looks
// the same, without storing a color anywhere — a simple string hash picked
// into a fixed hue, kept at a consistent saturation/lightness so text stays
// readable on top of it.
function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue}, 55%, 45%)`;
}
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  const first = parts[0]?.[0] || '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}
function renderAvatar(el, name) {
  el.textContent = initials(name);
  el.style.background = colorForName(name || '?');
}

async function init() {
  document.getElementById('logout-btn').addEventListener('click', logout);

  state.currentUser = await revealAdminNavIfApplicable();
  if (state.currentUser?.role === 'admin') {
    document.getElementById('tab-moderation').hidden = false;
  }
  if (state.currentUser?.fullName) {
    renderAvatar(document.getElementById('composer-avatar'), state.currentUser.fullName);
  }

  setupTabs();
  setupComposer();
  document.getElementById('load-more-btn').addEventListener('click', () => loadFeed({ append: true }));

  await loadFeed({ reset: true });
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  clearToken();
  window.location.href = '/index.html';
}

function setupTabs() {
  const tabFeed = document.getElementById('tab-feed');
  const tabModeration = document.getElementById('tab-moderation');
  const panelFeed = document.getElementById('panel-feed');
  const panelModeration = document.getElementById('panel-moderation');

  tabFeed.addEventListener('click', () => {
    tabFeed.setAttribute('aria-selected', 'true');
    tabModeration.setAttribute('aria-selected', 'false');
    panelFeed.hidden = false;
    panelModeration.hidden = true;
  });
  tabModeration.addEventListener('click', () => {
    tabFeed.setAttribute('aria-selected', 'false');
    tabModeration.setAttribute('aria-selected', 'true');
    panelFeed.hidden = true;
    panelModeration.hidden = false;
    loadModerationQueue();
  });
}

// --------------------------------------------------------- Composer -----

function setupComposer() {
  const fileInput = document.getElementById('composer-file-input');
  const videoInput = document.getElementById('composer-video-input');
  const preview = document.getElementById('composer-media-preview');
  const previewImg = document.getElementById('composer-image-img');
  const previewVideo = document.getElementById('composer-video-preview');
  const removeBtn = document.getElementById('composer-media-remove');
  const submitBtn = document.getElementById('composer-submit');
  const textarea = document.getElementById('composer-text');
  const alertRegion = document.getElementById('feed-alert-region');

  function clearMedia() {
    state.composerImageDataUrl = null;
    state.composerVideoDataUrl = null;
    fileInput.value = '';
    videoInput.value = '';
    previewImg.hidden = true;
    previewImg.src = '';
    previewVideo.hidden = true;
    previewVideo.removeAttribute('src');
    preview.hidden = true;
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      showAlert(alertRegion, `Image must be smaller than ${MAX_IMAGE_BYTES / (1024 * 1024)}MB.`);
      fileInput.value = '';
      return;
    }
    videoInput.value = '';
    state.composerVideoDataUrl = null;
    const reader = new FileReader();
    reader.onload = () => {
      state.composerImageDataUrl = reader.result;
      previewVideo.hidden = true;
      previewVideo.removeAttribute('src');
      previewImg.hidden = false;
      previewImg.src = reader.result;
      preview.hidden = false;
    };
    reader.readAsDataURL(file);
  });

  videoInput.addEventListener('change', () => {
    const file = videoInput.files[0];
    if (!file) return;
    if (file.size > MAX_VIDEO_BYTES) {
      showAlert(alertRegion, `Video must be smaller than ${MAX_VIDEO_BYTES / (1024 * 1024)}MB.`);
      videoInput.value = '';
      return;
    }
    fileInput.value = '';
    state.composerImageDataUrl = null;
    const reader = new FileReader();
    reader.onload = () => {
      state.composerVideoDataUrl = reader.result;
      previewImg.hidden = true;
      previewImg.src = '';
      previewVideo.hidden = false;
      previewVideo.src = reader.result;
      preview.hidden = false;
    };
    reader.readAsDataURL(file);
  });

  removeBtn.addEventListener('click', clearMedia);

  submitBtn.addEventListener('click', async () => {
    clearAlert(alertRegion);
    const content = textarea.value.trim();
    if (!content) {
      showAlert(alertRegion, 'Write something before posting.');
      return;
    }
    submitBtn.disabled = true;
    try {
      const body = { content };
      if (state.composerImageDataUrl) body.image = { dataUrl: state.composerImageDataUrl };
      if (state.composerVideoDataUrl) body.video = { dataUrl: state.composerVideoDataUrl };
      await api('/api/social/posts', { method: 'POST', body });
      textarea.value = '';
      clearMedia();
      await loadFeed({ reset: true });
    } catch (err) {
      showAlert(alertRegion, err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// -------------------------------------------------------------- Feed -----

async function loadFeed({ reset = false, append = false } = {}) {
  const alertRegion = document.getElementById('feed-alert-region');
  const loading = document.getElementById('feed-loading');
  const listEl = document.getElementById('feed-list');
  const loadMoreRow = document.getElementById('load-more-row');
  const loadMoreBtn = document.getElementById('load-more-btn');

  if (reset) {
    state.nextCursor = null;
    listEl.innerHTML = '';
    loading.hidden = false;
  }
  if (append) loadMoreBtn.disabled = true;

  try {
    const query = state.nextCursor && append ? `?before=${state.nextCursor}&limit=10` : '?limit=10';
    const result = await api(`/api/social/posts${query}`);
    loading.hidden = true;

    if (result.posts.length === 0 && !append) {
      listEl.innerHTML = `<div class="empty-state"><h3>No posts yet</h3><p>Be the first to share something with the class.</p></div>`;
      loadMoreRow.hidden = true;
      return;
    }

    for (const post of result.posts) {
      listEl.appendChild(renderPost(post));
    }
    state.nextCursor = result.nextCursor;
    loadMoreRow.hidden = !result.nextCursor;
  } catch (err) {
    loading.hidden = true;
    showAlert(alertRegion, err.message);
  } finally {
    loadMoreBtn.disabled = false;
  }
}

function renderPost(post) {
  const card = document.createElement('div');
  card.className = 'post-card';
  card.dataset.postId = post.id;

  const head = document.createElement('div');
  head.className = 'post-card__head';
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  renderAvatar(avatar, post.authorName);
  const headText = document.createElement('div');
  headText.className = 'post-card__head-text';
  headText.innerHTML = `
    <span class="post-card__author">${escapeHtml(post.authorName)}</span>
    <span class="post-card__date">${timeAgo(post.createdAt)}</span>
  `;
  head.append(avatar, headText);

  const canDelete = state.currentUser?.role === 'admin' || post.authorId === state.currentUser?.id;
  if (canDelete) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'post-card__menu-btn';
    deleteBtn.setAttribute('aria-label', 'Delete post');
    deleteBtn.title = 'Delete post';
    deleteBtn.textContent = '🗑️';
    deleteBtn.addEventListener('click', () => deleteOwnPost(post.id, card));
    head.appendChild(deleteBtn);
  }
  card.appendChild(head);

  const contentEl = document.createElement('p');
  contentEl.className = 'post-card__content';
  contentEl.textContent = post.content;
  card.appendChild(contentEl);

  if (post.imageRef) {
    const img = document.createElement('img');
    img.className = 'post-card__image';
    img.alt = 'Post image';
    img.width = 1;
    img.height = 1;
    fetchAuthenticatedImageUrl(`/api/social/images/${post.imageRef}`)
      .then((url) => { img.src = url; })
      .catch(() => { img.alt = 'Image failed to load'; });
    card.appendChild(img);
  }

  if (post.videoRef) {
    const video = document.createElement('video');
    video.className = 'post-card__video';
    video.controls = true;
    video.playsInline = true;
    fetchAuthenticatedImageUrl(`/api/social/media/${post.videoRef}`)
      .then((url) => { video.src = url; })
      .catch(() => {
        const fallback = document.createElement('p');
        fallback.className = 'text-muted';
        fallback.style.fontSize = 'var(--text-sm)';
        fallback.textContent = 'Video failed to load.';
        card.replaceChild(fallback, video);
      });
    card.appendChild(video);
  }

  const actions = document.createElement('div');
  actions.className = 'post-card__actions';

  const likeBtn = document.createElement('button');
  likeBtn.className = 'post-action-btn' + (post.likedByMe ? ' is-active' : '');
  likeBtn.innerHTML = `${post.likedByMe ? '♥' : '♡'} <span class="like-count">${post.likeCount}</span>`;
  likeBtn.addEventListener('click', () => toggleLike(post.id, likeBtn));

  const commentBtn = document.createElement('button');
  commentBtn.className = 'post-action-btn';
  commentBtn.innerHTML = `💬 <span class="comment-count">${post.commentCount}</span>`;

  const reportBtn = document.createElement('button');
  reportBtn.className = 'post-action-btn';
  reportBtn.textContent = '⚑ Report';
  reportBtn.addEventListener('click', () => openReportDialog(post.id));

  actions.append(likeBtn, commentBtn, reportBtn);
  card.appendChild(actions);

  const commentSection = document.createElement('div');
  commentSection.className = 'comment-section';
  card.appendChild(commentSection);

  let commentsLoaded = false;
  commentBtn.addEventListener('click', async () => {
    commentSection.classList.toggle('is-open');
    if (commentSection.classList.contains('is-open') && !commentsLoaded) {
      commentsLoaded = true;
      await loadComments(post.id, commentSection, commentBtn);
    }
  });

  return card;
}

async function deleteOwnPost(postId, card) {
  if (!confirm('Delete this post? This cannot be undone.')) return;
  try {
    await api(`/api/social/posts/${postId}`, { method: 'DELETE' });
    card.remove();
  } catch (err) {
    showAlert(document.getElementById('feed-alert-region'), err.message);
  }
}

async function toggleLike(postId, likeBtn) {
  const isActive = likeBtn.classList.contains('is-active');
  likeBtn.disabled = true;
  try {
    const result = isActive
      ? await api(`/api/social/posts/${postId}/like`, { method: 'DELETE' })
      : await api(`/api/social/posts/${postId}/like`, { method: 'POST' });
    likeBtn.classList.toggle('is-active', result.likedByMe);
    likeBtn.innerHTML = `${result.likedByMe ? '♥' : '♡'} <span class="like-count">${result.likeCount}</span>`;
  } catch (err) {
    showAlert(document.getElementById('feed-alert-region'), err.message);
  } finally {
    likeBtn.disabled = false;
  }
}

async function loadComments(postId, container, commentBtn) {
  container.innerHTML = '<div class="loading-row"><span class="spinner" aria-hidden="true"></span> Loading comments&hellip;</div>';
  try {
    const result = await api(`/api/social/posts/${postId}/comments`);
    container.innerHTML = '';
    const list = document.createElement('div');
    if (result.comments.length === 0) {
      list.innerHTML = `<p class="text-muted" style="font-size: var(--text-sm)">No comments yet.</p>`;
    } else {
      for (const c of result.comments) {
        const item = document.createElement('div');
        item.className = 'comment-item';
        const av = document.createElement('div');
        av.className = 'avatar avatar--sm';
        renderAvatar(av, c.authorName);
        const text = document.createElement('div');
        text.innerHTML = `<span class="comment-item__author">${escapeHtml(c.authorName)}</span>${escapeHtml(c.content)}`;
        item.append(av, text);
        list.appendChild(item);
      }
    }
    container.appendChild(list);

    const form = document.createElement('div');
    form.className = 'comment-form';
    form.innerHTML = `<input type="text" placeholder="Write a comment&hellip;" maxlength="500" aria-label="Write a comment" />
      <button class="btn btn-secondary btn-sm">Send</button>`;
    const input = form.querySelector('input');
    const sendBtn = form.querySelector('button');
    async function submitComment() {
      const content = input.value.trim();
      if (!content) return;
      sendBtn.disabled = true;
      try {
        await api(`/api/social/posts/${postId}/comments`, { method: 'POST', body: { content } });
        input.value = '';
        const item = document.createElement('div');
        item.className = 'comment-item';
        const av = document.createElement('div');
        av.className = 'avatar avatar--sm';
        renderAvatar(av, state.currentUser?.fullName || 'You');
        const text = document.createElement('div');
        text.innerHTML = `<span class="comment-item__author">${escapeHtml(state.currentUser?.fullName || 'You')}</span>${escapeHtml(content)}`;
        item.append(av, text);
        list.appendChild(item);
        const countEl = commentBtn.querySelector('.comment-count');
        countEl.textContent = String(Number(countEl.textContent) + 1);
      } catch (err) {
        showAlert(document.getElementById('feed-alert-region'), err.message);
      } finally {
        sendBtn.disabled = false;
      }
    }
    sendBtn.addEventListener('click', submitComment);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitComment(); } });
    container.appendChild(form);
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

// ------------------------------------------------------------ Report -----

let pendingReportPostId = null;
const reportDialog = document.getElementById('report-dialog');

function openReportDialog(postId) {
  pendingReportPostId = postId;
  document.getElementById('report-reason-input').value = '';
  reportDialog.showModal();
}
document.getElementById('report-dialog-cancel').addEventListener('click', () => reportDialog.close());
document.getElementById('report-dialog-confirm').addEventListener('click', async () => {
  const reason = document.getElementById('report-reason-input').value.trim();
  const alertRegion = document.getElementById('feed-alert-region');
  if (!reason) return;
  try {
    await api(`/api/social/posts/${pendingReportPostId}/report`, { method: 'POST', body: { reason } });
    reportDialog.close();
    showAlert(alertRegion, 'Thanks — this post has been reported for review.', 'success');
  } catch (err) {
    reportDialog.close();
    showAlert(alertRegion, err.message);
  }
});

// -------------------------------------------------------- Moderation -----

async function loadModerationQueue() {
  const alertRegion = document.getElementById('moderation-alert-region');
  clearAlert(alertRegion);
  const loading = document.getElementById('moderation-loading');
  const listEl = document.getElementById('moderation-list');
  loading.hidden = false;
  listEl.innerHTML = '';

  try {
    const result = await api('/api/social/reports');
    loading.hidden = true;
    if (result.reports.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><h3>Nothing reported</h3><p>No posts are currently awaiting review.</p></div>`;
      return;
    }
    for (const r of result.reports) {
      listEl.appendChild(renderReportRow(r));
    }
  } catch (err) {
    loading.hidden = true;
    showAlert(alertRegion, err.message);
  }
}

function renderReportRow(report) {
  const row = document.createElement('div');
  row.className = 'moderation-row';
  row.innerHTML = `
    <div class="moderation-row__meta">
      Post by <strong>${escapeHtml(report.postAuthor)}</strong> &middot;
      reported by ${escapeHtml(report.reportedBy)} &middot;
      ${new Date(report.createdAt).toLocaleString()}
    </div>
    <p class="mt-0"><strong>Reason:</strong> ${escapeHtml(report.reason)}</p>
    <blockquote class="mt-0" style="background: var(--color-paper); border: 1px solid var(--color-line); border-radius: var(--radius-sm); padding: var(--sp-2) var(--sp-3); font-style: normal;">${escapeHtml(report.postContent)}</blockquote>
  `;

  if (report.postImageRef) {
    const img = document.createElement('img');
    img.className = 'report-image-thumb';
    fetchAuthenticatedImageUrl(`/api/social/images/${report.postImageRef}`).then((url) => { img.src = url; }).catch(() => {});
    row.appendChild(img);
  }

  const actions = document.createElement('div');
  actions.className = 'moderation-row__actions';

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'btn btn-secondary btn-sm';
  dismissBtn.textContent = 'Dismiss report';
  dismissBtn.addEventListener('click', () => moderateReport(report.id, 'dismissed', row));

  const reviewedBtn = document.createElement('button');
  reviewedBtn.className = 'btn btn-secondary btn-sm';
  reviewedBtn.textContent = 'Mark reviewed (keep post)';
  reviewedBtn.addEventListener('click', () => moderateReport(report.id, 'reviewed', row));

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn btn-danger btn-sm';
  removeBtn.textContent = 'Remove post';
  removeBtn.addEventListener('click', () => removePost(report.postId, row));

  actions.append(dismissBtn, reviewedBtn, removeBtn);
  row.appendChild(actions);
  return row;
}

async function moderateReport(reportId, status, row) {
  try {
    await api(`/api/social/reports/${reportId}`, { method: 'PATCH', body: { status } });
    row.remove();
  } catch (err) {
    showAlert(document.getElementById('moderation-alert-region'), err.message);
  }
}

async function removePost(postId, row) {
  if (!confirm('Remove this post from the feed? This cannot be undone.')) return;
  try {
    await api(`/api/social/posts/${postId}`, { method: 'DELETE' });
    row.remove();
  } catch (err) {
    showAlert(document.getElementById('moderation-alert-region'), err.message);
  }
}
