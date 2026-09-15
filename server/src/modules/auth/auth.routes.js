import { ok, created } from '../../lib/response.js';
import { requireAuth } from '../../middleware/auth.js';
import * as authService from './auth.service.js';

export function registerAuthRoutes(router) {
  router.post('/api/auth/register', async (req, res) => {
    const result = await authService.register(req.body, req.ip);
    created(res, {
      message: 'Registration started. Check your email for a verification code.',
      email: result.email,
    });
  });

  router.post('/api/auth/verify-otp', async (req, res) => {
    const result = await authService.verifyOtp(req.body, req.ip);
    ok(res, result);
  });

  router.post('/api/auth/resend-otp', async (req, res) => {
    const result = await authService.resendOtp(req.body, req.ip);
    ok(res, result);
  });

  router.post('/api/auth/forgot-password', async (req, res) => {
    const result = await authService.requestPasswordReset(req.body, req.ip);
    ok(res, result);
  });

  router.post('/api/auth/reset-password', async (req, res) => {
    const result = await authService.resetPassword(req.body, req.ip);
    ok(res, result);
  });

  router.post('/api/auth/login', async (req, res) => {
    const result = await authService.login(req.body, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    ok(res, result);
  });

  router.post('/api/auth/logout', async (req, res) => {
    const header = req.headers['authorization'] || '';
    const [, token] = header.split(' ');
    if (token) await authService.logout(token);
    ok(res, { message: 'Logged out.' });
  });

  router.get('/api/auth/me', async (req, res) => {
    const user = await requireAuth(req);
    ok(res, { user });
  });
}
