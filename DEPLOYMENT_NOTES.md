# CampusFix update: safe deployment checklist

This build changes production account handling. Do the environment setup **before** deploying this version.

## 1. Set the first administrator in Render

Open the CampusFix web service in Render → **Environment** and add:

- `NODE_ENV` = `production`
- `JWT_SECRET` = an existing strong random secret of at least 32 characters (keep it secret)
- `ADMIN_EMAIL` = an email address you control
- `ADMIN_PASSWORD` = a unique random password of at least 16 characters
- `ADMIN_NAME` = your preferred administrator display name (optional)

Do not paste real values into GitHub, source files, or screenshots. If the current deployment uses the old `admin@campusfix.com` demo account, you may use that exact email in `ADMIN_EMAIL` and set a new strong `ADMIN_PASSWORD`; the old demo account is disabled first and then securely reconfigured as the administrator. If you choose a new email, the app creates that administrator if no active administrator exists.

Existing active administrators are not overwritten by these variables. If an older default account was disabled, all its old tokens stop working. This build revokes prior session tokens, so users must log in again after deployment.

## 2. Understand data persistence before using real submissions

The application now supports `DB_FILE` and `UPLOAD_DIR` so you can place the SQLite database and photos under a persistent mount. Example paths, only when a persistent volume is actually attached:

```text
DB_FILE=/var/data/campusfix.db
UPLOAD_DIR=/var/data/uploads
```

Render Free web services cannot attach a persistent disk. Their local SQLite files and uploaded photos can be lost during a restart, spin-down, or redeploy. Setting the two paths above without a persistent mount does **not** make data durable. For a real campus deployment, configure durable external database and photo storage, or use an appropriate paid persistent disk, after checking cost and backup requirements.

If the current SQLite database contains data you need, back it up before deployment. Do not assume a Free Render filesystem will preserve it.

## 3. Update the GitHub project

1. Download and extract the updated project ZIP.
2. Copy the updated project files over your local `campus-issue-tracker` working folder. Keep any local `.env` file outside Git; do not copy secrets into source code.
3. In Git Bash, run `git status` and inspect the changes.
4. Run `npm install` and `npm test` locally.
5. Commit and push the changes to the existing `main` branch. Render will redeploy if auto-deploy is enabled.
6. After deployment, open the live site and test login, student signup, issue submission, photo viewing, user management, and location configuration.

## 4. Verify campus pins

The seeded building names do not have invented building-level coordinates. The map is centered near Marwadi University. After signing in as administrator, open **Manage → Configure existing map locations** and set verified latitude/longitude values for each building. Leave both values blank until you verify the location.

## 5. Limits of the current build

- Rate limiting is in-process and intended for one running application instance.
- Authenticated users can view issue attachments because issue details are shared with logged-in users.
- Local automated tests require installing the packages in `package.json`. The code package includes a production security regression test; run it after dependencies install.
