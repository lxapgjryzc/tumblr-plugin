'use strict';
// "Start with Windows" for the work environment: a value under HKCU\…\Run that starts the backend only (no
// page). Off unless the user turns it on. The command is the installed launcher script.
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const NAME = 'Tumblr Studio';
// the packaged layout puts "Tumblr Studio.vbs" in the folder above app/
const launcher = () => path.join(__dirname, '..', '..', '..', 'Tumblr Studio.vbs');

function get() {
  const r = spawnSync('reg', ['query', KEY, '/v', NAME], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && /REG_SZ/.test(r.stdout || '');
}
function set(on) {
  if (on) {
    const vbs = launcher();
    if (!fs.existsSync(vbs)) throw new Error('start with Windows needs the installed version (launcher not found)');
    const r = spawnSync('reg', ['add', KEY, '/v', NAME, '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}" background`, '/f'], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error('could not turn on start with Windows');
  } else spawnSync('reg', ['delete', KEY, '/v', NAME, '/f'], { encoding: 'utf8', windowsHide: true });
  return get();
}

module.exports = { get, set };
