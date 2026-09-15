import { ok } from '../../lib/response.js';
import { requireRole } from '../../middleware/auth.js';
import * as adminService from './admin.service.js';

export function registerAdminRoutes(router) {
  router.get('/api/admin/stats', async (req, res) => {
    await requireRole(req, 'admin');
    ok(res, { stats: await adminService.getStats() });
  });

  router.get('/api/admin/users', async (req, res) => {
    await requireRole(req, 'admin');
    const users = await adminService.listUsers({ search: req.query.search, role: req.query.role });
    ok(res, { users });
  });

  router.patch('/api/admin/users/:id', async (req, res) => {
    const admin = await requireRole(req, 'admin');
    const user = await adminService.updateUser(admin.id, Number(req.params.id), req.body);
    ok(res, { user });
  });

  router.get('/api/admin/audit-logs', async (req, res) => {
    await requireRole(req, 'admin');
    const result = await adminService.listAuditLogs({ before: req.query.before, limit: req.query.limit });
    ok(res, result);
  });
}
