import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'vaccess-campus-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = await import('../src/db/db.js');
const campusService = await import('../src/modules/campus/campus.service.js');

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const ADMIN_ID = 1;
{
  const db = getDb();
  const adminRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('admin').id;
  db.prepare('INSERT INTO users (id, full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, ?, 1)')
    .run(ADMIN_ID, 'The Admin', 'admin@vitstudent.ac.in', 'x', adminRoleId);
}

let blockEId;

test('createBlock and createRange build up a searchable zone', () => {
  const block = campusService.createBlock(ADMIN_ID, { name: 'Block E', description: 'Test zone' });
  blockEId = block.id;
  const range = campusService.createRange(ADMIN_ID, {
    locationId: blockEId,
    floor: '2',
    rangeStart: 30,
    rangeEnd: 40,
    directionsText: 'Enter from the canteen side, take the stairs up one flight.',
  });
  assert.ok(range.id);
  assert.deepEqual(range.warnings, []);
});

test('search resolves "PRP 230" to the seeded Block E floor-2 range, matching the real-world example', () => {
  const result = campusService.search('PRP 230');
  assert.equal(result.kind, 'room');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].locationName, 'Block E');
  assert.equal(result.matches[0].directionsText, 'Enter from the canteen side, take the stairs up one flight.');
});

test('search returns no matches for a room number outside any seeded range', () => {
  const result = campusService.search('PRP 299');
  assert.equal(result.kind, 'room');
  assert.equal(result.matches.length, 0);
});

test('search falls back to a zone name/description search when the input is not a parseable room code', () => {
  const result = campusService.search('Block E');
  assert.equal(result.kind, 'zone');
  assert.ok(result.zones.some((z) => z.id === blockEId));
});

test('createRange flags a genuine boundary overlap without rejecting the write', () => {
  const otherBlock = campusService.createBlock(ADMIN_ID, { name: 'Block C2 (test)' });
  // Overlaps the existing Block E floor-2 range [30,40] at 35-45.
  const overlapping = campusService.createRange(ADMIN_ID, {
    locationId: otherBlock.id,
    floor: '2',
    rangeStart: 35,
    rangeEnd: 45,
  });
  assert.equal(overlapping.warnings.length, 1);
  assert.match(overlapping.warnings[0], /Block E/);

  // Both zones should now show up for a room code that falls in the overlap.
  const search = campusService.search('PRP 237');
  assert.equal(search.matches.length, 2);
});

test('a range on a different floor never triggers an overlap warning against another floor', () => {
  const block = campusService.createBlock(ADMIN_ID, { name: 'Isolated block' });
  const range = campusService.createRange(ADMIN_ID, { locationId: block.id, floor: '5', rangeStart: 30, rangeEnd: 40 });
  assert.deepEqual(range.warnings, []);
});

test('createRange rejects an invalid range (end before start)', () => {
  assert.throws(() =>
    campusService.createRange(ADMIN_ID, { locationId: blockEId, floor: '3', rangeStart: 50, rangeEnd: 10 })
  );
});

test('createRange rejects a nonexistent location', () => {
  assert.throws(() => campusService.createRange(ADMIN_ID, { locationId: 999999, floor: '1', rangeStart: 1, rangeEnd: 5 }));
});

test('updateRange changes bounds and re-checks overlaps', () => {
  const block = campusService.createBlock(ADMIN_ID, { name: 'Update test block' });
  const range = campusService.createRange(ADMIN_ID, { locationId: block.id, floor: '4', rangeStart: 1, rangeEnd: 5 });
  const updated = campusService.updateRange(ADMIN_ID, range.id, { rangeStart: 1, rangeEnd: 9 });
  assert.equal(updated.id, range.id);

  const detail = campusService.listRangesForBlock(block.id);
  assert.equal(detail[0].rangeEnd, 9);
});

test('listRangesForBlock orders Ground before numbered floors', () => {
  const block = campusService.createBlock(ADMIN_ID, { name: 'Floor order test' });
  campusService.createRange(ADMIN_ID, { locationId: block.id, floor: '2', rangeStart: 1, rangeEnd: 5 });
  campusService.createRange(ADMIN_ID, { locationId: block.id, floor: 'G', rangeStart: 1, rangeEnd: 5 });
  campusService.createRange(ADMIN_ID, { locationId: block.id, floor: '1', rangeStart: 1, rangeEnd: 5 });

  const ranges = campusService.listRangesForBlock(block.id);
  assert.deepEqual(ranges.map((r) => r.floor), ['G', '1', '2']);
});

test('deleteBlock cascades and removes its ranges; searches no longer find them', () => {
  const block = campusService.createBlock(ADMIN_ID, { name: 'To be deleted' });
  campusService.createRange(ADMIN_ID, { locationId: block.id, floor: '3', rangeStart: 90, rangeEnd: 95 });
  campusService.deleteBlock(ADMIN_ID, block.id);

  assert.throws(() => campusService.getBlock(block.id), /not found/i);
  const search = campusService.search('PRP 392');
  assert.ok(!search.matches.some((m) => m.locationName === 'To be deleted'));
});

test('deleteRange removes a single range without affecting the rest of its block', () => {
  const block = campusService.createBlock(ADMIN_ID, { name: 'Partial delete test' });
  const r1 = campusService.createRange(ADMIN_ID, { locationId: block.id, floor: '1', rangeStart: 1, rangeEnd: 5 });
  campusService.createRange(ADMIN_ID, { locationId: block.id, floor: '2', rangeStart: 1, rangeEnd: 5 });
  campusService.deleteRange(ADMIN_ID, r1.id);

  const remaining = campusService.listRangesForBlock(block.id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].floor, '2');
});

test('updateBlock and deleteBlock on a nonexistent id throw not-found', () => {
  assert.throws(() => campusService.updateBlock(ADMIN_ID, 999999, { name: 'x' }), /not found/i);
  assert.throws(() => campusService.deleteBlock(ADMIN_ID, 999999), /not found/i);
});

test('search requires a non-empty query', () => {
  assert.throws(() => campusService.search(''));
});

// --- Map anchors (latitude/longitude) -----------------------------------

test('a zone created without coordinates has none, and is excluded from map anchors', () => {
  const block = campusService.createBlock(ADMIN_ID, { name: 'No Coordinates Zone' });
  const detail = campusService.getBlock(block.id);
  assert.equal(detail.latitude, null);
  assert.equal(detail.longitude, null);
  const anchors = campusService.listMapAnchors();
  assert.ok(!anchors.some((a) => a.id === block.id));
});

test('a zone created with real coordinates appears in map anchors', () => {
  const block = campusService.createBlock(ADMIN_ID, {
    name: 'PRP Anchor Test',
    latitude: 12.971493,
    longitude: 79.166208,
  });
  const anchors = campusService.listMapAnchors();
  const found = anchors.find((a) => a.id === block.id);
  assert.ok(found);
  assert.equal(found.latitude, 12.971493);
  assert.equal(found.longitude, 79.166208);
});

test('createBlock rejects a latitude or longitude given without its pair', () => {
  assert.throws(() => campusService.createBlock(ADMIN_ID, { name: 'Partial Coords', latitude: 12.9 }));
});

test('createBlock rejects an out-of-range coordinate', () => {
  assert.throws(() => campusService.createBlock(ADMIN_ID, { name: 'Bad Lat', latitude: 200, longitude: 79 }));
  assert.throws(() => campusService.createBlock(ADMIN_ID, { name: 'Bad Lng', latitude: 12, longitude: -200 }));
});

test('updateBlock can add coordinates to a zone that had none, and can explicitly clear them', () => {
  const block = campusService.createBlock(ADMIN_ID, { name: 'Coord Update Test' });
  campusService.updateBlock(ADMIN_ID, block.id, { latitude: 12.97, longitude: 79.16 });
  assert.ok(campusService.listMapAnchors().some((a) => a.id === block.id));

  campusService.updateBlock(ADMIN_ID, block.id, { latitude: null, longitude: null });
  const cleared = campusService.getBlock(block.id);
  assert.equal(cleared.latitude, null);
  assert.ok(!campusService.listMapAnchors().some((a) => a.id === block.id));
});
