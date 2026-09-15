import {
  api,
  clearToken,
  guardAuthenticatedPage,
  downloadAuthenticatedFile,
  revealAdminNavIfApplicable,
} from '/js/api.js';

const state = {
  currentUser: null,
  selectedFile: null,
};

if (guardAuthenticatedPage()) {
  init();
}

// Matches the server's default NOTES_MAX_FILE_MB — a client-side pre-check
// only; the backend enforces the real limit regardless of what the
// frontend does.
const MAX_FILE_BYTES = 15 * 1024 * 1024;

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
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function init() {
  document.getElementById('logout-btn').addEventListener('click', logout);
  state.currentUser = await revealAdminNavIfApplicable();

  setupUploadForm();
  await Promise.all([loadFacultyOptions(), loadSubjectOptions()]);

  let searchDebounce;
  document.getElementById('filter-search').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadNotes, 250);
  });
  document.getElementById('filter-subject').addEventListener('change', loadNotes);
  document.getElementById('filter-faculty').addEventListener('change', loadNotes);

  await loadNotes();
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  clearToken();
  window.location.href = '/index.html';
}

// --------------------------------------------------------------- Setup ---

async function loadFacultyOptions() {
  try {
    const result = await api('/api/faculty');
    const uploadSelect = document.getElementById('upload-faculty');
    const filterSelect = document.getElementById('filter-faculty');
    for (const f of result.faculty) {
      const opt1 = document.createElement('option');
      opt1.value = f.id;
      opt1.textContent = f.fullName;
      uploadSelect.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = f.id;
      opt2.textContent = f.fullName;
      filterSelect.appendChild(opt2);
    }
  } catch {
    // Non-fatal — the upload form still works without faculty tagging.
  }
}

async function loadSubjectOptions() {
  try {
    const result = await api('/api/notes/subjects');
    const select = document.getElementById('filter-subject');
    for (const subject of result.subjects) {
      const opt = document.createElement('option');
      opt.value = subject;
      opt.textContent = subject;
      select.appendChild(opt);
    }
  } catch {
    // Non-fatal.
  }
}

function setupUploadForm() {
  const fileInput = document.getElementById('upload-file-input');
  const dropText = document.getElementById('file-drop-text');
  const dropLabel = document.getElementById('file-drop-label');
  const alertRegion = document.getElementById('page-alert-region');
  const submitBtn = document.getElementById('upload-submit');

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      showAlert(alertRegion, `File must be smaller than ${MAX_FILE_BYTES / (1024 * 1024)}MB.`);
      fileInput.value = '';
      return;
    }
    state.selectedFile = file;
    dropText.textContent = `${file.name} (${formatFileSize(file.size)})`;
    dropLabel.classList.add('has-file');
  });

  submitBtn.addEventListener('click', async () => {
    clearAlert(alertRegion);
    const subject = document.getElementById('upload-subject').value.trim();
    const facultyId = document.getElementById('upload-faculty').value;

    if (!subject) return showAlert(alertRegion, 'Enter a subject.');
    if (!state.selectedFile) return showAlert(alertRegion, 'Choose a file to upload.');

    submitBtn.disabled = true;
    try {
      const dataUrl = await readFileAsDataUrl(state.selectedFile);
      await api('/api/notes', {
        method: 'POST',
        body: {
          fileName: state.selectedFile.name,
          subject,
          facultyId: facultyId || undefined,
          file: { dataUrl },
        },
      });
      document.getElementById('upload-subject').value = '';
      document.getElementById('upload-faculty').value = '';
      fileInput.value = '';
      state.selectedFile = null;
      dropText.textContent = 'Click to choose a PDF, DOC/DOCX, or PPT/PPTX file';
      dropLabel.classList.remove('has-file');
      showAlert(alertRegion, 'Uploaded.', 'success');
      await Promise.all([loadNotes(), loadSubjectOptions()]);
    } catch (err) {
      showAlert(alertRegion, err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}

// --------------------------------------------------------------- List -----

async function loadNotes() {
  const loading = document.getElementById('notes-loading');
  const listEl = document.getElementById('notes-list');
  const alertRegion = document.getElementById('page-alert-region');
  loading.hidden = false;

  const search = document.getElementById('filter-search').value.trim();
  const subject = document.getElementById('filter-subject').value;
  const facultyId = document.getElementById('filter-faculty').value;

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (subject) params.set('subject', subject);
  if (facultyId) params.set('facultyId', facultyId);

  try {
    const result = await api(`/api/notes${params.toString() ? '?' + params.toString() : ''}`);
    loading.hidden = true;
    listEl.innerHTML = '';

    if (result.notes.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><h3>No notes found</h3><p>Try a different search or filter, or upload the first resource for this subject.</p></div>`;
      return;
    }

    for (const note of result.notes) {
      listEl.appendChild(renderNoteRow(note));
    }
  } catch (err) {
    loading.hidden = true;
    showAlert(alertRegion, err.message);
  }
}

function renderNoteRow(note) {
  const row = document.createElement('div');
  row.className = 'note-row';

  row.innerHTML = `
    <span class="note-row__type">${escapeHtml(note.fileType)}</span>
    <div class="note-row__main">
      <div class="note-row__name">${escapeHtml(note.fileName)}</div>
      <div class="note-row__meta">${escapeHtml(note.subject)}${note.facultyName ? ' &middot; ' + escapeHtml(note.facultyName) : ''} &middot; ${escapeHtml(note.uploadedBy)} &middot; ${new Date(note.createdAt).toLocaleDateString()} &middot; ${formatFileSize(note.fileSize)}</div>
    </div>
  `;

  const actions = document.createElement('div');
  actions.className = 'note-row__actions';

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'btn btn-secondary btn-sm';
  downloadBtn.textContent = 'Download';
  downloadBtn.addEventListener('click', async () => {
    downloadBtn.disabled = true;
    try {
      await downloadAuthenticatedFile(`/api/notes/${note.id}/download`, note.fileName);
    } catch (err) {
      showAlert(document.getElementById('page-alert-region'), err.message);
    } finally {
      downloadBtn.disabled = false;
    }
  });
  actions.appendChild(downloadBtn);

  if (state.currentUser?.role === 'admin' || note.uploadedById === state.currentUser?.id) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-danger btn-sm';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => openDeleteDialog(note.id, row));
    actions.appendChild(removeBtn);
  }

  row.appendChild(actions);
  return row;
}

let pendingDeleteId = null;
let pendingDeleteRow = null;
const deleteDialog = document.getElementById('delete-note-dialog');

function openDeleteDialog(noteId, row) {
  pendingDeleteId = noteId;
  pendingDeleteRow = row;
  deleteDialog.showModal();
}
document.getElementById('delete-note-cancel').addEventListener('click', () => deleteDialog.close());
document.getElementById('delete-note-confirm').addEventListener('click', async () => {
  try {
    await api(`/api/notes/${pendingDeleteId}`, { method: 'DELETE' });
    deleteDialog.close();
    pendingDeleteRow?.remove();
  } catch (err) {
    deleteDialog.close();
    showAlert(document.getElementById('page-alert-region'), err.message);
  }
});
