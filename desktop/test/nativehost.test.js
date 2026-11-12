'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hostFiles, NAME } = require('../src/server/nativereg');

const HOST = path.join(__dirname, '..', 'src', 'server', 'nativehost.js');
const frame = obj => { const b = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };
const answer = out => JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString());

test('native host: answers in Chrome framing, refuses anything but open and a missing launcher', () => {
  let r = spawnSync(process.execPath, [HOST, path.join(os.tmpdir(), 'no-such.vbs')], { input: frame({ cmd: 'open' }) });
  assert.match(answer(r.stdout).error, /launcher not found/);
  r = spawnSync(process.execPath, [HOST, 'x'], { input: frame({ cmd: 'read', path: 'C:/' }) });
  assert.deepEqual(answer(r.stdout), { ok: false, error: 'unknown command' });
});

test('native host manifest: only the paired extension may call it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-nh-'));
  const f = hostFiles(dir, 'inaidogffecccahcjagnjdmneimgknck');
  assert.equal(f.manifest.name, NAME);
  assert.deepEqual(f.manifest.allowed_origins, ['chrome-extension://inaidogffecccahcjagnjdmneimgknck/']);
  assert.match(f.batText, /nativehost\.js" ".*Tumblr Studio\.vbs"/);
});
