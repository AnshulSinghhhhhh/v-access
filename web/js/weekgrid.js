// Renders a list of flat entries (one per weekly meeting — see
// timetable.service.js formatting) into a CSS-grid weekly timetable.
// entries: [{ courseCode, slotCode, dayOfWeek (1=Mon..6=Sat), startTime, endTime, venue }]

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GRID_START_MINUTES = 8 * 60; // 08:00
const GRID_END_MINUTES = 18 * 60; // 18:00
const ROW_MINUTES = 30;
const TOTAL_ROWS = (GRID_END_MINUTES - GRID_START_MINUTES) / ROW_MINUTES;

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function renderWeekGrid(container, entries) {
  container.innerHTML = '';
  container.className = 'week-grid';
  container.style.gridTemplateRows = `auto repeat(${TOTAL_ROWS}, 26px)`;
  container.setAttribute('role', 'table');
  container.setAttribute('aria-label', 'Weekly timetable grid');

  // Header row
  const corner = document.createElement('div');
  corner.className = 'week-grid__cell week-grid__head';
  corner.style.gridColumn = '1';
  corner.style.gridRow = '1';
  container.appendChild(corner);

  DAY_LABELS.forEach((label, i) => {
    const cell = document.createElement('div');
    cell.className = 'week-grid__cell week-grid__head';
    cell.textContent = label;
    cell.style.gridColumn = String(i + 2);
    cell.style.gridRow = '1';
    container.appendChild(cell);
  });

  // Hour labels down the left column (every 2 rows = 1 hour)
  for (let row = 0; row < TOTAL_ROWS; row += 2) {
    const minutes = GRID_START_MINUTES + row * ROW_MINUTES;
    const hour = Math.floor(minutes / 60);
    const label = document.createElement('div');
    label.className = 'week-grid__cell week-grid__time';
    label.textContent = `${String(hour).padStart(2, '0')}:00`;
    label.style.gridColumn = '1';
    label.style.gridRow = `${row + 2} / span 2`;
    container.appendChild(label);
  }

  // Background cells so the grid has visible structure even where empty
  for (let row = 0; row < TOTAL_ROWS; row++) {
    for (let col = 0; col < DAY_LABELS.length; col++) {
      const cell = document.createElement('div');
      cell.className = 'week-grid__cell';
      cell.style.gridColumn = String(col + 2);
      cell.style.gridRow = String(row + 2);
      container.appendChild(cell);
    }
  }

  // Course blocks
  for (const entry of entries) {
    if (entry.dayOfWeek < 1 || entry.dayOfWeek > 6) continue; // Sunday not shown
    const startMin = timeToMinutes(entry.startTime);
    const endMin = timeToMinutes(entry.endTime);
    const startRow = 2 + Math.round((startMin - GRID_START_MINUTES) / ROW_MINUTES);
    const endRow = 2 + Math.round((endMin - GRID_START_MINUTES) / ROW_MINUTES);

    const block = document.createElement('div');
    block.className = 'week-grid__course';
    block.style.gridColumn = String(entry.dayOfWeek + 1);
    block.style.gridRow = `${startRow} / ${endRow}`;
    block.innerHTML = `${escapeHtml(entry.courseCode)}<span class="venue">${escapeHtml(entry.venue || '')}</span>`;
    block.title = `${entry.courseTitle || entry.courseCode} — ${entry.slotCode} — ${entry.startTime}-${entry.endTime}${entry.venue ? ' — ' + entry.venue : ''}`;
    container.appendChild(block);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function minutesToLabel(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
