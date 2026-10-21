# CampusFix: Campus Issue Tracking and Resolution System

Students report campus problems, staff fix them, and admins oversee everything,
with a full audit trail, SLA deadlines and automatic escalation.

**Stack:** Node.js 22.5+, Express, SQLite (built-in `node:sqlite`), vanilla JS frontend, Leaflet + OpenStreetMap.

## Run
```bash
npm install
npm start          # http://localhost:3000
npm test           # unit tests + end-to-end API test
```
Optional: set `JWT_SECRET` (see `.env.example`). The database file `campusfix.db` is created and seeded on first start.

## Development accounts (seed data only, change before any real use)
| Role | Email | Password |
|---|---|---|
| Admin | admin@campusfix.com | admin123 |
| Staff (IT Support) | it.staff@campusfix.com | staff123 |
| Staff (Maintenance) | maint.staff@campusfix.com | staff123 |
| Student | student@campusfix.com | student123 |

New sign-ups are always students. Admins can promote users and assign a department on the Users page.

## What is implemented
- Roles (student / staff / admin) enforced **on the server**; roles are re-read from the database on every request
- Issue reporting: category, building, room, photo, map pin, anonymous option, IDs like `CIT-2026-0001`
- Status workflow with validated transitions and a full history (who, when, note)
- Staff can act only on their own department's issues; admins assign issues and change priority (audited)
- Resolution verification: staff mark fixed with a note, the student confirms or reopens, then rates the fix
- Upvotes (one per user, enforced by the database), comments, in-app notifications
- Duplicate detection and category/priority suggestions (rule-based, shown as suggestions, never blocks a report)
- Safety keywords (fire, exposed wire, ...) always raise priority to Critical regardless of votes
- Configurable SLA hours per priority; background job warns before and escalates after the deadline
- Campus map, filters, search, pagination
- Dashboards computed from real data: student, staff, admin (resolution time/rate, by category, building, department, 30-day trend)
- CSV export (no reporter identities), audit log, rate limiting, upload validation, generic error responses

## Database
`users, departments, categories, locations, issues, status_history, comments, votes, notifications, feedback, sla_policies, audit_logs`
(see `db.js`; schema is created automatically).

## Known limitations / not built yet
- **AI:** classification and duplicate detection use keyword and text-similarity rules, not an LLM. The code is isolated in `lib.js` so a model API can be added later.
- Not built yet: knowledge base, announcements, profile/notification settings page, email notifications, PDF export, working-hours-aware SLAs, staff-uploaded resolution photos, user-facing "assign/accept" for staff, CSRF is not needed because tokens are sent in headers, but tokens are stored in localStorage.
- Charts are simple CSS bars, not Recharts. SQLite suits a college deployment, not heavy load.
- Seed map coordinates are samples near Rajkot; add your real buildings on the Manage page.
