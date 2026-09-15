import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { env } from './config/env.js';
import { getDb, ensureDefaultAdmin } from './db/db.js';
import { Router, createApp } from './lib/router.js';
import { ok } from './lib/response.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { registerDashboardRoutes } from './modules/dashboard.routes.js';
import { registerCatalogRoutes } from './modules/catalog/catalog.routes.js';
import { registerTimetableRoutes } from './modules/timetable/timetable.routes.js';
import { registerFacultyRoutes } from './modules/faculty/faculty.routes.js';
import { registerSocialRoutes } from './modules/social/social.routes.js';
import { registerNotesRoutes } from './modules/notes/notes.routes.js';
import { registerAdminRoutes } from './modules/admin/admin.routes.js';
import { registerCampusRoutes } from './modules/campus/campus.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, '..', '..', 'web');

// Builds the real, fully-wired HTTP server — the exact same route
// registration main() uses in production — without starting it or calling
// process.exit on failure. Exported so tests can boot a real server on an
// ephemeral port and exercise it over actual HTTP, not just at the service
// layer. This is the single source of truth for "every route the app has";
// main() and the test suite both go through this.
export function buildServer() {
  const router = new Router();
  registerAuthRoutes(router);
  registerDashboardRoutes(router);
  registerCatalogRoutes(router);
  registerTimetableRoutes(router);
  registerFacultyRoutes(router);
  registerSocialRoutes(router);
  registerNotesRoutes(router);
  registerAdminRoutes(router);
  registerCampusRoutes(router);

  router.get('/api/health', async (req, res) => {
    ok(res, { status: 'up', env: env.nodeEnv });
  });

  return createApp({ router, staticDir });
}

async function main() {
  await getDb(); // opens the DB and runs schema.postgres.sql (idempotent) on boot
  await ensureDefaultAdmin();

  const server = buildServer();
  server.listen(env.port, () => {
    console.log(`V-ACCESS server listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  // Keep-alive ping for serverless Postgres providers (e.g. Neon)
  setInterval(async () => {
    try {
      const db = await getDb();
      await db.prepare('SELECT 1').get();
    } catch {}
  }, 90 * 1000).unref();
}

process.on('uncaughtException', (err) => {
  if (err?.code === '57P01' || err?.message?.includes('Connection terminated') || err?.message?.includes('terminating connection')) {
    console.warn('Postgres connection reset, server continuing...');
    return;
  }
  console.error('Fatal unhandled error:', err);
  process.exit(1);
});

// Only auto-start when run directly (`node app.js`), not when imported by
// the test suite via buildServer(). pathToFileURL correctly handles
// Windows paths (backslashes, drive letters) and special characters like
// spaces in the folder name — a plain `'file://' + process.argv[1]` string
// concatenation does NOT: Windows paths use backslashes while
// import.meta.url always uses forward slashes, so that comparison silently
// fails on every Windows machine, main() never runs, and the process just
// exits immediately with no error and no server.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
