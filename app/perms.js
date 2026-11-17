// perms.js - file ownership and switching away from root (container-specific).
//
// Problem: /data is a bind mount of a NAS folder. Its owner is whatever TOS
// decided (often root), so the unprivileged `node` user (uid 1000) may not be
// able to write to it, and fixing that by hand needs SSH.
//
// Approach (used by app.js): if we were started as root, make sure the data
// folder exists, hand it and everything inside it (app.db, its -journal file,
// backups/ and the backup files) to the `node` user, then permanently switch
// this process to `node` before opening the database or the port.
// If we were started as non-root (e.g. `user: "1000:1000"` in compose, or a
// local run on a PC), nothing happens.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// chown a folder and everything below it. lchown: never follow symlinks.
function chownTree(dir, uid, gid) {
  fs.lchownSync(dir, uid, gid);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) chownTree(full, uid, gid);
    else fs.lchownSync(full, uid, gid);
  }
}

// Permanently become uid/gid. Order matters: supplementary groups and the
// group must be changed while we are still root. setgroups() drops root's
// extra groups (e.g. gid 0), which setgid/setuid alone would leave in place.
function switchUser(uid, gid) {
  process.setgroups([gid]);
  process.setgid(gid);
  process.setuid(uid); // after this, root privileges cannot be regained
}

// Used by the web server at startup.
function dropPrivileges(dataDir, uid, gid) {
  if (!isRoot()) return false;
  fs.mkdirSync(dataDir, { recursive: true });
  chownTree(dataDir, uid, gid);
  switchUser(uid, gid);
  return true;
}

// Used by backup.js (run with `docker exec`, which starts it as root): become
// whoever owns the data folder, so new backup files are owned like the rest
// of /data. If the folder itself is owned by root, stay root.
function becomeDataOwner(dataDir) {
  if (!isRoot()) return null;
  const st = fs.statSync(dataDir);
  if (st.uid === 0) return null;
  switchUser(st.uid, st.gid);
  return { uid: st.uid, gid: st.gid };
}

module.exports = { isRoot, chownTree, switchUser, dropPrivileges, becomeDataOwner };
