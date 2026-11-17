'use strict';
// The optional settings blog: two computers share their per-post display choices through one private post.
// All blogs, ids and tags are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service/service');
const { makeApi } = require('../src/service/api');
const { addSettingsSync, parseDoc, TAG } = require('../src/service/settingsync');
const display = require('../src/service/display');
const { makeFake } = require('./fake-tumblr');

const BLOGS = [{ uuid: 't:main', name: 'mainblog', primary: true }, { uuid: 't:art', name: 'artside' }, { uuid: 't:cfg', name: 'studiosettings' }];

function computer(fake, clock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ss-'));
  const svc = createService({ dataDir: dir, tumblr: fake, now: () => clock.t });
  const extra = {};
  addSettingsSync(svc, extra);
  const api = makeApi(svc, { extra });
  const run = async () => { for (let i = 0; i < 20; i++) { await svc.jobs.drain(svc.ctx); clock.t += 30e3; } };
  const pass = async () => { svc.pass(); await run(); };
  // the 30-second check the running app does: send new choices of this computer
  const tick = async () => { for (const f of svc.tickers) f(); await run(); };
  const disp = id => ({ ...svc.db.get('SELECT display, display_src FROM policies WHERE blog = ? AND id = ?', 't:art', id) });
  return { svc, db: svc.db, api, run, pass, tick, disp };
}
const doc = fake => {
  const posts = [...fake.posts.values()].filter(p => p.blog.uuid === 't:cfg');
  assert.equal(posts.length, 1, 'one settings post');
  return { post: posts[0], doc: parseDoc(posts[0]) };
};

test('settings blog: choices made on one computer reach the other; a first join with different choices asks; the blog is not a blog of works', async () => {
  const clock = { t: Date.UTC(2026, 10, 17) };
  const fake = makeFake({ blogs: BLOGS, now: () => clock.t });
  const A = fake.addPost('t:art', { content: [{ type: 'text', text: 'a' }], tags: ['art'] });
  const B = fake.addPost('t:art', { content: [{ type: 'text', text: 'b' }], tags: ['art'] });
  const A2 = fake.addPost('t:art', { content: [{ type: 'text', text: 'a2' }], tags: ['art'] });
  const one = computer(fake, clock), two = computer(fake, clock);
  await one.pass(); await two.pass();

  // computer two chose differently before the settings blog existed (a choice from before this version)
  two.db.run(`INSERT INTO policies (blog, id, display, updated_at) VALUES ('t:art', ?, 'keep_hidden', ?)`, A.id_string, clock.t);

  // one: keep A public, then pick the settings blog: a private post is made holding that choice
  one.api.keepVisible({ targets: [{ blog: 't:art', id: A.id_string }] });
  assert.throws(() => one.api.setSettingsBlog({ blog: 't:main' }), /main blog/);
  one.api.setSettingsBlog({ blog: 't:cfg' });
  await one.run();
  let d = doc(fake);
  assert.equal(d.post.state, 'private');
  assert.deepEqual(d.post.tags, [TAG]);
  assert.equal(d.doc.posts['t:art/' + A.id_string][0], 'keep_visible');
  await one.pass();
  assert.equal(one.db.get(`SELECT COUNT(*) n FROM posts WHERE blog = 't:cfg'`).n, 0, 'the settings blog is not read as posts');

  // two joins: A differs, so nothing is applied or sent for it until the user picks
  two.api.setSettingsBlog({ blog: 't:cfg' });
  await two.run();
  let st = two.api.settingsSyncStatus();
  assert.deepEqual(st.conflicts.map(c => [c.id, c.here, c.there]), [[A.id_string, 'keep_hidden', 'keep_visible']]);
  assert.equal(two.disp(A.id_string).display, 'keep_hidden');
  assert.equal(doc(fake).doc.posts['t:art/' + A.id_string][0], 'keep_visible', 'the post keeps the other choice meanwhile');
  await two.pass();
  assert.equal(two.api.settingsSyncStatus().conflicts.length, 1, 'later passes keep asking');

  // the user takes the settings blog's choice on two
  two.api.settingsSyncResolve({ keys: ['t:art/' + A.id_string], pick: 'there' });
  await two.run();
  assert.equal(two.disp(A.id_string).display, 'keep_visible');
  assert.equal(two.api.settingsSyncStatus().conflicts.length, 0);

  // steady state: a choice on two reaches one at its next sync
  clock.t += 60e3;
  two.api.visibility({ targets: [{ blog: 't:art', id: B.id_string }], target: 'private' });
  await two.tick();
  assert.equal(doc(fake).doc.posts['t:art/' + B.id_string][0], 'keep_hidden');
  await one.pass();
  assert.equal(one.disp(B.id_string).display, 'keep_hidden');
  // "keep public" on a post that stays public changes nothing on Tumblr: one learns it only from the settings blog
  two.api.keepVisible({ targets: [{ blog: 't:art', id: A2.id_string }] });
  await two.tick(); await one.pass();
  assert.deepEqual(one.disp(A2.id_string), { display: 'keep_visible', display_src: 'sync' });
  // back to the rules on one wins over the older choice everywhere
  clock.t += 60e3;
  one.api.followRule({ targets: [{ blog: 't:art', id: B.id_string }] });
  await one.tick(); await two.pass();
  assert.equal(two.disp(B.id_string).display, 'follow_rule');
  assert.equal(doc(fake).doc.posts['t:art/' + B.id_string][0], 'follow_rule');
});

test('settings blog: a hide made by the other computer\'s rule is not kept as a choice here; an unreadable post is never overwritten', async () => {
  const clock = { t: Date.UTC(2026, 10, 17) };
  const fake = makeFake({ blogs: BLOGS, now: () => clock.t });
  const C = fake.addPost('t:art', { content: [{ type: 'text', text: 'c' }], tags: ['art'] });
  const one = computer(fake, clock), two = computer(fake, clock);
  await one.pass(); await two.pass();
  one.api.setSettingsBlog({ blog: 't:cfg' }); await one.run();
  two.api.setSettingsBlog({ blog: 't:cfg' }); await two.run();

  // one's display rule hides C (as ops.visibility records a verified rule hide); two sees the hide first
  fake.posts.get(C.id_string).state = 'private';
  const p = display.policyOf(one.db, 't:art', C.id_string);
  p.auto_hide = { op: 1, rule: 1, revision: 1, prev: 'published', at: clock.t };
  display.savePolicy(one.db, p, clock.t);
  await two.pass();
  assert.deepEqual(two.disp(C.id_string), { display: 'keep_hidden', display_src: 'observed' }, 'taken for a hide made on Tumblr…');
  await one.tick();
  assert.ok(doc(fake).doc.auto['t:art/' + C.id_string]);
  await two.pass();
  assert.equal(two.disp(C.id_string).display, 'follow_rule', '…until the settings post says it was a rule hide');

  // someone edits the settings post by hand: it is read, not overwritten
  const post = doc(fake).post;
  post.content = [{ type: 'text', text: 'my notes' }];
  const puts = fake.calls.filter(c => c === 'put:' + post.id_string).length;
  one.api.keepVisible({ targets: [{ blog: 't:art', id: C.id_string }] });
  await one.tick();
  assert.match(one.api.settingsSyncStatus().error, /can't be read/);
  assert.equal(fake.calls.filter(c => c === 'put:' + post.id_string).length, puts, 'nothing written over it');
});
