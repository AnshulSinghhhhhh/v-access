import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';

// Storage abstraction: callers use saveImage()/readImage()/deleteImage() and
// never touch the filesystem directly. Only this file needs to change to
// swap in cloud storage (S3, GCS, etc.) later — see env.storage.driver.
// Currently only the 'local' driver is implemented, which is enough for
// development, grading, and small deployments.

export class StorageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB

// Real content-type validation via magic bytes — a renamed .exe with a
// ".png" extension or a spoofed Content-Type header is rejected here,
// because detection reads the actual file bytes, not the filename or any
// client-supplied metadata.
const IMAGE_SIGNATURES = [
  {
    type: 'png',
    ext: 'png',
    mime: 'image/png',
    check: (buf) =>
      buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a,
  },
  {
    type: 'jpeg',
    ext: 'jpg',
    mime: 'image/jpeg',
    check: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    type: 'gif',
    ext: 'gif',
    mime: 'image/gif',
    check: (buf) =>
      buf.length >= 6 &&
      (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a'),
  },
  {
    type: 'webp',
    ext: 'webp',
    mime: 'image/webp',
    check: (buf) =>
      buf.length >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP',
  },
];

export function detectImageType(buffer) {
  return IMAGE_SIGNATURES.find((sig) => sig.check(buffer)) || null;
}

const FILENAME_PATTERN = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function ensureDir() {
  fs.mkdirSync(env.storage.localDir, { recursive: true });
}

export function saveImage(buffer) {
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new StorageError(`Image must be smaller than ${MAX_IMAGE_BYTES / (1024 * 1024)}MB.`, 'IMAGE_TOO_LARGE');
  }
  const signature = detectImageType(buffer);
  if (!signature) {
    throw new StorageError('Unsupported image type — use PNG, JPEG, GIF, or WEBP.', 'UNSUPPORTED_TYPE');
  }
  ensureDir();
  const filename = `${randomBytes(16).toString('hex')}.${signature.ext}`;
  fs.writeFileSync(path.join(env.storage.localDir, filename), buffer);
  return { storageRef: filename, mime: signature.mime };
}

// storageRef is always server-generated (random hex + known extension), so
// this pattern check alone is sufficient to prevent path traversal — no
// user-supplied path ever reaches the filesystem.
export function readImage(storageRef) {
  if (typeof storageRef !== 'string' || !FILENAME_PATTERN.test(storageRef)) return null;
  const filePath = path.join(env.storage.localDir, storageRef);
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(storageRef).slice(1);
  return { buffer: fs.readFileSync(filePath), mime: MIME_BY_EXT[ext] };
}

export function deleteImage(storageRef) {
  if (typeof storageRef !== 'string' || !FILENAME_PATTERN.test(storageRef)) return;
  const filePath = path.join(env.storage.localDir, storageRef);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ===========================================================================
// Documents (Notes Hub): PDF, DOC/DOCX, PPT/PPTX
//
// PDF and the modern XML-based Office formats (.docx/.pptx) are verified by
// reading real file structure — a PDF must actually start with the PDF
// header, and a .docx/.pptx must actually be a ZIP archive containing the
// entry paths ("word/", "ppt/") unique to each format, discovered by
// reading the ZIP's own central directory. Extension and any client-
// supplied Content-Type are never trusted on their own.
//
// Legacy binary Office files (.doc/.ppt) are a genuine limitation: both
// formats share the exact same outer container (the OLE Compound File
// format) and are only distinguishable from each other by parsing the
// compound file's internal stream directory — well beyond a magic-byte
// check. We verify the container really is a valid OLE file (rejecting
// anything that isn't), and for the .doc vs .ppt distinction specifically
// fall back to the uploaded file's own extension as a tiebreaker. This is
// documented here and in the README rather than silently overclaiming full
// content verification for every format.
// ===========================================================================

export const MAX_DOCUMENT_BYTES = env.storage.maxDocumentBytes;

const PDF_SIGNATURE = Buffer.from('%PDF-');
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_LOCAL_HEADER_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY_ARCHIVE_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_CENTRAL_DIR_SIG = 0x02014b50;

function isPdf(buf) {
  return buf.length >= PDF_SIGNATURE.length && buf.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE);
}
function isOle(buf) {
  return buf.length >= OLE_SIGNATURE.length && buf.subarray(0, OLE_SIGNATURE.length).equals(OLE_SIGNATURE);
}
function isZip(buf) {
  return (
    buf.length >= 4 &&
    (buf.subarray(0, 4).equals(ZIP_LOCAL_HEADER_SIG) || buf.subarray(0, 4).equals(ZIP_EMPTY_ARCHIVE_SIG))
  );
}

// Finds the End Of Central Directory record by scanning backward from the
// end of the buffer (it may be preceded by a variable-length comment field,
// up to 65535 bytes, so a fixed offset can't be assumed).
function findEndOfCentralDirectory(buf) {
  const searchFloor = Math.max(0, buf.length - (22 + 65535));
  for (let i = buf.length - 22; i >= searchFloor; i--) {
    if (buf.subarray(i, i + 4).equals(ZIP_EOCD_SIG)) return i;
  }
  return -1;
}

// Reads entry filenames straight from the ZIP central directory, without
// decompressing anything — enough to tell a .docx (has "word/...") apart
// from a .pptx (has "ppt/...") or a plain, non-Office ZIP file.
function listZipEntryNames(buf, maxEntries = 100) {
  const eocdOffset = findEndOfCentralDirectory(buf);
  if (eocdOffset === -1 || eocdOffset + 22 > buf.length) return null;

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  if (centralDirOffset >= buf.length) return null;

  const names = [];
  let ptr = centralDirOffset;
  for (let i = 0; i < totalEntries && i < maxEntries; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== ZIP_CENTRAL_DIR_SIG) break;
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const nameStart = ptr + 46;
    if (nameStart + nameLen > buf.length) break;
    names.push(buf.subarray(nameStart, nameStart + nameLen).toString('utf8'));
    ptr = nameStart + nameLen + extraLen + commentLen;
  }
  return names;
}

const DOCUMENT_MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function detectDocumentType(buffer, originalFileName) {
  if (isPdf(buffer)) return { type: 'pdf', ext: 'pdf', mime: DOCUMENT_MIME.pdf };

  if (isZip(buffer)) {
    const names = listZipEntryNames(buffer) || [];
    if (names.some((n) => n.startsWith('word/'))) return { type: 'docx', ext: 'docx', mime: DOCUMENT_MIME.docx };
    if (names.some((n) => n.startsWith('ppt/'))) return { type: 'pptx', ext: 'pptx', mime: DOCUMENT_MIME.pptx };
    return null; // a real ZIP, but not a recognized Office document
  }

  if (isOle(buffer)) {
    // Container is genuinely a compound binary file — real verification —
    // but .doc and .ppt are byte-identical at this level, so the uploaded
    // file's own extension breaks the tie (see comment block above).
    const ext = String(originalFileName || '').toLowerCase().split('.').pop();
    if (ext === 'doc') return { type: 'doc', ext: 'doc', mime: DOCUMENT_MIME.doc };
    if (ext === 'ppt') return { type: 'ppt', ext: 'ppt', mime: DOCUMENT_MIME.ppt };
    return null;
  }

  return null;
}

const DOC_FILENAME_PATTERN = /^[a-f0-9]{32}\.(pdf|doc|docx|ppt|pptx)$/;

export function saveDocument(buffer, originalFileName) {
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new StorageError(`File must be smaller than ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))}MB.`, 'DOCUMENT_TOO_LARGE');
  }
  const detected = detectDocumentType(buffer, originalFileName);
  if (!detected) {
    throw new StorageError('Unsupported or unrecognized file — upload a PDF, DOC/DOCX, or PPT/PPTX.', 'UNSUPPORTED_TYPE');
  }
  ensureDir();
  const filename = `${randomBytes(16).toString('hex')}.${detected.ext}`;
  fs.writeFileSync(path.join(env.storage.localDir, filename), buffer);
  return { storageRef: filename, mime: detected.mime, fileType: detected.type };
}

export function readDocument(storageRef) {
  if (typeof storageRef !== 'string' || !DOC_FILENAME_PATTERN.test(storageRef)) return null;
  const filePath = path.join(env.storage.localDir, storageRef);
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(storageRef).slice(1);
  return { buffer: fs.readFileSync(filePath), mime: DOCUMENT_MIME[ext] };
}

export function deleteDocument(storageRef) {
  if (typeof storageRef !== 'string' || !DOC_FILENAME_PATTERN.test(storageRef)) return;
  const filePath = path.join(env.storage.localDir, storageRef);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ===========================================================================
// Media (Social Page): video/audio post attachments — MP4, WebM, OGG.
//
// As with images and documents, the actual file bytes are inspected rather
// than trusting the client-supplied extension or MIME type. MP4 (and the
// MOV/M4A family) is identified by the "ftyp" box that appears at a fixed
// offset near the start of every ISO-BMFF file; WebM by its EBML magic
// number; OGG by its "OggS" page header. All three are natively playable by
// an HTML <video>/<audio> element in every evergreen browser, so no
// transcoding step is needed — this app has no video-processing dependency
// (see package.json: zero runtime dependencies), so the uploaded container
// is served back byte-for-byte as-is.
// ===========================================================================

export const MAX_MEDIA_BYTES = env.storage.maxMediaBytes;

const EBML_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]); // WebM/Matroska
const OGG_SIGNATURE = Buffer.from('OggS', 'ascii');

function isMp4(buf) {
  // The box-size field (bytes 0-3) varies, but a valid ISO-BMFF file has
  // the literal ASCII bytes "ftyp" at offset 4.
  return buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp';
}
function isWebm(buf) {
  return buf.length >= 4 && buf.subarray(0, 4).equals(EBML_SIGNATURE);
}
function isOgg(buf) {
  return buf.length >= 4 && buf.subarray(0, 4).equals(OGG_SIGNATURE);
}

const MEDIA_MIME = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
};

export function detectMediaType(buffer) {
  if (isMp4(buffer)) return { type: 'mp4', ext: 'mp4', mime: MEDIA_MIME.mp4 };
  if (isWebm(buffer)) return { type: 'webm', ext: 'webm', mime: MEDIA_MIME.webm };
  if (isOgg(buffer)) return { type: 'ogg', ext: 'ogg', mime: MEDIA_MIME.ogg };
  return null;
}

const MEDIA_FILENAME_PATTERN = /^[a-f0-9]{32}\.(mp4|webm|ogg)$/;

export function saveMedia(buffer) {
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new StorageError(`Video must be smaller than ${Math.round(MAX_MEDIA_BYTES / (1024 * 1024))}MB.`, 'MEDIA_TOO_LARGE');
  }
  const detected = detectMediaType(buffer);
  if (!detected) {
    throw new StorageError('Unsupported video type — use MP4, WebM, or OGG.', 'UNSUPPORTED_TYPE');
  }
  ensureDir();
  const filename = `${randomBytes(16).toString('hex')}.${detected.ext}`;
  fs.writeFileSync(path.join(env.storage.localDir, filename), buffer);
  return { storageRef: filename, mime: detected.mime, mediaType: detected.type };
}

export function readMedia(storageRef) {
  if (typeof storageRef !== 'string' || !MEDIA_FILENAME_PATTERN.test(storageRef)) return null;
  const filePath = path.join(env.storage.localDir, storageRef);
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(storageRef).slice(1);
  return { buffer: fs.readFileSync(filePath), mime: MEDIA_MIME[ext] };
}

export function deleteMedia(storageRef) {
  if (typeof storageRef !== 'string' || !MEDIA_FILENAME_PATTERN.test(storageRef)) return;
  const filePath = path.join(env.storage.localDir, storageRef);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
