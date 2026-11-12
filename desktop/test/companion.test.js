'use strict';
// The browser companion's bridge (A53, A54) and material collection moved into the app (A55, R09).
// All blogs, ids and tags are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service/service');
const { makeApi } = require('../src/service/api');
const { addWriting } = require('../src/service/writing');
const { addData } = require('../src/service/data');
const { addMaterial } = require('../src/service/material');
const { makeBridge } = require('../src/service/bridge');
const C = require('../src/service/core');
const { makeFake, netFail } = require('./fake-tumblr');

const BLOGS = [{ uuid: 't:main', name: 'mainblog', primary: true }, { uuid: 't:art', name: 'artside' }, { uuid: 't:ref', name: 'refside' }];
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const IMG = url => ({ type: 'image', media: [{ url, width: 1280, height: 960 }] });

function setup({ approve = true, media = null, relay = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-c-'));
  const clock = { t: Date.UTC(2026, 10, 3) };
  const now = () => clock.t;
  const fake = makeFake({ blogs: BLOGS, now });
  const svc = createService({ dataDir: dir, tumblr: fake, now });
  svc.db.capability('edit.labels', 'not_used');
  const extra = {};
  addWriting(svc, extra, { dataDir: dir });
  addData(svc, extra, { dataDir: dir });
  addMaterial(svc, extra, { media: media || { pixels: async () => new Uint8ClampedArray(Array.from({ length: 64 * 4 }, (_, i) => [230, 40, 30, 255][i % 4])), dataUrl: async () => 'data:image/jpeg;base64,AAAA' }, aiKey: () => 'k' });
  const api = makeApi(svc, { extra });
  const opened = [];
  const bridge = makeBridge(svc, api, { version: 'test', relay, approve: async () => approve, onOpen: o => opened.push(o) });
  const run = async () => { for (let i = 0; i < 25; i++) { await svc.jobs.drain(svc.ctx); clock.t += 70e3; } };
  const call = (p, body = {}, { origin = EXT, host = '127.0.0.1:47823', auth = '' } = {}) => bridge.handle({ origin, host, auth, path: p, body: { v: 1, ...body } });
  return { dir, fake, svc, db: svc.db, api, bridge, run, call, clock, opened };
}

test('bridge: only a paired extension on loopback gets in; one operation id makes one job (A53)', async () => {
  const s = setup();
  s.svc.pass(); await s.run();
  // not loopback, a web page, a wrong protocol
  assert.equal((await s.call('/hello', {}, { host: 'evil.example:47823' })).status, 403);
  assert.equal((await s.call('/hello', {}, { origin: 'https://www.tumblr.com' })).status, 403);
  assert.equal((await s.bridge.handle({ origin: EXT, host: '127.0.0.1', path: '/hello', body: { v: 9 } })).status, 400);
  assert.equal((await s.call('/hello')).json.paired, false);
  assert.equal((await s.call('/snapshot')).status, 401, 'nothing before pairing');
  // pairing from a browser logged into another account is refused
  assert.equal((await s.call('/pair', { primary: 'someoneelse', code: '1234' })).status, 409);
  const pr = await s.call('/pair', { primary: 'mainblog', code: '1234' });
  assert.equal(pr.status, 200);
  const auth = 'Bearer ' + pr.json.token;
  assert.equal((await s.call('/snapshot', {}, { auth: 'Bearer nope' })).status, 401);
  assert.equal((await s.call('/snapshot', {}, { auth, origin: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba' })).status, 403, 'another extension');
  // the snapshot: read-only data for in-page help, versioned
  const snap = (await s.call('/snapshot', {}, { auth })).json;
  assert.ok(snap.version && snap.cache.blogs['t:main'] && Array.isArray(snap.categories) && snap.categories.some(c => c.tag === 'fanart'));
  assert.equal((await s.call('/snapshot', { have: snap.version }, { auth })).json.unchanged, true);
  // collect a post through a typed request; the same op again is the same job
  s.db.run(`UPDATE blogs SET role = 'material' WHERE uuid = 't:ref'`);
  s.api.saveCollect({ blog: 't:ref', tags: ['reference'] });
  const liked = s.fake.addPost('t:other', { blog: { uuid: 't:other', name: 'otherartist' }, content: [IMG('https://64.media.tumblr.com/abc/x/s1280x1920/a.jpg')], tags: ['painting'] });
  const req = { op: 'op-0001-collect', kind: 'collect', request: { blog: 'otherartist', id: liked.id_string } };
  const r1 = await s.call('/request', req, { auth });
  const r2 = await s.call('/request', req, { auth });
  assert.equal(r1.status, 200); assert.ok(r1.json.job.id);
  assert.equal(r2.json.repeated, true); assert.equal(r2.json.job.id, r1.json.job.id);
  assert.equal(s.svc.jobs.list({ status: 'open' }).filter(j => j.kind === 'material.collect').length, 1);
  await s.run();
  const res = await s.call('/result', { op: 'op-0001-collect' }, { auth });
  assert.equal(res.json.job.status, 'succeeded');
  // unknown kinds and malformed identities are refused; an account switch in the browser is refused
  assert.equal((await s.call('/request', { op: 'op-0002-x', kind: 'shell', request: {} }, { auth })).status, 400);
  assert.equal((await s.call('/request', { op: 'op-0003-c', kind: 'collect', request: { blog: '../x', id: '1' } }, { auth })).status, 400);
  assert.equal((await s.call('/status', { primary: 'otheraccount' }, { auth })).status, 409);
  // open in Studio
  const A = s.fake.addPost('t:art', { content: [{ type: 'text', text: 'mine' }] });
  s.svc.pass(); await s.run();
  await s.call('/request', { op: 'op-0004-open', kind: 'open', request: { blog: 'artside', id: A.id_string } }, { auth });
  assert.ok(s.opened[0]?.item, 'the app was asked to show that work');
});

test('bridge: a declined pairing gives nothing', async () => {
  const s = setup({ approve: false });
  assert.equal((await s.call('/pair', { code: '1234' })).status, 403);
  assert.equal((await s.call('/pair', {})).status, 403, 'no grant and no code: refused');
  assert.equal((await s.call('/status')).status, 401);
});

test('material: likes are collected with tags fixed before creation; skips, AI art and nothing written afterwards (R09, A55)', async () => {
  const s = setup();
  s.svc.pass(); await s.run();
  s.api.saveCollect({ blog: 't:ref', tags: ['reference', 'Reference'], auto: true });
  assert.equal(s.db.get(`SELECT role FROM blogs WHERE uuid = 't:ref'`).role, 'material');
  const since = s.api.collectSettings().since;
  const like = (fields, at) => { const p = s.fake.addPost(fields.blog.uuid, fields); s.fake.likes.push({ ...JSON.parse(JSON.stringify(p)), liked_timestamp: at }); return p; };
  const old = like({ blog: { uuid: 't:o1', name: 'oldone' }, content: [IMG('https://64.media.tumblr.com/o/x/s1280x1920/o.jpg')] }, since - 100);
  const pic = like({ blog: { uuid: 't:o2', name: 'painter' }, content: [IMG('https://64.media.tumblr.com/p/x/s1280x1920/p.jpg')], tags: ['oil'] }, since + 10);
  const txt = like({ blog: { uuid: 't:o3', name: 'writer' }, content: [{ type: 'text', text: 'words' }] }, since + 20);
  const ai = like({ blog: { uuid: 't:o4', name: 'genner' }, content: [IMG('https://64.media.tumblr.com/q/x/s1280x1920/q.jpg')], tags: ['ai art'] }, since + 30);
  const mine = like({ blog: { uuid: 't:art', name: 'artside' }, content: [IMG('https://64.media.tumblr.com/m/x/s1280x1920/m.jpg')] }, since + 40);
  s.svc.pass(); await s.run();
  const onRef = () => [...s.fake.posts.values()].filter(p => p.blog.uuid === 't:ref');
  assert.deepEqual(onRef().map(p => p.parent_post_id), [pic.id_string], 'only the new picture by someone else');
  const made = onRef()[0];
  assert.equal(made.tags[0], 'reference');
  assert.ok(made.tags.some(t => C.refGroupOf(t) === 'palette'), 'palette worked out before creation: ' + made.tags);
  const log = Object.fromEntries(s.api.collectLog().map(r => [r.src_id, r.status + (r.reason ? ':' + r.reason : '')]));
  assert.equal(log[txt.id_string], 'skipped:noImages');
  assert.equal(log[ai.id_string], 'skipped:aiArt');
  assert.equal(log[mine.id_string], 'skipped:mine');
  assert.ok(!log[old.id_string], 'likes from before switching on are left for an explicit choice');
  assert.ok(!s.fake.likes.some(p => p.id_string === ai.id_string), 'the AI-made like was taken back');
  // a second pass and a restart collect nothing twice
  s.svc.pass(); await s.run();
  assert.equal(onRef().length, 1);
  // AI tags and note are decided before creation, as part of the new reblog
  s.db.setMeta('settings', { ...s.db.getMeta('settings', {}), ai: { base: 'https://ai.test/v1', model: 'm' } });
  s.api.saveCollect({ ai: true });
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ light: ['backlight'], notes: 'sun behind' }) } }] }) });
  const pic2 = like({ blog: { uuid: 't:o5', name: 'photog' }, content: [IMG('https://64.media.tumblr.com/r/x/s1280x1920/r.jpg')] }, s.api.collectSettings().since + 5);
  try { s.svc.pass(); await s.run(); } finally { global.fetch = realFetch; }
  const made2 = onRef().find(p => p.parent_post_id === pic2.id_string);
  assert.ok(made2.tags.includes('backlight') && made2.tags.includes(C.AI_MARK), made2.tags.join());
  assert.ok(made2.content.some(b => b.text?.startsWith(C.AI_NOTE_MARK)), 'the note is part of the reblog as created');
  assert.ok(!s.fake.calls.some(c => c.startsWith('put:')), 'no collected reblog is ever edited');
});

test('material: a lost collect response is found on the material blog, not sent twice', async () => {
  const s = setup();
  s.svc.pass(); await s.run();
  s.api.saveCollect({ blog: 't:ref', tags: ['reference'] });
  const p = s.fake.addPost('t:o2', { blog: { uuid: 't:o2', name: 'painter' }, content: [IMG('https://64.media.tumblr.com/p/x/s1280x1920/p.jpg')] });
  const orig = s.fake.reblog;
  let sent = 0;
  s.fake.reblog = async (...a) => { sent++; await orig(...a); throw netFail(true); };
  s.api.collect({ posts: [JSON.parse(JSON.stringify(p))] });
  await s.run();
  s.fake.reblog = orig;
  await s.run();
  assert.equal(sent, 1);
  assert.equal([...s.fake.posts.values()].filter(q => q.blog.uuid === 't:ref').length, 1);
  assert.equal(s.api.collectLog()[0].status, 'created');
  // asking again for the same original does nothing
  assert.equal(s.api.collect({ posts: [JSON.parse(JSON.stringify(p))] }).queued, 0);
});

test('migration: the extension export brings collecting over switched off (A55)', async () => {
  const s = setup();
  s.svc.pass(); await s.run();
  const exp = { format: 'tth-export', version: 1, extension: '0.10.0', data: { settings: { collect: { blog: 't:ref', auto: true, tags: ['ref'], imagesOnly: true }, blogRoles: {} }, collectSince: 123, packs: [] } };
  s.api.importExtension({ data: exp });
  const c = s.api.collectSettings();
  assert.equal(c.blog, 't:ref'); assert.deepEqual(c.tags, ['ref']); assert.equal(c.auto, false, 'never resumes on its own');
  assert.equal(s.db.get(`SELECT role FROM blogs WHERE uuid = 't:ref'`).role, 'material');
  assert.equal(s.fake.calls.filter(x => /put|reblog|create|POST/.test(x)).length, 0);
});

test('companion page: the app serves the extension page files from a fixed list, loopback only, strict CSP', async () => {
  const http = require('node:http');
  const { makeCompanionPage } = require('../src/service/companion-page');
  const server = http.createServer(makeCompanionPage([path.join(__dirname, '..', '..', 'extension')]));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (p, host = '127.0.0.1:' + port) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, r => {
    let body = ''; r.on('data', c => { body += c; }); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body }));
  }).on('error', rej));
  try {
    const page = await get('/companion/');
    assert.equal(page.status, 200);
    assert.match(page.body, /name="tumblr-studio-companion"/);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal((await get('/companion/companion-ops.js')).status, 200);
    assert.equal((await get('/companion/core.js')).status, 200);
    assert.equal((await get('/')).headers.location, '/companion/');
    assert.equal((await get('/companion/manifest.json')).status, 404, 'only the listed files');
    assert.equal((await get('/companion/../manifest.json')).status, 404);
    assert.equal((await get('/companion/', 'evil.example:' + port)).status, 403, 'no DNS rebinding');
  } finally { server.close(); }
});

test('bridge: the browser relay is for the paired extension only and lists the account blogs', async () => {
  const { makeRelay } = require('../src/service/relay');
  const relay = makeRelay();
  const s = setup({ relay });
  s.svc.pass(); await s.run();
  assert.equal((await s.call('/relay/next', { wait: 0 })).status, 401, 'nothing before pairing');
  const { token } = (await s.call('/pair', { primary: 'mainblog', code: '1234' })).json;
  const auth = 'Bearer ' + token;
  // the same extension id in another Chrome profile, with an older token, isn't the paired browser
  assert.equal((await s.call('/hello', {}, { auth: 'Bearer stale' })).json.paired, false);
  assert.equal((await s.call('/hello', {}, { auth })).json.paired, true);
  const empty = await s.call('/relay/next', { wait: 0, primary: 'mainblog' }, { auth });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.items, []);
  assert.ok(empty.json.blogs.includes('t:art') && empty.json.blogs.includes('artside'));
  assert.ok(relay.available(), 'a poll makes the browser count as connected');
  const p = relay.send({ method: 'GET', path: '/v2/blog/artside/posts/1', query: {} });
  const got = await s.call('/relay/next', { wait: 0, primary: 'mainblog' }, { auth });
  assert.equal(got.json.items.length, 1);
  await s.call('/relay/done', { answers: [{ rid: got.json.items[0].rid, status: 200, text: '{"response":{}}' }], primary: 'mainblog' }, { auth });
  assert.equal((await p).status, 200);
});

test('material: an automatic collect queued before collecting was switched off sends nothing; a manual one still goes', async () => {
  const s = setup();
  s.svc.pass(); await s.run();
  s.api.saveCollect({ blog: 't:ref', tags: ['reference'], auto: true });
  const p = s.fake.addPost('t:o2', { blog: { uuid: 't:o2', name: 'painter' }, content: [IMG('https://64.media.tumblr.com/p/x/s1280x1920/p.jpg')] });
  const post = { ...JSON.parse(JSON.stringify(p)), id: p.id_string };
  s.svc.jobs.add('material.collect', { root: 't:o2/' + p.id_string, dest: 't:ref', post, manual: false }, { scope: 'collect:t:o2/' + p.id_string });
  s.api.saveCollect({ auto: false });
  await s.run();
  const onRef = () => [...s.fake.posts.values()].filter(q => q.blog.uuid === 't:ref');
  assert.equal(onRef().length, 0);
  assert.equal(s.svc.jobs.list({}).find(j => j.kind === 'material.collect').status, 'cancelled');
  s.svc.jobs.add('material.collect', { root: 't:o2/' + p.id_string, dest: 't:ref', post, manual: true }, { scope: 'collect:m:' + p.id_string });
  await s.run();
  assert.equal(onRef().length, 1, 'a manual collect is not blocked by the automatic switch');
});
