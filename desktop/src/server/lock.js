'use strict';
// One executor per data folder (LOCAL_WEB_APP_SPEC 5.2, 5.5): a lock file in the data folder, created
// exclusively, holding the owner's pid. A lock whose process is gone is stale and taken over. The Electron
// shell takes the same lock, so the old and the new runtime can never manage one folder at the same time.

const fs = require('node:fs');
const path = require('node:path');

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function takeLock(dataDir, info = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'studio.lock');
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), ...info }));
      fs.closeSync(fd);
      const release = () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch {} };
      process.on('exit', release);
      return { release, update: more => fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), ...info, ...more })) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = readLock(dataDir);
      if (cur && cur.pid !== process.pid && alive(cur.pid)) return { held: cur };
      try { fs.unlinkSync(file); } catch {}
    }
  }
  throw new Error('could not take the data folder lock');
}

function readLock(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'studio.lock'), 'utf8')); } catch { return null; }
}

// A backend left running from an older install (or from another folder with the same version) is replaced by the
// launcher, so starting a new copy really runs the new copy (2026-11-15: a new package kept opening the old 0.6.13
// backend on the second computer). A newer backend is kept. Backends before 0.6.15 write no version: older.
const vnum = v => String(v || '0').split('.').map(n => parseInt(n, 10) || 0);
function vcmp(a, b) { const x = vnum(a), y = vnum(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; }
function outdatedBackend(lock, version, root) {
  const c = vcmp(version, lock?.version);
  return c > 0 || (c === 0 && String(lock?.root || '').toLowerCase() !== String(root).toLowerCase());
}

module.exports = { takeLock, readLock, alive, outdatedBackend };
