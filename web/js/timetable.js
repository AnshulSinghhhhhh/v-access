import { api, clearToken, guardAuthenticatedPage, revealAdminNavIfApplicable } from '/js/api.js';
import { renderWeekGrid } from '/js/weekgrid.js';

const state = {
  courses: [],
  selections: new Map(), // courseId -> Set<slotCode>
  preferredDays: new Set(),
  lastResults: null, // { combinations, truncated, total }
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

async function init() {
  document.getElementById('logout-btn').addEventListener('click', logout);
  setupTabs();
  setupDayToggles();
  document.getElementById('generate-btn').addEventListener('click', onGenerate);
  await revealAdminNavIfApplicable();
  await loadCourses();
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  clearToken();
  window.location.href = '/index.html';
}

// ---------------------------------------------------------------- Tabs ---

function setupTabs() {
  const tabBuild = document.getElementById('tab-build');
  const tabSaved = document.getElementById('tab-saved');
  const panelBuild = document.getElementById('panel-build');
  const panelSaved = document.getElementById('panel-saved');

  tabBuild.addEventListener('click', () => {
    tabBuild.setAttribute('aria-selected', 'true');
    tabSaved.setAttribute('aria-selected', 'false');
    panelBuild.hidden = false;
    panelSaved.hidden = true;
  });

  tabSaved.addEventListener('click', () => {
    tabBuild.setAttribute('aria-selected', 'false');
    tabSaved.setAttribute('aria-selected', 'true');
    panelBuild.hidden = true;
    panelSaved.hidden = false;
    loadSavedTimetables();
  });
}

function setupDayToggles() {
  document.querySelectorAll('.day-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const day = Number(btn.dataset.day);
      const pressed = btn.getAttribute('aria-pressed') === 'true';
      btn.setAttribute('aria-pressed', String(!pressed));
      if (pressed) state.preferredDays.delete(day);
      else state.preferredDays.add(day);
    });
  });
}

// ----------------------------------------------------------- Courses -----

async function loadCourses() {
  const alertRegion = document.getElementById('build-alert-region');
  try {
    const result = await api('/api/courses');
    state.courses = result.courses;
    document.getElementById('course-loading').hidden = true;
    const picker = document.getElementById('course-picker');
    picker.hidden = false;

    if (state.courses.length === 0) {
      picker.innerHTML = `<div class="empty-state"><h3>No courses available yet</h3><p>An administrator hasn't added any courses. Run the dev seed script (<code>npm run seed</code>) to try this out locally.</p></div>`;
      return;
    }
    renderCoursePicker();
  } catch (err) {
    document.getElementById('course-loading').hidden = true;
    showAlert(alertRegion, err.message);
  }
}

function renderCoursePicker() {
  const picker = document.getElementById('course-picker');
  picker.innerHTML = '';

  for (const course of state.courses) {
    const item = document.createElement('div');
    item.className = 'course-picker__item';

    const head = document.createElement('div');
    head.className = 'course-picker__head';
    head.innerHTML = `
      <span class="course-picker__code mono">${escapeHtml(course.code)}</span>
      <span class="course-picker__title">${escapeHtml(course.title)} &middot; ${course.credits} credits</span>
      <span aria-hidden="true">&#9662;</span>
    `;
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', 'false');

    const slotsWrap = document.createElement('div');
    slotsWrap.className = 'course-picker__slots';
    slotsWrap.hidden = true;

    if (course.sections.length === 0) {
      slotsWrap.innerHTML = `<span class="text-muted">No slots defined for this course yet.</span>`;
    } else {
      for (const section of course.sections) {
        const meetingSummary = section.meetings
          .map((m) => `${dayShort(m.dayOfWeek)} ${m.startTime}-${m.endTime}`)
          .join(', ');
        const venue = section.meetings[0]?.venue || '';
        const row = document.createElement('label');
        row.className = 'slot-checkbox';
        const checked = state.selections.get(course.id)?.has(section.slotCode) ? 'checked' : '';
        row.innerHTML = `
          <input type="checkbox" data-course-id="${course.id}" data-slot-code="${escapeHtml(section.slotCode)}" ${checked} />
          <span class="mono">${escapeHtml(section.slotCode)}</span>
          <span>${escapeHtml(meetingSummary)}${venue ? ' &middot; ' + escapeHtml(venue) : ''}</span>
        `;
        slotsWrap.appendChild(row);
      }
    }

    function toggleExpand() {
      const expanded = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', String(!expanded));
      slotsWrap.hidden = expanded;
    }
    head.addEventListener('click', toggleExpand);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(); }
    });

    slotsWrap.addEventListener('change', (e) => {
      const input = e.target;
      if (input.tagName !== 'INPUT') return;
      const courseId = Number(input.dataset.courseId);
      const slotCode = input.dataset.slotCode;
      if (!state.selections.has(courseId)) state.selections.set(courseId, new Set());
      const set = state.selections.get(courseId);
      if (input.checked) set.add(slotCode);
      else set.delete(slotCode);
      if (set.size === 0) state.selections.delete(courseId);
    });

    item.appendChild(head);
    item.appendChild(slotsWrap);
    picker.appendChild(item);
  }
}

function dayShort(dayOfWeek) {
  return ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][dayOfWeek] || '?';
}

// -------------------------------------------------------- Generation -----

function buildPreferencesPayload() {
  const prefs = {};
  if (document.getElementById('pref-no-8am').checked) prefs.excludeEarlyMorning = true;
  if (state.preferredDays.size > 0) prefs.preferredDays = [...state.preferredDays];
  const earliest = document.getElementById('pref-earliest').value;
  const latest = document.getElementById('pref-latest').value;
  if (earliest) prefs.earliestStart = earliest;
  if (latest) prefs.latestEnd = latest;
  return prefs;
}

async function onGenerate() {
  const alertRegion = document.getElementById('build-alert-region');
  clearAlert(alertRegion);

  const selections = [...state.selections.entries()]
    .filter(([, set]) => set.size > 0)
    .map(([courseId, set]) => ({ courseId, acceptableSlotCodes: [...set] }));

  if (selections.length === 0) {
    showAlert(alertRegion, 'Select at least one course and one acceptable slot for it.');
    return;
  }

  const btn = document.getElementById('generate-btn');
  btn.disabled = true;
  btn.querySelector('.btn-label').innerHTML = '<span class="spinner" aria-hidden="true"></span> Generating&hellip;';

  try {
    const result = await api('/api/timetable/generate', {
      method: 'POST',
      body: { selections, preferences: buildPreferencesPayload() },
    });
    state.lastResults = result;
    renderResults(result);
  } catch (err) {
    document.getElementById('results-region').innerHTML = '';
    showAlert(alertRegion, err.message);
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = 'Generate timetables';
  }
}

function renderResults(result) {
  const region = document.getElementById('results-region');
  region.innerHTML = '';

  const heading = document.createElement('div');
  heading.style.marginBottom = 'var(--sp-4)';
  heading.innerHTML = `<h2 style="font-size: var(--text-md)">3. Compare and save (${result.total} combination${result.total === 1 ? '' : 's'}${result.truncated ? ', showing first 300' : ''})</h2>`;
  region.appendChild(heading);

  result.combinations.forEach((combo, index) => {
    const card = document.createElement('div');
    card.className = 'combo-card';

    const head = document.createElement('div');
    head.className = 'combo-card__head';
    head.innerHTML = `
      <strong>Option ${index + 1}</strong>
      <div class="combo-card__stats">
        <span>Days on campus: <span class="mono">${combo.stats.daysUsed}</span></span>
        <span>Free days: <span class="mono">${combo.stats.freeDays}</span></span>
        <span>Earliest start: <span class="mono">${minutesToTime(combo.stats.earliestStartMinutes)}</span></span>
        <span>Latest end: <span class="mono">${minutesToTime(combo.stats.latestEndMinutes)}</span></span>
      </div>
    `;
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.textContent = 'Save this timetable';
    saveBtn.addEventListener('click', () => openSaveDialog(combo));
    head.appendChild(saveBtn);

    const gridEl = document.createElement('div');
    renderWeekGrid(gridEl, combo.entries);

    card.appendChild(head);
    card.appendChild(gridEl);
    region.appendChild(card);
  });
}

function minutesToTime(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ------------------------------------------------------------- Save -----

let pendingSaveCombo = null;
const saveDialog = document.getElementById('save-dialog');

function openSaveDialog(combo) {
  pendingSaveCombo = combo;
  document.getElementById('save-name-input').value = '';
  saveDialog.showModal();
  document.getElementById('save-name-input').focus();
}

document.getElementById('save-dialog-cancel').addEventListener('click', () => saveDialog.close());

document.getElementById('save-dialog-confirm').addEventListener('click', async () => {
  const name = document.getElementById('save-name-input').value.trim();
  if (!name) {
    document.getElementById('save-name-input').focus();
    return;
  }
  // Reduce the flat entries list to one { courseId, slotCode } per course.
  const seen = new Map();
  for (const entry of pendingSaveCombo.entries) {
    seen.set(entry.courseId, entry.slotCode);
  }
  const entries = [...seen.entries()].map(([courseId, slotCode]) => ({ courseId, slotCode }));

  const alertRegion = document.getElementById('build-alert-region');
  try {
    await api('/api/timetable', { method: 'POST', body: { name, entries } });
    saveDialog.close();
    showAlert(alertRegion, `Saved as "${name}". View it under Saved timetables.`, 'success');
  } catch (err) {
    saveDialog.close();
    showAlert(alertRegion, err.message);
  }
});

// -------------------------------------------------------- Saved list -----

async function loadSavedTimetables() {
  const loading = document.getElementById('saved-loading');
  const listEl = document.getElementById('saved-list');
  const alertRegion = document.getElementById('saved-alert-region');
  clearAlert(alertRegion);
  loading.hidden = false;
  listEl.innerHTML = '';

  try {
    const result = await api('/api/timetable');
    loading.hidden = true;
    if (result.timetables.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><h3>No saved timetables yet</h3><p>Generate a combination in the Build tab and save the one you like.</p></div>`;
      return;
    }
    for (const t of result.timetables) {
      listEl.appendChild(renderSavedItem(t));
    }
  } catch (err) {
    loading.hidden = true;
    showAlert(alertRegion, err.message);
  }
}

function renderSavedItem(timetable) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginBottom = 'var(--sp-4)';

  const head = document.createElement('div');
  head.style.display = 'flex';
  head.style.justifyContent = 'space-between';
  head.style.alignItems = 'center';
  head.style.flexWrap = 'wrap';
  head.style.gap = 'var(--sp-2)';
  head.innerHTML = `
    <div>
      <div class="card__title">${escapeHtml(timetable.name)}</div>
      <div class="card__desc">${timetable.courseCount} course${timetable.courseCount === 1 ? '' : 's'} &middot; saved ${new Date(timetable.createdAt).toLocaleDateString()}</div>
    </div>
  `;
  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = 'var(--sp-2)';

  const viewBtn = document.createElement('button');
  viewBtn.className = 'btn btn-secondary btn-sm';
  viewBtn.textContent = 'View';

  const renameBtn = document.createElement('button');
  renameBtn.className = 'btn btn-secondary btn-sm';
  renameBtn.textContent = 'Rename';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger btn-sm';
  deleteBtn.textContent = 'Delete';

  actions.append(viewBtn, renameBtn, deleteBtn);
  head.appendChild(actions);
  card.appendChild(head);

  const gridWrap = document.createElement('div');
  gridWrap.style.marginTop = 'var(--sp-4)';
  gridWrap.hidden = true;
  card.appendChild(gridWrap);

  viewBtn.addEventListener('click', async () => {
    if (!gridWrap.hidden) { gridWrap.hidden = true; return; }
    gridWrap.hidden = false;
    gridWrap.innerHTML = '<div class="loading-row"><span class="spinner" aria-hidden="true"></span> Loading&hellip;</div>';
    try {
      const result = await api(`/api/timetable/${timetable.id}`);
      const gridEl = document.createElement('div');
      renderWeekGrid(gridEl, result.timetable.entries);
      gridWrap.innerHTML = '';
      gridWrap.appendChild(gridEl);
    } catch (err) {
      gridWrap.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });

  renameBtn.addEventListener('click', async () => {
    const newName = prompt('Rename timetable', timetable.name);
    if (!newName || !newName.trim() || newName.trim() === timetable.name) return;
    try {
      await api(`/api/timetable/${timetable.id}`, { method: 'PATCH', body: { name: newName.trim() } });
      loadSavedTimetables();
    } catch (err) {
      showAlert(document.getElementById('saved-alert-region'), err.message);
    }
  });

  deleteBtn.addEventListener('click', () => openDeleteDialog(timetable.id));

  return card;
}

let pendingDeleteId = null;
const deleteDialog = document.getElementById('delete-dialog');

function openDeleteDialog(id) {
  pendingDeleteId = id;
  deleteDialog.showModal();
}
document.getElementById('delete-dialog-cancel').addEventListener('click', () => deleteDialog.close());
document.getElementById('delete-dialog-confirm').addEventListener('click', async () => {
  try {
    await api(`/api/timetable/${pendingDeleteId}`, { method: 'DELETE' });
    deleteDialog.close();
    loadSavedTimetables();
  } catch (err) {
    deleteDialog.close();
    showAlert(document.getElementById('saved-alert-region'), err.message);
  }
});
