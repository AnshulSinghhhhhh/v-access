// Run manually with `npm run seed`. Never called from app.js — production
// course data should come from an admin import, not this script. This
// exists so the Timetable Designer has realistic data to generate against
// in development and grading, per requirement 18 ("use realistic seed data
// only for development/testing").
import { getDb, closeDb } from './db.js';

async function main() {
const db = await getDb();

const courses = [
  { code: 'CSE1004', title: 'Data Structures and Algorithms', credits: 4 },
  { code: 'CSE2005', title: 'Database Systems', credits: 4 },
  { code: 'CSE3006', title: 'Operating Systems', credits: 3 },
  { code: 'MAT1002', title: 'Discrete Mathematics', credits: 3 },
  { code: 'ECE1010', title: 'Digital Logic Design', credits: 3 },
  { code: 'HUM1001', title: 'Professional Communication', credits: 2 },
  { code: 'CSE3021', title: 'Computer Networks', credits: 4 },
  { code: 'MGT1003', title: 'Principles of Management', credits: 2 },
];

// day_of_week: 1=Mon .. 7=Sun. Multiple slot options per course simulate
// different sections a student can choose between, deliberately including
// some 8 AM sections and some overlaps so the conflict/filter logic has
// something real to demonstrate against.
const slotsByCode = {
  CSE1004: [
    { slot_code: 'A1', day_of_week: 1, start_time: '08:00', end_time: '08:50', venue: 'SJT301' },
    { slot_code: 'A1', day_of_week: 3, start_time: '08:00', end_time: '08:50', venue: 'SJT301' },
    { slot_code: 'B1', day_of_week: 2, start_time: '09:00', end_time: '09:50', venue: 'SJT302' },
    { slot_code: 'B1', day_of_week: 4, start_time: '09:00', end_time: '09:50', venue: 'SJT302' },
  ],
  CSE2005: [
    { slot_code: 'C1', day_of_week: 1, start_time: '10:00', end_time: '10:50', venue: 'SJT204' },
    { slot_code: 'C1', day_of_week: 3, start_time: '10:00', end_time: '10:50', venue: 'SJT204' },
    { slot_code: 'D1', day_of_week: 2, start_time: '08:00', end_time: '08:50', venue: 'SJT205' },
    { slot_code: 'D1', day_of_week: 5, start_time: '08:00', end_time: '08:50', venue: 'SJT205' },
  ],
  CSE3006: [
    { slot_code: 'E1', day_of_week: 2, start_time: '11:00', end_time: '11:50', venue: 'TT101' },
    { slot_code: 'E1', day_of_week: 4, start_time: '11:00', end_time: '11:50', venue: 'TT101' },
    { slot_code: 'F1', day_of_week: 5, start_time: '14:00', end_time: '14:50', venue: 'TT102' },
  ],
  MAT1002: [
    { slot_code: 'G1', day_of_week: 1, start_time: '09:00', end_time: '09:50', venue: 'SMV105' },
    { slot_code: 'G1', day_of_week: 5, start_time: '09:00', end_time: '09:50', venue: 'SMV105' },
  ],
  ECE1010: [
    { slot_code: 'H1', day_of_week: 3, start_time: '11:00', end_time: '11:50', venue: 'SJT401' },
    { slot_code: 'H1', day_of_week: 5, start_time: '11:00', end_time: '11:50', venue: 'SJT401' },
    { slot_code: 'J1', day_of_week: 6, start_time: '08:00', end_time: '08:50', venue: 'SJT402' },
  ],
  HUM1001: [
    { slot_code: 'K1', day_of_week: 6, start_time: '10:00', end_time: '11:40', venue: 'GDN Hall' },
  ],
  CSE3021: [
    { slot_code: 'L1', day_of_week: 2, start_time: '10:00', end_time: '10:50', venue: 'SJT301' },
    { slot_code: 'L1', day_of_week: 4, start_time: '10:00', end_time: '10:50', venue: 'SJT301' },
    { slot_code: 'M1', day_of_week: 1, start_time: '14:00', end_time: '14:50', venue: 'SJT303' },
    { slot_code: 'M1', day_of_week: 3, start_time: '14:00', end_time: '14:50', venue: 'SJT303' },
  ],
  MGT1003: [
    { slot_code: 'N1', day_of_week: 4, start_time: '13:00', end_time: '13:50', venue: 'GDN201' },
  ],
};

const insertCourse = db.prepare(
  'INSERT INTO courses (code, title, credits) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET title=excluded.title, credits=excluded.credits'
);
const clearSlots = db.prepare('DELETE FROM course_slots WHERE course_id = ?');
const insertSlot = db.prepare(
  'INSERT INTO course_slots (course_id, slot_code, day_of_week, start_time, end_time, venue) VALUES (?, ?, ?, ?, ?, ?)'
);
const findCourseId = db.prepare('SELECT id FROM courses WHERE code = ?');

const faculty = [
  { fullName: 'Dr. Ananya Raghunathan', department: 'School of Computer Science', designation: 'Associate Professor', bio: 'Specializes in data structures and algorithm design.' },
  { fullName: 'Dr. Vikram Nair', department: 'School of Computer Science', designation: 'Professor', bio: 'Researches distributed systems and databases.' },
  { fullName: 'Dr. Priya Menon', department: 'School of Electronics', designation: 'Assistant Professor', bio: 'Digital logic design and embedded systems.' },
  { fullName: 'Dr. Suresh Iyer', department: 'School of Mathematics', designation: 'Professor', bio: 'Discrete mathematics and combinatorics.' },
  { fullName: 'Ms. Kavya Subramaniam', department: 'School of Humanities', designation: 'Lecturer', bio: 'Professional and technical communication.' },
];

const insertFaculty = db.prepare(
  'INSERT INTO faculty (full_name, department, designation, bio) VALUES (?, ?, ?, ?)'
);
const findFacultyByName = db.prepare('SELECT id FROM faculty WHERE full_name = ?');

await db.exec('BEGIN');
try {
  for (const f of faculty) {
    const exists = await findFacultyByName.get(f.fullName);
    if (!exists) {
      await insertFaculty.run(f.fullName, f.department, f.designation, f.bio);
    }
  }
  await db.exec('COMMIT');
  console.log(`Seeded ${faculty.length} faculty members.`);
} catch (err) {
  await db.exec('ROLLBACK');
  throw err;
}

// -----------------------------------------------------------------------
// Campus locations (Stage 5 — Find My Class)
//
// Real data transcribed from VIT-PRP's own room-numbering reference (not
// synthetic): each zone has one contiguous room-number range per floor,
// with the floor digit embedded in the room code itself (e.g. "PRP 230" =
// floor 2, room 30 — matches Block E's floor-2 range below). Values here
// are already floor-digit-stripped; see campus.parser.js for the runtime
// parsing logic applied to what a student actually types.
//
// directionsText is intentionally left null — those are real per-zone
// instructions an administrator has to write from firsthand knowledge of
// the building, not something to invent here.
// -----------------------------------------------------------------------

const campusZones = [
  { name: 'Block A', description: null, ranges: { G: [43, 54], 1: [46, 59], 2: [41, 53], 3: [42, 57], 4: [37, 53], 5: [42, 56], 6: [42, 57], 7: [42, 54] } },
  { name: 'Block B', description: null, ranges: { G: [60, 67], 1: [63, 70], 2: [58, 66], 3: [63, 70], 4: [55, 63], 5: [61, 67], 6: [62, 69], 7: [59, 65] } },
  { name: 'Block C1', description: 'Part of the central Block C hexagonal complex.', ranges: { G: [1, 7], 1: [1, 8], 2: [1, 7], 3: [1, 7], 4: [1, 6], 5: [1, 6], 6: [1, 4], 7: [1, 5] } },
  { name: 'Block C2', description: 'Part of the central Block C hexagonal complex.', ranges: { G: [8, 13], 1: [8, 13], 2: [8, 12], 3: [7, 11], 4: [6, 10], 5: [7, 11], 6: [5, 9], 7: [6, 13] } },
  { name: 'Block C3', description: 'Part of the central Block C hexagonal complex. Name unconfirmed — this zone was unlabeled in the source data; renumbered here based on its position between two named Block C zones.', ranges: { G: [17, 21], 1: [19, 24], 2: [19, 22], 3: [17, 21], 4: [13, 16], 5: [18, 21], 6: [15, 20], 7: [16, 21] } },
  { name: 'Block C4', description: 'Part of the central Block C hexagonal complex.', ranges: { G: [22, 28], 1: [25, 31], 2: [22, 29], 3: [21, 26], 4: [17, 21], 5: [22, 26], 6: [21, 26], 7: [22, 28] } },
  { name: 'Main Entrance', description: 'Ground-level entrance, adjacent to the Block C complex.', ranges: { G: [14, 16], 1: [15, 16], 2: [13, 18], 3: [12, 16], 4: [11, 13], 5: [12, 17], 6: [10, 10], 7: [14, 15] } },
  { name: 'Block F', description: 'Small block adjacent to the Block C complex. No ground floor.', ranges: { 1: [17, 17], 2: [16, 17], 3: [15, 15], 4: [12, 12], 5: [13, 16], 6: [11, 14] } }, // floor 7: none (source marked "NA")
  { name: 'Block D', description: null, ranges: { 1: [72, 76], 2: [67, 75], 3: [71, 79], 4: [64, 72], 5: [68, 76], 6: [70, 78], 7: [66, 73] } }, // ground floor: none (source marked "NA")
  { name: 'Block E', description: null, ranges: { G: [29, 41], 1: [32, 45], 2: [30, 40], 3: [27, 41], 4: [22, 36], 5: [27, 41], 6: [27, 41], 7: [29, 40] } },
];

const insertZone = db.prepare('INSERT INTO campus_locations (name, description) VALUES (?, ?)');
const insertRange = db.prepare(
  'INSERT INTO campus_room_ranges (location_id, floor, range_start, range_end) VALUES (?, ?, ?, ?)'
);
const existingZone = db.prepare('SELECT id FROM campus_locations WHERE name = ?');
const clearRangesForZone = db.prepare('DELETE FROM campus_room_ranges WHERE location_id = ?');

await db.exec('BEGIN');
try {
  let rangeCount = 0;
  for (const zone of campusZones) {
    let zoneId;
    const existing = await existingZone.get(zone.name);
    if (existing) {
      zoneId = existing.id;
      await clearRangesForZone.run(zoneId); // re-seedable without duplicating ranges
    } else {
      const result = await insertZone.run(zone.name, zone.description);
      zoneId = Number(result.lastInsertRowid);
    }
    for (const [floor, [start, end]] of Object.entries(zone.ranges)) {
      await insertRange.run(zoneId, floor, start, end);
      rangeCount++;
    }
  }
  await db.exec('COMMIT');
  console.log(`Seeded ${campusZones.length} campus zones with ${rangeCount} room ranges.`);
} catch (err) {
  await db.exec('ROLLBACK');
  throw err;
}

// -----------------------------------------------------------------------
// Live map anchor: the PRP building's real outdoor coordinate, for the
// campus-wide live map. This is intentionally a SEPARATE row from the
// zones above, not a coordinate copied onto all ten of them — GPS can't
// distinguish blocks 50-100m apart within the same building complex, so
// giving each zone its own "coordinate" would imply a precision that
// doesn't exist. This one point represents "the PRP building," full stop;
// which block/floor once you're there is what the room lookup is for.
//
// Source: OpenStreetMap way 1092533785 (tagged building=university,
// levels=7 — matches VIT's own published "G+7 floors" for PRP), via
// https://www.openstreetmap.org/way/1092533785, retrieved 2026.
// -----------------------------------------------------------------------

const PRP_ANCHOR = {
  name: 'Pearl Research Park (PRP)',
  description: 'The PRP building as a whole, for getting to the right building on campus. See "Find a room" for which block/floor once you\'re there.',
  latitude: 12.971493,
  longitude: 79.166208,
};

const existingAnchor = await db.prepare('SELECT id FROM campus_locations WHERE name = ?').get(PRP_ANCHOR.name);
if (existingAnchor) {
  await db.prepare('UPDATE campus_locations SET description = ?, latitude = ?, longitude = ? WHERE id = ?')
    .run(PRP_ANCHOR.description, PRP_ANCHOR.latitude, PRP_ANCHOR.longitude, existingAnchor.id);
} else {
  await db.prepare('INSERT INTO campus_locations (name, description, latitude, longitude) VALUES (?, ?, ?, ?)')
    .run(PRP_ANCHOR.name, PRP_ANCHOR.description, PRP_ANCHOR.latitude, PRP_ANCHOR.longitude);
}
console.log('Seeded the PRP live-map anchor point.');

await db.exec('BEGIN');
try {
  for (const course of courses) {
    await insertCourse.run(course.code, course.title, course.credits);
    const { id } = await findCourseId.get(course.code);
    await clearSlots.run(id);
    for (const slot of slotsByCode[course.code] || []) {
      await insertSlot.run(id, slot.slot_code, slot.day_of_week, slot.start_time, slot.end_time, slot.venue);
    }
  }
  await db.exec('COMMIT');
  console.log(`Seeded ${courses.length} courses with their slots.`);
} catch (err) {
  await db.exec('ROLLBACK');
  throw err;
}

}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
