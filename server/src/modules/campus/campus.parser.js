// Room code parsing for VIT-PRP's numbering convention:
//   "PRP 230"  -> floor '2', room 30   (leading digit is the floor)
//   "230"      -> same, the "PRP" prefix is optional
//   "PRP G45"  -> floor 'G', room 45   (Ground floor uses a literal G, since
//                 it has no digit of its own to embed)
//
// This is intentionally a pure function with no DB access, so it can be
// unit-tested against real transcribed examples without a database.

const PRP_PREFIX_RE = /^prp[\s-]*/i;

export function parseRoomCode(rawInput) {
  if (typeof rawInput !== 'string') return null;

  const stripped = rawInput.trim().replace(PRP_PREFIX_RE, '').trim();
  if (!stripped) return null;

  const upper = stripped.toUpperCase();

  if (upper.startsWith('G')) {
    const numberPart = upper.slice(1);
    if (!/^\d{1,3}$/.test(numberPart)) return null;
    return { floor: 'G', roomNumber: parseInt(numberPart, 10) };
  }

  // First character is the floor digit; the rest is the room number within
  // that floor (e.g. "230" -> floor '2', room 30).
  const match = /^([1-9])(\d{1,3})$/.exec(upper);
  if (!match) return null;
  return { floor: match[1], roomNumber: parseInt(match[2], 10) };
}

// Formats a {floor, roomNumber} pair back into the canonical display form,
// e.g. for showing "PRP 230" in a result even if the student typed "230".
// Assumes a 2-digit room number within each floor, which held for every
// room in the transcribed VIT-PRP data (max 2 digits after the floor
// digit is stripped) — would need adjusting if a future block runs to 3.
export function formatRoomCode({ floor, roomNumber }) {
  const paddedRoom = String(roomNumber).padStart(2, '0');
  return `PRP ${floor}${paddedRoom}`;
}
