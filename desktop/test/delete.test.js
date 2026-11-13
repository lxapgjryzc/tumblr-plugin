'use strict';
// The verified delete job (post.delete) when the answer is lost or the app restarts mid-send: it reads the post
// before sending again, and a 404 counts as deleted only when the same identity can still read the blog.
// All blogs and ids are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service/service');
const { addAiArt } = require('../src/service/aiart');
const { NetError, HttpError } = require('../src/service/errors');
const { postGone } = require('../src/service/gone');
const { makeFake } = require('./fake-tumblr');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-delete-'));
  const fake = makeFake({ blogs: [{ uuid: 't:main', name: 'mainblog', primary: true }, { uuid: 't:ref', name: 'refside' }] });
  const clock = { t: Date.now() };
  const svc = createService({ dataDir: dir, tumblr: fake, now: () => clock.t });
  addAiArt(svc, {});
  const orig = fake.addPost('t:painter', { blog: { uuid: 't:painter', name: 'painter' }, reblog_key: 'kp', tags: [] });
  const r = fake.addPost('t:ref', { tags: [], parent_post_id: orig.id_string, parent_tumblelog_uuid: 't:painter', reblog_key: 'kr' });
  svc.db.run(`INSERT OR REPLACE INTO blogs (uuid, name, role) VALUES ('t:ref', 'refside', 'material')`);
  svc.db.run(`INSERT OR REPLACE INTO posts (blog, id, kind, state, parent_blog, parent_id) VALUES ('t:ref', ?, 'reblog', 'published', 't:painter', ?)`, r.id_string, orig.id_string);
  const deletes = () => fake.calls.filter(c => c === 'delete:' + r.id_string).length;
  const runAll = async () => { for (let i = 0; i < 8; i++) { await svc.jobs.drain(svc.ctx); clock.t += 120e3; } };
  return { svc, fake, r, deletes, runAll };
}

test('delete: a lost answer leaves the job waiting; the next run finds the post gone and sends nothing again', async () => {
  const { svc, fake, r, deletes, runAll } = setup();
  const real = fake.deletePost;
  fake.deletePost = async (blog, id) => { await real(blog, id); throw new NetError('browser request failed', { uncertain: true }); };
  const id = svc.jobs.add('post.delete', { blog: 't:ref', id: r.id_string }, { priority: 2 });
  await svc.jobs.drain(svc.ctx);
  assert.equal(svc.jobs.get(id).status, 'waiting', 'uncertain: it waits instead of sending another way');
  fake.deletePost = real;
  await runAll();
  assert.equal(svc.jobs.get(id).status, 'succeeded');
  assert.equal(deletes(), 1, 'sent once');
  assert.equal(svc.db.get('SELECT state FROM posts WHERE id = ?', r.id_string).state, 'gone');
});

test('delete: interrupted by a restart, it reads first and does not delete twice', async () => {
  const { svc, fake, r, deletes, runAll } = setup();
  const id = svc.jobs.add('post.delete', { blog: 't:ref', id: r.id_string }, { priority: 2 });
  // the delete landed, then the app stopped before recording anything
  await fake.deletePost('t:ref', r.id_string);
  svc.db.run(`UPDATE jobs SET status = 'running' WHERE id = ?`, id);
  svc.jobs.recover();
  assert.equal(svc.jobs.get(id).status, 'pending');
  await runAll();
  assert.equal(svc.jobs.get(id).status, 'succeeded');
  assert.equal(deletes(), 1, 'only the delete before the restart');
});

test('delete: a 404 counts as gone only when the blog itself still reads', async () => {
  const t = { getPost: async () => { throw new HttpError('HTTP 404', { status: 404 }); }, postsPage: async () => ({ posts: [] }) };
  assert.equal(await postGone(t, 't:ref', '1'), true);
  t.postsPage = async () => { throw new HttpError('HTTP 404', { status: 404 }); };
  await assert.rejects(postGone(t, 't:wrong', '1'), HttpError, 'wrong blog or no access: not "deleted"');
  t.getPost = async () => ({ id_string: '1' });
  assert.equal(await postGone(t, 't:ref', '1'), false);
});
