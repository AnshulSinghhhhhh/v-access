import { ok } from '../../lib/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { listCourses } from './catalog.service.js';

export function registerCatalogRoutes(router) {
  router.get('/api/courses', async (req, res) => {
    await requireAuth(req);
    const courses = await listCourses({ search: req.query.search });
    ok(res, { courses });
  });
}
