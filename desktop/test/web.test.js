'use strict';
// The local web backend (docs/LOCAL_WEB_APP_SPEC.md): access control (LW11), separate environments (LW16),
// pairing bound to the backend that issued the grant (LW17), one executor per data folder (LW09), image
// decoding without Electron (LW12). Made-up data only; nothing reaches Tumblr.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootStudio, listenFirst } = require('../src/service/boot');
const { makeWeb } = require('../src/server/web');
const { takeLock } = require('../src/server/lock');
const { decode, scale } = require('../src/server/media');

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

async function instance(name, ports) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-web-' + name + '-'));
  const vault = { encrypt: s => Buffer.from(s), decrypt: b => Buffer.from(b).toString() };
  let web;
  const studio = bootStudio({ dataDir, vault, media: null, fake: true, checkGrant: g => web.checkGrant(g) });
  web = makeWeb({ env: { name, test: name === 'test' }, dataDir, studio, controlToken: 'ctl-' + name, serveCompanion: (req, res) => { res.writeHead(200); res.end('companion'); },
    onStop: () => {}, extraApi: { pairingGrant: () => ({ grant: web.grant() }) } });
  const port = await listenFirst(web.server, ports);
  web.setPort(port);
  const base = `http://127.0.0.1:${port}`;
  const close = () => { web.server.closeAllConnections?.(); web.server.close(); studio.svc.stop(); studio.db.close(); };
  return { name, web, studio, port, base, dataDir, close };
}
async function login(i) {
  const { code } = await (await fetch(i.base + '/control/login-code', { method: 'POST', headers: { 'X-Studio-Control': 'ctl-' + i.name } })).json();
  const r = await fetch(i.base + '/login?code=' + code, { redirect: 'manual' });
  assert.equal(r.status, 302);
  return { cookie: r.headers.get('set-cookie').split(';')[0], code };
}
const callApi = (i, cookie, method, args, headers = {}) => fetch(i.base + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1', Origin: i.base, Cookie: cookie, ...headers }, body: JSON.stringify({ method, args }) });

test('access control: sessions, one-time codes, origin and CSRF header (LW11)', async () => {
  const w = await instance('work', [47891]);
  try {
    assert.equal((await fetch(w.base + '/api/call', { method: 'POST', headers: { 'X-Studio': '1' }, body: '{"method":"status"}' })).status, 401, 'no session');
    assert.equal((await fetch(w.base + '/control/status', { method: 'POST' })).status, 403, 'no control token');
    assert.equal((await fetch(w.base + '/control/status', { method: 'POST', headers: { 'X-Studio-Control': 'ctl-work', Origin: 'https://evil.example' } })).status, 403, 'control is never for pages');
    const { cookie, code } = await login(w);
    assert.equal((await fetch(w.base + '/login?code=' + code, { redirect: 'manual' })).status, 403, 'a code works once');
    assert.equal((await callApi(w, cookie, 'serverInfo')).status, 404, 'unknown methods are refused');
    const ok = await (await callApi(w, cookie, 'status')).json();
    assert.equal(ok.ok, true);
    assert.equal((await callApi(w, cookie, 'status', null, { Origin: 'https://evil.example' })).status, 403, 'foreign origin');
    assert.equal((await callApi(w, cookie, 'status', null, { 'X-Studio': '' })).status, 403, 'no CSRF header');
    // a forged Host (DNS rebinding) gets nothing, even with a valid session
    const http = require('node:http');
    const status = await new Promise(res => http.request({ host: '127.0.0.1', port: w.port, path: '/api/call', method: 'POST', headers: { Host: 'evil.example:' + w.port, Cookie: cookie, 'X-Studio': '1' } }, r => res(r.statusCode)).end('{"method":"status"}'));
    assert.equal(status, 403);
    // content needs a session too: assets and the companion page
    assert.equal((await fetch(w.base + '/asset/a123')).status, 401);
    assert.equal((await fetch(w.base + '/companion/')).status, 401);
    // the interface's code is public, its data isn't
    assert.equal((await fetch(w.base + '/ui.js')).status, 200);
    assert.equal((await fetch(w.base + '/../package.json')).status, 404);
    const html = await (await fetch(w.base + '/', { headers: { Cookie: cookie } })).text();
    assert.match(html, /<script src="web.js">/);
    assert.match(html, /connect-src 'self'/);
  } finally { w.close(); }
});

test('environments are separate: a work session opens nothing in test, and grants only pair their own backend (LW16, LW17)', async () => {
  const w = await instance('work', [47893]);
  const t = await instance('test', [47894]);
  try {
    const ws = await login(w), ts = await login(t);
    assert.equal((await callApi(t, ws.cookie, 'status')).status, 401, 'the work session is no key to test');
    assert.equal((await callApi(w, ts.cookie, 'status')).status, 401, 'nor the other way');
    const pair = (i, grant) => fetch(i.base + '/pair', { method: 'POST', headers: { Origin: EXT, 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, grant }) });
    assert.equal((await pair(w)).status, 403, 'no grant, no pairing');
    const tg = (await (await callApi(t, ts.cookie, 'pairingGrant')).json()).value.grant;
    assert.equal((await pair(w, tg)).status, 403, 'a test grant never pairs the work backend (same extension id)');
    const wg = (await (await callApi(w, ws.cookie, 'pairingGrant')).json()).value.grant;
    const r = await pair(w, wg);
    assert.equal(r.status, 200);
    assert.ok((await r.json()).token);
    assert.equal((await pair(w, wg)).status, 403, 'a grant works once');
    assert.equal(t.studio.db.getMeta('companion', null), null, 'the test backend stays unpaired');
  } finally { w.close(); t.close(); }
});

test('one executor per data folder (LW09)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lock-'));
  const a = takeLock(dir, { kind: 'web' });
  assert.ok(a.release);
  // another live process holding it: refused (simulated with this process's parent, which is alive)
  fs.writeFileSync(path.join(dir, 'studio.lock'), JSON.stringify({ pid: process.ppid, kind: 'electron' }));
  const b = takeLock(dir, { kind: 'web' });
  assert.equal(b.held.kind, 'electron');
  // a stale lock (process gone) is taken over
  fs.writeFileSync(path.join(dir, 'studio.lock'), JSON.stringify({ pid: 999999, kind: 'electron' }));
  const c = takeLock(dir, { kind: 'web' });
  assert.ok(c.release);
  c.release();
});

test('images decode and scale without Electron (LW12)', () => {
  const { PNG } = require('pngjs');
  const jpeg = require('jpeg-js');
  const png = new PNG({ width: 64, height: 32 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 200; png.data[i + 1] = 40; png.data[i + 2] = 40; png.data[i + 3] = 255; }
  const a = scale(decode(PNG.sync.write(png)), 16);
  assert.deepEqual([a.width, a.height], [16, 8]);
  assert.ok(Math.abs(a.data[0] - 200) < 2);
  const j = jpeg.encode({ data: Buffer.from(png.data), width: 64, height: 32 }, 90).data;
  const b = decode(j);
  assert.deepEqual([b.width, b.height], [64, 32]);
  assert.throws(() => decode(Buffer.from('GIF89a......')), /not readable/);
});
