import { ok, created } from '../../lib/response.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import * as socialService from './social.service.js';
import { readImage, readMedia } from '../../lib/storage.js';

export function registerSocialRoutes(router) {
  // --- Feed & posts -------------------------------------------------------
  router.get('/api/social/posts', async (req, res) => {
    const user = await requireAuth(req);
    const result = await socialService.listFeed(user.id, { before: req.query.before, limit: req.query.limit });
    ok(res, result);
  });

  router.post('/api/social/posts', async (req, res) => {
    const user = await requireAuth(req);
    const result = await socialService.createPost(user.id, req.body);
    created(res, result);
  });

  // Author can delete their own post; an admin can delete any post
  // (moderation). Ownership vs. admin is enforced in the service layer.
  router.delete('/api/social/posts/:id', async (req, res) => {
    const user = await requireAuth(req);
    await socialService.removePost(user, Number(req.params.id));
    ok(res, { message: 'Post removed.' });
  });

  // Requires auth like every other protected resource; the frontend fetches
  // this with an Authorization header and renders it via a blob URL, since a
  // plain <img src="..."> cannot carry a bearer token.
  router.get('/api/social/images/:ref', async (req, res) => {
    await requireAuth(req);
    const file = readImage(req.params.ref);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': file.mime, 'Cache-Control': 'private, max-age=86400' });
    res.end(file.buffer);
  });

  // Same auth-then-blob-URL pattern as images, for video/audio attachments.
  router.get('/api/social/media/:ref', async (req, res) => {
    await requireAuth(req);
    const file = readMedia(req.params.ref);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': file.mime, 'Cache-Control': 'private, max-age=86400' });
    res.end(file.buffer);
  });

  // --- Likes ----------------------------------------------------------
  router.post('/api/social/posts/:id/like', async (req, res) => {
    const user = await requireAuth(req);
    const result = await socialService.likePost(user.id, Number(req.params.id));
    ok(res, result);
  });

  router.delete('/api/social/posts/:id/like', async (req, res) => {
    const user = await requireAuth(req);
    const result = await socialService.unlikePost(user.id, Number(req.params.id));
    ok(res, result);
  });

  // --- Comments -------------------------------------------------------
  router.get('/api/social/posts/:id/comments', async (req, res) => {
    await requireAuth(req);
    const comments = await socialService.listComments(Number(req.params.id));
    ok(res, { comments });
  });

  router.post('/api/social/posts/:id/comments', async (req, res) => {
    const user = await requireAuth(req);
    const result = await socialService.addComment(user.id, Number(req.params.id), req.body);
    created(res, result);
  });

  // --- Reporting --------------------------------------------------------
  router.post('/api/social/posts/:id/report', async (req, res) => {
    const user = await requireAuth(req);
    const result = await socialService.reportPost(user.id, Number(req.params.id), req.body);
    created(res, result);
  });

  // --- Admin moderation ---------------------------------------------------
  router.get('/api/social/reports', async (req, res) => {
    await requireRole(req, 'admin');
    const reports = await socialService.listPendingReports();
    ok(res, { reports });
  });

  router.patch('/api/social/reports/:id', async (req, res) => {
    const admin = await requireRole(req, 'admin');
    const result = await socialService.moderateReport(admin.id, Number(req.params.id), req.body.status);
    ok(res, result);
  });
}
