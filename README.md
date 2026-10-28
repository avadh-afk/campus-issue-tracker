# CampusFix: Campus Issue Tracking and Resolution System

CampusFix helps students report campus problems, staff manage repairs, and administrators oversee progress through issue timelines, notifications, deadlines, and an audit trail.

**Stack:** Node.js 22.5+, Express, SQLite (`node:sqlite`), vanilla JavaScript, Leaflet, and OpenStreetMap.

## Run locally

```bash
npm install
cp .env.example .env
npm start          # http://localhost:3000
npm test           # automated unit and API tests
```

The starter loads `.env` automatically when that file exists. The database schema is created automatically. Set `JWT_SECRET` in `.env` to a long random value. `DB_FILE` and `UPLOAD_DIR` can be set to absolute paths if your development environment needs custom locations.

## Development accounts

On a new **non-production** database, CampusFix creates these convenience accounts unless `SEED_DEMO_USERS=false` is set:

| Role | Email | Password |
|---|---|---|
| Admin | admin@campusfix.com | admin123 |
| Staff (IT Support) | it.staff@campusfix.com | staff123 |
| Staff (Maintenance) | maint.staff@campusfix.com | staff123 |
| Student | student@campusfix.com | student123 |

These credentials are for local development only. Never reuse them in a publicly accessible deployment. Existing starter accounts using these default passwords are automatically disabled when running in production. Their old sessions are revoked too. Historical rows are kept so issue and audit records are not orphaned. Existing users may need to sign in again after upgrading because this build uses versioned session tokens.

## Production administrator setup

Before deploying a fresh production database, configure these as **secret environment variables in your host dashboard**, not in source code or GitHub:

- `NODE_ENV=production`
- `JWT_SECRET`: a cryptographically random secret of at least 32 characters.
- `ADMIN_EMAIL`: the email address you control for the first administrator.
- `ADMIN_PASSWORD`: a unique password of at least 16 characters.
- `ADMIN_NAME`: optional display name.

If there is no active administrator, the app creates one from the `ADMIN_*` variables. It does not overwrite an existing active administrator. On an older database, known demo accounts with their default passwords are disabled automatically; if you want to keep administering the deployment, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before the first deployment of this version.

New sign-ups are always students. An administrator can promote users and assign staff departments through the Users page. The application prevents an admin from demoting the final active administrator.

## Storage and hosting notes

`DB_FILE` selects the SQLite database file and `UPLOAD_DIR` selects the uploaded-photo directory. For a host with a mounted persistent volume, both paths should be inside that mount, for example:

```text
DB_FILE=/var/data/campusfix.db
UPLOAD_DIR=/var/data/uploads
```

**Render Free web services have an ephemeral filesystem and cannot attach persistent disks.** SQLite records and local uploads may be lost when the service restarts, spins down, or redeploys. Configure durable external storage before using the application for real campus reports. Render's free Postgres instances also have a limited lifetime, so confirm the current database plan and backup requirements before relying on it for long-term data. See [Render's free-service documentation](https://render.com/docs/free) and [persistent disk documentation](https://render.com/docs/disks).

## What is implemented

- Server-side student, staff, and administrator roles; inactive accounts are rejected even if an old JWT is still presented.
- Issue reporting with category, location, optional room, optional photo, map pin, and anonymous option.
- Status workflow, issue IDs, activity history, comments, one vote per user, and resolution feedback.
- Staff actions scoped to their department and administrator issue assignment.
- Category and priority suggestions plus duplicate-report suggestions using transparent keyword and text-similarity rules.
- Safety keywords that raise suggested priority to Critical.
- Configurable SLA hours, deadline warnings, and escalation notifications.
- Search, filters, pagination, a campus map, and role-specific dashboards.
- Administrator user/category/department/location management, SLA settings, audit log, and CSV export.
- Login/signup validation, rate limiting for selected actions, upload size/type/signature checks, safer HTTP headers, generic server errors, and authenticated photo retrieval.

## Campus map configuration

The initial database includes example building names but does not assign fabricated building-level coordinates. The map starts near Marwadi University, Rajkot. Before using CampusFix on campus, an administrator should open **Manage → Configure existing map locations** and enter verified coordinates for each building. Users can also mark a more precise point when submitting an issue.

Coordinates should be checked against a reliable campus map. Do not use approximate building pins as if they were exact locations.

## Known limitations

- **AI:** category/priority suggestions and duplicate detection use keyword and text-similarity rules, not an LLM.
- Authentication tokens are stored in browser `localStorage`; a future version could move to secure, HTTP-only cookies with CSRF protections.
- Rate limiting is in-process and designed for a single instance. Use a shared limiter if deploying multiple instances.
- The SQLite/local-upload setup is intended for a small demo. For a durable shared deployment, use a persistent database and durable file storage.
- Building coordinates must be verified by an administrator before location-based views are considered campus-accurate.
- The project does not yet include email notifications, a knowledge base, announcements, PDF export, working-hours-aware SLAs, or staff-uploaded resolution photographs.
