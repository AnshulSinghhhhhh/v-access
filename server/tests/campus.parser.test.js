import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoomCode, formatRoomCode } from '../src/modules/campus/campus.parser.js';

test('parses "PRP 230" as floor 2, room 30 (the reference example)', () => {
  assert.deepEqual(parseRoomCode('PRP 230'), { floor: '2', roomNumber: 30 });
});

test('the "PRP" prefix is optional', () => {
  assert.deepEqual(parseRoomCode('230'), { floor: '2', roomNumber: 30 });
});

test('parsing is case-insensitive and tolerates extra whitespace', () => {
  assert.deepEqual(parseRoomCode('  prp   230  '), { floor: '2', roomNumber: 30 });
  assert.deepEqual(parseRoomCode('prp230'), { floor: '2', roomNumber: 30 });
});

test('Ground floor uses a literal G prefix', () => {
  assert.deepEqual(parseRoomCode('PRP G45'), { floor: 'G', roomNumber: 45 });
  assert.deepEqual(parseRoomCode('g7'), { floor: 'G', roomNumber: 7 });
  assert.deepEqual(parseRoomCode('G07'), { floor: 'G', roomNumber: 7 });
});

test('a single-digit-total room code still resolves (e.g. floor 6, room 10 -> "610")', () => {
  assert.deepEqual(parseRoomCode('610'), { floor: '6', roomNumber: 10 });
});

test('a 3-digit code with a small room number resolves (e.g. "117" -> floor 1, room 17)', () => {
  assert.deepEqual(parseRoomCode('117'), { floor: '1', roomNumber: 17 });
});

test('unparseable input returns null rather than throwing', () => {
  assert.equal(parseRoomCode('nonsense'), null);
  assert.equal(parseRoomCode(''), null);
  assert.equal(parseRoomCode('0'), null); // floor 0 doesn't exist
  assert.equal(parseRoomCode(undefined), null);
  assert.equal(parseRoomCode(null), null);
});

test('formatRoomCode renders the canonical display form, zero-padded', () => {
  assert.equal(formatRoomCode({ floor: '2', roomNumber: 30 }), 'PRP 230');
  assert.equal(formatRoomCode({ floor: 'G', roomNumber: 7 }), 'PRP G07');
});
