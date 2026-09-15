import { getDb } from '../../db/db.js';
import { ValidationError, requireString } from '../../lib/validate.js';
import { logAudit } from '../../lib/audit.js';
import { parseRoomCode, formatRoomCode } from './campus.parser.js';

function notFound(message) {
  const err = new ValidationError(message, 'id');
  err.status = 404;
  return err;
}

// Both coordinates must travel together — a lone latitude or longitude is
// almost certainly a mistake, not a valid partial location.
function validateCoordinates(latitude, longitude) {
  if (latitude === undefined && longitude === undefined) return { latitude: undefined, longitude: undefined };
  if (latitude === null && longitude === null) return { latitude: null, longitude: null }; // explicit clear
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new ValidationError('Provide both latitude and longitude, or neither.', 'latitude');
  }
  if (lat < -90 || lat > 90) throw new ValidationError('Latitude must be between -90 and 90.', 'latitude');
  if (lng < -180 || lng > 180) throw new ValidationError('Longitude must be between -180 and 180.', 'longitude');
  return { latitude: lat, longitude: lng };
}

// --- Zones (blocks) --------------------------------------------------

export async function listBlocks() {
  const db = await getDb();
  const rows = await db.prepare('SELECT * FROM campus_locations ORDER BY name').all();
  return rows.map(formatLocation);
}

export async function getBlock(id) {
  const db = await getDb();
  const row = await db.prepare('SELECT * FROM campus_locations WHERE id = ?').get(id);
  if (!row) throw notFound('Location not found.');
  return formatLocation(row);
}

export async function createBlock(adminId, { name, description, latitude, longitude }) {
  const cleanName = requireString(name, 'name', { min: 1, max: 120 });
  const coords = validateCoordinates(latitude, longitude);
  const db = await getDb();
  const result = await db
    .prepare('INSERT INTO campus_locations (name, description, latitude, longitude) VALUES (?, ?, ?, ?)')
    .run(cleanName, description || null, coords.latitude ?? null, coords.longitude ?? null);
  const id = Number(result.lastInsertRowid);
  await logAudit({ actorId: adminId, action: 'campus.block.create', targetType: 'campus_location', targetId: id });
  return { id };
}

export async function updateBlock(adminId, id, { name, description, latitude, longitude }) {
  const db = await getDb();
  const existing = await db.prepare('SELECT * FROM campus_locations WHERE id = ?').get(id);
  if (!existing) throw notFound('Location not found.');

  const cleanName = name !== undefined ? requireString(name, 'name', { min: 1, max: 120 }) : existing.name;
  const coords = validateCoordinates(latitude, longitude);
  await db.prepare('UPDATE campus_locations SET name = ?, description = ?, latitude = ?, longitude = ? WHERE id = ?').run(
    cleanName,
    description !== undefined ? description : existing.description,
    coords.latitude !== undefined ? coords.latitude : existing.latitude,
    coords.longitude !== undefined ? coords.longitude : existing.longitude,
    id
  );
  await logAudit({ actorId: adminId, action: 'campus.block.update', targetType: 'campus_location', targetId: id });
  return { id };
}

export async function deleteBlock(adminId, id) {
  const db = await getDb();
  const existing = await db.prepare('SELECT id FROM campus_locations WHERE id = ?').get(id);
  if (!existing) throw notFound('Location not found.');
  await db.prepare('DELETE FROM campus_locations WHERE id = ?').run(id); // cascades to its ranges
  await logAudit({ actorId: adminId, action: 'campus.block.delete', targetType: 'campus_location', targetId: id });
}

// Zones with a real, verified outdoor coordinate — used to render the live
// campus map. Most zones will have neither (see the schema comment on
// campus_locations): GPS can't distinguish blocks within one building at a
// useful resolution, so only genuinely map-relevant points get one.
export async function listMapAnchors() {
  const db = await getDb();
  const rows = await db.prepare('SELECT * FROM campus_locations WHERE latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY name').all();
  return rows.map(formatLocation);
}

function formatLocation(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    latitude: row.latitude,
    longitude: row.longitude,
    createdAt: row.created_at,
  };
}

// --- Ranges -----------------------------------------------------------

// Non-blocking check: flags ranges on the same floor (across any zone)
// that overlap the given [start, end]. The real transcribed source data
// has a few genuine boundary overlaps (e.g. one zone ending at 108, the
// next starting at 108) — these are warned about, not rejected, since
// they reflect the actual source rather than a data-entry mistake.
async function findOverlaps(floor, rangeStart, rangeEnd, excludeRangeId = null) {
  const db = await getDb();
  const rows = await db
    .prepare(
      `SELECT campus_room_ranges.*, campus_locations.name AS location_name
       FROM campus_room_ranges
       JOIN campus_locations ON campus_locations.id = campus_room_ranges.location_id
       WHERE campus_room_ranges.floor = ?
         AND campus_room_ranges.range_start <= ?
         AND campus_room_ranges.range_end >= ?
         AND campus_room_ranges.id != ?`
    )
    .all(floor, rangeEnd, rangeStart, excludeRangeId ?? -1);

  return rows.map(
    (r) => `Overlaps with ${r.location_name} (floor ${r.floor}, ${r.range_start}-${r.range_end})`
  );
}

export async function listRangesForBlock(locationId) {
  const db = await getDb();
  const rows = await db
    .prepare(
      `SELECT * FROM campus_room_ranges WHERE location_id = ? ORDER BY
       CASE WHEN floor = 'G' THEN -1 ELSE CAST(floor AS INTEGER) END, range_start`
    )
    .all(locationId);
  return rows.map(formatRange);
}

function formatRange(r) {
  return {
    id: r.id,
    locationId: r.location_id,
    floor: r.floor,
    rangeStart: r.range_start,
    rangeEnd: r.range_end,
    directionsText: r.directions_text,
    createdAt: r.created_at,
  };
}

function validateRangeBounds(floor, rangeStart, rangeEnd) {
  const cleanFloor = requireString(floor, 'floor', { min: 1, max: 4 }).toUpperCase();
  const start = Number(rangeStart);
  const end = Number(rangeEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new ValidationError('Range start/end must be whole numbers, with end >= start.', 'rangeEnd');
  }
  return { cleanFloor, start, end };
}

export async function createRange(adminId, { locationId, floor, rangeStart, rangeEnd, directionsText }) {
  const db = await getDb();
  const location = await db.prepare('SELECT id FROM campus_locations WHERE id = ?').get(Number(locationId));
  if (!location) throw new ValidationError('Location not found.', 'locationId');

  const { cleanFloor, start, end } = validateRangeBounds(floor, rangeStart, rangeEnd);
  const result = await db
    .prepare(
      `INSERT INTO campus_room_ranges (location_id, floor, range_start, range_end, directions_text)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(location.id, cleanFloor, start, end, directionsText || null);

  const id = Number(result.lastInsertRowid);
  await logAudit({ actorId: adminId, action: 'campus.range.create', targetType: 'campus_room_range', targetId: id });
  const warnings = await findOverlaps(cleanFloor, start, end, id);
  return { id, warnings };
}

export async function updateRange(adminId, id, { floor, rangeStart, rangeEnd, directionsText }) {
  const db = await getDb();
  const existing = await db.prepare('SELECT * FROM campus_room_ranges WHERE id = ?').get(id);
  if (!existing) throw notFound('Range not found.');

  const cleanFloor = floor !== undefined ? requireString(floor, 'floor', { min: 1, max: 4 }).toUpperCase() : existing.floor;
  const start = rangeStart !== undefined ? Number(rangeStart) : existing.range_start;
  const end = rangeEnd !== undefined ? Number(rangeEnd) : existing.range_end;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new ValidationError('Range start/end must be whole numbers, with end >= start.', 'rangeEnd');
  }

  await db.prepare(
    `UPDATE campus_room_ranges SET floor = ?, range_start = ?, range_end = ?, directions_text = ? WHERE id = ?`
  ).run(cleanFloor, start, end, directionsText !== undefined ? directionsText : existing.directions_text, id);

  await logAudit({ actorId: adminId, action: 'campus.range.update', targetType: 'campus_room_range', targetId: id });
  const warnings = await findOverlaps(cleanFloor, start, end, id);
  return { id, warnings };
}

export async function deleteRange(adminId, id) {
  const db = await getDb();
  const existing = await db.prepare('SELECT id FROM campus_room_ranges WHERE id = ?').get(id);
  if (!existing) throw notFound('Range not found.');
  await db.prepare('DELETE FROM campus_room_ranges WHERE id = ?').run(id);
  await logAudit({ actorId: adminId, action: 'campus.range.delete', targetType: 'campus_room_range', targetId: id });
}

// --- Student-facing search ---------------------------------------------

// Accepts either a room code ("PRP 230", "230", "G45") or a free-text zone
// name/description search ("Main Entrance", "canteen"). Room codes are
// tried first since they're the primary, unambiguous use case.
export async function search(query) {
  const cleanQuery = requireString(query, 'q', { min: 1, max: 60 });
  const db = await getDb();

  const parsed = parseRoomCode(cleanQuery);
  if (parsed) {
    const rows = await db
      .prepare(
        `SELECT campus_room_ranges.*, campus_locations.name AS location_name,
                campus_locations.description AS location_description
         FROM campus_room_ranges
         JOIN campus_locations ON campus_locations.id = campus_room_ranges.location_id
         WHERE campus_room_ranges.floor = ?
           AND campus_room_ranges.range_start <= ?
           AND campus_room_ranges.range_end >= ?`
      )
      .all(parsed.floor, parsed.roomNumber, parsed.roomNumber);

    return {
      kind: 'room',
      query: cleanQuery,
      parsedCode: formatRoomCode(parsed),
      matches: rows.map((r) => ({
        locationId: r.location_id,
        locationName: r.location_name,
        locationDescription: r.location_description,
        floor: r.floor,
        rangeStart: r.range_start,
        rangeEnd: r.range_end,
        directionsText: r.directions_text,
      })),
    };
  }

  // Not a parseable room code — fall back to a name/description search
  // over zones themselves (e.g. a student searching "Main Entrance").
  const like = `%${cleanQuery.toLowerCase()}%`;
  const zoneRows = await db
    .prepare(
      `SELECT * FROM campus_locations WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ? ORDER BY name`
    )
    .all(like, like);

  return {
    kind: 'zone',
    query: cleanQuery,
    zones: zoneRows.map(formatLocation),
  };
}
