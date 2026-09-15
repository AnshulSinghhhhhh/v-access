import { ok } from '../lib/response.js';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../db/db.js';

export function registerDashboardRoutes(router) {
  router.get('/api/dashboard/summary', async (req, res) => {
    const user = await requireAuth(req);
    const db = await getDb();

    // Real counts from the schema (zero mocked data) — modules not yet
    // built in this stage simply report 0 until their tables have rows.
    const savedTimetables = (await db
      .prepare('SELECT COUNT(*) AS n FROM timetables WHERE student_id = ?')
      .get(user.id)).n;
    const notesUploaded = (await db
      .prepare('SELECT COUNT(*) AS n FROM notes WHERE uploaded_by = ?')
      .get(user.id)).n;
    const reviewsWritten = (await db
      .prepare('SELECT COUNT(*) AS n FROM reviews WHERE student_id = ?')
      .get(user.id)).n;

    // Top-rated faculty (approved reviews only), for a quick glance from
    // the dashboard without a trip to the full Faculty Review page.
    const topRatedFacultyRows = await db
      .prepare(
        `SELECT faculty.id, faculty.full_name, faculty.department,
                AVG(reviews.rating) AS avg_rating, COUNT(*) AS review_count
         FROM reviews
         JOIN faculty ON faculty.id = reviews.faculty_id
         WHERE reviews.status = 'approved'
         GROUP BY faculty.id
         ORDER BY avg_rating DESC, review_count DESC
         LIMIT 5`
      )
      .all();
    const topRatedFaculty = topRatedFacultyRows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      department: r.department,
      avgRating: Math.round(r.avg_rating * 10) / 10,
      reviewCount: Number(r.review_count),
    }));

    ok(res, {
      user,
      stats: { savedTimetables, notesUploaded, reviewsWritten },
      topRatedFaculty,
    });
  });
}
