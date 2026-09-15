import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildMinimalPdf, buildMinimalZip, buildOleContainer, buildRandomBytes } from './helpers/fixtures.js';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'vaccess-notes-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.STORAGE_LOCAL_DIR = path.join(tmpDir, 'uploads');
process.env.NODE_ENV = 'test';
// This file exercises many upload scenarios against the same actor —
// raised so upload-abuse rate limiting (tested separately in
// security.test.js) doesn't interfere with unrelated functional cases.
process.env.RATE_LIMIT_MAX_NOTE_UPLOAD = '100';

const { getDb, closeDb } = await import('../src/db/db.js');
const notesService = await import('../src/modules/notes/notes.service.js');

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const STUDENT_ID = 1;
const ADMIN_ID = 2;
let facultyId;

{
  const db = getDb();
  const studentRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('student').id;
  const adminRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('admin').id;
  db.prepare('INSERT INTO users (id, full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, ?, 1)')
    .run(STUDENT_ID, 'Student One', 's1@vitstudent.ac.in', 'x', studentRoleId);
  db.prepare('INSERT INTO users (id, full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, ?, 1)')
    .run(ADMIN_ID, 'The Admin', 'admin@vitstudent.ac.in', 'x', adminRoleId);
  const result = db
    .prepare('INSERT INTO faculty (full_name, department) VALUES (?, ?)')
    .run('Dr. Test Faculty', 'School of Computer Science');
  facultyId = Number(result.lastInsertRowid);
}

function dataUrl(buffer, mime = 'application/octet-stream') {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

test('uploading a real PDF succeeds and is correctly typed', () => {
  const result = notesService.uploadNote(STUDENT_ID, {
    fileName: 'unit3-notes.pdf',
    subject: 'Data Structures',
    facultyId,
    file: { dataUrl: dataUrl(buildMinimalPdf(), 'application/pdf') },
  });
  assert.equal(result.fileType, 'pdf');
});

test('uploading a real DOCX (detected via its ZIP entry names, not the extension) succeeds', () => {
  const zip = buildMinimalZip('word/document.xml');
  const result = notesService.uploadNote(STUDENT_ID, {
    fileName: 'assignment.docx',
    subject: 'Discrete Mathematics',
    file: { dataUrl: dataUrl(zip) },
  });
  assert.equal(result.fileType, 'docx');
});

test('uploading a real PPTX succeeds', () => {
  const zip = buildMinimalZip('ppt/presentation.xml');
  const result = notesService.uploadNote(STUDENT_ID, {
    fileName: 'lecture-slides.pptx',
    subject: 'Operating Systems',
    file: { dataUrl: dataUrl(zip) },
  });
  assert.equal(result.fileType, 'pptx');
});

test('a legacy OLE container disambiguates doc vs ppt using the filename, since the container bytes are identical', () => {
  const ole = buildOleContainer();
  const asDoc = notesService.uploadNote(STUDENT_ID, {
    fileName: 'old-notes.doc',
    subject: 'History',
    file: { dataUrl: dataUrl(ole) },
  });
  assert.equal(asDoc.fileType, 'doc');

  const asPpt = notesService.uploadNote(STUDENT_ID, {
    fileName: 'old-slides.ppt',
    subject: 'History',
    file: { dataUrl: dataUrl(ole) },
  });
  assert.equal(asPpt.fileType, 'ppt');
});

test('a ZIP file that is not a recognized Office document is rejected, even with a .docx name', () => {
  const zip = buildMinimalZip('random/file.txt');
  assert.throws(
    () =>
      notesService.uploadNote(STUDENT_ID, {
        fileName: 'sneaky.docx',
        subject: 'Test',
        file: { dataUrl: dataUrl(zip) },
      }),
    /unsupported or unrecognized file/i
  );
});

test('random bytes are rejected even when named and declared as a PDF', () => {
  const garbage = buildRandomBytes(128);
  assert.throws(
    () =>
      notesService.uploadNote(STUDENT_ID, {
        fileName: 'totally-a-pdf.pdf',
        subject: 'Test',
        file: { dataUrl: dataUrl(garbage, 'application/pdf') },
      }),
    /unsupported or unrecognized file/i
  );
});

test('an OLE container with an unrecognized extension is rejected rather than guessed at', () => {
  const ole = buildOleContainer();
  assert.throws(() =>
    notesService.uploadNote(STUDENT_ID, {
      fileName: 'mystery-file.xyz',
      subject: 'Test',
      file: { dataUrl: dataUrl(ole) },
    })
  );
});

test('upload rejects a nonexistent faculty id', () => {
  assert.throws(() =>
    notesService.uploadNote(STUDENT_ID, {
      fileName: 'notes.pdf',
      subject: 'Test',
      facultyId: 999999,
      file: { dataUrl: dataUrl(buildMinimalPdf(), 'application/pdf') },
    })
  );
});

test('upload rejects missing content for required fields', () => {
  assert.throws(() =>
    notesService.uploadNote(STUDENT_ID, { fileName: '', subject: 'Test', file: { dataUrl: dataUrl(buildMinimalPdf()) } })
  );
  assert.throws(() =>
    notesService.uploadNote(STUDENT_ID, { fileName: 'notes.pdf', subject: '', file: { dataUrl: dataUrl(buildMinimalPdf()) } })
  );
});

let noteId;

test('listNotes finds an uploaded note by filename search, subject filter, and faculty filter', () => {
  const result = notesService.uploadNote(STUDENT_ID, {
    fileName: 'unique-searchable-name.pdf',
    subject: 'Very Specific Subject',
    facultyId,
    file: { dataUrl: dataUrl(buildMinimalPdf(), 'application/pdf') },
  });
  noteId = result.id;

  const bySearch = notesService.listNotes({ search: 'unique-searchable' });
  assert.ok(bySearch.some((n) => n.id === noteId));

  const bySubject = notesService.listNotes({ subject: 'Very Specific Subject' });
  assert.ok(bySubject.some((n) => n.id === noteId));

  const byFaculty = notesService.listNotes({ facultyId });
  assert.ok(byFaculty.some((n) => n.id === noteId));

  const noMatch = notesService.listNotes({ search: 'nothing-matches-this-string' });
  assert.ok(!noMatch.some((n) => n.id === noteId));
});

test('listSubjects returns distinct subjects including the one just uploaded', () => {
  const subjects = notesService.listSubjects();
  assert.ok(subjects.includes('Very Specific Subject'));
});

test('downloadNote returns the exact original bytes and filename', () => {
  const original = buildMinimalPdf();
  const uploaded = notesService.uploadNote(STUDENT_ID, {
    fileName: 'roundtrip-test.pdf',
    subject: 'Test',
    file: { dataUrl: dataUrl(original, 'application/pdf') },
  });
  const downloaded = notesService.downloadNote(uploaded.id);
  assert.ok(downloaded.buffer.equals(original));
  assert.equal(downloaded.fileName, 'roundtrip-test.pdf');
  assert.equal(downloaded.mime, 'application/pdf');
});

test('downloadNote on a nonexistent note throws not-found', () => {
  assert.throws(() => notesService.downloadNote(999999), /not found/i);
});

test('deleteNote (admin) removes the note and its stored file; download then fails', () => {
  notesService.deleteNote({ id: ADMIN_ID, role: 'admin' }, noteId);
  assert.throws(() => notesService.downloadNote(noteId), /not found/i);
  const stillListed = notesService.listNotes({ search: 'unique-searchable' });
  assert.ok(!stillListed.some((n) => n.id === noteId));
});

test('deleteNote on a nonexistent note throws not-found', () => {
  assert.throws(() => notesService.deleteNote({ id: ADMIN_ID, role: 'admin' }, 999999), /not found/i);
});

test('deleteNote lets the uploader remove their own note even without admin role', () => {
  const upload = notesService.uploadNote(STUDENT_ID, {
    fileName: 'own-note.pdf',
    subject: 'Ownership Test',
    file: { dataUrl: dataUrl(buildMinimalPdf(), 'application/pdf') },
  });
  notesService.deleteNote({ id: STUDENT_ID, role: 'student' }, upload.id);
  assert.throws(() => notesService.downloadNote(upload.id), /not found/i);
});

test('deleteNote rejects a student who did not upload the note and is not an admin', () => {
  const OTHER_STUDENT_ID = 3;
  {
    const db = getDb();
    const studentRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('student').id;
    db.prepare('INSERT INTO users (id, full_name, email, password_hash, role_id, is_verified) VALUES (?, ?, ?, ?, ?, 1)')
      .run(OTHER_STUDENT_ID, 'Student Two', 's2@vitstudent.ac.in', 'x', studentRoleId);
  }
  const upload = notesService.uploadNote(STUDENT_ID, {
    fileName: 'not-yours.pdf',
    subject: 'Ownership Test',
    file: { dataUrl: dataUrl(buildMinimalPdf(), 'application/pdf') },
  });
  assert.throws(
    () => notesService.deleteNote({ id: OTHER_STUDENT_ID, role: 'student' }, upload.id),
    /only remove notes you uploaded/i
  );
});
