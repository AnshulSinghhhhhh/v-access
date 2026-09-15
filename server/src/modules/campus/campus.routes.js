import { ok, created } from '../../lib/response.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import * as campusService from './campus.service.js';

export function registerCampusRoutes(router) {
  // --- Student-facing ----------------------------------------------------
  router.get('/api/campus/search', async (req, res) => {
    await requireAuth(req);
    const result = await campusService.search(req.query.q);
    ok(res, result);
  });

  router.get('/api/campus/blocks', async (req, res) => {
    await requireAuth(req);
    const blocks = await campusService.listBlocks();
    ok(res, { blocks });
  });

  router.get('/api/campus/blocks/:id/ranges', async (req, res) => {
    await requireAuth(req);
    const block = await campusService.getBlock(Number(req.params.id));
    const ranges = await campusService.listRangesForBlock(Number(req.params.id));
    ok(res, { block, ranges });
  });

  router.get('/api/campus/map-anchors', async (req, res) => {
    await requireAuth(req);
    const anchors = await campusService.listMapAnchors();
    ok(res, { anchors });
  });

  // --- Admin: zone management ---------------------------------------------
  router.post('/api/campus/blocks', async (req, res) => {
    const admin = await requireRole(req, 'admin');
    const result = await campusService.createBlock(admin.id, req.body);
    created(res, result);
  });

  router.patch('/api/campus/blocks/:id', async (req, res) => {
    const admin = await requireRole(req, 'admin');
    const result = await campusService.updateBlock(admin.id, Number(req.params.id), req.body);
    ok(res, result);
  });

  router.delete('/api/campus/blocks/:id', async (req, res) => {
    const admin = await requireRole(req, 'admin');
    await campusService.deleteBlock(admin.id, Number(req.params.id));
    ok(res, { message: 'Location removed.' });
  });

  // --- Admin: range management ---------------------------------------------
  router.post('/api/campus/ranges', async (req, res) => {
    const admin = await requireRole(req, 'admin');
    const result = await campusService.createRange(admin.id, req.body);
    created(res, result);
  });

  router.patch('/api/campus/ranges/:id', async (req, res) => {
    const admin = await requireRole(req, 'admin');
    const result = await campusService.updateRange(admin.id, Number(req.params.id), req.body);
    ok(res, result);
  });

  router.delete('/api/campus/ranges/:id', async (req, res) => {
    const admin = await requireRole(req, 'admin');
    await campusService.deleteRange(admin.id, Number(req.params.id));
    ok(res, { message: 'Range removed.' });
  });
}
