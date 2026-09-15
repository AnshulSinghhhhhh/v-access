import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'vaccess-tt-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = await import('../src/db/db.js');
const timetableService = await import('../src/modules/timetable/timetable.service.js');

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Seed two courses. Course 1 has a twice-weekly section (A1: Mon+Wed 8am)
// and a single-meeting section (B1: Tue 10am). Course 2 has a section that
// conflicts with A1 on Monday (C1: Mon 8:30) and one that never conflicts
// with anything (D1: Tue 11am). This exercises multi-meeting sections,
// conflict detection across them, and the always-conflict-free path.
function seed() {
  const db = getDb();
  db.exec('BEGIN');
  const c1 = db.prepare('INSERT INTO courses (code, title, credits) VALUES (?, ?, ?)').run('CSE1004', 'DSA', 4);
  const c2 = db.prepare('INSERT INTO courses (code, title, credits) VALUES (?, ?, ?)').run('MAT1002', 'Discrete Math', 3);
  const course1Id = Number(c1.lastInsertRowid);
  const course2Id = Number(c2.lastInsertRowid);

  const insertSlot = db.prepare(
    'INSERT INTO course_slots (course_id, slot_code, day_of_week, start_time, end_time, venue) VALUES (?, ?, ?, ?, ?, ?)'
  );
  // Section A1: meets Monday AND Wednesday at 8am (twice-weekly section).
  insertSlot.run(course1Id, 'A1', 1, '08:00', '08:50', 'SJT301');
  insertSlot.run(course1Id, 'A1', 3, '08:00', '08:50', 'SJT301');
  // Section B1: single Tuesday 10am meeting.
  insertSlot.run(course1Id, 'B1', 2, '10:00', '10:50', 'SJT302');

  // Section C1: Monday 8:30 — conflicts with A1's Monday 8:00-8:50 meeting.
  insertSlot.run(course2Id, 'C1', 1, '08:30', '09:20', 'SMV105');
  // Section D1: Tuesday 11am — never conflicts with anything above.
  insertSlot.run(course2Id, 'D1', 2, '11:00', '11:50', 'SMV106');
  db.exec('COMMIT');

  return { course1Id, course2Id };
}

const ids = seed();
const STUDENT_ID = 1;
const OTHER_STUDENT_ID = 2;

{
  const db = getDb();
  const roleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('student').id;
  db.prepare('INSERT INTO users (id, full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, ?, 1)')
    .run(STUDENT_ID, 'Student One', 's1@vitstudent.ac.in', 'x', roleId);
  db.prepare('INSERT INTO users (id, full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, ?, 1)')
    .run(OTHER_STUDENT_ID, 'Student Two', 's2@vitstudent.ac.in', 'x', roleId);
}

test('generateTimetables returns only conflict-free combinations, expanding multi-meeting sections', () => {
  const result = timetableService.generateTimetables({
    selections: [
      { courseId: ids.course1Id, acceptableSlotCodes: ['A1', 'B1'] },
      { courseId: ids.course2Id, acceptableSlotCodes: ['C1', 'D1'] },
    ],
    preferences: {},
  });

  // A1+C1 conflicts (both Monday morning); the other 3 pairings don't.
  assert.equal(result.combinations.length, 3);

  const withA1 = result.combinations.find((c) => c.entries.some((e) => e.slotCode === 'A1'));
  assert.ok(withA1, 'a combination using section A1 should exist');
  // A1 meets twice a week, so it must appear as two entries for course 1.
  const a1Entries = withA1.entries.filter((e) => e.slotCode === 'A1');
  assert.equal(a1Entries.length, 2);
  assert.deepEqual(a1Entries.map((e) => e.dayOfWeek).sort(), [1, 3]);

  for (const combo of result.combinations) {
    const hasA1 = combo.entries.some((e) => e.slotCode === 'A1');
    const hasC1 = combo.entries.some((e) => e.slotCode === 'C1');
    assert.ok(!(hasA1 && hasC1), 'conflicting sections should never appear in the same combination');
  }
});

test('generateTimetables applies the "exclude early morning" preference', () => {
  const result = timetableService.generateTimetables({
    selections: [
      { courseId: ids.course1Id, acceptableSlotCodes: ['A1', 'B1'] },
      { courseId: ids.course2Id, acceptableSlotCodes: ['D1'] },
    ],
    preferences: { excludeEarlyMorning: true },
  });

  // A1 (8am) must be excluded, leaving only B1 + D1.
  assert.equal(result.combinations.length, 1);
  assert.ok(result.combinations[0].entries.every((e) => e.slotCode !== 'A1'));
});

let savedTimetableId;

test('saveTimetable persists a valid, conflict-free section selection', () => {
  const saved = timetableService.saveTimetable(STUDENT_ID, {
    name: 'My preferred schedule',
    entries: [
      { courseId: ids.course1Id, slotCode: 'B1' },
      { courseId: ids.course2Id, slotCode: 'D1' },
    ],
  });
  savedTimetableId = saved.id;
  assert.ok(savedTimetableId);

  const list = timetableService.listSavedTimetables(STUDENT_ID);
  assert.equal(list.length, 1);
  assert.equal(list[0].courseCount, 2);
});

test('saveTimetable expands a twice-weekly section into two stored entries', () => {
  const saved = timetableService.saveTimetable(STUDENT_ID, {
    name: 'Includes A1',
    entries: [{ courseId: ids.course1Id, slotCode: 'A1' }],
  });
  const detail = timetableService.getSavedTimetable(STUDENT_ID, saved.id);
  assert.equal(detail.entries.length, 2); // Monday + Wednesday meetings
  timetableService.deleteTimetable(STUDENT_ID, saved.id);
});

test('saveTimetable rejects a conflicting pair even if the client submits it directly', () => {
  assert.throws(() =>
    timetableService.saveTimetable(STUDENT_ID, {
      name: 'Bad schedule',
      entries: [
        { courseId: ids.course1Id, slotCode: 'A1' },
        { courseId: ids.course2Id, slotCode: 'C1' },
      ],
    })
  );
});

test('saveTimetable rejects the same course selected twice under different sections, even with no time overlap', () => {
  // A1 (Mon/Wed 8am) and B1 (Tue 10am) never overlap in time, but a
  // student cannot be enrolled in one course under two different sections.
  assert.throws(() =>
    timetableService.saveTimetable(STUDENT_ID, {
      name: 'Duplicate course',
      entries: [
        { courseId: ids.course1Id, slotCode: 'A1' },
        { courseId: ids.course1Id, slotCode: 'B1' },
      ],
    }),
    /selected more than once/i
  );
});

test('generateTimetables rejects duplicate course selections in the request', () => {
  assert.throws(() =>
    timetableService.generateTimetables({
      selections: [
        { courseId: ids.course1Id, acceptableSlotCodes: ['A1'] },
        { courseId: ids.course1Id, acceptableSlotCodes: ['B1'] },
      ],
      preferences: {},
    }),
    /only be selected once/i
  );
});

test('getSavedTimetable returns full entry detail for the owner', () => {
  const timetable = timetableService.getSavedTimetable(STUDENT_ID, savedTimetableId);
  assert.equal(timetable.name, 'My preferred schedule');
  assert.equal(timetable.entries.length, 2);
});

test('a different student cannot view or delete someone else\'s timetable', () => {
  assert.throws(() => timetableService.getSavedTimetable(OTHER_STUDENT_ID, savedTimetableId), /not found/i);
  assert.throws(() => timetableService.deleteTimetable(OTHER_STUDENT_ID, savedTimetableId), /not found/i);
});

test('updateTimetable can rename without touching entries', () => {
  const updated = timetableService.updateTimetable(STUDENT_ID, savedTimetableId, {
    name: 'Renamed schedule',
  });
  assert.equal(updated.name, 'Renamed schedule');
  assert.equal(updated.entries.length, 2, 'entries unchanged when not provided in the update');
});

test('updateTimetable can replace entries, re-validating conflicts', () => {
  const updated = timetableService.updateTimetable(STUDENT_ID, savedTimetableId, {
    entries: [{ courseId: ids.course1Id, slotCode: 'A1' }],
  });
  assert.equal(updated.entries.length, 2); // A1's two weekly meetings
  assert.ok(updated.entries.every((e) => e.slotCode === 'A1'));
});

test('deleteTimetable removes the timetable for its owner', () => {
  timetableService.deleteTimetable(STUDENT_ID, savedTimetableId);
  const list = timetableService.listSavedTimetables(STUDENT_ID);
  assert.equal(list.length, 0);
});
