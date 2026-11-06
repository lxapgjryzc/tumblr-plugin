'use strict';
// AI-made images among collected material (A55, R09): results stay in the app, nothing is written onto the
// reblogs; removing is a confirmed, verified delete of reblogs on material blogs only, plus the unlike.
// All blogs, ids and tags are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service/service');
const { makeApi } = require('../src/service/api');
const { addAiArt } = require('../src/service/aiart');
const { makeFake } = require('./fake-tumblr');

test('ai art: the poster’s own tags flag a collected reblog; nothing is written; delete + unlike only when asked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-aiart-'));
  const fake = makeFake({ blogs: [{ uuid: 't:main', name: 'mainblog', primary: true }, { uuid: 't:ref', name: 'refside' }] });
  const clock = { t: Date.now() };
  const svc = createService({ dataDir: dir, tumblr: fake, now: () => clock.t });
  svc.db.capability('edit.labels', 'not_used');
  const extra = {};
  addAiArt(svc, extra);
  const api = makeApi(svc, { extra });
  const run = async () => { for (let i = 0; i < 20; i++) { await svc.jobs.drain(svc.ctx); clock.t += 70e3; } };

  const aiOrig = fake.addPost('t:painter', { blog: { uuid: 't:painter', name: 'painter' }, reblog_key: 'kp', tags: ['ai art', 'landscape'] });
  const handOrig = fake.addPost('t:inker', { blog: { uuid: 't:inker', name: 'inker' }, reblog_key: 'ki', tags: ['my art', 'not ai'] });
  const reblogOf = o => fake.addPost('t:ref', { tags: ['reference'], parent_post_id: o.id_string, parent_tumblelog_uuid: o.blog.uuid, reblog_key: 'k' + o.id_string,
    trail: [{ blog: { uuid: o.blog.uuid, name: o.blog.name }, post: { id: o.id_string } }] });
  const r1 = reblogOf(aiOrig), r2 = reblogOf(handOrig);
  const mine = fake.addPost('t:ref', { tags: ['my study'] }); // an original on the material blog: never deleted here
  fake.likes = [{ ...aiOrig, liked_timestamp: 1 }];
  svc.pass();
  await run();
  svc.db.run(`UPDATE blogs SET role = 'material' WHERE uuid = 't:ref'`);

  const before = JSON.stringify([...fake.posts.values()].map(p => p.tags));
  const res = await api.aiArtCheck({ blog: 't:ref' });
  assert.equal(res.checked, 2);
  assert.equal(res.flagged, 1);
  const list = api.aiArtList({ blog: 't:ref' });
  assert.deepEqual(list.map(x => [x.id, x.verdict]), [[r1.id_string, 'ai']]);
  assert.equal(JSON.stringify([...fake.posts.values()].map(p => p.tags)), before, 'no post was edited');
  assert.equal(api.aiArtStatus({ blog: 't:ref' }).checked, 2);

  // only reblogs on material blogs are accepted
  assert.equal(api.aiArtRemove({ blog: 't:ref', ids: [mine.id_string] }).queued, 0);
  assert.equal(api.aiArtRemove({ blog: 't:ref', ids: [r1.id_string], unlike: true }).queued, 1);
  await run();
  assert.ok(!fake.posts.has(r1.id_string), 'the flagged reblog is deleted');
  assert.ok(fake.posts.has(r2.id_string) && fake.posts.has(mine.id_string), 'nothing else is');
  assert.equal(svc.db.get('SELECT state FROM posts WHERE id = ?', r1.id_string).state, 'gone');
  assert.equal(fake.likes.length, 0, 'the like it came from is taken back');
  assert.equal(svc.db.get(`SELECT status FROM jobs WHERE kind = 'post.delete'`).status, 'succeeded');
});
