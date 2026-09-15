import { ok, created } from '../../lib/response.js';
import { requireAuth } from '../../middleware/auth.js';
import * as notesService from './notes.service.js';

function sanitizeForHeader(str) {
  return String(str).replace(/[\r\n"]/g, '');
}

export function registerNotesRoutes(router) {
  router.get('/api/notes', async (req, res) => {
    await requireAuth(req);
    const notes = await notesService.listNotes({
      search: req.query.search,
      subject: req.query.subject,
      facultyId: req.query.facultyId,
    });
    ok(res, { notes });
  });

  router.get('/api/notes/subjects', async (req, res) => {
    await requireAuth(req);
    const subjects = await notesService.listSubjects();
    ok(res, { subjects });
  });

  router.post('/api/notes', async (req, res) => {
    const user = await requireAuth(req);
    const result = await notesService.uploadNote(user.id, req.body);
    created(res, result);
  });

  router.get('/api/notes/:id/download', async (req, res) => {
    await requireAuth(req);
    const file = await notesService.downloadNote(Number(req.params.id));
    const safeName = sanitizeForHeader(file.fileName);
    res.writeHead(200, {
      'Content-Type': file.mime,
      'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      'Content-Length': file.buffer.length,
    });
    res.end(file.buffer);
  });

  router.delete('/api/notes/:id', async (req, res) => {
    const user = await requireAuth(req);
    await notesService.deleteNote(user, Number(req.params.id));
    ok(res, { message: 'Note removed.' });
  });
}
