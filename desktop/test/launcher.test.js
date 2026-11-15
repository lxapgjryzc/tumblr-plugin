'use strict';
// The work environment's Chrome profile is the user's choice on each computer: asked on first open (exit code 3
// with a numbered list), recorded by `bind`, used from then on. Runs against a made-up Chrome profile list in a
// temporary folder; nothing is started or opened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeOpener, ChooseProfileError } = require('../src/server/chrome');

const LAUNCHER = path.join(__dirname, '..', 'src', 'server', 'launcher.js');

function fakeMachine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-launch-'));
  const userData = path.join(root, 'local', 'Google', 'Chrome', 'User Data');
  const cache = { Default: { name: 'Your Chrome', user_name: '' }, 'Profile 2': { name: 'Daily', user_name: 'someone@example.com' }, 'Profile 7': { name: 'Gone', user_name: '' } };
  for (const d of ['Default', 'Profile 2']) fs.mkdirSync(path.join(userData, d), { recursive: true });
  fs.writeFileSync(path.join(userData, 'Local State'), JSON.stringify({ profile: { info_cache: cache } }));
  const env = { ...process.env, APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'), STUDIO_LAUNCH_MSG: path.join(root, 'msg.txt') };
  const run = (...a) => { fs.rmSync(env.STUDIO_LAUNCH_MSG, { force: true }); const r = spawnSync(process.execPath, [LAUNCHER, ...a], { env, encoding: 'utf8' }); return { code: r.status, msg: fs.existsSync(env.STUDIO_LAUNCH_MSG) ? fs.readFileSync(env.STUDIO_LAUNCH_MSG, 'utf8') : '' }; };
  return { root, run, dataDir: path.join(env.APPDATA, 'Tumblr Studio') };
}

test('work profile: asked on first open, chosen by number, remembered; nothing starts before that', () => {
  const m = fakeMachine();
  const first = m.run('open');
  assert.equal(first.code, 3);
  assert.match(first.msg, /1 {3}Your Chrome {3}\(Default\)/);
  assert.match(first.msg, /2 {3}Daily {2}someone@example\.com {3}\(Profile 2\)/);
  assert.doesNotMatch(first.msg, /Gone/, 'a profile whose folder is missing is not offered');
  assert.ok(!fs.existsSync(path.join(m.dataDir, 'studio.lock')), 'no backend was started');
  const bad = m.run('bind', '9');
  assert.equal(bad.code, 3, 'a wrong number asks again');
  assert.match(bad.msg, /not one of the numbers/);
  assert.equal(m.run('bind', '2').code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.dataDir, 'browser.json'), 'utf8')).profileDir, 'Profile 2');
  // a later choice replaces it; the test environment's profile is fixed
  assert.equal(m.run('bind', 'Default').code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.dataDir, 'browser.json'), 'utf8')).profileDir, 'Default');
  assert.equal(m.run('bind', '1', '--env', 'test').code, 1);
});

test('opener without a fixed profile reads the recorded choice at each use', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-open-'));
  const o = makeOpener(dir, null);
  assert.throws(() => o.check(), ChooseProfileError);
  fs.writeFileSync(path.join(dir, 'browser.json'), JSON.stringify({ profileDir: 'Profile 99' }));
  assert.throws(() => o.check(), e => !(e instanceof ChooseProfileError));
});

test('a backend from an older install is replaced, a newer one is kept (2026-11-15)', () => {
  const { outdatedBackend } = require('../src/server/lock');
  const root = 'C:\Apps\Tumblr Studio\app';
  assert.equal(outdatedBackend({ pid: 1, port: 47823 }, '0.6.15', root), true, 'before 0.6.15 no version was written');
  assert.equal(outdatedBackend({ version: '0.6.13', root }, '0.6.15', root), true);
  assert.equal(outdatedBackend({ version: '0.6.9', root }, '0.6.10', root), true, 'numeric, not text order');
  assert.equal(outdatedBackend({ version: '0.6.15', root: root.toLowerCase() }, '0.6.15', root), false, 'same install');
  assert.equal(outdatedBackend({ version: '0.6.15', root: 'D:\old copy\app' }, '0.6.15', root), true, 'another folder');
  assert.equal(outdatedBackend({ version: '0.7.0', root: 'D:\old copy\app' }, '0.6.15', root), false, 'a newer one is kept');
});
