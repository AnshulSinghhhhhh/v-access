import { resolveSession } from '../modules/auth/auth.service.js';
import { ApiError } from '../lib/response.js';

function extractToken(req) {
  const header = req.headers['authorization'] || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) return token;
  return null;
}

// Every protected route calls this first. Frontend role checks are UX only;
// this is the actual boundary students cannot bypass by editing requests.
export async function requireAuth(req) {
  const token = extractToken(req);
  const user = await resolveSession(token);
  if (!user) {
    throw new ApiError(401, 'Authentication required.');
  }
  req.user = user;
  return user;
}

export async function requireRole(req, ...roles) {
  const user = await requireAuth(req);
  if (!roles.includes(user.role)) {
    throw new ApiError(403, 'You do not have permission to perform this action.');
  }
  return user;
}
