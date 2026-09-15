-- V-ACCESS Database Schema
-- SQLite (node:sqlite). Normalized, with PKs, FKs, UNIQUE constraints, CHECKs, and indexes.
-- Every module's tables are defined here in Stage 1 even though most modules
-- are implemented in later stages, so the schema matches SRS Section 10 in full.

-- ---------------------------------------------------------------------------
-- Roles & Users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE CHECK (name IN ('student', 'admin'))
);

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  full_name      TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role_id        INTEGER NOT NULL REFERENCES roles(id),
  is_verified    INTEGER NOT NULL DEFAULT 0 CHECK (is_verified IN (0, 1)),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  created_at     TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at     TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);

-- One-time codes for registration verification / password reset.
CREATE TABLE IF NOT EXISTS email_verifications (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('register', 'password_reset')),
  otp_hash    TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id, purpose);

-- Server-side sessions. Only a hash of the bearer token is stored, so a DB
-- leak alone does not yield working session tokens.
CREATE TABLE IF NOT EXISTS sessions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  user_agent  TEXT,
  ip_address  TEXT,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
-- No separate index on token_hash: it already has UNIQUE above, which
-- SQLite backs with its own index — a second one here would just be
-- redundant maintenance overhead on every session insert/delete.

-- Login/auth attempt log, keyed by email+ip, for rate limiting.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id          SERIAL PRIMARY KEY,
  identifier  TEXT NOT NULL, -- email or ip
  kind        TEXT NOT NULL, -- 'login' | 'register' | 'otp'
  created_at  TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_lookup ON auth_attempts(identifier, kind, created_at);

-- ---------------------------------------------------------------------------
-- Faculty & Reviews (Stage 4)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faculty (
  id           SERIAL PRIMARY KEY,
  full_name    TEXT NOT NULL,
  department   TEXT NOT NULL,
  designation  TEXT,
  email        TEXT,
  bio          TEXT,
  created_at   TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_faculty_department ON faculty(department);
CREATE INDEX IF NOT EXISTS idx_faculty_name ON faculty(full_name);

CREATE TABLE IF NOT EXISTS reviews (
  id           SERIAL PRIMARY KEY,
  faculty_id   INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text  TEXT,
  is_anonymous INTEGER NOT NULL DEFAULT 0 CHECK (is_anonymous IN (0, 1)),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  UNIQUE (faculty_id, student_id) -- REQ-12: one review per student per faculty
);
CREATE INDEX IF NOT EXISTS idx_reviews_faculty ON reviews(faculty_id, status);

-- ---------------------------------------------------------------------------
-- Courses, Slots, Timetables (Stage 3)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS courses (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  credits    INTEGER NOT NULL DEFAULT 0,
  faculty_id INTEGER REFERENCES faculty(id)
);

CREATE TABLE IF NOT EXISTS course_slots (
  id           SERIAL PRIMARY KEY,
  course_id    INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  slot_code    TEXT NOT NULL,
  day_of_week  INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_time   TEXT NOT NULL, -- 'HH:MM' 24h
  end_time     TEXT NOT NULL,
  venue        TEXT
);
CREATE INDEX IF NOT EXISTS idx_course_slots_course ON course_slots(course_id);

CREATE TABLE IF NOT EXISTS timetables (
  id         SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_timetables_student ON timetables(student_id);

CREATE TABLE IF NOT EXISTS timetable_entries (
  id           SERIAL PRIMARY KEY,
  timetable_id INTEGER NOT NULL REFERENCES timetables(id) ON DELETE CASCADE,
  course_id    INTEGER NOT NULL REFERENCES courses(id),
  slot_id      INTEGER NOT NULL REFERENCES course_slots(id)
);
CREATE INDEX IF NOT EXISTS idx_timetable_entries_tt ON timetable_entries(timetable_id);

-- ---------------------------------------------------------------------------
-- Campus Locations (Stage 5)
--
-- Real VIT-PRP data showed each named zone (block) has one contiguous room
-- range per floor (e.g. Block A, floor 2 = rooms 241-253), rather than
-- individually numbered rooms with no derivable pattern. So the model here
-- is zone + per-floor ranges, not one row per room — this is what makes
-- "PRP 230" resolvable by parsing (floor 2, room 30) and a range lookup,
-- with a human-written directions text per zone+floor rather than per room.
--
-- latitude/longitude are nullable and, honestly, mostly unpopulated: GPS
-- can't distinguish between blocks 50-100m apart within one building
-- complex (that's exactly why the range-lookup approach above exists), so
-- these only get set on rows that genuinely represent an outdoor,
-- map-relevant point — see campus.notes for how that's actually used.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campus_locations (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  latitude     REAL,
  longitude    REAL,
  created_at   TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE IF NOT EXISTS campus_room_ranges (
  id              SERIAL PRIMARY KEY,
  location_id     INTEGER NOT NULL REFERENCES campus_locations(id) ON DELETE CASCADE,
  floor           TEXT NOT NULL, -- 'G', '1'..'7', etc. — kept as text since 'G' isn't numeric
  range_start     INTEGER NOT NULL,
  range_end       INTEGER NOT NULL CHECK (range_end >= range_start),
  directions_text TEXT,
  created_at      TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_campus_ranges_floor ON campus_room_ranges(floor, range_start, range_end);
CREATE INDEX IF NOT EXISTS idx_campus_ranges_location ON campus_room_ranges(location_id);

-- ---------------------------------------------------------------------------
-- Social Page (Stage 6)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id         SERIAL PRIMARY KEY,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  image_ref  TEXT,
  video_ref  TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
-- Matches the actual feed query's access pattern (WHERE status = ? ORDER BY
-- id DESC) — indexed on created_at would not serve that ORDER BY.
CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(status, id);

CREATE TABLE IF NOT EXISTS likes (
  id         SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  UNIQUE (post_id, student_id) -- one like per student per post
);

CREATE TABLE IF NOT EXISTS comments (
  id         SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

CREATE TABLE IF NOT EXISTS reports (
  id           SERIAL PRIMARY KEY,
  post_id      INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  reported_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed')),
  created_at   TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
-- Serves reportPost's duplicate-pending-report check (post_id + reported_by
-- together), which the status-only index above doesn't cover.
CREATE INDEX IF NOT EXISTS idx_reports_post_reporter ON reports(post_id, reported_by);

-- ---------------------------------------------------------------------------
-- Notes Hub (Stage 7)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
  id           SERIAL PRIMARY KEY,
  uploaded_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name    TEXT NOT NULL,
  subject      TEXT NOT NULL,
  faculty_id   INTEGER REFERENCES faculty(id),
  file_type    TEXT NOT NULL CHECK (file_type IN ('pdf', 'doc', 'docx', 'ppt', 'pptx')),
  file_size    INTEGER NOT NULL,
  storage_ref  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_notes_search ON notes(subject, faculty_id);
-- The compound index above only helps queries filtering by subject (its
-- leftmost column); a search filtering by faculty_id alone — a real,
-- separate filter option in Notes Hub — needs its own index.
CREATE INDEX IF NOT EXISTS idx_notes_faculty ON notes(faculty_id);

-- ---------------------------------------------------------------------------
-- Audit Logs (Stage 9)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          SERIAL PRIMARY KEY,
  actor_id    INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  metadata    TEXT, -- JSON string
  ip_address  TEXT,
  created_at  TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id, created_at);
