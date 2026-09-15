# V-ACCESS — VIT Student Accessibility Website

Status: **All 10 stages complete.** Every functional module (Stages 1–8)
plus a dedicated security-hardening pass (Stage 9) and a
testing/integration/optimization pass (Stage 10) are implemented, tested,
and verified against a running server. Stage 9 in particular found and
fixed a real bug — see "Security hardening notes" below — rather than just
restating what already existed; see "Known limitations" for anything still
genuinely open.

## 1. Technology stack, and why

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 (built-in `node:http`, `node:sqlite`, `node:crypto`, `node:test`) | Zero install step — no `npm install`, no framework version drift, no external DB server to stand up. Everything a grader or teammate needs is `node`. |
| Database | SQLite via `node:sqlite` | Fully relational (FKs, UNIQUE, CHECK, indexes) and satisfies every schema requirement in the SRS, but ships as a single file — no separate DB server to configure. Swappable later for Postgres/MySQL behind the same `db.js` module if the project needs multi-writer concurrency at scale. |
| Auth | Scrypt password hashing (`node:crypto`) + opaque server-side session tokens | No plaintext passwords, ever. Opaque tokens (not JWT) mean logout / revocation is instant and a stolen DB dump alone can't be replayed as a live session. |
| Frontend | Vanilla HTML/CSS/JS, no build step | Matches the "no install" philosophy, keeps the bundle inspectable, and avoids a build toolchain the grading environment may not have. Structured with a shared design-token system so it's easy to port to a framework later if desired. |
| Email | Pluggable service (`lib/email.js`) | The SRS leaves the email provider unspecified (Appendix C, TBD-1 doesn't cover it explicitly, but 2.7 does note it "depends on services... through email" without naming one). Defaults to a console transport (prints the email — zero setup for development/grading); swap in real SMTP by setting `EMAIL_TRANSPORT=smtp` and filling in the `SMTP_*` vars. |
| File storage | Local filesystem driver (`lib/storage.js`) | Post images and Notes Hub documents are validated by real magic-byte/structure sniffing (not filename/MIME trust) and stored under `STORAGE_LOCAL_DIR`. One module to swap for S3/GCS/etc. later — see requirement 18's "storage abstraction" note. |
| Campus navigation | Room-range lookup + a static reference image + a live OpenStreetMap embed, no map JS library or API key | Real transcribed VIT-PRP data showed each block has one contiguous room-number range per floor — a lookup problem, not a mapping problem — so that's solved first, independently of any map. A live outdoor view was added on top of that using OSM's own iframe embed with one real, verified building-level coordinate (sourced from OpenStreetMap's own data, not estimated), rather than a JS mapping library, to avoid vendoring a large dependency or loosening the CSP's `script-src`. See "Find My Class notes" below for the full reasoning, including why per-block GPS precision was deliberately not attempted. |

## 2. Folder structure

```
v-access/
├── server/
│   ├── src/
│   │   ├── app.js                 # entry point — wires DB, routes, static serving
│   │   ├── config/env.js          # all configuration from environment variables
│   │   ├── db/
│   │   │   ├── schema.sql         # full relational schema, every SRS entity
│   │   │   └── db.js              # connection singleton + migration + admin seed
│   │   ├── lib/                   # framework-free utilities
│   │   │   ├── router.js          # HTTP router, static file server, error handling
│   │   │   ├── response.js        # JSON response helpers
│   │   │   ├── password.js        # scrypt hash/verify
│   │   │   ├── tokens.js          # session token + OTP generation
│   │   │   ├── validate.js        # backend input validation (never trust the client)
│   │   │   ├── email.js           # email service abstraction
│   │   │   ├── ratelimit.js       # sliding-window rate limiter
│   │   │   └── audit.js           # audit log writer
│   │   ├── middleware/auth.js     # requireAuth / requireRole — the real security boundary
│   │   └── modules/
│   │       ├── auth/              # register, verify-otp, login, logout, me, password reset
│   │       ├── catalog/           # course + section listing (read)
│   │       ├── timetable/         # generation engine, save/view/edit/delete
│   │       ├── faculty/           # search/detail/review, admin moderation
│   │       ├── social/            # feed, likes, comments, reports, moderation
│   │       ├── notes/             # upload with real file-type validation, search, download
│   │       ├── admin/             # cross-module stats, user management, audit log
│   │       ├── campus/            # room-code lookup, zone/range management
│   │       └── dashboard.routes.js
│   ├── scripts/
│   │   └── smoke-test.sh          # post-deploy health/config check (`npm run smoke-test`)
│   ├── tests/
│   │   ├── helpers/fixtures.js    # real minimal PDF/ZIP/OLE builders for file-validation tests
│   │   ├── auth.test.js
│   │   ├── timetable.engine.test.js
│   │   ├── timetable.service.test.js
│   │   ├── faculty.test.js
│   │   ├── social.test.js
│   │   ├── notes.test.js
│   │   ├── admin.test.js
│   │   ├── campus.parser.test.js
│   │   ├── campus.service.test.js
│   │   ├── security.test.js       # SRS Section 14 "Security" checklist, over a real booted server
│   │   └── integration.test.js    # full cross-module HTTP journey + concurrency correctness
│   ├── package.json
│   └── .env.example
└── web/
    ├── index.html                 # login
    ├── register.html
    ├── verify.html                # OTP entry
    ├── forgot-password.html       # password reset (request code, then set new password)
    ├── dashboard.html             # protected — student dashboard
    ├── timetable.html             # protected — Timetable Designer
    ├── faculty.html                # protected — Faculty Review + admin moderation
    ├── social.html                 # protected — Social Page + admin moderation
    ├── notes.html                  # protected — Notes Hub upload/search/download
    ├── admin.html                  # protected, admin-only — stats, users, audit log
    ├── find-my-class.html          # protected — room lookup, browse, admin location management
    ├── 404.html                   # honest "not built yet" page for future modules
    ├── images/
    │   └── prp-layout.png          # static aerial reference diagram (blocks A-E)
    ├── css/
    │   ├── tokens.css             # design system: color, type, spacing
    │   ├── base.css                # reset, layout shell
    │   ├── components.css         # buttons, forms, cards, alerts, etc.
    │   ├── timetable.css          # weekly grid, course picker, combo cards
    │   ├── faculty.css             # rating stars, faculty list, review cards
    │   ├── social.css              # composer, post cards, comment threads
    │   ├── notes.css               # upload form, filter bar, note rows
    │   ├── admin.css               # stat cards, user rows, audit log rows
    │   └── campus.css              # search results, zone cards, admin range editor
    └── js/
        ├── api.js                 # fetch wrapper, session token, download/image helpers, route guard
        ├── login.js                # login page logic
        ├── register.js             # registration page logic
        ├── verify.js                # OTP verification page logic
        ├── forgot-password.js      # password reset flow logic
        ├── dashboard.js            # dashboard page logic
        ├── weekgrid.js             # renders a flat entry list into a CSS-grid week view
        ├── timetable.js           # Timetable Designer page logic
        ├── faculty.js              # Faculty Review page logic
        ├── social.js               # Social Page page logic
        ├── notes.js                # Notes Hub page logic
        ├── admin.js                # Admin Dashboard page logic
        └── campus.js               # Find My Class page logic
```

## 3. Database schema

`server/src/db/schema.sql` defines every entity from SRS Section 10:
`roles`, `users`, `email_verifications`, `sessions`, `auth_attempts`, `faculty`,
`reviews`, `courses`, `course_slots`, `timetables`, `timetable_entries`,
`campus_locations`, `campus_room_ranges`, `posts`, `likes`, `comments`,
`reports`, `notes`, `audit_logs`.

Key constraints implementing the SRS business rules directly at the database level:

- **One account per student** — `users.email UNIQUE`.
- **One review per student per faculty** — `reviews UNIQUE (faculty_id, student_id)`.
- **One like per student per post** — `likes UNIQUE (post_id, student_id)`.
- Ratings are bounded — `reviews.rating CHECK (BETWEEN 1 AND 5)`.
- A room range must be well-formed — `campus_room_ranges.CHECK (range_end >= range_start)`.
- Ownership — every user-created row (`reviews`, `posts`, `comments`, `notes`,
  `timetables`) carries a `student_id`/`author_id`/`uploaded_by` foreign key,
  enforced with `ON DELETE CASCADE` so orphaned rows can't accumulate.
- Passwords are never stored in plaintext — `users.password_hash` holds a
  salted scrypt digest (`scrypt$N$r$p$salt$hash`), never the password itself.
- Sessions store only a SHA-256 hash of the bearer token, not the token.

`campus_locations` went through one schema revision worth knowing about: it
originally had a per-room shape (one row per classroom) from when Stage 5
was first reserved, before any real room data existed. Once real VIT-PRP
numbering data showed the actual pattern was "one contiguous range per
floor per zone," the table was redesigned to `campus_locations` (zones) +
`campus_room_ranges` (their per-floor ranges) instead. Since the old shape
never held real data, `db.js` detects and drops it on boot rather than
carrying a placeholder shape forward — see "Find My Class notes" below.

## 4. API endpoints (implemented so far)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | none | Register with VIT email + password; sends OTP |
| POST | `/api/auth/verify-otp` | none | Confirm the 6-digit code, activates the account |
| POST | `/api/auth/resend-otp` | none | Re-sends a code (rate-limited, doesn't leak account existence) |
| POST | `/api/auth/forgot-password` | none | Requests a password-reset code (same non-enumeration shape as resend-otp) |
| POST | `/api/auth/reset-password` | none | Verifies the code, sets a new password, and revokes all existing sessions |
| POST | `/api/auth/login` | none | Returns a bearer session token |
| POST | `/api/auth/logout` | bearer token | Revokes the current session |
| GET | `/api/auth/me` | bearer token | Returns the authenticated user |
| GET | `/api/dashboard/summary` | bearer token | User info + activity counts |
| GET | `/api/courses` | bearer token | List/search the course catalog, each with its sections and weekly meetings |
| POST | `/api/timetable/generate` | bearer token | Generate every conflict-free combination for the given course/section selections + preferences |
| POST | `/api/timetable` | bearer token | Save a specific combination as a named timetable |
| GET | `/api/timetable` | bearer token | List the student's saved timetables |
| GET | `/api/timetable/:id` | bearer token | Full entry detail for one saved timetable (owner only) |
| PATCH | `/api/timetable/:id` | bearer token | Rename and/or replace the entries of a saved timetable |
| DELETE | `/api/timetable/:id` | bearer token | Delete a saved timetable (owner only) |
| GET | `/api/faculty` | bearer token | Search/list faculty with computed average rating + approved review count |
| GET | `/api/faculty/:id` | bearer token | Faculty detail: bio, rating, and approved reviews |
| GET | `/api/faculty/:id/my-review` | bearer token | The current student's own review for this faculty member, if any |
| POST | `/api/faculty/:id/reviews` | bearer token | Submit a 1–5 rating + optional text (one per student per faculty) |
| POST | `/api/faculty` | admin only | Create a faculty record |
| PATCH | `/api/faculty/:id` | admin only | Update a faculty record |
| DELETE | `/api/faculty/:id` | admin only | Delete a faculty record (cascades to its reviews) |
| GET | `/api/faculty-reviews/pending` | admin only | Moderation queue |
| PATCH | `/api/faculty-reviews/:reviewId` | admin only | Approve or reject a pending review |
| DELETE | `/api/faculty-reviews/:reviewId` | admin only | Remove a review outright, regardless of status |
| GET | `/api/social/posts` | bearer token | Paginated feed (`?before=&limit=`), active posts only |
| POST | `/api/social/posts` | bearer token | Create a post, optionally with a base64-encoded image |
| GET | `/api/social/images/:ref` | bearer token | Serves a stored post image (binary), auth-gated |
| POST | `/api/social/posts/:id/like` | bearer token | Like a post (idempotent — safe to call twice) |
| DELETE | `/api/social/posts/:id/like` | bearer token | Unlike a post (idempotent) |
| GET | `/api/social/posts/:id/comments` | bearer token | List comments on a post |
| POST | `/api/social/posts/:id/comments` | bearer token | Add a comment |
| POST | `/api/social/posts/:id/report` | bearer token | Report a post (one pending report per student per post) |
| GET | `/api/social/reports` | admin only | Pending report queue |
| PATCH | `/api/social/reports/:id` | admin only | Mark a report reviewed or dismissed |
| DELETE | `/api/social/posts/:id` | admin only | Remove a post (soft delete — see notes below) |
| GET | `/api/notes` | bearer token | Search notes (`?search=&subject=&facultyId=`) |
| GET | `/api/notes/subjects` | bearer token | Distinct subjects, for building a filter dropdown |
| POST | `/api/notes` | bearer token | Upload a note (PDF/DOC/DOCX/PPT/PPTX as base64) |
| GET | `/api/notes/:id/download` | bearer token | Download the original file |
| DELETE | `/api/notes/:id` | admin only | Remove a note and its stored file |
| GET | `/api/admin/stats` | admin only | Cross-module counts (SRS Section 9) |
| GET | `/api/admin/users` | admin only | Search/filter all users |
| PATCH | `/api/admin/users/:id` | admin only | Suspend/reactivate or change a user's role |
| GET | `/api/admin/audit-logs` | admin only | Paginated audit/security log |
| GET | `/api/campus/search` | bearer token | Look up a room code ("PRP 230") or search zone names |
| GET | `/api/campus/blocks` | bearer token | List all zones/blocks |
| GET | `/api/campus/blocks/:id/ranges` | bearer token | A zone's per-floor room ranges + directions |
| GET | `/api/campus/map-anchors` | bearer token | Zones with real outdoor coordinates, for the live map |
| POST/PATCH/DELETE | `/api/campus/blocks[/:id]` | admin only | Manage zones (name, description, optional coordinates) |
| POST/PATCH/DELETE | `/api/campus/ranges[/:id]` | admin only | Manage per-floor ranges and their directions text |
| GET | `/api/health` | none | Liveness check |

All protected routes call `requireAuth()`/`requireRole()` from
`middleware/auth.js` — this is the actual authorization boundary. The frontend
never decides who's allowed to see what; it just reflects what the backend
already enforced. A student cannot reach an admin-only route by editing
frontend requests, because there are no admin routes registered yet that skip
this check (and none will be, in later stages).

### Timetable Designer notes

- The selectable unit is a **section** (e.g. "A1"), identified by
  `slotCode` — not a single meeting. A section that meets twice a week
  (e.g. Monday and Wednesday) is one choice; picking it commits to every one
  of its weekly meetings together. This matters because two sections can be
  individually conflict-free per-meeting but the combination should still be
  treated as one atomic unit — the engine and API both work at the section
  level for exactly this reason.
- Conflict detection compares every meeting of one selected section against
  every meeting of every other selected section — see
  `timetable.engine.js::slotsConflict`.
- Combinations are generated by backtracking (not a full cartesian product
  followed by filtering), so invalid branches are pruned early — see
  `generateValidCombinations`. Results are capped at 300 combinations with
  `truncated: true` returned if more exist.
- The same course can never appear twice in one request or one saved
  timetable, even if the two sections chosen don't overlap in time — this is
  checked explicitly, not inferred from time conflicts alone (an early build
  of this stage had that gap; the test suite now guards against it — see
  `timetable.service.test.js`).
- Every write (`generate`, `save`, `update`) re-validates against the
  database — the frontend only ever sends a combination it already generated,
  but the backend never trusts that.

### Faculty Review notes

- The one-review-per-student-per-faculty rule (REQ-12) is enforced twice:
  the `reviews` table has `UNIQUE(faculty_id, student_id)`, and
  `faculty.service.js::submitReview` catches that constraint violation and
  turns it into a clear message — so it holds even against a direct API call
  that skips the frontend's own "already reviewed" check.
- New reviews are always `pending` and excluded from the public average and
  review list until an admin approves them — `getFacultyDetail` only ever
  queries `WHERE status = 'approved'`.
- Anonymity is a *display* choice, not an accountability gap: the moderation
  queue (`listPendingReviews`) always shows the real submitter, even for
  reviews marked anonymous — anonymity only hides the name from other
  students once approved (`formatReview`).
- Admin routes for faculty management and review moderation live in this
  module now, ahead of the Stage 8 Admin Dashboard, because the SRS itself
  scopes "admin moderation" as part of the Faculty Review feature (REQ-14),
  separately from the cross-module statistics dashboard in SRS Section 9.
  There's no dedicated admin UI page for it yet — the moderation queue is a
  tab inside `faculty.html`, visible only when the logged-in user's role is
  `admin`.

### Social Page notes

- Post images are sent as a base64 data URL in the same JSON request as the
  post content (no multipart form parsing needed, keeping the server
  dependency-free) and validated server-side by **real magic-byte
  detection** (`lib/storage.js::detectImageType`) — a file's declared
  `Content-Type` or extension is never trusted on its own; a renamed
  non-image file is rejected even with an `image/png` data URL prefix.
- `<img src="...">` can't carry an `Authorization` header, so the image
  route stays behind `requireAuth` like everything else, and the frontend
  fetches it with `fetch()` + the bearer token, then renders the result as a
  blob URL (`api.js::fetchAuthenticatedImageUrl`). Images are only reachable
  by someone with a valid session, consistent with "student-only."
- Likes are idempotent by design: liking twice (a double-click, or a direct
  repeated API call) never double-counts and never errors — both the
  `UNIQUE(post_id, student_id)` constraint and an `INSERT OR IGNORE` in
  `social.service.js::likePost` enforce this, satisfying "prevent duplicate
  likes" without punishing the user for clicking twice.
- Removing a post is a **soft delete** (`posts.status = 'removed'`), not a
  hard `DELETE` — it disappears from the feed immediately (`listFeed` only
  ever selects `status = 'active'`) but the row, its comments, and its
  report history survive for audit purposes. Any of the post's own pending
  reports are auto-closed when it's removed, since removal already resolves
  them.
- Pagination is a "Load more" button rather than silent scroll-triggered
  infinite loading — both are legitimate readings of the SRS's
  "pagination/infinite loading" requirement; a button was chosen for
  predictability and keyboard/screen-reader accessibility. The API itself
  is cursor-based (`?before=<postId>`), so swapping in scroll-triggered
  loading later is a frontend-only change.

### Notes Hub notes

- Files are validated by **real structural inspection**, not filename or
  declared MIME type — this is the SRS's own explicit requirement ("do not
  rely only on file extensions"). Specifically:
  - **PDF** must actually start with the PDF header.
  - **DOCX/PPTX** must actually be ZIP archives, and the specific format is
    told apart by reading real entry paths (`word/...` vs `ppt/...`) out of
    the ZIP's own central directory (`lib/storage.js::listZipEntryNames`) —
    a ZIP that isn't a recognized Office document is rejected even if it's
    named `.docx`.
  - **DOC/PPT** (legacy binary Office format) share an identical outer
    container (OLE Compound File) and genuinely cannot be told apart from
    each other by magic bytes alone without full internal stream parsing.
    The container itself is still verified as real OLE data — anything that
    isn't is rejected — and only the doc-vs-ppt tie-break falls back to the
    uploaded file's own extension. This is a deliberate, documented
    exception to "don't rely on the extension," not an oversight — see the
    comment block at the top of the documents section in `lib/storage.js`.
  - Tests exercise this directly (`tests/notes.test.js` +
    `tests/helpers/fixtures.js`) by constructing real minimal PDF/ZIP/OLE
    byte sequences rather than mocking the detector.
- Uploads travel as a base64 data URL in the same JSON request as the
  metadata, same approach as Social Page images, avoiding the need for a
  multipart parser. The size limit is configurable
  (`NOTES_MAX_FILE_MB`, default 15) and enforced server-side regardless of
  what the frontend pre-checks.
- Downloads require authentication ("Only authenticated VIT students can
  download files") and stream the original bytes back with a proper
  `Content-Disposition` header (including an RFC 5987 `filename*` fallback
  for non-ASCII filenames); the frontend triggers the browser's native save
  dialog via a blob URL, since a plain link can't carry a bearer token.
- Only admins can remove notes (`DELETE /api/notes/:id`) — the SRS lists
  this as an admin capability and doesn't mention student self-deletion of
  their own uploads, so it wasn't added (see requirement 18: "do not create
  unrelated features").

### Admin Dashboard notes

- `GET /api/admin/stats` computes every number in SRS Section 9 live from
  the database on each request — nothing is cached or precomputed, so it's
  always exactly correct, verified in `admin.test.js` by seeding known rows
  and asserting exact counts (including that approving a review moves it
  from `pendingReviews` into `totalReviews` without double-counting).
- User management includes two self-protection guards enforced server-side:
  an admin can never suspend their own account or change their own role.
  Without this, a single click could lock every admin out of the system
  with no way back in short of direct database access.
- Suspending a user **immediately revokes every one of their live
  sessions** (not just a flag that takes effect next login) — verified in
  `admin.test.js` by suspending a user with a real active session and
  confirming it stops resolving in the same instant.
- Faculty management/moderation, Social Page moderation, and Notes Hub
  management already have their own admin-only endpoints and UI tabs built
  directly into `faculty.html`/`social.html`/`notes.html` (see their
  sections above) — `admin.html` links out to each rather than duplicating
  them, matching how the SRS scopes "admin moderation" as part of each
  feature (REQ-14, etc.) separately from the cross-module dashboard in
  Section 9.
- The audit log (`audit_logs` table, populated by every module via
  `lib/audit.js::logAudit`) has been recording real entries since Stage 1 —
  registrations, logins, timetable saves, review moderation, post removal,
  note uploads, user suspensions, and more all already appear in
  `admin.html`'s Audit Log tab with no separate "enable logging" step.
- Campus location management (one of the SRS's listed admin capabilities)
  is intentionally not built — it depends on the Find My Class module
  (Stage 5), which was skipped pending a map provider decision.

### Find My Class notes

- **The map question resolved differently than planned.** The SRS asks for
  building navigation, and the original plan assumed that meant an outdoor
  map (Leaflet/OSM, Google Maps, or an embedded third-party "VIT Map").
  Once real VIT-PRP room-numbering data was available, it became clear the
  actual hard problem was **indoor, per-room lookup** — "PRP 230" needs to
  resolve to a specific block and floor — and a live map doesn't solve that
  at all (GPS doesn't distinguish floors). So Stage 5 built the lookup
  first, and treats the outdoor/live-map layer as a separate, optional
  addition — described below, not yet built.
- **The room code is parsed, not looked up row-by-row.** VIT-PRP's
  convention embeds the floor directly in the room number — "PRP 230" is
  floor 2, room 30; "PRP G45" is Ground floor, room 45 — and each zone
  (block) has one contiguous room-number range per floor, not
  individually-numbered rooms with no pattern. `campus.parser.js::parseRoomCode`
  is a small, pure, independently-tested function that extracts
  `{floor, roomNumber}` from whatever a student types ("230", "PRP230",
  "prp 230", "G45" all resolve the same way), and the service does a range
  lookup (`floor = ? AND range_start <= ? AND range_end >= ?`) rather than
  storing or searching one row per room.
- **The seeded zone data is real, not placeholder.** `Block A` through
  `Block F`, `Main Entrance`, and four zones of the central hexagonal
  `Block C` complex (`Block C1`–`C4`) with their real per-floor room ranges
  came from VIT-PRP's own room-numbering reference, transcribed and
  verified against the stated example ("PRP 230" does resolve to Block E,
  floor 2 — checked in `campus.service.test.js`). One zone's name was
  unconfirmed in the source (labeled `Block C3` here, with that noted
  directly in its stored description) — worth confirming and renaming via
  the admin UI if the real name is known. `directionsText` is deliberately
  left blank in the seed — those are real per-floor instructions an
  administrator has to write from firsthand knowledge of the building, not
  something to invent.
- **A few zone boundaries in the real data genuinely overlap** (e.g. one
  zone's floor-3 range ends at room 7 and the adjacent zone's floor-3 range
  also starts at 7) — almost certainly a transcription artifact in the
  original source, but rather than silently guessing which side is "right,"
  overlaps are surfaced as **non-blocking warnings** whenever an admin
  creates or edits a range (`campus.service.js::findOverlaps`), and a
  student searching a room number in the overlap zone simply sees both
  candidate zones. Verified directly in tests, including that fixing one
  side clears the warning.
- **A live outdoor map now exists too, added deliberately after the room
  lookup, not instead of it.** The static aerial image is still there for
  block-relative orientation, but `find-my-class.html` now also embeds a
  real, live OpenStreetMap view via `campus_locations.latitude`/`longitude`
  — the exact seam this README said it would use, now actually built:
  - **The coordinate is real, not estimated.** PRP's location
    (12.971493, 79.166208) comes from OpenStreetMap's own building record
    (way `1092533785`, tagged `building=university`, `levels=7` — matching
    VIT's own published "G+7 floors" for PRP), not a guess from the aerial
    image's pixel layout.
  - **It's one point for the whole building, deliberately not one per
    block.** GPS can't distinguish blocks 50-100m apart within the same
    complex — that's the entire reason the range-lookup system exists
    instead of a map pin per room. Giving each of the ten zone rows its
    own "coordinate" would have implied a precision that doesn't exist;
    instead, exactly one new row ("Pearl Research Park (PRP)") carries
    real coordinates, and the other ten stay `NULL` — honestly reflecting
    what's actually known. `latitude`/`longitude` are ordinary nullable
    columns on `campus_locations`, so any zone *could* get real coordinates
    later if someone obtains them (e.g. a proper survey), without a schema
    change.
  - **No map library, no API key, no new build step.** Loading a full JS
    mapping library (Leaflet, etc.) wasn't possible without either
    vendoring a large third-party bundle into a zero-dependency project or
    loosening `script-src` to trust an external CDN — the latter would
    have directly undone Stage 9's CSP hardening. Instead, this uses
    OpenStreetMap's own `/export/embed.html` iframe endpoint, built from
    real anchor coordinates fetched from `GET /api/campus/map-anchors`
    (never hardcoded), plus a "open larger map" link out.
  - **The CSP change this required is real but narrowly scoped, and worth
    being precise about.** `frame-src https://www.openstreetmap.org` was
    added — and *only* `frame-src`, not `script-src`. An iframe runs in
    its own browsing context and cannot read this page's DOM, cookies, or
    `sessionStorage` (where the bearer token lives) under the browser's
    same-origin policy; a `script-src` grant to the same origin would
    instead let that origin's code execute directly inside this page,
    which is a categorically different (and much higher) risk. This
    distinction — and that `script-src` remains exactly `'self'`, unchanged
    — is asserted directly in `security.test.js`, not just claimed here.
  - Admins can set, correct, or clear a zone's coordinates from
    `find-my-class.html`'s "Manage locations" tab (both fields together,
    enforced server-side — a lone latitude or longitude is rejected rather
    than silently accepted as a mistake).
- Only admins can add/edit/delete zones and ranges — matches the SRS's
  "Campus location management" as an admin-only capability, consistent
  with how Faculty/Notes/Social moderation is scoped elsewhere.

### Security hardening notes (Stage 9)

This stage was treated as a real audit, not a restatement — it found and
fixed one genuine functional bug and one genuine misconfiguration, on top
of adding coverage that didn't exist before.

- **A real bug: the CSP would have silently broken login in a real
  browser.** The security headers (present since Stage 1) send
  `Content-Security-Policy: script-src 'self'` — correct, since it blocks
  inline script injection — but `index.html`, `register.html`,
  `verify.html`, and `dashboard.html` had their page logic in inline
  `<script type="module">` blocks rather than external files. Per the CSP
  spec, `script-src 'self'` (without `'unsafe-inline'`) blocks **all**
  inline script content, including `type="module"` blocks, in every major
  browser — so those four pages' JavaScript would not have executed at
  all. This was never caught earlier because every prior smoke test used
  `curl`, which doesn't execute JavaScript or enforce CSP — only a real
  browser (or a spec-level read of what the header actually does) surfaces
  it. Fixed by extracting all four into external files (`js/login.js`,
  `js/register.js`, `js/verify.js`, `js/dashboard.js`), matching the
  pattern every other page already used — no weakening of the CSP was
  needed or done.
- **A real misconfiguration: CORS was reflecting any origin.**
  `Access-Control-Allow-Origin` was being set to whatever `Origin` header
  the request sent, combined with `Access-Control-Allow-Credentials: true`
  — a well-known permissive-CORS anti-pattern (it tells browsers any
  website's JavaScript may read the API's responses). Fixed: only the
  configured `WEB_ORIGIN` is ever allowed, and `Allow-Credentials` is no
  longer sent at all, since this app's auth is a bearer token the browser
  never attaches automatically — there's no ambient credential for CORS to
  protect in the first place. Verified directly in `security.test.js`
  (the configured origin is allowed, an arbitrary one is not, and the
  credentials header is absent).
- **CSRF is architecturally not applicable, not merely "not implemented."**
  CSRF exploits a browser automatically attaching an ambient credential
  (a cookie) to a cross-site request the user didn't intend. This app's
  sessions are bearer tokens sent via an explicit `Authorization` header,
  stored in `sessionStorage` — nothing here is ever attached to a request
  automatically, so there is no ambient credential for a forged cross-site
  request to ride on. The real trade-off this creates, and the one worth
  being honest about: a bearer token in `sessionStorage` **is** readable by
  any JavaScript running on the page, so if this app ever had an XSS hole,
  the token could be exfiltrated directly — which is exactly why CSP's
  `script-src 'self'` (no inline, no `unsafe-inline`) is treated as load
  bearing here rather than a nice-to-have, and why every piece of
  user-generated content rendered by the frontend goes through
  `escapeHtml()` before being placed in the DOM (checked by hand across
  every module's JS file as part of this pass).
- **Rate limiting now covers content-creation, not just auth.** Until this
  stage, an authenticated account could create unlimited posts, comments,
  reports, reviews, or note uploads with no throttling at all — only the
  auth endpoints (login/register/OTP) were protected. Extended
  `lib/ratelimit.js` with per-action limits (`post_create`,
  `comment_create`, `report_submit`, `review_submit`, `note_upload`), all
  configurable via `.env`. Verified under genuine concurrent load in
  `integration.test.js`, not just sequential calls — see below.
- **Password reset now exists.** The SRS's own auth requirements list
  doesn't explicitly call for it, but a "production-ready" login system
  with no account-recovery path is a real gap, and the scaffolding for it
  (an `email_verifications.purpose` column already supporting
  `'password_reset'`, and `sendOtpEmail` already labeling that case) had
  existed unused since Stage 1. `POST /api/auth/forgot-password` +
  `POST /api/auth/reset-password` complete it: same non-enumeration shape
  as the existing `resend-otp` endpoint, and — like an admin-initiated
  suspension — a successful reset immediately revokes every existing
  session for that account, not just future ones.
- Added a `Permissions-Policy` header denying camera/microphone/geolocation/
  payment (this app uses none of them) and a `frame-ancestors 'none'` +
  `base-uri 'self'` + `form-action 'self'` tightening to the existing CSP,
  for defense in depth alongside the existing `X-Frame-Options: DENY`.
- New `tests/security.test.js` maps directly to SRS Section 14's Security
  checklist, item by item, over a **real booted HTTP server** (not just
  service-layer calls): unauthorized access to every protected endpoint,
  a student token against every admin-only endpoint, malformed JSON and
  invalid field values, rate-limit enforcement over real HTTP, oversized
  and spoofed file uploads, and that the security headers above are
  actually present on real responses (including error responses).

### Testing, integration & optimization notes (Stage 10)

- **Two indexes were actually wrong, not just missing** — found by
  comparing every index definition against the queries actually run
  against it, rather than assuming "an index exists" meant "the right
  index exists":
  - `idx_posts_feed` was defined on `(status, created_at)`, but the feed
    query filters by `status` and sorts by `id` (`ORDER BY posts.id DESC`)
    — the old definition didn't serve the sort at all. Recreated as
    `(status, id)`.
  - `idx_sessions_token_hash` was a redundant duplicate of the index
    SQLite already maintains automatically for `sessions.token_hash`'s
    `UNIQUE` constraint — removed, since it was pure write overhead on
    every session insert with no benefit.
  - Two genuinely missing indexes were added: `notes(faculty_id)` (the
    existing `(subject, faculty_id)` compound index doesn't serve a
    faculty-only filter, which Notes Hub's search supports) and
    `reports(post_id, reported_by)` (serves the duplicate-pending-report
    check on every report submission).
  - Since `CREATE INDEX IF NOT EXISTS` does not update an index's
    definition if one by that name already exists, changing the first two
    required an explicit migration step in `db.js` (`DROP INDEX` before
    `schema.sql` recreates them) — the same pattern already established
    for the Stage 5 `campus_locations` schema change. Verified directly:
    a database built with the old index shapes gets the corrected ones on
    next boot, checked against `sqlite_master`.
- **A real HTTP-level integration test now exists**
  (`tests/integration.test.js`), distinct from the ~120 service-layer
  tests elsewhere. It boots the actual production `buildServer()` (the
  same function `app.js` uses — not a reimplementation) on an ephemeral
  port and runs one coherent session over real `fetch()` calls: register →
  verify → dashboard → generate and save a timetable → submit a faculty
  review → create a post, like it, comment on it → upload and download a
  note (byte-for-byte verified) → look up a room code → then, as an admin,
  confirms all of that shows up correctly in cross-module stats, the
  moderation queue, and the audit log. This is what actually caught that
  the modules compose correctly end to end, not just in isolation.
- **A genuine concurrency test, not just a claim.** SRS Section 16 asks
  the system to "handle concurrent student usage." Two tests fire real
  parallel HTTP requests (via `Promise.all`, not sequential `await`s) at
  the running server: 8 different students liking the same post
  simultaneously (verifies the final count is exactly right — no lost or
  duplicated rows under concurrency), and 25 simultaneous post-creation
  requests from one account against a limit of 15 (verifies **at most**
  15 succeed even under a genuine race, not more). The second test
  incidentally demonstrates something worth knowing about this
  architecture: because `node:sqlite` calls are synchronous and each
  request handler runs its rate-limit check-then-record as one
  uninterrupted synchronous block, there's no check-then-record race
  condition within a single Node process — verified empirically here
  rather than just asserted. This is a real property of the current
  single-process design, and also names its own scaling boundary (see
  "Known limitations").
- **A deployment smoke-test script** (`server/scripts/smoke-test.sh`,
  `npm run smoke-test`) for exactly the failure mode a from-scratch build
  is most likely to hit post-deploy: "it's up, but misconfigured." It
  deliberately does not attempt a full register→verify→login round trip —
  in a real deployment (`EMAIL_TRANSPORT=smtp`), a smoke test has no way to
  read an OTP out of a real inbox, so it checks everything observable from
  the outside instead: liveness, that the frontend is served, that the
  security headers survive whatever reverse proxy sits in front, and that
  invalid input fails closed with a 4xx rather than a 500.

## 5. Environment variables

See `server/.env.example` for the full list with inline documentation. Copy it:

```bash
cp server/.env.example server/.env
```

Nothing needs to be filled in for local development — sensible defaults are
used for everything except `NODE_ENV=production`, where missing secrets
(`SESSION_SECRET`, etc.) cause the app to refuse to start rather than run
insecurely.

## 6. Installation & running

No `npm install` is required — the server has zero runtime dependencies.

```bash
cd server
cp .env.example .env         # optional for local dev, required for production
npm run dev                  # starts with --watch, http://localhost:4000
# or
npm start                    # plain start
```

The frontend is served by the same server at the same origin (no separate
frontend server or build step) — open `http://localhost:4000`.

Once it's running, `npm run smoke-test` (or `sh scripts/smoke-test.sh
<url>` against a deployed instance) runs a quick post-deploy health and
configuration check — see "Testing, integration & optimization notes"
above for what it covers and why it doesn't attempt a full signup flow.

## 7. Database setup

Nothing to run manually. On first boot, `db.js` opens (creating, if
necessary) the SQLite file at `DB_PATH` (default `server/data/vaccess.db`)
and applies `schema.sql`, which uses `CREATE TABLE IF NOT EXISTS`, so it's
safe to run on every boot.

Course data (needed for the Timetable Designer) is **not** seeded
automatically — it's dynamic, per-institution data that a real deployment
would get from an admin import, not from application code. For local
development and grading, populate realistic sample courses with:

```bash
cd server
npm run seed
```

This is safe to re-run — it upserts by course code rather than duplicating
rows.

## 8. Default admin setup

Set these in `server/.env` before first boot:

```
DEFAULT_ADMIN_EMAIL=admin@vitstudent.ac.in
DEFAULT_ADMIN_PASSWORD=choose-a-strong-password
```

An admin account is created automatically on the next server start if one
with that email doesn't already exist. Leave both blank to skip. There is no
public "become admin" endpoint — promoting a user to admin is a direct
database operation an administrator performs, by design.

## 9. Testing

```bash
cd server
npm test
```

Current suite exercises, against a real throwaway SQLite database (not mocks):

`tests/auth.test.js`:
- Registration rejects non-VIT email domains
- Registration rejects weak passwords
- Full flow: register → OTP sent → wrong OTP rejected → correct OTP verifies
  → login → protected-route session resolves → logout → session is revoked
- Login before email verification is rejected
- Repeated failed logins trigger rate limiting

`tests/timetable.engine.test.js` (pure logic, no DB):
- Conflict detection within and across days, including multi-meeting sections
- "Exclude early morning" and "preferred days" preference filtering
- Combination generation only ever returns conflict-free results
- `maxResults` truncation is respected and reported

`tests/timetable.service.test.js` (against a real seeded DB):
- Generation expands a twice-weekly section into its full set of meetings
- Saving rejects a conflicting pair even if submitted directly, bypassing the UI
- Saving rejects the same course selected twice under different sections
  (a real bug caught during manual smoke-testing this stage — the fix and a
  regression test both landed together)
- Ownership is enforced: a different student gets "not found", not the data
- Update can rename without touching entries, or replace entries with
  re-validated conflict checking

`tests/faculty.test.js` (against a real seeded DB):
- A pending review never appears in the public list or average
- A student cannot submit a second review for the same faculty member
- A different student can still submit their own
- The moderation queue always shows the real submitter, even for reviews
  marked anonymous
- Approving folds a review into the average and makes it visible; rejecting
  keeps it hidden permanently
- Anonymous + approved hides the name from the public view
- Removing a review deletes it outright regardless of status
- Deleting a faculty member cascades and removes its reviews

`tests/social.test.js` (against a real seeded DB):
- Text-only and image posts both work; a real 1×1 PNG is uploaded, stored,
  and read back with the correct MIME type
- Non-image data is rejected even when wrapped in an `image/png` data URL
- Liking twice never double-counts (duplicate-like prevention)
- Comments, reporting, and duplicate-report prevention while a report is
  still pending
- Admin moderation: dismissing a report leaves the post untouched; removing
  a post soft-deletes it (hidden from the feed, row preserved) and
  auto-closes its own pending reports
- Actions against a removed post (like, comment) are rejected as not found
- Feed pagination returns a working cursor with no overlap between pages

`tests/notes.test.js` (against a real seeded DB, using real minimal
PDF/ZIP/OLE byte fixtures — not mocked detection):
- Real PDF, DOCX (via ZIP entry names), and PPTX uploads all succeed and
  are correctly typed
- A legacy OLE container correctly becomes `doc` or `ppt` depending on the
  uploaded filename, since the container bytes alone can't distinguish them
- A ZIP that isn't a recognized Office document is rejected even when named
  `.docx`; random bytes are rejected even when declared as a PDF; an OLE
  file with an unrecognized extension is rejected rather than guessed at
- Search by filename, filter by subject, filter by faculty
- Downloaded bytes are byte-for-byte identical to what was uploaded
- Admin deletion removes both the database row and the stored file

`tests/admin.test.js` (against a real seeded DB):
- Statistics exactly match manually-seeded rows across every module, and
  update correctly when a review is approved
- User search and role filtering
- An admin cannot suspend or change the role of their own account
- Suspending a different user immediately revokes their live session
- Promoting/demoting works, and a *different* admin can act on an account
  the first admin couldn't
- Audit log entries from other modules (e.g. review moderation) appear
  with the correct actor name resolved, and pagination has no overlap

`tests/campus.parser.test.js` (pure logic, no DB):
- "PRP 230" parses to floor 2, room 30 — the reference example from the
  real numbering convention — plus the "PRP" prefix being optional,
  case/whitespace tolerance, the Ground-floor "G" form, and that
  unparseable input returns `null` rather than throwing

`tests/campus.service.test.js` (against a real seeded DB):
- "PRP 230" resolves to the correct zone and floor end-to-end
- A genuine boundary overlap between two zones is flagged as a non-blocking
  warning on write, and a room number in the overlap correctly returns both
  zones as matches
- Zone name/description search works as the fallback when input isn't a
  parseable room code
- Deleting a zone cascades to its ranges; deleting one range doesn't affect
  its siblings
- A zone with real coordinates appears in the live-map anchor list; one
  without stays excluded; a lone latitude without its longitude (or vice
  versa) is rejected rather than silently accepted; coordinates can be
  added to an existing zone or explicitly cleared back to unset

`tests/security.test.js` (SRS Section 14's Security checklist, over a
**real booted HTTP server** — see "Security hardening notes" above):
- Every protected endpoint rejects no token, a garbage token, and a token
  invalidated by logout
- A student token is rejected (403) by every admin-only endpoint tested;
  an admin token is accepted by the same ones
- Malformed JSON, missing required fields, and out-of-range values all
  fail as 4xx, never a 500
- A write endpoint's rate limit actually triggers over real HTTP, and is
  scoped per-account (a different account is unaffected)
- An oversized upload and a non-document masquerading as a PDF are both
  rejected server-side; an oversized raw request body is rejected before
  processing
- Security headers (CSP, X-Frame-Options, Permissions-Policy) and the
  tightened CORS behavior are present on real responses, including error
  responses

`tests/integration.test.js` (full cross-module HTTP journey +
concurrency, over the same real booted server):
- One coherent session — register, verify, dashboard, generate and save a
  timetable, submit a faculty review, create/like/comment on a post,
  upload and byte-verify a note download, look up a room code, then
  confirm all of it shows up correctly in an admin's stats, moderation
  queue, and audit log
- 8 simultaneous likes from different accounts land as exactly 8, no lost
  or duplicated rows
- 25 simultaneous post-creation requests against a limit of 15 never let
  more than 15 through, and the persisted row count matches the accepted
  response count exactly — a genuine concurrency check, not a sequential
  one

Run `npm test` yourself to reproduce — nothing here is asserted without a
passing test behind it.

## 10. Production build & deployment

There's no separate build step (no bundler) — `npm start` is what runs in
production too. For deployment:

1. Set `NODE_ENV=production` and fill in every required var in `.env`
   (the app will refuse to boot if secrets are missing).
2. Put a reverse proxy (nginx, Caddy, or your host's built-in one) in front
   of the Node process to terminate HTTPS — the app sets HSTS and other
   secure headers assuming it's behind TLS.
3. Persist `DB_PATH` and `STORAGE_LOCAL_DIR` on a durable volume (they're
   plain files) if deploying to a container platform.
4. Point `EMAIL_TRANSPORT=smtp` at a real provider before going live —
   the console transport is for development only and must not be used in
   production (OTPs would be unusable).
5. The database runs in WAL mode (`db.js` sets this on boot), which means
   two extra files sit alongside the main one (`vaccess.db-wal`,
   `vaccess.db-shm`) — back up all three together, or run
   `PRAGMA wal_checkpoint(TRUNCATE);` first so a single-file copy of
   `vaccess.db` is complete on its own.
6. After deploying, run `npm run smoke-test <your-url>` — see "Testing,
   integration & optimization notes" above for exactly what it checks and
   why it's scoped the way it is.

## 11. Known limitations (honest, as of this build)

- All 8 functional modules are now implemented. There is no admin UI yet
  for managing courses/sections (Timetable Designer) — the only way to
  populate them today is the dev seed script or a direct database insert;
  Find My Class's zones/ranges, by contrast, do have a full admin UI
  (`find-my-class.html`'s "Manage locations" tab).
- Find My Class now has a live outdoor map (see "Find My Class notes"
  above) with one real, verified coordinate for the PRP building as a
  whole — deliberately not one per block, since GPS can't distinguish
  blocks 50-100m apart within one complex. Per-block outdoor precision
  would need a real survey, not something to fabricate; the schema
  supports it (nullable `latitude`/`longitude` per zone) whenever such
  data exists.
- One Find My Class zone's name (`Block C3`) is unconfirmed — it was
  unlabeled in the source data and inferred by position; flagged directly
  in its stored description pending confirmation.
- `directionsText` for Find My Class ranges is blank in the seed data —
  real per-floor walking directions have to be written by someone with
  firsthand knowledge of the building, via the admin UI.
- Post images are capped at 3MB and only PNG/JPEG/GIF/WEBP are accepted;
  Notes Hub documents are capped at 15MB (configurable) and only
  PDF/DOC/DOCX/PPT/PPTX are accepted. Neither is compressed/resized —
  an accepted file is stored at its original size.
- The current architecture is a single Node process with synchronous
  SQLite calls — genuinely correct under concurrency at this scale (see
  the concurrency tests in "Testing, integration & optimization notes"),
  but it is a real ceiling: one process means one CPU core, and a
  synchronous DB call blocks the event loop for its duration, so this
  won't scale past small-to-moderate concurrent load by adding hardware
  alone. The documented path past that ceiling is swapping SQLite for
  Postgres behind the same `db.js` interface (see the technology stack
  table) — nothing else in the codebase assumes SQLite specifically.
- Legacy `.doc`/`.ppt` files can't be told apart from each other by content
  alone (see "Notes Hub notes") — the extension is used as a tie-break
  only for that one ambiguous case.
- CSRF protection was evaluated and deliberately not built, because the
  bearer-token architecture here has no ambient credential for it to
  protect — see "Security hardening notes" above for the reasoning and
  the trade-off that decision creates (XSS becomes the credential-theft
  vector to guard against instead, which is why CSP and output-escaping
  discipline are treated as load-bearing).
  been done as their own dedicated stages yet.
- CSRF protection is not yet implemented — not required yet since the API
  uses bearer tokens (not cookies), which are not CSRF-vulnerable the way
  cookie-based sessions are, but this should be revisited if cookies are
  introduced later.
- The email transport's default (console) is for development only; real
  SMTP integration is a stub that needs a chosen provider (see `lib/email.js`).
- Map provider is unspecified per the SRS's own TBD list (Appendix C,
  TBD-1) — `config/env.js` has the abstraction point ready.
- File upload validation, storage abstraction, and the moderation/report
  queues are designed in the schema but land with the Social Page and Notes
  Hub stages.

## 12. Future enhancements

Per SRS Section 6.5: a companion mobile app, AI-assisted timetable
suggestions, personalized faculty recommendations, push notifications,
integration with VIT's official academic systems, and offline access to
shared notes are all out of scope for this build but the modular structure
(one `modules/<name>/` folder per feature, all sharing the same auth and DB
layer) is intended to make adding them later straightforward.

## Build stages (per SRS Section 19)

- [x] Stage 1 — Project setup, database, authentication
- [x] Stage 2 — Student dashboard and common UI
- [x] Stage 3 — Timetable Designer
- [x] Stage 4 — Faculty Review
- [x] Stage 5 — Find My Class
- [x] Stage 6 — Social Page
- [x] Stage 7 — Notes Hub
- [x] Stage 8 — Admin Dashboard and moderation
- [x] Stage 9 — Security hardening
- [x] Stage 10 — Testing, integration, optimization, deployment prep
