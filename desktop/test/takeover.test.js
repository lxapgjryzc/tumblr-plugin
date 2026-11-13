'use strict';
// Taking over the extension's reblog sync (A55): offered once, never switched on by itself; accepting creates
// the route, turns route automation on and reblogs only the side-blog posts the main blog is missing.
// All blogs, ids and tags are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service/service');
const { makeApi } = require('../src/service/api');
const { addTakeover } = require('../src/service/takeover');
const { makeFake } = require('./fake-tumblr');

test('reblog sync takeover: offered from the import, only the missed post is sent, then new posts follow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-to-'));
  const clock = { t: Date.UTC(2026, 10, 6, 12) };
  const now = () => clock.t;
  const fake = makeFake({ blogs: [{ uuid: 't:main', name: 'mainblog', primary: true }, { uuid: 't:side', name: 'sideblog' }], now });
  const svc = createService({ dataDir: dir, tumblr: fake, now });
  const extra = {};
  addTakeover(svc, extra, { dataDir: dir });
  const api = makeApi(svc, { extra });
  const run = async () => { for (let i = 0; i < 30; i++) { await svc.jobs.drain(svc.ctx); clock.t += 70e3; } };
  const pass = async () => { svc.pass(); await run(); };

  // the extension reblogged `done`; `missed` came after its background pass stopped
  const done = fake.addPost('t:side', { content: [{ type: 'text', text: 'done' }], timestamp: Math.floor((clock.t - 86400e3) / 1000) });
  await fake.reblog('t:main', { parentBlog: 't:side', parentId: done.id_string, reblogKey: 'k', tags: [] });
  const missed = fake.addPost('t:side', { content: [{ type: 'text', text: 'missed' }], timestamp: Math.floor((clock.t - 3600e3) / 1000) });
  await pass();
  svc.db.run(`UPDATE blogs SET role = 'share' WHERE uuid = 't:side'`);
  // an import like the user's: reblog sync on since a week ago
  fs.mkdirSync(path.join(dir, 'imports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'imports', 'extension-2026-11-06.json'), JSON.stringify({ format: 'tth-export', data: { settings: { syncReblogs: true }, autoSince: Math.floor((clock.t - 7 * 86400e3) / 1000) } }));

  const o = api.reblogTakeoverOffer();
  assert.ok(o, 'offered');
  assert.deepEqual(o.missed.map(m => m.id), [missed.id_string], 'only the post the main blog lacks');
  assert.equal(svc.db.getMeta('automation', {}).routes, undefined, 'nothing switched on by itself');
  const before = fake.posts.size;
  await pass();
  assert.equal(fake.posts.size, before, 'nothing sent before accepting');

  const r = api.reblogTakeover({ accept: true, ids: [missed.id_string] });
  assert.equal(r.queued, 1);
  await run();
  const copiesOf = id => [...fake.posts.values()].filter(p => p.blog.uuid === 't:main' && p.parent_post_id === id);
  assert.equal(copiesOf(missed.id_string).length, 1, 'the missed post is reblogged');
  assert.equal(copiesOf(done.id_string).length, 1, 'the one already there is not sent again');
  assert.equal(api.reblogTakeoverOffer(), null, 'offered once');

  // and from now on the route follows new posts
  clock.t += 60e3;
  const fresh = fake.addPost('t:side', { content: [{ type: 'text', text: 'fresh' }], timestamp: Math.floor(clock.t / 1000) });
  await pass();
  await pass();
  assert.equal(copiesOf(fresh.id_string).length, 1, 'a new side-blog post is reblogged automatically');
});
