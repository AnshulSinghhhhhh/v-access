import { getDb } from '../../db/db.js';
import { ValidationError, requireString } from '../../lib/validate.js';
import { logAudit } from '../../lib/audit.js';
import { saveDocument, readDocument, deleteDocument, StorageError } from '../../lib/storage.js';
import { checkRateLimit, recordAttempt } from '../../lib/ratelimit.js';

function notFound(message) {
  const err = new ValidationError(message, 'id');
  err.status = 404;
  return err;
}

function decodeFileDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    throw new ValidationError('Invalid file data.', 'file');
  }
  const match = /^data:[\w/+.-]*;base64,([\s\S]+)$/.exec(dataUrl.trim());
  if (!match) {
    throw new ValidationError('File must be a base64 data URL.', 'file');
  }
  try {
    return Buffer.from(match[1], 'base64');
  } catch {
    throw new ValidationError('Could not decode file data.', 'file');
  }
}

export async function uploadNote(uploadedBy, { fileName, subject, facultyId, file }) {
  await checkRateLimit(String(uploadedBy), 'note_upload');
  await recordAttempt(String(uploadedBy), 'note_upload');

  const cleanFileName = requireString(fileName, 'fileName', { min: 1, max: 255 });
  const cleanSubject = requireString(subject, 'subject', { min: 1, max: 120 });

  let cleanFacultyId = null;
  if (facultyId !== undefined && facultyId !== null && facultyId !== '') {
    const db0 = await getDb();
    const faculty = await db0.prepare('SELECT id FROM faculty WHERE id = ?').get(Number(facultyId));
    if (!faculty) throw new ValidationError('Selected faculty member was not found.', 'facultyId');
    cleanFacultyId = faculty.id;
  }

  if (!file || !file.dataUrl) {
    throw new ValidationError('Attach a file to upload.', 'file');
  }
  const buffer = decodeFileDataUrl(file.dataUrl);

  let saved;
  try {
    // Real validation happens here — file bytes are inspected for their
    // actual structure (see lib/storage.js), never just the extension on
    // cleanFileName or any client-supplied MIME type.
    saved = saveDocument(buffer, cleanFileName);
  } catch (err) {
    if (err instanceof StorageError) throw new ValidationError(err.message, 'file');
    throw err;
  }

  const db = await getDb();
  const result = await db
    .prepare(
      `INSERT INTO notes (uploaded_by, file_name, subject, faculty_id, file_type, file_size, storage_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(uploadedBy, cleanFileName, cleanSubject, cleanFacultyId, saved.fileType, buffer.length, saved.storageRef);

  const noteId = Number(result.lastInsertRowid);
  await logAudit({ actorId: uploadedBy, action: 'note.upload', targetType: 'note', targetId: noteId });
  return { id: noteId, fileType: saved.fileType };
}

export async function listNotes({ search, subject, facultyId } = {}) {
  const db = await getDb();
  const clauses = [];
  const params = [];

  if (search) {
    clauses.push('LOWER(notes.file_name) LIKE ?');
    params.push(`%${search.toLowerCase()}%`);
  }
  if (subject) {
    clauses.push('LOWER(notes.subject) = ?');
    params.push(subject.toLowerCase());
  }
  if (facultyId) {
    clauses.push('notes.faculty_id = ?');
    params.push(Number(facultyId));
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db
    .prepare(
      `SELECT notes.*, users.full_name AS uploader_name, faculty.full_name AS faculty_name
       FROM notes
       JOIN users ON users.id = notes.uploaded_by
       LEFT JOIN faculty ON faculty.id = notes.faculty_id
       ${where}
       ORDER BY notes.created_at DESC
       LIMIT 200`
    )
    .all(...params);

  return rows.map(formatNote);
}

export async function listSubjects() {
  const db = await getDb();
  const rows = await db.prepare('SELECT DISTINCT subject FROM notes ORDER BY subject').all();
  return rows.map((r) => r.subject);
}

function formatNote(r) {
  return {
    id: r.id,
    fileName: r.file_name,
    subject: r.subject,
    facultyId: r.faculty_id,
    facultyName: r.faculty_name,
    uploadedBy: r.uploader_name,
    uploadedById: r.uploaded_by,
    fileType: r.file_type,
    fileSize: r.file_size,
    createdAt: r.created_at,
  };
}

// Auth (any verified VIT student) is enforced by requireAuth at the route
// level — REQ: "Only authenticated VIT students can download files."
export async function downloadNote(noteId) {
  const db = await getDb();
  const row = await db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
  if (!row) throw notFound('Note not found.');
  const file = readDocument(row.storage_ref);
  if (!file) throw notFound('The file is missing from storage.');
  return { buffer: file.buffer, mime: file.mime, fileName: row.file_name };
}

export async function deleteNote(actor, noteId) {
  const db = await getDb();
  const row = await db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
  if (!row) throw notFound('Note not found.');

  const isOwner = row.uploaded_by === actor.id;
  const isAdmin = actor.role === 'admin';
  if (!isOwner && !isAdmin) {
    const err = new ValidationError('You can only remove notes you uploaded.', 'id');
    err.status = 403;
    throw err;
  }

  await db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
  deleteDocument(row.storage_ref);
  await logAudit({ actorId: actor.id, action: 'note.remove', targetType: 'note', targetId: noteId });
}
