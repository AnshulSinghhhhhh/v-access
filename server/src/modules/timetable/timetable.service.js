import { getDb } from '../../db/db.js';
import { getCoursesByIds } from '../catalog/catalog.service.js';
import {
  applyPreferencesToSlots,
  generateValidCombinations,
  sortCombinationsForComparison,
  summarizeCombination,
  slotsConflict,
} from './timetable.engine.js';
import { ValidationError, requireString } from '../../lib/validate.js';
import { logAudit } from '../../lib/audit.js';

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Adapts a catalog section { slotCode, meetings: [{dayOfWeek,startTime,endTime,...}] }
// to the engine's expected shape { id, meetings: [{day_of_week,start_time,end_time}] }.
function toEngineSection(section) {
  return {
    id: section.slotCode,
    meetings: section.meetings.map((m) => ({
      day_of_week: m.dayOfWeek,
      start_time: m.startTime,
      end_time: m.endTime,
    })),
  };
}

function parseSelections(rawSelections) {
  if (!Array.isArray(rawSelections) || rawSelections.length === 0) {
    throw new ValidationError('Select at least one course.', 'selections');
  }
  if (rawSelections.length > 15) {
    throw new ValidationError('You can generate a timetable for at most 15 courses at once.', 'selections');
  }
  const seenCourseIds = new Set();
  const parsed = rawSelections.map((sel) => {
    const courseId = Number(sel.courseId);
    const acceptableSlotCodes = Array.isArray(sel.acceptableSlotCodes)
      ? sel.acceptableSlotCodes.map(String)
      : [];
    if (!Number.isInteger(courseId) || courseId <= 0) {
      throw new ValidationError('Invalid course selected.', 'selections');
    }
    if (acceptableSlotCodes.length === 0) {
      throw new ValidationError('Select at least one acceptable slot for each chosen course.', 'selections');
    }
    return { courseId, acceptableSlotCodes };
  });
  for (const sel of parsed) {
    if (seenCourseIds.has(sel.courseId)) {
      throw new ValidationError('Each course can only be selected once.', 'selections');
    }
    seenCourseIds.add(sel.courseId);
  }
  return parsed;
}

function parsePreferences(raw = {}) {
  const prefs = {};
  if (raw.excludeEarlyMorning) prefs.excludeEarlyMorning = true;
  if (Array.isArray(raw.preferredDays)) {
    const days = raw.preferredDays.map(Number).filter((d) => d >= 1 && d <= 7);
    if (days.length > 0) prefs.preferredDays = days;
  }
  if (typeof raw.earliestStart === 'string' && /^\d{2}:\d{2}$/.test(raw.earliestStart)) {
    prefs.earliestStart = raw.earliestStart;
  }
  if (typeof raw.latestEnd === 'string' && /^\d{2}:\d{2}$/.test(raw.latestEnd)) {
    prefs.latestEnd = raw.latestEnd;
  }
  return prefs;
}

export async function generateTimetables({ selections: rawSelections, preferences: rawPreferences }) {
  const selections = parseSelections(rawSelections);
  const preferences = parsePreferences(rawPreferences);

  const courseIds = selections.map((s) => s.courseId);
  const courses = await getCoursesByIds(courseIds);
  const courseById = new Map(courses.map((c) => [c.id, c]));

  for (const sel of selections) {
    if (!courseById.has(sel.courseId)) {
      throw new ValidationError(`Course ${sel.courseId} was not found.`, 'selections');
    }
  }

  const courseSlotGroups = selections.map((sel) => {
    const course = courseById.get(sel.courseId);
    const sectionByCode = new Map(course.sections.map((s) => [s.slotCode, s]));
    const chosenSections = sel.acceptableSlotCodes.map((code) => {
      const section = sectionByCode.get(code);
      if (!section) {
        throw new ValidationError(`Slot ${code} does not belong to ${course.code}.`, 'selections');
      }
      return section;
    });

    const engineShaped = chosenSections.map(toEngineSection);
    const survivingCodes = new Set(
      applyPreferencesToSlots(engineShaped, preferences).map((s) => s.id)
    );
    const filteredSections = chosenSections.filter((s) => survivingCodes.has(s.slotCode));

    return {
      courseId: sel.courseId,
      course,
      slots: filteredSections,
      slotLookup: new Map(filteredSections.map((s) => [s.slotCode, s])),
    };
  });

  const emptyGroup = courseSlotGroups.find((g) => g.slots.length === 0);
  if (emptyGroup) {
    throw new ValidationError(
      `No slots for ${emptyGroup.course.code} match your preferences. Loosen a filter and try again.`,
      'preferences'
    );
  }

  // The engine only needs meeting times to detect conflicts; it echoes the
  // same (engine-shaped) objects back inside each combination, and we
  // re-attach full display data (venue, meeting ids) via slotLookup after.
  const { combinations, truncated } = generateValidCombinations(
    courseSlotGroups.map((g) => ({ courseId: g.courseId, slots: g.slots.map(toEngineSection) })),
    { maxResults: 300 }
  );

  if (combinations.length === 0) {
    throw new ValidationError(
      'No conflict-free combination exists for the courses and slots you selected.',
      'selections'
    );
  }

  const sorted = sortCombinationsForComparison(combinations);
  const groupByCourseId = new Map(courseSlotGroups.map((g) => [g.courseId, g]));

  const formatted = sorted.map((combo) => {
    // One display entry per weekly meeting, so a two-meetings-a-week
    // section produces two grid blocks — but they share the same slotCode
    // so the frontend/save payload treats them as one selection.
    const entries = combo.flatMap((choice) => {
      const group = groupByCourseId.get(choice.courseId);
      const fullSection = group.slotLookup.get(choice.slot.id); // choice.slot.id === slotCode
      return fullSection.meetings.map((meeting) => ({
        courseId: choice.courseId,
        courseCode: group.course.code,
        courseTitle: group.course.title,
        slotCode: fullSection.slotCode,
        slotId: meeting.id,
        dayOfWeek: meeting.dayOfWeek,
        dayName: DAY_NAMES[meeting.dayOfWeek],
        startTime: meeting.startTime,
        endTime: meeting.endTime,
        venue: meeting.venue,
      }));
    });
    const stats = summarizeCombination(combo);
    return { entries, stats };
  });

  return { combinations: formatted, truncated, total: formatted.length };
}

// --- Saved timetables -------------------------------------------------

// entries: [{ courseId, slotCode }] — one selection per course, naming the
// SECTION chosen (which may cover several weekly meetings).
async function resolveSectionSelections(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ValidationError('A timetable needs at least one course.', 'entries');
  }
  const courseIds = [...new Set(entries.map((e) => Number(e.courseId)))];
  const courses = await getCoursesByIds(courseIds);
  const courseById = new Map(courses.map((c) => [c.id, c]));

  const resolved = entries.map((e) => {
    const courseId = Number(e.courseId);
    const slotCode = String(e.slotCode);
    const course = courseById.get(courseId);
    if (!course) throw new ValidationError('One of the selected courses no longer exists.', 'entries');
    const section = course.sections.find((s) => s.slotCode === slotCode);
    if (!section) throw new ValidationError(`Slot ${slotCode} does not belong to ${course.code}.`, 'entries');
    return { courseId, course, section };
  });

  const seenCourseIds = new Set();
  for (const r of resolved) {
    if (seenCourseIds.has(r.courseId)) {
      throw new ValidationError(`${r.course.code} was selected more than once.`, 'entries');
    }
    seenCourseIds.add(r.courseId);
  }

  // Re-check conflicts server-side even though the frontend should only
  // ever submit a combination it generated — never trust the client.
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (slotsConflict(toEngineSection(resolved[i].section), toEngineSection(resolved[j].section))) {
        throw new ValidationError(
          `${resolved[i].course.code} and ${resolved[j].course.code} conflict on the selected slots.`,
          'entries'
        );
      }
    }
  }

  return resolved;
}

export async function saveTimetable(studentId, { name, entries }) {
  const cleanName = requireString(name, 'name', { min: 1, max: 100 });
  const resolved = await resolveSectionSelections(entries);

  const db = await getDb();
  await db.exec('BEGIN');
  try {
    const result = await db
      .prepare('INSERT INTO timetables (student_id, name) VALUES (?, ?)')
      .run(studentId, cleanName);
    const timetableId = Number(result.lastInsertRowid);

    const insertEntry = db.prepare(
      'INSERT INTO timetable_entries (timetable_id, course_id, slot_id) VALUES (?, ?, ?)'
    );
    for (const { courseId, section } of resolved) {
      for (const meeting of section.meetings) {
        await insertEntry.run(timetableId, courseId, meeting.id);
      }
    }
    await db.exec('COMMIT');
    await logAudit({ actorId: studentId, action: 'timetable.save', targetType: 'timetable', targetId: timetableId });
    return { id: timetableId, name: cleanName };
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

export async function listSavedTimetables(studentId) {
  const db = await getDb();
  const timetables = await db
    .prepare(
      `SELECT t.id, t.name, t.created_at, COUNT(DISTINCT e.course_id) AS course_count
       FROM timetables t
       LEFT JOIN timetable_entries e ON e.timetable_id = t.id
       WHERE t.student_id = ?
       GROUP BY t.id
       ORDER BY t.created_at DESC`
    )
    .all(studentId);

  return timetables.map((t) => ({
    id: t.id,
    name: t.name,
    createdAt: t.created_at,
    courseCount: Number(t.course_count),
  }));
}

async function loadOwnedTimetable(studentId, timetableId) {
  const db = await getDb();
  const timetable = await db
    .prepare('SELECT * FROM timetables WHERE id = ? AND student_id = ?')
    .get(timetableId, studentId);
  if (!timetable) {
    const err = new ValidationError('Timetable not found.', 'id');
    err.status = 404;
    throw err;
  }
  return timetable;
}

export async function getSavedTimetable(studentId, timetableId) {
  const timetable = await loadOwnedTimetable(studentId, timetableId);
  const db = await getDb();
  const rows = await db
    .prepare(
      `SELECT c.id AS course_id, c.code, c.title, s.id AS slot_id,
              s.slot_code, s.day_of_week, s.start_time, s.end_time, s.venue
       FROM timetable_entries e
       JOIN courses c ON c.id = e.course_id
       JOIN course_slots s ON s.id = e.slot_id
       WHERE e.timetable_id = ?
       ORDER BY s.day_of_week, s.start_time`
    )
    .all(timetable.id);

  const entries = rows.map((r) => ({
    courseId: r.course_id,
    courseCode: r.code,
    courseTitle: r.title,
    slotCode: r.slot_code,
    slotId: r.slot_id,
    dayOfWeek: r.day_of_week,
    dayName: DAY_NAMES[r.day_of_week],
    startTime: r.start_time,
    endTime: r.end_time,
    venue: r.venue,
  }));

  return { id: timetable.id, name: timetable.name, createdAt: timetable.created_at, entries };
}

export async function updateTimetable(studentId, timetableId, { name, entries }) {
  const timetable = await loadOwnedTimetable(studentId, timetableId);
  const db = await getDb();

  const cleanName = name !== undefined ? requireString(name, 'name', { min: 1, max: 100 }) : timetable.name;
  const resolvedEntries = entries !== undefined ? await resolveSectionSelections(entries) : null;

  await db.exec('BEGIN');
  try {
    await db.prepare('UPDATE timetables SET name = ? WHERE id = ?').run(cleanName, timetable.id);
    if (resolvedEntries) {
      await db.prepare('DELETE FROM timetable_entries WHERE timetable_id = ?').run(timetable.id);
      const insertEntry = db.prepare(
        'INSERT INTO timetable_entries (timetable_id, course_id, slot_id) VALUES (?, ?, ?)'
      );
      for (const { courseId, section } of resolvedEntries) {
        for (const meeting of section.meetings) {
          await insertEntry.run(timetable.id, courseId, meeting.id);
        }
      }
    }
    await db.exec('COMMIT');
    await logAudit({ actorId: studentId, action: 'timetable.update', targetType: 'timetable', targetId: timetable.id });
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }

  return getSavedTimetable(studentId, timetable.id);
}

export async function deleteTimetable(studentId, timetableId) {
  const timetable = await loadOwnedTimetable(studentId, timetableId);
  const db = await getDb();
  await db.prepare('DELETE FROM timetables WHERE id = ?').run(timetable.id); // cascades to entries
  await logAudit({ actorId: studentId, action: 'timetable.delete', targetType: 'timetable', targetId: timetable.id });
}
