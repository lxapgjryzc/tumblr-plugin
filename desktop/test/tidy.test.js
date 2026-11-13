'use strict';
// Tag upkeep in the app (moved from the extension's manager, A55): weak-tag cleanup, tidying by packs, pack
// review. Scans only read; edits are post.tags jobs on originals of sharing blogs; reblogs are never touched.
// All blogs, ids and tags are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service/service');
const { makeApi } = require('../src/service/api');
const { addTidy } = require('../src/service/tidy');
const { makeFake } = require('./fake-tumblr');

const PACK = {
  format: 'tth-template-pack', id: 'fx', name: 'Fandom X', version: '1', base: ['fandom x'],
  characters: [
    { id: 'ann', name: 'Ann', tags: ['ann fandom x', 'ann fx'], retired: ['ann old'] },
    { id: 'bo', name: 'Bo', tags: ['bo fandom x'] },
  ],
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tidy-'));
  const fake = makeFake({ blogs: [{ uuid: 't:main', name: 'mainblog', primary: true }, { uuid: 't:ref', name: 'refside' }] });
  const clock = { t: Date.now() };
  const svc = createService({ dataDir: dir, tumblr: fake, now: () => clock.t });
  const extra = {};
  addTidy(svc, extra, { fetchFn: async () => ({ ok: false, text: async () => '' }) });
  const api = makeApi(svc, { extra });
  const run = async () => { for (let i = 0; i < 20; i++) { await svc.jobs.drain(svc.ctx); clock.t += 70e3; } };
  return { fake, svc, api, run, db: svc.db, clock };
}
const lively = (tag, extra = []) => Array.from({ length: 20 }, () => ({ tags: [tag, ...extra], note_count: 50 }));

test('tidy: cleanup lists weak tags no pack knows, on originals only, and removes only the ticked ones (A55)', async () => {
  const s = setup();
  s.db.setMeta('packs', [{ raw: PACK, source: 'test' }]);
  const a = s.fake.addPost('t:main', { tags: ['fandom x', 'ann fandom x', 'deadtag', 'goodtag'] });
  const b = s.fake.addPost('t:main', { tags: ['deadtag', 'goodtag'] });
  s.fake.addPost('t:ref', { tags: ['deadtag'] });
  const rb = s.fake.addPost('t:main', { tags: ['deadtag'], parent_post_id: a.id_string, parent_tumblelog_uuid: 't:main', trail: [{ blog: { uuid: 't:main', name: 'mainblog' }, post: { id: a.id_string } }] });
  s.svc.pass();
  await s.run();
  s.db.run(`UPDATE blogs SET role = 'material' WHERE uuid = 't:ref'`);
  assert.equal(s.db.get('SELECT kind FROM posts WHERE id = ?', rb.id_string).kind, 'reblog');
  s.fake.tagged.goodtag = lively('goodtag', ['fandom x']); // lively and used in this fandom
  const r = await s.api.cleanupScan();
  const keys = r.results.map(x => x.key);
  assert.ok(keys.includes('deadtag'), 'a dead tag is listed: ' + JSON.stringify(r.results));
  assert.ok(!keys.includes('goodtag'), 'a lively tag is not: ' + JSON.stringify(r.results));
  assert.ok(!keys.includes('ann fandom x') && !keys.includes('fandom x'), 'tags a pack knows are never listed');
  assert.ok(s.db.getMeta('tagStats', {}).goodtag, 'samples are kept for the composer and the next scan');
  const pv = s.api.cleanupPreview({ tags: ['deadtag'] });
  assert.equal(pv.posts, 2, 'the two originals on the sharing blog, not the reblog or the material blog');
  assert.equal(s.api.cleanupApply({ tags: ['deadtag'] }).queued, 2);
  await s.run();
  assert.deepEqual(s.fake.posts.get(a.id_string).tags, ['fandom x', 'ann fandom x', 'goodtag']);
  assert.deepEqual(s.fake.posts.get(b.id_string).tags, ['goodtag']);
  assert.deepEqual(s.fake.posts.get(rb.id_string).tags, ['deadtag'], 'the reblog keeps its tags');
});

test('tidy: packs replace retired spellings and add missing search spellings, recomputed at run time (A55)', async () => {
  const s = setup();
  s.db.setMeta('packs', [{ raw: PACK, source: 'test' }]);
  const a = s.fake.addPost('t:main', { tags: ['fandom x', 'ann old', 'mine'] });
  s.svc.pass();
  await s.run();
  const plan = s.api.upkeepScan();
  assert.equal(plan.posts, 1);
  const retire = plan.rules.find(r => r.from === 'ann old');
  assert.ok(retire, 'the retired spelling is found: ' + JSON.stringify(plan.rules));
  assert.equal(retire.examples[0].id, a.id_string);
  s.api.upkeepApply({ rules: [retire.rule] });
  // a tag added on Tumblr before the job runs stays
  s.fake.posts.get(a.id_string).tags.push('added meanwhile');
  await s.run();
  const tags = s.fake.posts.get(a.id_string).tags;
  assert.ok(!tags.includes('ann old'), 'retired spelling gone: ' + tags);
  assert.ok(tags.includes('mine') && tags.includes('added meanwhile'), 'tags the pack does not know stay');
  assert.ok(tags.includes('ann fandom x'), 'replaced with the current spelling');
});

test('tidy: a category tag change can retag old originals in place, previewed and never automatic (design 6.3)', async () => {
  const s = setup();
  const a = s.fake.addPost('t:main', { tags: ['first', 'photograph', 'last'] });
  const b = s.fake.addPost('t:main', { tags: ['photograph', 'photo'] });
  const rb = s.fake.addPost('t:main', { tags: ['photograph'], parent_post_id: a.id_string, parent_tumblelog_uuid: 't:main', trail: [{ blog: { uuid: 't:main', name: 'mainblog' }, post: { id: a.id_string } }] });
  s.svc.pass();
  await s.run();
  assert.equal(s.api.retagPreview({ from: 'photograph', to: 'photo' }).posts, 2, 'the two originals, not the reblog');
  assert.equal(s.fake.posts.get(a.id_string).tags.join(), 'first,photograph,last', 'nothing changes from a preview');
  s.api.retagApply({ from: 'photograph', to: 'photo' });
  await s.run();
  assert.deepEqual(s.fake.posts.get(a.id_string).tags, ['first', 'photo', 'last'], 'replaced where it stood');
  assert.deepEqual(s.fake.posts.get(b.id_string).tags, ['photo'], 'no duplicate when the new tag is already there');
  assert.deepEqual(s.fake.posts.get(rb.id_string).tags, ['photograph'], 'the reblog keeps its tags');
});

test('tidy: pack review suggests changes and writes them into the pack, never leaving an item without tags (A55)', async () => {
  const s = setup();
  s.db.setMeta('packs', [{ raw: PACK, source: 'test' }]);
  s.fake.tagged['bo fandom x'] = lively('bo fandom x', ['other show']);
  s.fake.tagged['ann fandom x'] = lively('ann fandom x', ['fandom x', 'ann x']);
  s.fake.tagged['ann fx'] = lively('ann fx', ['fandom x']);
  s.fake.tagged['fandom x'] = lively('fandom x');
  s.fake.tagged['ann x'] = lively('ann x', ['fandom x']);
  const r = await s.api.packReview({ id: 'fx' });
  const bo = r.items.find(i => i.id === 'bo');
  assert.ok(bo?.remove.some(x => x.tag === 'bo fandom x' && x.reason === 'offtopic'), 'another fandom’s tag is suggested for removal: ' + JSON.stringify(r.items));
  const ann = r.items.find(i => i.id === 'ann');
  assert.ok(ann?.add.some(x => x.tag === 'ann x'), 'a spelling used together is suggested');
  const out = s.api.packReviewApply({ pack: 'fx', items: [{ id: 'bo', remove: ['bo fandom x'], add: [] }, { id: 'ann', add: ['ann x'], remove: [] }] });
  assert.deepEqual(out.keptOne, ['bo'], 'Bo keeps his only tag');
  const pack = s.db.getMeta('packs')[0];
  assert.ok(pack.edited);
  assert.deepEqual(pack.raw.characters.find(c => c.id === 'bo').tags, ['bo fandom x']);
  assert.ok(pack.raw.characters.find(c => c.id === 'ann').tags.includes('ann x'));
});

test('tags: general categories always go first, in their configured order; other tags keep their place', async () => {
  const s = setup();
  const g1 = Number(s.db.run("INSERT INTO category_groups (key, ord) VALUES ('subject', 0)").lastInsertRowid);
  const g2 = Number(s.db.run("INSERT INTO category_groups (key, ord) VALUES ('role', 1)").lastInsertRowid);
  s.db.run("INSERT INTO categories (name, tag, ord, group_id) VALUES ('Study', 'art study', 0, ?)", g2);
  s.db.run("INSERT INTO categories (name, tag, ord, group_id) VALUES ('Fanart', 'fanart', 0, ?)", g1);
  const a = s.fake.addPost('t:main', { tags: ['fandom x', 'ann fx'] });
  const b = s.fake.addPost('t:main', { tags: ['fandom x', 'art study', 'bo fx', 'Fanart'] });
  s.svc.pass(); await s.run();
  // a bulk add puts the category first, not at the end
  s.svc.jobs.add('post.tags', { blog: 't:main', id: a.id_string, add: ['art study'] });
  await s.run();
  assert.deepEqual(s.fake.posts.get(a.id_string).tags, ['art study', 'fandom x', 'ann fx']);
  // the one-off fix moves categories already on a post to the front, nothing else
  const { queueCategoryFirst } = require('../src/service/ops');
  assert.equal(queueCategoryFirst(s.db, s.svc.jobs), 1);
  await s.run();
  assert.deepEqual(s.fake.posts.get(b.id_string).tags, ['Fanart', 'art study', 'fandom x', 'bo fx']);
  assert.equal(queueCategoryFirst(s.db, s.svc.jobs), 0, 'nothing left to move');
});
