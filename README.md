# Wedding Platform 0.2.0 – guest list

A small private web app for running a wedding's guest list, deployed as one
Docker container on the TerraMaster NAS. Version 0.2.0 ("Sprint 1") adds a
password-protected admin area with a guest list, CSV import/export and
backups, on top of the 0.1.0 status page (`/`) and health check (`/health`).

- Node.js only, no npm packages and no build step: only built-in modules
  (`node:http`, `node:sqlite`, `node:crypto`, ...). Runs on Node 26 (target)
  and Node 22.13 or newer.
- Base image `node:26-alpine` (Node 26 = current Active LTS).
- One container serves one wedding. Every guest row carries an `event_id`, so
  the same code can later run other weddings, one container each.

## Files

```
app/app.js              entry point: startup, privilege drop, routing, / and /health
app/config.js           all settings (environment variables) in one place
app/perms.js            data folder ownership; switching from root to the node user
app/db.js               opens SQLite, numbered schema migrations
app/guests.js           guest validation, CSV import rules, guest database queries
app/csv.js              CSV reading and writing
app/auth.js             admin password, sessions, CSRF tokens, login lockout
app/admin.js            the /admin pages
app/views.js            HTML for all pages (with escaping)
app/web.js              HTTP helpers, security headers, static files
app/backup.js           database backups (also runnable on its own)
app/public/style.css    the stylesheet
app/public/import.js    reads a chosen CSV file into the import form
tests/*.test.js         unit tests (node --test)
sample-guests.csv       fictional guests for trying the import
Dockerfile              image definition (Path B builds it)
docker-compose.yml      Path B: build from source over SSH
portainer-stack.yml     Path A: paste into Portainer, no build, no SSH
.env.example            settings for Path B (copy to .env)
.dockerignore           keeps data/.env/docs/tests out of the image build
.gitignore              keeps data, backups and .env out of Git
scripts/deploy.sh       Path B: build, start, wait for healthy
scripts/smoke-test.sh   checks from the NAS (or any Linux/macOS shell)
scripts/smoke-test.ps1  same checks from Windows PowerShell
data/                   created at first start; holds app.db and backups/
```

The code is CommonJS (`require` / `module.exports`): the mounted `app` folder
has no `package.json`, and without one Node treats `.js` files as CommonJS.

URLs: `http://192.168.2.40:8088/` (status page), `/health` (JSON),
`/admin` (admin area).

Use **one** deployment path at a time. Both create a project named `wedding`
with a container `wedding-web-1`; remove one before switching to the other.

---

## Upgrading from 0.1.0 (Path A)

Your existing database (`data\app.db`, with the visit counter) is upgraded in
place at the first start: the app adds the new tables and keeps the counter.
Nothing is deleted.

1. **Optional manual backup.** Portainer → Containers → `wedding-web-1` →
   **Stop**. In Explorer, copy `Z:\wedding\data\app.db` somewhere safe
   (e.g. `Documents\wedding-backup-0.1.0\app.db`). Leave the container
   stopped; step 3 starts it again. (0.1.0 has no backup button yet; from
   0.2.0 on, use the one on `/admin`.)
2. **Copy the new files** over `Z:\wedding` (= `/Volume1/docker/wedding`),
   replacing what is there: `app\` (now several `.js` files plus a `public\`
   folder), `scripts\`, `tests\`, `sample-guests.csv`, `portainer-stack.yml`,
   `docker-compose.yml`, `Dockerfile`, `.env.example`, `.dockerignore`,
   `.gitignore`, `README.md`. Do **not** delete or replace `Z:\wedding\data\`
   (the zip does not contain a `data` folder, so extracting it over the
   folder is safe).
3. **Update the stack.** Portainer → **Stacks** → `wedding` → **Editor**.
   Replace the whole text with the new `portainer-stack.yml`, then change
   `ADMIN_PASSWORD: "CHANGE_ME"` to a real password (see
   [Choosing the admin password](#choosing-the-admin-password)). Click
   **Update the stack**. A plain container restart is **not** enough this
   time: the environment variables changed, and only an update recreates the
   container with them.
4. **Check the logs** (Containers → `wedding-web-1` → Logs). The first start
   shows `applied migration 1`, `2`, `3` and `database schema version 3`.
   Then run the smoke test from your PC, with the password:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\smoke-test.ps1 -AdminPassword 'your password'
   ```

   All 10 checks should PASS, and the **Visits** number continues from where
   0.1.0 left off.
5. **Try it.** Open http://192.168.2.40:8088/admin, log in, click
   **Create backup now** (so you can undo the experiment), then go to
   **Import**, choose `sample-guests.csv`, look at the preview and import it.
   The sample guests are fictional; to remove them all again, restore the
   backup you just made (see [Backups](#backups-and-restore)), or delete them
   one by one.

**Going back to 0.1.0** (if something is wrong): put the old `app\app.js`
back, paste the old stack text in Portainer and update the stack. 0.1.0
ignores the new tables, so the guest data stays in the database for when you
upgrade again.

---

## Path A – Portainer only (no SSH), fresh install

1. In Windows Explorer, copy this folder's contents to
   `\\192.168.2.40\docker\wedding` so that you have
   `\\192.168.2.40\docker\wedding\app\app.js`.
2. Create an empty folder `\\192.168.2.40\docker\wedding\data`.
3. Portainer → **Stacks** → **Add stack**. Name: `wedding`. Build method:
   **Web editor**. Paste the contents of `portainer-stack.yml` and set
   `ADMIN_PASSWORD`.
4. Click **Deploy the stack**. The first deploy downloads the
   `node:26-alpine` image, which takes a little longer.
5. Portainer → **Containers**: `wedding-web-1` should show **healthy** after
   about 10–30 seconds.
6. Open http://192.168.2.40:8088

Settings are inline in the stack. Change them in Portainer → Stacks →
wedding → **Editor**, then **Update the stack**.

| Setting          | Default          | Meaning |
|------------------|------------------|---------|
| `APP_ENV`        | `dev`            | label shown on the pages |
| `EVENT_NAME`     | `Casey & Dustin` | the wedding's name |
| `ADMIN_PASSWORD` | `CHANGE_ME`      | admin password; empty or `CHANGE_ME` = admin disabled |
| `SIDE_A_LABEL`   | `Casey`          | label for side "a" of the guest list |
| `SIDE_B_LABEL`   | `Dustin`         | label for side "b" |
| `COOKIE_SECURE`  | `false`          | `true` only once the site is served over HTTPS |

### Choosing the admin password

Use a long passphrase made of letters, digits, spaces and dashes, e.g.
`velvet-harbor-orchid-1742`. Avoid `$`, `"`, `\` and `#`: in the stack (and in
`.env`) Docker Compose treats `$` as the start of a variable name, so
`ab$cd` would silently become `ab`. If you must use `$`, write it as `$$`.

## Path B – SSH

```sh
ssh -p 9222 <user>@192.168.2.40
cd /Volume1/docker/wedding
cp .env.example .env        # then edit .env (vi .env): set ADMIN_PASSWORD
sh scripts/deploy.sh
```

If `docker` reports "permission denied" on `/var/run/docker.sock`, run it as
`sudo sh scripts/deploy.sh` (same for the other `docker` commands below).

`deploy.sh` builds the image, starts the container, waits until it is healthy
and prints the status. It exits non-zero and shows the last log lines if the
container does not become healthy.

---

## Admin area

Log in at `/admin` (there is also an **Admin** link on the status page).
Everything under `/admin` except the login page redirects to the login page
when you are not logged in. A login lasts 12 hours; **Log out** ends it.

- **/admin** – links to everything, version / environment / event name /
  schema version, and the backup button with the list of backups.
- **Guests** (`/admin/guests`) – all guests sorted by last name, with the
  total and the count per side. Search matches first name, last name, full
  name, household and email. **Add guest**, **Edit** and **Delete** (delete
  asks for confirmation on a separate page).
- **Add / edit form** – first name or last name is required; email, if
  given, must look like `name@example.com`; phone is kept exactly as typed
  (only leading/trailing spaces removed); side is one of the two labels,
  Both, or Not set. Lengths: names 100, household 200, email 254, phone 50,
  notes 2000 characters. On an error the form is shown again with the
  messages and with what you typed.
- **Export CSV** (`/admin/guests/export.csv`) – downloads all guests.
- **Import** (`/admin/guests/import`) – see below.

The pages work on a phone (wide tables scroll sideways).

## CSV import

Choose a `.csv` file (the browser reads it into the text box) or paste the
text into the box, then click **Preview**. Without JavaScript the file picker
is hidden and pasting works the same way.

**Format.** The first line must be a header. Commas, semicolons (common in
European Excel) and tabs are all accepted; the app guesses from the header
line. Quoted values may contain commas, quotes (`""`) and line breaks. A
UTF-8 byte order mark is ignored. Files saved by Excel as plain
"CSV (Comma delimited)" are Windows-1252, not UTF-8; the file picker detects
that and reads them correctly. Blank lines are skipped. Limit: 5,000 rows per
import and about 1.5 MB of text.

**Column names** (any capitalisation; spaces, dashes and underscores are
ignored, so `First Name`, `first_name` and `FIRSTNAME` are the same):

| Field      | Accepted headers |
|------------|------------------|
| First name | first name, first, firstname, given name, forename |
| Last name  | last name, last, surname, family name |
| Full name  | name, full name, guest, guest name – used only if first and last name are both empty; split at the last space ("Mary Ann Smith" → "Mary Ann" + "Smith") |
| Household  | household, family, party, group |
| Email      | email, e-mail, email address, mail |
| Phone      | phone, mobile, cell, phone number, mobile phone, cell phone, telephone, tel |
| Side       | side, guest of, bride or groom |
| Notes      | notes, note, comments, comment |

Other columns are listed as "ignored". If two columns mean the same field,
the first one is used. **Side** values: `a`, `b`, `both`, or the two
configured labels (Casey / Dustin by default), any capitalisation. Anything
else, including "bride" and "groom" (unless a label is literally that), is
imported as "not set" with a warning.

**Preview.** Nothing is saved at this step. Every row gets a status:

| Status    | Meaning | Imported? |
|-----------|---------|-----------|
| OK        | fine | yes |
| Warning   | imported with a change: an unknown side was left empty, or an invalid email was **removed and its text added to the guest's notes** ("Invalid email from import: ...") so nothing is lost | yes |
| Error     | no first or last name, or a value too long | no |
| Duplicate | same first + last name (ignoring case) and the same email (ignoring case), or both without email, as an existing guest or an earlier row in the same file | no, unless you tick "Also import the duplicate rows" |

**Import.** The confirm button sends the same text back; the server reads and
checks it again (nothing shown on the preview page is trusted, and the guest
list may have changed meanwhile) and inserts all importable rows in one
transaction: all of them or none. The guest list then says how many were
added and skipped.

`sample-guests.csv` gives: 13 rows → 9 OK, 2 warnings (an invalid email, the
side "bride"), 1 error (no name), 1 duplicate → **11 guests added, 2 skipped**,
column `Table` ignored. Importing it a second time gives 12 duplicates and
1 error, nothing added.

## CSV export

UTF-8 with a byte order mark, so Excel shows accents correctly, with Windows
line endings. Columns: First name, Last name, Household, Email, Phone, Side
(as the label), Notes, Created (UTC), Updated (UTC).

Protection against "CSV injection": a value starting with `=`, `+`, `-`, `@`,
tab or carriage return could be run as a formula by Excel, so the export puts
a `'` in front of it (e.g. a phone number `+1 555 0100` is exported as
`'+1 555 0100`; Excel shows the text as-is). The import removes that `'`
again, so an exported file can be re-imported (it shows up as all
duplicates).

## Backups and restore

**Create:** `/admin` → **Create backup now**, or from the NAS:

```sh
docker exec wedding-web-1 node /app/backup.js
```

Both write `data/backups/app-YYYYMMDD-HHMMSS.db` (time in UTC) using SQLite's
`VACUUM INTO`, which makes a complete, consistent copy even while the app is
running. The newest 20 backups are kept; older ones are deleted
automatically. The `docker exec` command runs as root inside the container;
the script switches to the owner of `/data` first, so the backup files are
owned like the rest of the folder.

Backups are on the same disk as the database. Now and then, copy
`Z:\wedding\data\backups\` (or the newest file in it) to your PC or another
disk.

**Restore:**

1. Portainer → Containers → `wedding-web-1` → **Stop**.
2. In Explorer, copy the backup you want, e.g.
   `Z:\wedding\data\backups\app-20261116-140309.db`, over
   `Z:\wedding\data\app.db` (replace it). If there is a file
   `app.db-journal` next to it, delete it.
3. **Start** the container. Check the logs and the guest list.

Everything after the backup's time is lost (guests, and also any logins:
you will have to log in again).

## Smoke test

From Windows (PowerShell 5.1 or 7):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\smoke-test.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\smoke-test.ps1 -BaseUrl http://192.168.2.40:8088 -AdminPassword 'your password'
```

Run it from a local copy of the folder; running scripts directly from the
network share may be blocked by Windows.

From the NAS over SSH (needs `curl` for the logged-in checks):

```sh
sh scripts/smoke-test.sh                                   # default http://localhost:8088
sh scripts/smoke-test.sh http://192.168.2.40:8088 'your password'
ADMIN_PASSWORD='your password' sh scripts/smoke-test.sh
```

Checks: `/health` returns 200 with `"status":"ok"`; `/` returns 200; the visit
counter goes up between two loads; an unknown path returns 404;
`/admin/guests` without login redirects to the login page. With a password
also: login works; `/admin/guests` returns 200; a POST without CSRF token is
rejected with 403. Without a password those three print SKIP (not a
failure). The smoke test does not create, change or delete guests; it logs
in and out again. Note that a wrong password counts towards the login
lockout. Exit code 1 if anything failed.

## Unit tests

Needs Node 22.13 or newer on the machine where you run them (your PC, or
inside the container). From the project folder:

```sh
node --test
```

This finds and runs `tests/*.test.js` (CSV parsing and export escaping,
header aliases, validation, duplicate detection, the import plan for
`sample-guests.csv`, migrations from a 0.1.0 database and their idempotence,
guest queries, backups). On Node 22 you will see an `ExperimentalWarning`
about SQLite; that is expected. The tests are not inside the container
(Path A mounts only `app/`, Path B leaves `tests/` out of the image), so run
them on a PC with Node installed. (`node --test tests/` with a folder name
works on Node 26 but not on Node 22; plain `node --test` works on both.)

## Exercise: prove the data persists

1. Open the page and note the **Visits** number (say 7).
2. Restart the container:
   - Portainer: Containers → `wedding-web-1` → **Restart**
   - SSH: `docker compose restart web`
3. Reload the page. **Server started** has changed (new process), **Visits**
   shows 8, not 1. You are also still logged in to `/admin`: sessions are
   stored in the database.
4. Stronger version: remove and recreate the container (Portainer:
   Containers → `wedding-web-1` → Remove, then Stacks → wedding → Editor →
   **Update the stack**; SSH: `docker compose down && docker compose up -d`).
   The counter and the guests are still there, because they live in
   `data/app.db` on the NAS, not in the container.

## Logs

- Portainer: Containers → `wedding-web-1` → **Logs**.
- SSH: `docker compose logs -f web` (Ctrl+C to stop following).

Each request is one line: `timestamp METHOD path status` (the query string,
e.g. search text, is not logged). Docker's health check calls `/health` every
30 s, so a `GET /health 200` line every 30 s is normal. Logins, failed
logins, imports and backups are logged too.

## Updating after editing the code

- **Path A**: save the changed files to `\\192.168.2.40\docker\wedding\app\`,
  then Portainer → Containers → `wedding-web-1` → **Restart**. The code is
  mounted from the NAS folder, so no rebuild or pull is needed. If you changed
  `portainer-stack.yml` (settings), use Stacks → wedding → Editor →
  **Update the stack** instead.
- **Path B**: copy the new files to the NAS, then `sh scripts/deploy.sh`
  (rebuilds the image with the new code and replaces the container).
  A plain restart is not enough in Path B: the code is baked into the image.

Database changes go into a new numbered migration in `app/db.js`; never edit
a migration that has already run on the NAS.

## Version control

Git is not required to run the app, but it is the easy way to keep history.
On the PC, in the project folder:

```sh
git init
git add .
git commit -m "Wedding Platform 0.2.0"
```

`.gitignore` keeps `data/` (database and backups, i.e. guest data), `.env`
(password) and editor/OS junk out of the repository.

Running Git directly on the mapped network drive (`Z:\wedding`) tends to fail
with "detected dubious ownership in repository" (the share's files belong to
a NAS user, not your Windows user) and is slow. Two options:

1. Tell Git the folder is trusted. Git's error message prints the exact
   command for your path (something like
   `git config --global --add safe.directory Z:/wedding`); run that. Git on
   the share stays slow, though.
2. (Recommended) keep the repository in a local folder on the PC, e.g.
   `C:\Projects\wedding`, work and commit there, and copy the files to `Z:\wedding`
   to deploy.

## Security notes

- **One shared password.** Anyone who knows `ADMIN_PASSWORD` has full
  access; there are no separate users. The password sits in plain text in the
  Portainer stack definition (anyone with Portainer access can read it) and,
  for Path B, in `.env`.
- **Plain HTTP on the LAN.** The password, the session cookie and all guest
  data travel unencrypted over the home network. Anyone able to watch that
  traffic (e.g. on the Wi-Fi) could read them. This is acceptable only on a
  trusted home network.
- **Do not expose this to the internet** (port forwarding, etc.) until it is
  served over HTTPS (for example behind a reverse proxy with a certificate);
  then set `COOKIE_SECURE=true`.
- **Login lockout.** After 5 wrong passwords from one address, that address
  is locked out for 60 seconds (held in memory; a restart clears it).
  Depending on how Docker forwards the port, the app may see the same
  address (the Docker gateway) for every client, so the lockout can then
  apply to everyone, including you: just wait a minute.
- **Changing the password** does not end existing logins; they stay valid
  until they expire (at most 12 hours after they were made).
- What is in place: constant-time password comparison, random session tokens
  stored only as hashes, HttpOnly + SameSite cookies, CSRF tokens on every
  form that changes something, HTML escaping of all data, a strict
  Content-Security-Policy (no inline scripts), clickjacking protection,
  `no-store` caching for admin pages, 2 MB request limit, and the server
  process runs as an unprivileged user.

## Stop / remove

- Path A: Portainer → Stacks → wedding → **Stop** (keeps it) or **Delete**
  (removes container and network).
- Path B: `docker compose stop` (keeps it) or `docker compose down`
  (removes container and network). Add `docker image rm wedding-skeleton:local`
  to remove the built image.

Neither removes the `data` folder; the database and backups stay until you
delete them.

## Troubleshooting

**"Admin login is disabled"**: `ADMIN_PASSWORD` is empty or still
`CHANGE_ME` in the running container. Set it in the stack and click
**Update the stack** (a restart does not apply new settings).

**Login says "Wrong password" although it is right**: check for a `$` in the
password (see [Choosing the admin password](#choosing-the-admin-password)).
**Login seems to work but you land on the login page again**:
`COOKIE_SECURE` is `true` while you use `http://`; set it to `false`.
**"The form expired"**: your browser blocked cookies for the site, or the
login page was open for more than an hour; reload it.

**Port already in use** (`port is already allocated` / `address already in use`):
another service uses 8088. Path B: set `HOST_PORT=8090` (for example) in `.env`
and re-run `deploy.sh`. Path A: change `"8088:3000"` to `"8090:3000"` in the
stack editor and update the stack. Then use the new port in the URL and in the
smoke test.

**Permission denied on /data** (`EACCES`, `EPERM`, or `attempt to write a
readonly database` in the logs):
The container starts as root, gives the `data` folder and everything in it
(including `backups/`) to the `node` user (uid 1000) and then switches to
that user (see `app/perms.js`). This normally fixes ownership automatically.
It can still fail if:
- you added `user:` to the compose/stack file, so the app starts as non-root and
  cannot fix ownership. Remove it, or make `data` writable by uid 1000
  (SSH: `sudo chown -R 1000:1000 /Volume1/docker/wedding/data`).
- the volume does not allow `chown` (unusual for `/Volume1`). Check the log for
  `EPERM ... chown`.
Note the side effect: on the NAS, `data` and its files end up owned by uid 1000.
If that uid belongs to a TOS user, that user owns them; reading them over the
share as another user may need the share's permissions adjusted.

**"database schema version N is newer than this app supports"**: the database
was upgraded by a newer version of the app and you started an older one. Use
the newer version, or restore a backup made before the upgrade.

**Image pull failing** (`pull access denied`, `toomanyrequests`, timeouts):
- Check the NAS has internet and DNS (TOS network settings).
- Pull manually: Portainer → Images → Pull `node:26-alpine`, or SSH
  `docker pull node:26-alpine`.
- `toomanyrequests` is Docker Hub's anonymous rate limit; wait or log in to a
  Docker Hub account in Portainer (Registries).
- `no matching manifest`: the image is published for amd64 and arm64 only.
  Check the NAS CPU with `uname -m` (expect `x86_64` or `aarch64`).

**Scripts fail with `$'\r': command not found` or `not found`**: the `.sh`
file was saved with Windows line endings. Re-save it with LF line endings
(e.g. in VS Code, bottom-right "CRLF" → "LF").

**Container restarts in a loop**: look at the logs; the first lines after
`listening on port` or the error stack show the cause.
