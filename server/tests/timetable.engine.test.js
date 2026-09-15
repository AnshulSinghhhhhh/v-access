import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slotsConflict,
  isEarlyMorningSlot,
  applyPreferencesToSlots,
  generateValidCombinations,
  summarizeCombination,
} from '../src/modules/timetable/timetable.engine.js';

// Sections (the selectable unit) — each has an id and an array of weekly meetings.
const sectionA1 = { id: 'A1', meetings: [{ day_of_week: 1, start_time: '09:00', end_time: '09:50' }] };
const sectionB1 = { id: 'B1', meetings: [{ day_of_week: 1, start_time: '09:30', end_time: '10:20' }] };
const sectionC1 = { id: 'C1', meetings: [{ day_of_week: 1, start_time: '11:00', end_time: '11:50' }] };
const sectionD1 = { id: 'D1', meetings: [{ day_of_week: 2, start_time: '09:00', end_time: '09:50' }] };
const section8am = { id: 'E1', meetings: [{ day_of_week: 1, start_time: '08:00', end_time: '08:50' }] };
// A two-meetings-a-week section: Monday AND Wednesday, same time.
const sectionTwiceWeekly = {
  id: 'F1',
  meetings: [
    { day_of_week: 1, start_time: '14:00', end_time: '14:50' },
    { day_of_week: 3, start_time: '14:00', end_time: '14:50' },
  ],
};

test('slotsConflict detects overlapping times on the same day', () => {
  assert.equal(slotsConflict(sectionA1, sectionB1), true);
});

test('slotsConflict allows back-to-back non-overlapping slots', () => {
  assert.equal(slotsConflict(sectionA1, sectionC1), false);
});

test('slotsConflict ignores slots on different days', () => {
  assert.equal(slotsConflict(sectionA1, sectionD1), false);
});

test('slotsConflict checks every meeting of a multi-meeting section', () => {
  // sectionTwiceWeekly meets Mon+Wed 14:00-14:50. A section that only
  // overlaps its Wednesday meeting must still be flagged as a conflict.
  const wedOnlyOverlap = { id: 'G1', meetings: [{ day_of_week: 3, start_time: '14:30', end_time: '15:20' }] };
  assert.equal(slotsConflict(sectionTwiceWeekly, wedOnlyOverlap), true);
});

test('isEarlyMorningSlot flags a section with any 8 AM meeting', () => {
  assert.equal(isEarlyMorningSlot(section8am), true);
  assert.equal(isEarlyMorningSlot(sectionA1), false);
});

test('applyPreferencesToSlots excludes early morning when requested', () => {
  const result = applyPreferencesToSlots([section8am, sectionA1], { excludeEarlyMorning: true });
  assert.deepEqual(result.map((s) => s.id), [sectionA1.id]);
});

test('applyPreferencesToSlots filters by preferred days (every meeting must match)', () => {
  const result = applyPreferencesToSlots([sectionA1, sectionD1], { preferredDays: [2] });
  assert.deepEqual(result.map((s) => s.id), [sectionD1.id]);
});

test('applyPreferencesToSlots requires ALL meetings of a section to satisfy preferred days', () => {
  // sectionTwiceWeekly meets Mon+Wed; restricting to Monday only should drop it.
  const result = applyPreferencesToSlots([sectionTwiceWeekly], { preferredDays: [1] });
  assert.equal(result.length, 0);
});

test('generateValidCombinations produces only conflict-free combinations', () => {
  const groups = [
    { courseId: 100, slots: [sectionA1, sectionC1] }, // course A: 2 options
    { courseId: 200, slots: [sectionB1, sectionD1] }, // course B: 2 options
  ];
  const { combinations } = generateValidCombinations(groups);

  // sectionA1 conflicts with sectionB1, so only 3 of the 4 cartesian pairs survive.
  assert.equal(combinations.length, 3);
  for (const combo of combinations) {
    const [a, b] = combo;
    assert.equal(slotsConflict(a.slot, b.slot), false);
  }
});

test('generateValidCombinations reports which course has zero usable slots', () => {
  const groups = [{ courseId: 100, slots: [] }];
  const { combinations, unsatisfiableCourseId } = generateValidCombinations(groups);
  assert.equal(combinations.length, 0);
  assert.equal(unsatisfiableCourseId, 100);
});

test('generateValidCombinations respects maxResults', () => {
  const dayA = [1, 2, 3].map((d, i) => ({ id: `a${i}`, meetings: [{ day_of_week: d, start_time: '09:00', end_time: '09:50' }] }));
  const dayB = [1, 2, 3].map((d, i) => ({ id: `b${i}`, meetings: [{ day_of_week: d, start_time: '10:00', end_time: '10:50' }] }));
  const dayC = [1, 2, 3].map((d, i) => ({ id: `c${i}`, meetings: [{ day_of_week: d, start_time: '11:00', end_time: '11:50' }] }));
  const groups = [
    { courseId: 1, slots: dayA },
    { courseId: 2, slots: dayB },
    { courseId: 3, slots: dayC },
  ];
  const { combinations, truncated } = generateValidCombinations(groups, { maxResults: 5 });
  assert.equal(combinations.length, 5);
  assert.equal(truncated, true);
});

test('summarizeCombination counts distinct days used across all meetings', () => {
  const combo = [
    { courseId: 1, slot: sectionA1 },
    { courseId: 2, slot: sectionD1 },
  ];
  const stats = summarizeCombination(combo);
  assert.equal(stats.daysUsed, 2);
  assert.equal(stats.freeDays, 5);
});

test('summarizeCombination accounts for a section meeting multiple days', () => {
  const combo = [{ courseId: 1, slot: sectionTwiceWeekly }]; // Mon + Wed
  const stats = summarizeCombination(combo);
  assert.equal(stats.daysUsed, 2);
});
