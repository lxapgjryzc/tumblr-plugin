'use strict';
// Chrome native messaging host "com.tumblr_studio.launcher": lets the browser companion's toolbar icon start
// Tumblr Studio when it is not running. It does one thing: run the installed launcher ("Tumblr Studio.vbs open",
// the same as double-clicking it), which starts the backend if needed and opens the app page in the bound Chrome
// profile. No data passes through here and nothing else can be asked of it.
//
// Registered by the work backend of the installed version (nativereg.js) for the extension it is paired with.
// Chrome runs it through native-host.bat in the data folder: node nativehost.js <launcher.vbs>.

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const vbs = process.argv[2];

function reply(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]), () => process.exit(0));
}

let buf = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  if (buf.length < 4) return;
  const len = buf.readUInt32LE(0);
  if (buf.length < 4 + len) return;
  let msg = null;
  try { msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')); } catch {}
  if (msg?.cmd !== 'open') return reply({ ok: false, error: 'unknown command' });
  if (!vbs || !fs.existsSync(vbs)) return reply({ ok: false, error: 'launcher not found: ' + vbs });
  // wscript, detached: the launcher outlives this host, and its own dialogs (choose a profile, errors) still show
  spawn('wscript.exe', [vbs, 'open'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  reply({ ok: true });
});
process.stdin.on('end', () => process.exit(0));
