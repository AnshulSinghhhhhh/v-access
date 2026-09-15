import { api, clearToken, guardAuthenticatedPage, revealAdminNavIfApplicable } from '/js/api.js';

const state = {
  currentUser: null,
  blocks: [],
};

if (guardAuthenticatedPage()) {
  init();
}

const FLOOR_ORDER = ['G', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

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
  state.currentUser = await revealAdminNavIfApplicable();
  if (state.currentUser?.role === 'admin') {
    document.getElementById('tab-manage').hidden = false;
  }

  setupTabs();
  setupSearch();
  document.getElementById('back-to-blocks').addEventListener('click', (e) => {
    e.preventDefault();
    showBlockGrid();
  });
  document.getElementById('new-block-submit').addEventListener('click', onCreateBlock);
  setupDeleteBlockDialog();

  await loadLiveMap();
  await loadBlockGrid();
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  clearToken();
  window.location.href = '/index.html';
}

function setupTabs() {
  const tabFind = document.getElementById('tab-find');
  const tabManage = document.getElementById('tab-manage');
  const panelFind = document.getElementById('panel-find');
  const panelManage = document.getElementById('panel-manage');

  tabFind.addEventListener('click', () => {
    tabFind.setAttribute('aria-selected', 'true');
    tabManage.setAttribute('aria-selected', 'false');
    panelFind.hidden = false;
    panelManage.hidden = true;
  });
  tabManage.addEventListener('click', () => {
    tabFind.setAttribute('aria-selected', 'false');
    tabManage.setAttribute('aria-selected', 'true');
    panelFind.hidden = true;
    panelManage.hidden = false;
    loadManageList();
  });
}

// ------------------------------------------------------------ Live map ---

function buildOsmEmbedUrl(lat, lng, deltaDeg = 0.003) {
  const bbox = [lng - deltaDeg, lat - deltaDeg, lng + deltaDeg, lat + deltaDeg].join(',');
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
}
function buildOsmLargerMapUrl(lat, lng) {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}

async function loadLiveMap() {
  try {
    const result = await api('/api/campus/map-anchors');
    if (result.anchors.length === 0) return; // stays hidden — no map-relevant point has been set yet
    renderLiveMap(result.anchors);
  } catch {
    // Non-fatal: the live map is a supplement to the room lookup below,
    // not a dependency of it — the page still works fully without it.
  }
}

function renderLiveMap(anchors) {
  const card = document.getElementById('live-map-card');
  const iframe = document.getElementById('live-map-iframe');
  const titleEl = document.getElementById('live-map-title');
  const largerLink = document.getElementById('live-map-larger-link');
  const switcher = document.getElementById('live-map-switcher');

  function show(anchor) {
    titleEl.textContent = anchor.name;
    iframe.src = buildOsmEmbedUrl(anchor.latitude, anchor.longitude);
    iframe.title = `Live map showing ${anchor.name}`;
    largerLink.href = buildOsmLargerMapUrl(anchor.latitude, anchor.longitude);
  }

  show(anchors[0]);
  card.hidden = false;

  if (anchors.length > 1) {
    switcher.hidden = false;
    switcher.innerHTML = '';
    for (const anchor of anchors) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary btn-sm';
      btn.textContent = anchor.name;
      btn.addEventListener('click', () => show(anchor));
      switcher.appendChild(btn);
    }
  }
}

// -------------------------------------------------------------- Search ---

function setupSearch() {
  const input = document.getElementById('search-input');
  const btn = document.getElementById('search-btn');
  btn.addEventListener('click', runSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
}

async function runSearch() {
  const alertRegion = document.getElementById('search-alert-region');
  const resultsEl = document.getElementById('search-results');
  const query = document.getElementById('search-input').value.trim();
  clearAlert(alertRegion);
  resultsEl.innerHTML = '';

  if (!query) return;

  try {
    const result = await api(`/api/campus/search?q=${encodeURIComponent(query)}`);

    if (result.kind === 'room') {
      if (result.matches.length === 0) {
        resultsEl.innerHTML = `<div class="empty-state"><h3>No room matches "${escapeHtml(result.parsedCode)}"</h3><p>Try browsing by block below, or double-check the room number.</p></div>`;
        return;
      }
      for (const match of result.matches) {
        resultsEl.appendChild(renderRoomResult(result.parsedCode, match));
      }
    } else {
      if (result.zones.length === 0) {
        resultsEl.innerHTML = `<div class="empty-state"><h3>No matches for "${escapeHtml(query)}"</h3><p>That didn't look like a room code (e.g. "PRP 230") or match a block name — try browsing by block below.</p></div>`;
        return;
      }
      for (const zone of result.zones) {
        resultsEl.appendChild(renderZoneResult(zone));
      }
    }
  } catch (err) {
    showAlert(alertRegion, err.message);
  }
}

function renderRoomResult(parsedCode, match) {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.innerHTML = `
    <div class="result-card__zone">${escapeHtml(match.locationName)}</div>
    <span class="result-card__floor mono">Floor ${escapeHtml(match.floor)} &middot; ${parsedCode}</span>
    ${match.locationDescription ? `<p class="text-muted">${escapeHtml(match.locationDescription)}</p>` : ''}
    <div class="result-card__directions">
      ${match.directionsText
        ? escapeHtml(match.directionsText)
        : '<span class="result-card__no-directions">Directions haven\'t been added for this floor yet.</span>'}
    </div>
  `;
  return card;
}

function renderZoneResult(zone) {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.innerHTML = `
    <div class="result-card__zone">${escapeHtml(zone.name)}</div>
    ${zone.description ? `<p class="text-muted mt-0">${escapeHtml(zone.description)}</p>` : ''}
  `;
  const viewBtn = document.createElement('button');
  viewBtn.className = 'btn btn-secondary btn-sm';
  viewBtn.textContent = 'View floors';
  viewBtn.addEventListener('click', () => openBlockDetail(zone.id));
  card.appendChild(viewBtn);
  return card;
}

// --------------------------------------------------------- Browse -----

async function loadBlockGrid() {
  const grid = document.getElementById('block-grid');
  try {
    const result = await api('/api/campus/blocks');
    state.blocks = result.blocks;
    grid.innerHTML = '';
    for (const block of result.blocks) {
      const tile = document.createElement('div');
      tile.className = 'block-tile';
      tile.setAttribute('role', 'button');
      tile.setAttribute('tabindex', '0');
      tile.textContent = block.name;
      tile.addEventListener('click', () => openBlockDetail(block.id));
      tile.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBlockDetail(block.id); } });
      grid.appendChild(tile);
    }
  } catch (err) {
    showAlert(document.getElementById('search-alert-region'), err.message);
  }
}

function showBlockGrid() {
  document.getElementById('block-grid').hidden = false;
  document.getElementById('block-detail').hidden = true;
}

async function openBlockDetail(blockId) {
  document.getElementById('block-grid').hidden = true;
  const detail = document.getElementById('block-detail');
  detail.hidden = false;
  const floorsEl = document.getElementById('block-detail-floors');
  floorsEl.innerHTML = '<div class="loading-row"><span class="spinner" aria-hidden="true"></span> Loading&hellip;</div>';

  try {
    const result = await api(`/api/campus/blocks/${blockId}/ranges`);
    document.getElementById('block-detail-name').textContent = result.block.name;
    document.getElementById('block-detail-description').textContent = result.block.description || '';
    floorsEl.innerHTML = '';

    if (result.ranges.length === 0) {
      floorsEl.innerHTML = `<div class="empty-state"><h3>No floor ranges added yet</h3></div>`;
      return;
    }
    for (const range of result.ranges) {
      const row = document.createElement('div');
      row.className = 'floor-row';
      row.innerHTML = `
        <span class="floor-row__label">${escapeHtml(range.floor)}</span>
        <span class="floor-row__range">${range.rangeStart}&ndash;${range.rangeEnd}</span>
        <span class="floor-row__directions ${range.directionsText ? 'has-text' : ''}">${range.directionsText ? escapeHtml(range.directionsText) : 'No directions added yet.'}</span>
      `;
      floorsEl.appendChild(row);
    }
  } catch (err) {
    floorsEl.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

// ------------------------------------------------------------- Manage -----

async function onCreateBlock() {
  const alertRegion = document.getElementById('manage-alert-region');
  const nameInput = document.getElementById('new-block-name');
  const descInput = document.getElementById('new-block-description');
  const latInput = document.getElementById('new-block-lat');
  const lngInput = document.getElementById('new-block-lng');
  const name = nameInput.value.trim();
  if (!name) return showAlert(alertRegion, 'Enter a name.');

  const body = { name, description: descInput.value.trim() || undefined };
  if (latInput.value.trim() && lngInput.value.trim()) {
    body.latitude = Number(latInput.value);
    body.longitude = Number(lngInput.value);
  }

  try {
    await api('/api/campus/blocks', { method: 'POST', body });
    nameInput.value = '';
    descInput.value = '';
    latInput.value = '';
    lngInput.value = '';
    await Promise.all([loadManageList(), loadBlockGrid(), loadLiveMap()]);
  } catch (err) {
    showAlert(alertRegion, err.message);
  }
}

async function loadManageList() {
  const alertRegion = document.getElementById('manage-alert-region');
  const loading = document.getElementById('manage-loading');
  const listEl = document.getElementById('manage-list');
  loading.hidden = false;
  clearAlert(alertRegion);

  try {
    const result = await api('/api/campus/blocks');
    loading.hidden = true;
    listEl.innerHTML = '';
    for (const block of result.blocks) {
      listEl.appendChild(await renderManageBlockCard(block));
    }
  } catch (err) {
    loading.hidden = true;
    showAlert(alertRegion, err.message);
  }
}

async function renderManageBlockCard(block) {
  const card = document.createElement('div');
  card.className = 'manage-block-card';

  const head = document.createElement('div');
  head.className = 'manage-block-card__head';
  head.innerHTML = `
    <div style="flex:1">
      <div class="field" style="margin-bottom:var(--sp-2)">
        <input type="text" class="block-name-input" value="${escapeHtml(block.name)}" style="font-weight:600;font-size:var(--text-md);width:100%;border:1px solid var(--color-line);border-radius:var(--radius-sm);padding:var(--sp-1) var(--sp-2)" />
      </div>
      <input type="text" class="block-desc-input" value="${escapeHtml(block.description || '')}" placeholder="Description (optional)" style="width:100%;border:1px solid var(--color-line);border-radius:var(--radius-sm);padding:var(--sp-1) var(--sp-2);font-size:var(--text-sm);margin-bottom:var(--sp-2)" />
      <div style="display:flex;gap:var(--sp-2);align-items:center">
        <label style="font-size:var(--text-xs);color:var(--color-ink-muted)">Map coordinates (optional — for the live campus map only):</label>
        <input type="number" step="any" class="block-lat-input" value="${block.latitude ?? ''}" placeholder="Latitude" style="width:110px;border:1px solid var(--color-line);border-radius:var(--radius-sm);padding:var(--sp-1) var(--sp-2);font-size:var(--text-sm)" />
        <input type="number" step="any" class="block-lng-input" value="${block.longitude ?? ''}" placeholder="Longitude" style="width:110px;border:1px solid var(--color-line);border-radius:var(--radius-sm);padding:var(--sp-1) var(--sp-2);font-size:var(--text-sm)" />
      </div>
    </div>
  `;
  const headActions = document.createElement('div');
  headActions.style.display = 'flex';
  headActions.style.gap = 'var(--sp-2)';
  headActions.style.flexShrink = '0';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-secondary btn-sm';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    const name = head.querySelector('.block-name-input').value.trim();
    const description = head.querySelector('.block-desc-input').value.trim();
    const latRaw = head.querySelector('.block-lat-input').value.trim();
    const lngRaw = head.querySelector('.block-lng-input').value.trim();
    const body = { name, description };
    // Both filled -> set; both empty -> explicitly clear; one-only is left
    // for the backend's pairing validation to reject with a clear message.
    if (latRaw && lngRaw) {
      body.latitude = Number(latRaw);
      body.longitude = Number(lngRaw);
    } else if (!latRaw && !lngRaw) {
      body.latitude = null;
      body.longitude = null;
    }
    try {
      await api(`/api/campus/blocks/${block.id}`, { method: 'PATCH', body });
      await Promise.all([loadBlockGrid(), loadLiveMap()]);
      showAlert(document.getElementById('manage-alert-region'), 'Saved.', 'success');
    } catch (err) {
      showAlert(document.getElementById('manage-alert-region'), err.message);
    }
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger btn-sm';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => openDeleteBlockDialog(block.id, card));

  headActions.append(saveBtn, deleteBtn);
  head.appendChild(headActions);
  card.appendChild(head);

  const rangesContainer = document.createElement('div');
  card.appendChild(rangesContainer);

  let ranges = [];
  try {
    const result = await api(`/api/campus/blocks/${block.id}/ranges`);
    ranges = result.ranges;
  } catch {
    // leave ranges empty; the add-range form still works
  }

  for (const range of ranges) {
    rangesContainer.appendChild(renderManageRangeRow(range));
  }

  const addForm = document.createElement('div');
  addForm.className = 'add-range-form';
  addForm.innerHTML = `
    <select class="new-range-floor">
      ${FLOOR_ORDER.map((f) => `<option value="${f}">${f === 'G' ? 'Ground' : 'Floor ' + f}</option>`).join('')}
    </select>
    <input type="number" class="new-range-start" placeholder="Start" min="0" />
    <span>&ndash;</span>
    <input type="number" class="new-range-end" placeholder="End" min="0" />
    <input type="text" class="directions-input new-range-directions" placeholder="Directions (optional)" />
    <button class="btn btn-secondary btn-sm">Add range</button>
  `;
  const addBtn = addForm.querySelector('button');
  addBtn.addEventListener('click', async () => {
    const floor = addForm.querySelector('.new-range-floor').value;
    const rangeStart = addForm.querySelector('.new-range-start').value;
    const rangeEnd = addForm.querySelector('.new-range-end').value;
    const directionsText = addForm.querySelector('.new-range-directions').value.trim();
    if (rangeStart === '' || rangeEnd === '') {
      return showAlert(document.getElementById('manage-alert-region'), 'Enter both a start and end room number.');
    }
    try {
      const result = await api('/api/campus/ranges', {
        method: 'POST',
        body: { locationId: block.id, floor, rangeStart: Number(rangeStart), rangeEnd: Number(rangeEnd), directionsText: directionsText || undefined },
      });
      if (result.warnings.length > 0) {
        showAlert(document.getElementById('manage-alert-region'), result.warnings.join(' '), 'info');
      }
      const newCard = await renderManageBlockCard(block);
      card.replaceWith(newCard);
    } catch (err) {
      showAlert(document.getElementById('manage-alert-region'), err.message);
    }
  });
  card.appendChild(addForm);

  return card;
}

function renderManageRangeRow(range) {
  const row = document.createElement('div');
  row.className = 'manage-range-row';
  row.innerHTML = `
    <span class="mono" style="width:28px">${escapeHtml(range.floor)}</span>
    <input type="number" class="range-start-input" value="${range.rangeStart}" />
    <span>&ndash;</span>
    <input type="number" class="range-end-input" value="${range.rangeEnd}" />
    <input type="text" class="directions-input range-directions-input" value="${escapeHtml(range.directionsText || '')}" placeholder="Directions" />
  `;
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-secondary btn-sm';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    const rangeStart = Number(row.querySelector('.range-start-input').value);
    const rangeEnd = Number(row.querySelector('.range-end-input').value);
    const directionsText = row.querySelector('.range-directions-input').value.trim();
    try {
      const result = await api(`/api/campus/ranges/${range.id}`, {
        method: 'PATCH',
        body: { rangeStart, rangeEnd, directionsText },
      });
      if (result.warnings.length > 0) {
        showAlert(document.getElementById('manage-alert-region'), result.warnings.join(' '), 'info');
      } else {
        showAlert(document.getElementById('manage-alert-region'), 'Saved.', 'success');
      }
    } catch (err) {
      showAlert(document.getElementById('manage-alert-region'), err.message);
    }
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger btn-sm';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    try {
      await api(`/api/campus/ranges/${range.id}`, { method: 'DELETE' });
      row.remove();
    } catch (err) {
      showAlert(document.getElementById('manage-alert-region'), err.message);
    }
  });

  row.appendChild(saveBtn);
  row.appendChild(deleteBtn);
  return row;
}

let pendingDeleteBlockId = null;
let pendingDeleteBlockCard = null;
const deleteBlockDialog = document.getElementById('delete-block-dialog');

function openDeleteBlockDialog(blockId, card) {
  pendingDeleteBlockId = blockId;
  pendingDeleteBlockCard = card;
  deleteBlockDialog.showModal();
}
function setupDeleteBlockDialog() {
  document.getElementById('delete-block-cancel').addEventListener('click', () => deleteBlockDialog.close());
  document.getElementById('delete-block-confirm').addEventListener('click', async () => {
    try {
      await api(`/api/campus/blocks/${pendingDeleteBlockId}`, { method: 'DELETE' });
      deleteBlockDialog.close();
      pendingDeleteBlockCard?.remove();
      await loadBlockGrid();
    } catch (err) {
      deleteBlockDialog.close();
      showAlert(document.getElementById('manage-alert-region'), err.message);
    }
  });
}
