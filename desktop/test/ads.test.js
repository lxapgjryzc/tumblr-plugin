'use strict';
// Sponsored posts (Blaze ads) mixed into a blog's own post list by the web API: never stored as my posts, and
// the ones stored before the filter are removed with the jobs on them. Blogs, ids and texts are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../src/service/core');
const { makeTumblr } = require('../src/service/tumblr');
const { upsertPost } = require('../src/service/posts');
const { removeAds } = require('../src/service/ads');
const { createService } = require('../src/service/service');
const { makeFake } = require('./fake-tumblr');

// the shape seen on 2026-11-13: object_type post, another blog, ad fields
const ad = (id = '832690329598689280') => ({ object_type: 'post', type: 'blocks', id_string: id, id, blog_name: 'wordpress-blaze-1',
  blog: { name: 'wordpress-blaze-1', uuid: 't:adblog' }, show_sponsored_label: true, sponsored_badge_url: 'https://www.tumblr.com/docs/en/relevantads',
  adm: { native: {} }, content: [{ type: 'text', text: 'Dark Times Video Released' }], tags: [], timestamp: 1794000000, state: 'published' });
const mine = id => ({ object_type: 'post', id_string: id, id, blog_name: 'mainblog', blog: { name: 'mainblog', uuid: 't:main' }, content: [{ type: 'text', text: 'mine' }], tags: [], timestamp: 1794000000, state: 'published' });

test('ads: a sponsored post is not a post', () => {
  assert.equal(C.isPost(ad()), false);
  assert.equal(C.isSponsored({ object_type: 'post', id_string: '1', showSponsoredLabel: true }), true);
  assert.equal(C.isPost(mine('1')), true);
});

test('ads: a blog\'s post list keeps only that blog\'s own posts', async () => {
  const fetchFn = async () => ({ status: 200, ok: true, headers: { get: () => null },
    text: async () => JSON.stringify({ response: { posts: [mine('11'), ad('12'), { ...mine('13'), blog: { name: 'someoneelse', uuid: 't:x' }, blog_name: 'someoneelse' }] } }) });
  const T = makeTumblr({ creds: { accessToken: async () => 'tok', clientId: () => 'key' }, fetchFn });
  assert.deepEqual((await T.postsPage('t:main')).posts.map(p => p.id_string), ['11']);
  assert.deepEqual((await T.postsPage('MainBlog')).posts.map(p => p.id_string), ['11'], 'by name, any case');
});

test('ads: stored ads are removed with their revisions, deliveries and open jobs; my posts stay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ads-'));
  const fake = makeFake({ blogs: [{ uuid: 't:main', name: 'mainblog', primary: true }] });
  const svc = createService({ dataDir: dir, tumblr: fake });
  const db = svc.db;
  assert.equal(upsertPost(db, ad('900'), 't:main'), null, 'not stored any more');
  // stored the old way: insert as the sync used to
  db.run(`INSERT INTO posts (blog, id, kind, state, payload) VALUES ('t:main', '900', 'original', 'published', ?)`, JSON.stringify(ad('900')));
  upsertPost(db, mine('901'), 't:main');
  db.run(`INSERT INTO source_revisions (blog, id, rev, fingerprint, since, baseline, snapshot) VALUES ('t:main', '900', 1, 'f', 0, 1, '{}')`);
  db.run(`INSERT INTO deliveries (route_id, src_blog, src_id, rev, dest_blog, dest_id, status, at) VALUES (1, 't:main', '900', 1, 't:side', NULL, 'pending', 0)`);
  const hide = svc.jobs.add('post.visibility', { blog: 't:main', id: '900', target: 'private', reason: 'expiry' }, { scope: 'post:t:main:900' });
  const other = svc.jobs.add('post.visibility', { blog: 't:main', id: '901', target: 'private', reason: 'expiry' }, { scope: 'post:t:main:901' });
  const r = removeAds(db);
  assert.deepEqual(r, { removed: 1, cancelled: 1, kept: 0 });
  assert.equal(db.get(`SELECT 1 x FROM posts WHERE id = '900'`), undefined);
  assert.equal(db.get(`SELECT 1 x FROM source_revisions WHERE id = '900'`), undefined);
  assert.equal(db.get(`SELECT 1 x FROM deliveries WHERE src_id = '900'`), undefined);
  assert.equal(svc.jobs.get(hide).status, 'cancelled');
  assert.equal(svc.jobs.get(other).status, 'pending', 'jobs on my own posts stay');
  assert.ok(db.get(`SELECT 1 x FROM posts WHERE id = '901'`));
  assert.deepEqual(removeAds(db), { removed: 0 }, 'nothing left the next time');
});
