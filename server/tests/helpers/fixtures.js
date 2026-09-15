// Builds real, minimal-but-structurally-valid file fixtures so tests
// exercise the actual detection logic in lib/storage.js rather than mocking
// it. These are not full documents — they're the smallest byte sequences
// that satisfy each format's real structural checks.

export function buildMinimalPdf() {
  return Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
}

export function buildOleContainer() {
  // The 8-byte OLE Compound File signature, padded — enough to satisfy the
  // real container check; legacy .doc/.ppt disambiguation then falls back
  // to the filename extension, as documented in storage.js.
  return Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(56, 0),
  ]);
}

export function buildRandomBytes(length = 64) {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = (i * 37 + 11) % 256;
  return buf;
}

// Builds a real, minimal ZIP archive (local file header + central directory
// + end-of-central-directory record) containing one zero-length entry with
// the given name. This is genuinely valid ZIP structure — just with no file
// content — which is all lib/storage.js's central-directory reader needs to
// discover the entry name.
export function buildMinimalZip(entryName) {
  const nameBuf = Buffer.from(entryName, 'utf8');

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(0, 8); // compression method: stored
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(0, 14); // crc32
  localHeader.writeUInt32LE(0, 18); // compressed size
  localHeader.writeUInt32LE(0, 22); // uncompressed size
  localHeader.writeUInt16LE(nameBuf.length, 26); // filename length
  localHeader.writeUInt16LE(0, 28); // extra length
  const localEntry = Buffer.concat([localHeader, nameBuf]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt16LE(0, 8); // flags
  centralHeader.writeUInt16LE(0, 10); // compression method
  centralHeader.writeUInt16LE(0, 12); // mod time
  centralHeader.writeUInt16LE(0, 14); // mod date
  centralHeader.writeUInt32LE(0, 16); // crc32
  centralHeader.writeUInt32LE(0, 20); // compressed size
  centralHeader.writeUInt32LE(0, 24); // uncompressed size
  centralHeader.writeUInt16LE(nameBuf.length, 28); // filename length
  centralHeader.writeUInt16LE(0, 30); // extra length
  centralHeader.writeUInt16LE(0, 32); // comment length
  centralHeader.writeUInt16LE(0, 34); // disk number start
  centralHeader.writeUInt16LE(0, 36); // internal attrs
  centralHeader.writeUInt32LE(0, 38); // external attrs
  centralHeader.writeUInt32LE(0, 42); // local header offset (0: it's first)
  const centralDirectory = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralDirectory.length, 12); // central directory size
  eocd.writeUInt32LE(localEntry.length, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localEntry, centralDirectory, eocd]);
}
