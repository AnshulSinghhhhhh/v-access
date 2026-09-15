import { ok, created } from '../../lib/response.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import * as facultyService from './faculty.service.js';

export function registerFacultyRoutes(router) {
  // --- Student-facing reads --------------------------------------------
  router.get('/api/faculty', async (req, res) => {
    await requireAuth(req);
    const faculty = await facultyService.listFaculty({ search: req.query.search });
    ok(res, { faculty });
  });

  router.get('/api/faculty/:id', async (req, res) => {
    await requireAuth(req);
    const faculty = await facultyService.getFacultyDetail(Number(req.params.id));
    ok(res, { faculty });
  });

  router.get('/api/faculty/:id/my-review', async (req, res) => {
    const user = await requireAuth(req);
    const review = await facultyService.getMyReviewForFaculty(user.id, Number(req.params.id));
    ok(res, { review });
  });

  // --- Student: submit a review ----------------------------------------
  router.post('/api/faculty/:id/reviews', async (req, res) => {
    const user = await requireAuth(req);
    const result = await facultyService.submitReview(user.id, Number(req.params.id), req.body);
    created(res, result);
  });

  // --- Admin: faculty management ----------------------------------------
  // --- Add faculty: any authenticated student, subject to rate limiting
  // and duplicate checks in the service layer. Editing/removing a faculty
  // record stays admin-only below.
  router.post('/api/faculty', async (req, res) => {
    const user = await requireAuth(req);
    const result = await facultyService.createFaculty(user.id, req.body);
    created(res, result);
  });

  router.patch('/api/faculty/:id', async (req, res) => {
    await requireRole(req, 'admin');
    const result = await facultyService.updateFaculty(Number(req.params.id), req.body);
    ok(res, result);
  });

  router.delete('/api/faculty/:id', async (req, res) => {
    await requireRole(req, 'admin');
    await facultyService.deleteFaculty(Number(req.params.id));
    ok(res, { message: 'Faculty member deleted.' });
  });

  // --- Admin: review moderation ------------------------------------------
  router.get('/api/faculty-reviews/pending', async (req, res) => {
    await requireRole(req, 'admin');
    const reviews = await facultyService.listPendingReviews();
    ok(res, { reviews });
  });

  router.patch('/api/faculty-reviews/:reviewId', async (req, res) => {
    const admin = await requireRole(req, 'admin');
    const result = await facultyService.moderateReview(admin.id, Number(req.params.reviewId), req.body.status);
    ok(res, result);
  });

  router.delete('/api/faculty-reviews/:reviewId', async (req, res) => {
    const admin = await requireRole(req, 'admin');
    await facultyService.removeReview(admin.id, Number(req.params.reviewId));
    ok(res, { message: 'Review removed.' });
  });
}
