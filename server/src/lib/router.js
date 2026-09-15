import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { sendJson } from './response.js';
import { ValidationError } from './validate.js';
import { RateLimitError } from './ratelimit.js';
import { env } from '../config/env.js';

const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25MB — accommodates a base64-encoded document upload up to Notes Hub's configured limit (default 15MB decoded)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export class Router {
  constructor() {
    this.routes = []; // { method, pattern, keys, handler }
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern
          .split('/')
          .map((segment) => {
            if (segment.startsWith(':')) {
              keys.push(segment.slice(1));
              return '([^/]+)';
            }
            return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '$'
    );
    this.routes.push({ method, regex, keys, handler });
  }

  get(pattern, handler) { this.add('GET', pattern, handler); }
  post(pattern, handler) { this.add('POST', pattern, handler); }
  patch(pattern, handler) { this.add('PATCH', pattern, handler); }
  put(pattern, handler) { this.add('PUT', pattern, handler); }
  delete(pattern, handler) { this.add('DELETE', pattern, handler); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.keys.forEach((key, i) => (params[key] = decodeURIComponent(m[i + 1])));
      return { handler: route.handler, params };
    }
    return null;
  }
}

async function readJsonBody(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json')) return {};

  const chunks = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      // Once over the cap, stop keeping the bytes (memory stays bounded)
      // but keep pulling from the stream instead of throwing right away.
      // Throwing here would end the for-await loop, which destroys the
      // request stream while the client may still be mid-upload — the
      // server hanging up on a socket the client is actively writing to
      // causes the client's own request to fail with a connection reset
      // instead of cleanly receiving the 413 (reliably reproducible on
      // Windows). Draining to the end first means the client always
      // finishes its upload and gets a clean response.
      oversized = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (oversized) {
    const err = new Error('Request body too large.');
    err.status = 413;
    throw err;
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('Malformed JSON body.');
    err.status = 400;
    throw err;
  }
}

function applySecurityHeaders(res) {
  // Baseline secure headers (HTTPS-ready, XSS/clickjacking hardening).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    // frame-src allows embedding ONE specific, narrowly-scoped external
    // page: OpenStreetMap's own map embed, for the live campus map (Find
    // My Class). This is a much lower-risk grant than adding to script-src
    // would be — an iframe runs in its own browsing context and cannot
    // read this page's DOM, cookies, or sessionStorage (the bearer token
    // included) per the browser's same-origin policy; a script-src
    // addition would instead let that origin's code execute directly
    // inside this page. frame-ancestors below still stops any other site
    // from embedding V-ACCESS itself — this directive only concerns what
    // V-ACCESS chooses to embed.
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src https://www.openstreetmap.org; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  // Explicitly deny access to browser features this app never uses. Belt
  // and suspenders alongside frame-ancestors/X-Frame-Options — nothing
  // here needs a camera, microphone, or the user's location.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

export function createApp({ router, staticDir, apiPrefix = '/api' }) {
  return createServer(async (req, res) => {
    applySecurityHeaders(res);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS: the frontend is served from this same origin, so cross-origin
    // requests are not part of the normal flow. Rather than reflecting
    // whatever Origin header the caller sends (which, combined with
    // Allow-Credentials, is a well-known permissive-CORS misconfiguration —
    // it lets any website's JS read API responses), only the configured
    // WEB_ORIGIN is ever allowed, and Allow-Credentials is not sent at all
    // since auth here is a bearer token the browser never attaches
    // automatically — there's no ambient credential for CORS to protect.
    if (req.headers.origin === env.webOrigin) {
      res.setHeader('Access-Control-Allow-Origin', env.webOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (pathname.startsWith(apiPrefix)) {
      const match = router.match(req.method, pathname);
      if (!match) return sendJson(res, 404, { ok: false, error: 'Not found.' });

      try {
        req.ip = clientIp(req);
        req.query = Object.fromEntries(url.searchParams);
        req.params = match.params;
        req.body = ['POST', 'PATCH', 'PUT'].includes(req.method)
          ? await readJsonBody(req)
          : {};
        await match.handler(req, res);
      } catch (err) {
        // If we bailed out of reading the body early (e.g. the oversized-
        // body check in readJsonBody throws before the client has finished
        // sending), req.complete is still false — there are unsent bytes
        // the client believes this socket still wants. Keeping the
        // connection alive for reuse in that state means the next request
        // on this same keep-alive socket can race a RST from those
        // leftover bytes and fail with ECONNRESET. Telling the client to
        // close ensures a fresh connection is opened for whatever request
        // comes next, instead of reusing a socket that's already broken.
        if (req.complete === false) {
          res.setHeader('Connection', 'close');
        }
        handleError(err, res);
      }
      return;
    }

    // Static frontend files.
    return serveStatic(req, res, pathname, staticDir);
  });
}

function handleError(err, res) {
  if (err instanceof ValidationError) {
    return sendJson(res, err.status, { ok: false, error: err.message, field: err.field });
  }
  if (err instanceof RateLimitError) {
    return sendJson(res, err.status, { ok: false, error: err.message });
  }
  if (err && typeof err.status === 'number') {
    return sendJson(res, err.status, { ok: false, error: err.message });
  }
  // Never leak internal stack traces or DB details to the client (requirement 15).
  console.error('[unhandled error]', err);
  return sendJson(res, 500, { ok: false, error: 'Something went wrong. Please try again.' });
}

const NO_CACHE_EXTENSIONS = new Set(['.html', '.js', '.css']);

async function serveStatic(req, res, pathname, staticDir) {
  let relPath = pathname === '/' ? '/index.html' : pathname;
  let filePath = path.join(staticDir, relPath);

  // Prevent path traversal outside the static directory.
  if (!filePath.startsWith(staticDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = path.join(staticDir, '404.html');
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(404);
    return res.end(await readFile(filePath));
  }

  const ext = path.extname(filePath);
  const body = await readFile(filePath);
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  // HTML/JS/CSS must always be revalidated, never served stale from the
  // browser's own cache — with no Cache-Control at all (the previous
  // behavior), browsers apply their own heuristic caching and can keep
  // serving an old cached JS file indefinitely across page loads, which
  // silently breaks pages when a newer file expects something the stale
  // cached one doesn't have. Images are fine to cache normally since they
  // don't change between deploys the way app code does.
  headers['Cache-Control'] = NO_CACHE_EXTENSIONS.has(ext) ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, headers);
  res.end(body);
}
