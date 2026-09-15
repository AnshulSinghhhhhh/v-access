import { ok, created } from '../../lib/response.js';
import { requireAuth } from '../../middleware/auth.js';
import * as timetableService from './timetable.service.js';

export function registerTimetableRoutes(router) {
  router.post('/api/timetable/generate', async (req, res) => {
    await requireAuth(req);
    const result = await timetableService.generateTimetables(req.body);
    ok(res, result);
  });

  router.post('/api/timetable', async (req, res) => {
    const user = await requireAuth(req);
    const result = await timetableService.saveTimetable(user.id, req.body);
    created(res, result);
  });

  router.get('/api/timetable', async (req, res) => {
    const user = await requireAuth(req);
    const timetables = await timetableService.listSavedTimetables(user.id);
    ok(res, { timetables });
  });

  router.get('/api/timetable/:id', async (req, res) => {
    const user = await requireAuth(req);
    const timetable = await timetableService.getSavedTimetable(user.id, Number(req.params.id));
    ok(res, { timetable });
  });

  router.patch('/api/timetable/:id', async (req, res) => {
    const user = await requireAuth(req);
    const timetable = await timetableService.updateTimetable(user.id, Number(req.params.id), req.body);
    ok(res, { timetable });
  });

  router.delete('/api/timetable/:id', async (req, res) => {
    const user = await requireAuth(req);
    await timetableService.deleteTimetable(user.id, Number(req.params.id));
    ok(res, { message: 'Timetable deleted.' });
  });
}
