import { getDb } from '../../db/db.js';

export async function listCourses({ search } = {}) {
  const db = await getDb();
  let courses;
  if (search) {
    const like = `%${search.toLowerCase()}%`;
    courses = await db
      .prepare(
        `SELECT * FROM courses
         WHERE LOWER(code) LIKE ? OR LOWER(title) LIKE ?
         ORDER BY code`
      )
      .all(like, like);
  } else {
    courses = await db.prepare('SELECT * FROM courses ORDER BY code').all();
  }
  const out = [];
  for (const c of courses) out.push(await formatCourseWithSections(c));
  return out;
}

export async function getCoursesByIds(ids) {
  if (ids.length === 0) return [];
  const db = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  const courses = await db
    .prepare(`SELECT * FROM courses WHERE id IN (${placeholders})`)
    .all(...ids);
  const out = [];
  for (const c of courses) out.push(await formatCourseWithSections(c));
  return out;
}

async function formatCourseWithSections(course) {
  const db = await getDb();
  const rawSlots = (await db
    .prepare(`SELECT * FROM course_slots WHERE course_id = ? ORDER BY day_of_week, start_time`)
    .all(course.id))
    .map(formatSlot);

  return {
    id: course.id,
    code: course.code,
    title: course.title,
    credits: course.credits,
    slots: rawSlots, // flat meeting rows, kept for lookups by raw id
    sections: groupIntoSections(rawSlots), // the real selectable unit
  };
}

function formatSlot(slot) {
  return {
    id: slot.id,
    courseId: slot.course_id,
    slotCode: slot.slot_code,
    dayOfWeek: slot.day_of_week,
    startTime: slot.start_time,
    endTime: slot.end_time,
    venue: slot.venue,
  };
}

// A "section" groups every meeting (course_slots row) that shares the same
// slot_code within a course — e.g. section "A1" meeting Monday AND
// Wednesday is one section with two meetings, not two independent choices.
// This is the real selectable unit: a student picks a section, and gets
// every one of its weekly meetings together.
export function groupIntoSections(slots) {
  const bySlotCode = new Map();
  for (const slot of slots) {
    if (!bySlotCode.has(slot.slotCode)) bySlotCode.set(slot.slotCode, []);
    bySlotCode.get(slot.slotCode).push(slot);
  }
  return [...bySlotCode.entries()].map(([slotCode, meetings]) => ({
    slotCode,
    meetings: meetings.sort((a, b) => a.dayOfWeek - b.dayOfWeek),
  }));
}
