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

function formatTime12(timeStr) {
  if (!timeStr) return '';
  const [hStr, mStr] = timeStr.split(':');
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${mStr} ${ampm}`;
}

async function renderScheduleGlance(savedCount) {
  const strip = document.getElementById('schedule-strip');
  const dayLabel = document.getElementById('today-day-label');
  const nextBadge = document.getElementById('next-lecture-badge');
  const nextText = document.getElementById('next-lecture-text');
  const navBtn = document.getElementById('timetable-nav-btn');
  if (!strip) return;

  const now = new Date();
  const jsDay = now.getDay();
  // VIT slot day_of_week: 1 = Mon, 2 = Tue, 3 = Wed, 4 = Thu, 5 = Fri, 6 = Sat, 7 = Sun
  const todayDayOfWeek = jsDay === 0 ? 7 : jsDay;
  const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const todayName = DAY_NAMES[todayDayOfWeek] || 'Today';

  if (dayLabel) {
    dayLabel.textContent = todayName;
  }

  if (nextBadge) nextBadge.hidden = true;

  if (savedCount === 0) {
    if (navBtn) {
      navBtn.textContent = 'Create Timetable →';
      navBtn.href = '/timetable.html';
    }
    strip.innerHTML = `
      <div class="empty-state" style="padding: var(--sp-6) var(--sp-4); width: 100%;">
        <h3 style="font-size: var(--text-base); margin-bottom: var(--sp-1);">No Timetable Created Yet</h3>
        <p class="text-muted" style="font-size: var(--text-sm); margin-bottom: var(--sp-4);">
          You haven't generated a timetable yet. Assemble course sections to see your live daily schedule here.
        </p>
        <a href="/timetable.html" class="btn btn-primary btn-sm">Create Timetable &rarr;</a>
      </div>
    `;
    return;
  }

  if (navBtn) {
    navBtn.textContent = 'Full Timetable →';
    navBtn.href = '/timetable.html';
  }

  try {
    const list = await api('/api/timetable');
    if (!list || list.length === 0) {
      strip.innerHTML = `
        <div class="empty-state" style="padding: var(--sp-6) var(--sp-4); width: 100%;">
          <h3 style="font-size: var(--text-base); margin-bottom: var(--sp-1);">No Timetable Created Yet</h3>
          <p class="text-muted" style="font-size: var(--text-sm); margin-bottom: var(--sp-4);">
            You haven't generated a timetable yet. Assemble course sections to see your live daily schedule here.
          </p>
          <a href="/timetable.html" class="btn btn-primary btn-sm">Create Timetable &rarr;</a>
        </div>
      `;
      return;
    }

    const activeTt = await api(`/api/timetable/${list[0].id}`);
    const entries = activeTt?.entries || [];

    const todayClasses = entries
      .filter((e) => Number(e.dayOfWeek) === todayDayOfWeek)
      .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

    if (todayClasses.length === 0) {
      strip.innerHTML = `
        <div class="empty-state" style="padding: var(--sp-6) var(--sp-4); width: 100%;">
          <h3 style="font-size: var(--text-base); margin-bottom: var(--sp-1);">No Classes Scheduled Today</h3>
          <p class="text-muted" style="font-size: var(--text-sm); margin-bottom: 0;">
            No lecture slots assigned for ${escapeHtml(todayName)} in "${escapeHtml(activeTt.name)}".
          </p>
        </div>
      `;
      return;
    }

    const curHour = String(now.getHours()).padStart(2, '0');
    const curMin = String(now.getMinutes()).padStart(2, '0');
    const curTime = `${curHour}:${curMin}`;

    const nextClass = todayClasses.find((c) => curTime < c.endTime);

    if (nextClass && nextBadge && nextText) {
      const isOngoing = curTime >= nextClass.startTime;
      const statusLabel = isOngoing ? 'Ongoing Lecture' : 'Next Lecture';
      nextText.innerHTML = `${statusLabel}: <strong>${escapeHtml(nextClass.title)} (${escapeHtml(nextClass.code)})</strong> &middot; ${escapeHtml(nextClass.venue || 'TBA')}`;
      nextBadge.hidden = false;
    }

    strip.innerHTML = '';
    for (const c of todayClasses) {
      const isNext = nextClass && nextClass.slotId === c.slotId && nextClass.courseId === c.courseId;
      const isOngoing = isNext && curTime >= c.startTime;
      const isFinished = curTime > c.endTime;

      const card = document.createElement('div');
      card.className = `schedule-card${isNext ? ' schedule-card--active' : ''}`;
      if (isFinished) {
        card.style.opacity = '0.75';
      }

      let badgeHtml = '';
      if (isOngoing) {
        badgeHtml = `<span class="chip chip-live" style="padding:2px 8px; font-size:var(--text-xs);"><span class="pulse-dot"></span> Ongoing</span>`;
      } else if (isNext) {
        badgeHtml = `<span class="chip chip-live" style="padding:2px 8px; font-size:var(--text-xs);"><span class="pulse-dot"></span> Next</span>`;
      } else if (isFinished) {
        badgeHtml = `<span class="chip" style="padding:2px 8px; font-size:var(--text-xs); background:var(--color-bg);">Completed</span>`;
      }

      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span class="schedule-card__time"${isNext ? ' style="color:var(--color-accent); font-weight:600;"' : ''}>
            ${formatTime12(c.startTime)} – ${formatTime12(c.endTime)} &middot; Slot ${escapeHtml(c.slotCode)}
          </span>
          ${badgeHtml}
        </div>
        <div class="schedule-card__title">${escapeHtml(c.title)}</div>
        <div class="schedule-card__meta">
          <span class="chip chip-venue">${escapeHtml(c.venue || 'TBA')}</span>
          <span class="chip chip-course mono">${escapeHtml(c.code)}</span>
        </div>
      `;
      strip.appendChild(card);
    }
  } catch (err) {
    console.error('Failed to load schedule glance:', err);
    strip.innerHTML = `<p class="text-muted" style="font-size: var(--text-sm)">Unable to load schedule glance.</p>`;
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
    await renderScheduleGlance(result.stats.savedTimetables);
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
