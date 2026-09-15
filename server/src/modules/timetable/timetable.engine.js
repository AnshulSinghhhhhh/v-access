// Pure functions only — no DB, no HTTP. This is REQ-6..REQ-10: accept slot
// inputs, generate all valid combinations, apply filters (e.g. "no 8 AM"),
// prevent conflicts. Nothing here is a hardcoded timetable; combinations are
// derived at request time from whatever courses/sections are passed in.
//
// The selectable unit is a SECTION, not a single meeting: a section like
// "A1" that meets Monday and Wednesday is one choice with two meetings, and
// choosing it commits to both. `meetings` is an array of
// { day_of_week, start_time, end_time }.

export function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function meetingsOverlap(a, b) {
  if (a.day_of_week !== b.day_of_week) return false;
  const aStart = timeToMinutes(a.start_time);
  const aEnd = timeToMinutes(a.end_time);
  const bStart = timeToMinutes(b.start_time);
  const bEnd = timeToMinutes(b.end_time);
  return aStart < bEnd && bStart < aEnd;
}

// Two sections conflict if ANY meeting of one overlaps ANY meeting of the other.
export function slotsConflict(sectionA, sectionB) {
  for (const m1 of sectionA.meetings) {
    for (const m2 of sectionB.meetings) {
      if (meetingsOverlap(m1, m2)) return true;
    }
  }
  return false;
}

export function isEarlyMorningSlot(section, cutoffMinutes = 9 * 60) {
  return section.meetings.some((m) => timeToMinutes(m.start_time) < cutoffMinutes);
}

// Applies preference filters to the pool of candidate sections for ONE course.
// Returns the filtered list (does not mutate input).
export function applyPreferencesToSlots(sections, preferences = {}) {
  let filtered = sections;

  if (preferences.excludeEarlyMorning) {
    filtered = filtered.filter((s) => !isEarlyMorningSlot(s));
  }
  if (Array.isArray(preferences.preferredDays) && preferences.preferredDays.length > 0) {
    const allowed = new Set(preferences.preferredDays);
    // Every meeting of the section must fall on an allowed day — a section
    // that meets on an unwanted day doesn't half-qualify.
    filtered = filtered.filter((s) => s.meetings.every((m) => allowed.has(m.day_of_week)));
  }
  if (preferences.earliestStart) {
    const min = timeToMinutes(preferences.earliestStart);
    filtered = filtered.filter((s) => s.meetings.every((m) => timeToMinutes(m.start_time) >= min));
  }
  if (preferences.latestEnd) {
    const max = timeToMinutes(preferences.latestEnd);
    filtered = filtered.filter((s) => s.meetings.every((m) => timeToMinutes(m.end_time) <= max));
  }

  return filtered;
}

// courseSlotGroups: [{ courseId, slots: [sectionObj, ...] }, ...]
// Each sectionObj must have: id, meetings: [{ day_of_week, start_time, end_time }, ...].
//
// Generates every valid combination (one section per course, no pairwise
// conflicts) via backtracking — this naturally prunes invalid branches
// early instead of generating the full cartesian product and filtering
// afterward, which matters once course counts grow.
export function generateValidCombinations(courseSlotGroups, { maxResults = 300 } = {}) {
  const results = [];
  const empty = courseSlotGroups.find((g) => g.slots.length === 0);
  if (empty) {
    return { combinations: [], truncated: false, unsatisfiableCourseId: empty.courseId };
  }

  const chosen = [];

  function backtrack(index) {
    if (results.length >= maxResults) return;
    if (index === courseSlotGroups.length) {
      results.push(chosen.map((entry) => ({ ...entry })));
      return;
    }
    const group = courseSlotGroups[index];
    for (const slot of group.slots) {
      if (results.length >= maxResults) return;
      const conflict = chosen.some((c) => slotsConflict(c.slot, slot));
      if (conflict) continue;
      chosen.push({ courseId: group.courseId, slot });
      backtrack(index + 1);
      chosen.pop();
    }
  }

  backtrack(0);

  return {
    combinations: results,
    truncated: results.length >= maxResults,
    unsatisfiableCourseId: null,
  };
}

// Descriptive stats for one combination, so students can compare schedules
// on real facts rather than a single opinionated "best" score.
export function summarizeCombination(combination) {
  const allMeetings = combination.flatMap((entry) => entry.slot.meetings);
  const daysUsed = new Set(allMeetings.map((m) => m.day_of_week));
  const starts = allMeetings.map((m) => timeToMinutes(m.start_time));
  const ends = allMeetings.map((m) => timeToMinutes(m.end_time));
  return {
    daysUsed: daysUsed.size,
    earliestStartMinutes: Math.min(...starts),
    latestEndMinutes: Math.max(...ends),
    freeDays: 7 - daysUsed.size,
  };
}

// Default comparison order: fewer days on campus first, then a later
// earliest-start as a tiebreak (mildly favors not-too-early schedules).
// This is a default sort only — the frontend shows the underlying stats so
// the student can re-sort or judge for themselves.
export function sortCombinationsForComparison(combinations) {
  return [...combinations].sort((a, b) => {
    const sa = summarizeCombination(a);
    const sb = summarizeCombination(b);
    if (sa.daysUsed !== sb.daysUsed) return sa.daysUsed - sb.daysUsed;
    return sb.earliestStartMinutes - sa.earliestStartMinutes;
  });
}
