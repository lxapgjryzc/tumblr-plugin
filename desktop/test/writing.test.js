'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service/service');
const { makeApi } = require('../src/service/api');
const { addWriting, compile, composeTags, normaliseDoc } = require('../src/service/writing');
const { makeFake, netFail } = require('./fake-tumblr');

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-w-'));
  const clock = { t: Date.now() };
  const fake = makeFake({ blogs: [{ uuid: 't:main', name: 'mainblog', primary: true }, { uuid: 't:art', name: 'artside' }], now: () => clock.t });
  const svc = createService({ dataDir: dir, tumblr: fake, now: () => clock.t });
  const extra = {};
  addWriting(svc, extra, { dataDir: dir });
  const api = makeApi(svc, { extra });
  const run = async () => { for (let i = 0; i < 20; i++) { await svc.jobs.drain(svc.ctx); clock.t += 70e3; } };
  return { dir, fake, svc, api, run, clock };
}

test('compile: order, rows, read-more, code-point formatting (A23, A43)', () => {
  const doc = { blocks: [
    { id: 't1', type: 'text', text: '中文 🎨 bold', formatting: [{ type: 'bold', start: 5, end: 9 }] },
    { id: 'i1', type: 'image', asset: 'a1', alt: 'first' },
    { id: 'i2', type: 'image', asset: 'a2' },
    { id: 'i3', type: 'image', asset: 'a1' },          // the same file again: its own occurrence
    { id: 'rm', type: 'readmore' },
    { id: 't2', type: 'text', text: 'after', subtype: 'heading2' },
    { id: 't3', type: 'text', text: '' },
  ], rows: [['i1', 'i2']] };
  const assets = new Map([['a1', { exists: true, mime: 'image/png', width: 10, height: 10 }], ['a2', { exists: true, mime: 'image/jpeg' }]]);
  const c = compile(doc, assets);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.content.map(b => b.type), ['text', 'image', 'image', 'image', 'text']);
  assert.deepEqual(c.content[0].formatting, [{ type: 'bold', start: 5, end: 9 }]);
  assert.deepEqual(c.content.slice(1, 4).map(b => b.media[0].identifier), ['i1', 'i2', 'i3']);
  assert.equal(c.content[1].alt_text, 'first');
  assert.deepEqual(c.layout[0].display.map(r => r.blocks), [[0], [1, 2], [3], [4]]);
  assert.equal(c.layout[0].truncate_after, 3);
  // a missing file is reported at its block
  const c2 = compile(doc, new Map([['a1', { exists: true }]]));
  assert.deepEqual(c2.problems, [{ block: 'i2', problem: 'missing_image' }]);
});

test('rows: moving an image away splits the row; rows never exceed 3 or join non-neighbours (A40)', () => {
  const doc = normaliseDoc({ blocks: [
    { id: 'i1', type: 'image' }, { id: 't', type: 'text', text: 'x' }, { id: 'i2', type: 'image' }, { id: 'i3', type: 'image' },
  ], rows: [['i1', 'i2', 'i3']] });
  assert.deepEqual(doc.rows, [['i2', 'i3']]);
  const four = normaliseDoc({ blocks: ['a', 'b', 'c', 'd'].map(id => ({ id, type: 'image' })), rows: [['a', 'b', 'c', 'd']] });
  assert.deepEqual(four.rows, [['a', 'b', 'c']]);
});

test('tags: category first, template, then extras; duplicates keep the earliest (A21)', () => {
  const r = composeTags({ categories: ['fanart'], template: ['example series', 'Fanart', 'character alpha'], extra: ['weekend sketch', 'FANART', 'character alpha'] });
  assert.deepEqual(r.map(x => x.tag), ['fanart', 'example series', 'character alpha', 'weekend sketch']);
  assert.deepEqual(r.map(x => x.from), ['category', 'template', 'template', 'extra']);
});

test('publish: a frozen revision, tags in order, verified; a lost response is found, not reposted (A01, A26)', async () => {
  const { fake, svc, api, run, dir } = setup();
  svc.pass(); await run();
  svc.db.run(`UPDATE blogs SET role = 'share'`);
  const cat = api.categories().find(c => c.tag === 'fanart');
  const d = api.newDraft({ blog: 't:art' });
  const a = api.addAsset({ draftId: d.id, mime: 'image/png', bytes: PNG, width: 1, height: 1 });
  const doc = { v: 1, blocks: [{ id: 'x1', type: 'text', text: 'hello 你好' }, { id: 'x2', type: 'image', asset: a.id, alt: 'a picture' }], rows: [] };
  const r0 = api.saveDraft({ id: d.id, doc, options: { categoryIds: [] }, revision: d.revision, blog: 't:art' });
  api.saveDraft({ id: d.id, doc, options: { categoryIds: [cat.id], extra: ['wip', 'Fanart'] }, revision: r0.revision, blog: 't:art' });
  api.publish({ id: d.id, mode: 'private' });
  await run();
  const created = [...fake.posts.values()].filter(p => p.blog.uuid === 't:art');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].tags, ['fanart', 'wip']);
  assert.equal(created[0].state, 'private');
  assert.deepEqual(created[0]._files, ['x2']);
  const after = api.draft({ id: d.id });
  assert.equal(after.status, 'published');
  assert.deepEqual(svc.jobs.list({}).filter(j => j.kind === 'post.publish').map(j => [j.status, j.error]), [['succeeded', null]]);
  // remembered for the next post on that blog, not applied to other drafts
  assert.deepEqual(api.newDraft({ blog: 't:art' }).options.categoryIds, [cat.id]);

  // lost response: the post exists but the app never heard back
  const d2 = api.newDraft({ blog: 't:art' });
  api.saveDraft({ id: d2.id, doc: { v: 1, blocks: [{ id: 'y', type: 'text', text: 'second post' }], rows: [] }, options: { categoryIds: [cat.id] }, revision: d2.revision, blog: 't:art' });
  const orig = fake.createPost;
  fake.createPost = async (...args) => { await orig(...args); throw netFail(true); };
  api.publish({ id: d2.id });
  await run();
  fake.createPost = orig;
  assert.equal([...fake.posts.values()].filter(p => p.content?.[0]?.text === 'second post').length, 1, 'not posted twice');
  assert.equal(api.draft({ id: d2.id }).status, 'published');
  // restart keeps everything
  svc.stop(); svc.db.close();
  const svc2 = createService({ dataDir: dir, tumblr: fake });
  const extra2 = {}; addWriting(svc2, extra2, { dataDir: dir });
  assert.equal(extra2.draft({ id: d.id }).status, 'published');
});

test('drafts: autosave revisions reject a stale writer; images are stored once by content', () => {
  const { api } = setup();
  const d = api.newDraft({});
  const r1 = api.saveDraft({ id: d.id, doc: { blocks: [{ id: 'a', type: 'text', text: 'one' }] }, revision: d.revision });
  assert.throws(() => api.saveDraft({ id: d.id, doc: { blocks: [] }, revision: d.revision }), /conflict/);
  api.saveDraft({ id: d.id, doc: { blocks: [{ id: 'a', type: 'text', text: 'two' }] }, revision: r1.revision });
  const x = api.addAsset({ draftId: d.id, mime: 'image/png', bytes: PNG });
  const y = api.addAsset({ draftId: d.id, mime: 'image/png', bytes: PNG });
  assert.equal(x.id, y.id);
  assert.throws(() => api.addAsset({ draftId: d.id, mime: 'text/html', bytes: Buffer.from('<script>') }), /unsupported/);
});

test('publish: a lost response with nothing found stays unknown until you resolve it; lookalikes do not count (A19, A26)', async () => {
  const { fake, svc, api, run, clock } = setup();
  svc.pass(); await run();
  svc.db.run(`UPDATE blogs SET role = 'share'`);
  const cat = api.categories().find(c => c.tag === 'fanart');
  // an older post and a new one with the same first line but a different second block: neither is the post
  fake.addPost('t:art', { tags: ['fanart'], content: [{ type: 'text', text: 'same start' }], timestamp: Math.floor(clock.t / 1000) - 3600 });
  const d = api.newDraft({ blog: 't:art' });
  api.saveDraft({ id: d.id, doc: { v: 1, blocks: [{ id: 'a', type: 'text', text: 'same start' }, { id: 'b', type: 'text', text: 'second line' }], rows: [] }, options: { categoryIds: [cat.id] }, revision: d.revision, blog: 't:art' });
  const orig = fake.createPost;
  fake.createPost = async (blog, json) => {
    fake.addPost(blog, { tags: ['fanart'], content: [json.content[0], { type: 'text', text: 'other' }], timestamp: Math.floor(clock.t / 1000) });
    throw netFail(true);
  };
  api.publish({ id: d.id });
  for (let i = 0; i < 5; i++) { await run(); clock.t += 3600e3; }
  fake.createPost = orig;
  const job = () => svc.jobs.list({}).find(j => j.kind === 'post.publish');
  assert.equal(job().status, 'unknown', 'never turned into failed by itself');
  assert.match(job().error, /check on Tumblr/);
  assert.equal(api.draft({ id: d.id }).status, 'publishing');
  assert.throws(() => api.reopenDraft({ id: d.id }), /unknown/);
  assert.equal(svc.jobs.cancel(job().id), false, 'an unknown create cannot just be cancelled');
  assert.equal(api.resolveJob({ id: job().id }), true);
  assert.equal(job().status, 'failed');
  assert.equal(api.draft({ id: d.id }).status, 'failed');
  api.reopenDraft({ id: d.id });
  assert.equal(api.draft({ id: d.id }).status, 'editing');
});

test('categories: optional groups, configured order, display names apart from tags, no gate (A48, A49)', async () => {
  const { fake, svc, api, run } = setup();
  svc.pass(); await run();
  svc.db.run(`UPDATE blogs SET role = 'share'`);
  const groups = api.categoryGroups();
  assert.deepEqual(groups.map(g => g.key), ['subject', 'role', 'course', 'record', 'form']);
  const by = name => api.categories().find(c => c.name === name);
  assert.equal(by('同人').tag, 'fanart');
  assert.equal(by('日记').tag, 'diary');
  // course, role and subject are independent: a course assignment can be a formal original work, fanart a study
  const pick = ids => api.composeTags({ categoryIds: ids, extra: ['weekend sketch', 'FANART'] }).tags.map(x => x.tag);
  assert.deepEqual(pick([by('猹鱼日绘').id, by('习作').id, by('原创').id]), ['original art', 'art study', '猹鱼日绘', 'weekend sketch', 'FANART']);
  assert.deepEqual(pick([by('习作').id, by('同人').id]), ['fanart', 'art study', 'weekend sketch'], 'click order does not matter; fanart appears once, in the prefix');
  // a display-name edit keeps the tag
  api.saveCategory({ id: by('同人').id, name: 'Fan art' });
  assert.equal(api.categories().find(c => c.name === 'Fan art').tag, 'fanart');
  // nothing chosen: publishing still works (no invented category)
  const d = api.newDraft({ blog: 't:art' });
  api.saveDraft({ id: d.id, doc: { v: 1, blocks: [{ id: 'x', type: 'text', text: 'a diary without a category' }], rows: [] }, options: { categoryIds: [] }, revision: d.revision, blog: 't:art' });
  api.publish({ id: d.id });
  await run();
  const made = [...fake.posts.values()].find(p => p.content?.[0]?.text === 'a diary without a category');
  assert.ok(made);
  assert.deepEqual(made.tags, []);
  // deleting a group keeps its categories, ungrouped
  const course = groups.find(g => g.key === 'course');
  api.deleteCategoryGroup({ id: course.id });
  assert.equal(by('猹鱼速写').group_id, null);
});

test('filters: all conditions on whole tags; displayed view uses each instance\'s own tags (A50)', async () => {
  const { fake, svc, api, run } = setup();
  svc.pass(); await run();
  svc.db.run(`UPDATE blogs SET role = 'share'`);
  const A = fake.addPost('t:art', { tags: ['fanart', '习作', '猹鱼日绘'] });
  fake.addPost('t:art', { tags: ['fanart', '习作'] });
  fake.addPost('t:art', { tags: ['fanart art', '习作', '猹鱼日绘'] });
  // a reblog made when A had other tags: a snapshot with its own tags
  await fake.reblog('t:main', { parentBlog: 't:art', parentId: A.id_string, tags: ['fanart', '习作'] });
  svc.pass(); await run();
  const want = ['fanart', '习作', '猹鱼日绘'];
  const managed = api.posts({ view: 'managed', tags: want }).rows;
  assert.deepEqual(managed.map(r => r.id), [A.id_string], 'all three, whole tags only');
  const shown = api.posts({ view: 'displayed', tags: want }).rows;
  assert.deepEqual(shown.map(r => r.blog), ['t:art'], 'the reblog lacks 猹鱼日绘 itself; the original\'s tags are not lent to it');
  assert.equal(api.posts({ view: 'displayed', tags: ['FANART', '习作'] }).total, 3);
});

test('category migration: a flat list keeps ids, tags, order and draft choices; unknown entries stay ungrouped (A51)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mig-'));
  const { openDb } = require('../src/service/db');
  // a database as the flat version left it (schema up to the flat categories, seeded the old way)
  const db = openDb(path.join(dir, 'studio.db'));
  db.run('DELETE FROM categories');
  db.run('DELETE FROM category_groups');
  db.run(`INSERT INTO categories (id, name, tag, ord) VALUES (1, 'Diary', 'diary', 0), (2, 'Fanart', 'fanart', 1), (3, 'Photo', 'photo', 2), (7, 'Sketchbook', 'my sketchbook', 3)`);
  db.setMeta('categoriesSeeded', true);
  db.setMeta('categoryGroupsSeeded', false);
  db.run(`INSERT INTO drafts (blog, doc, options, created_at, updated_at) VALUES ('t:art', '{"v":1,"blocks":[],"rows":[]}', '{"categoryIds":[7,2]}', 1, 1)`);
  db.setMeta('blogDefaults', { 't:art': { categoryIds: [1, 7] } });
  db.close();
  const fake = makeFake({ blogs: [] });
  const svc = createService({ dataDir: dir, tumblr: fake });
  const extra = {};
  addWriting(svc, extra, { dataDir: dir });
  const cats = extra.categories();
  const c = id => cats.find(x => x.id === id);
  // the untouched old seed Photo/photo follows the changed default tag; everything else keeps its tag
  assert.deepEqual([c(1).tag, c(2).tag, c(3).tag, c(7).tag], ['diary', 'fanart', 'photography', 'my sketchbook']);
  assert.deepEqual([c(1).name, c(2).name, c(7).name], ['Diary', 'Fanart', 'Sketchbook'], 'names kept');
  assert.equal(c(7).group_id, null, 'no invented group');
  assert.ok(c(2).group_id && c(1).group_id && c(3).group_id);
  assert.equal(cats.filter(x => x.tag === 'fanart').length, 1, 'no duplicate of an existing tag');
  assert.deepEqual(JSON.parse(svc.db.get('SELECT options FROM drafts').options).categoryIds, [7, 2]);
  assert.deepEqual(extra.blogDefaults({ blog: 't:art' }).categoryIds, [1, 7]);
  assert.equal(fake.calls.filter(x => /put|create|reblog/.test(x)).length, 0, 'no remote edits');
});

test('categories: changed default tags reach untouched entries once; retired defaults go only when unselected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cat-up-'));
  const { openDb } = require('../src/service/db');
  const db = openDb(path.join(dir, 'studio.db'));
  db.run('DELETE FROM categories');
  db.run(`INSERT INTO categories (id, name, tag, ord) VALUES (1, '原创', 'original', 0), (2, '习作', 'my studies', 1), (3, '过程记录', '过程记录', 2),
    (4, '正式作品', '正式作品', 3), (5, '学习笔记', '学习笔记', 4), (6, 'Original', 'original', 5)`);
  db.setMeta('categoriesSeeded', true);
  db.setMeta('categoryGroupsSeeded', true);
  db.setMeta('categoryTagsUpgraded', false);
  db.setMeta('blogDefaults', { 't:art': { categoryIds: [5] } });
  db.close();
  const fake = makeFake({ blogs: [] });
  const svc = createService({ dataDir: dir, tumblr: fake });
  const extra = {};
  addWriting(svc, extra, { dataDir: dir });
  const c = id => extra.categories().find(x => x.id === id);
  assert.equal(c(1).tag, 'original art');
  assert.equal(c(6).tag, 'original', 'only one entry takes the new tag');
  assert.equal(c(2).tag, 'my studies', 'an edited tag is kept');
  assert.equal(c(3).tag, 'wip');
  assert.equal(c(4), undefined, 'retired and unselected: removed');
  assert.equal(c(5).tag, '学习笔记', 'retired but a blog default selects it: kept');
  assert.equal(fake.calls.filter(x => /put|create|reblog/.test(x)).length, 0, 'no remote edits');
});

test('publish: a reconcile that is rate limited or signed out stays unknown and never sends again', async () => {
  const { fake, svc, api, run } = setup();
  svc.pass(); await run();
  svc.db.run(`UPDATE blogs SET role = 'share'`);
  const d = api.newDraft({ blog: 't:art' });
  api.saveDraft({ id: d.id, doc: { v: 1, blocks: [{ id: 'y', type: 'text', text: 'only once' }], rows: [] }, options: {}, revision: d.revision, blog: 't:art' });
  const { RateError, AuthError } = require('../src/service/errors');
  const orig = fake.createPost, page = fake.postsPage;
  fake.createPost = async (...args) => { await orig(...args); throw netFail(true); };
  let lookups = 0;
  fake.postsPage = async (...args) => {
    lookups++;
    if (lookups === 1) throw new RateError('HTTP 429', { retryAt: 0 });
    if (lookups === 2) throw new AuthError('HTTP 401');
    return page(...args);
  };
  api.publish({ id: d.id });
  await svc.jobs.drain(svc.ctx); // create (lost) + first failed lookup
  const job = () => svc.jobs.list({}).find(j => j.kind === 'post.publish');
  assert.equal(job().status, 'unknown');
  await run();
  fake.createPost = orig; fake.postsPage = page;
  assert.equal(fake.calls.filter(c => c === 'create:t:art').length, 1, 'sent once');
  assert.equal([...fake.posts.values()].filter(p => p.content?.[0]?.text === 'only once').length, 1);
  assert.equal(api.draft({ id: d.id }).status, 'published');
});

test('publish: reconcile compares links, formatting and layout, so a different link post is not claimed', async () => {
  const { fake, svc, api, run, clock } = setup();
  svc.pass(); await run();
  svc.db.run(`UPDATE blogs SET role = 'share'`);
  const at = Math.floor(clock.t / 1000);
  fake.addPost('t:art', { content: [{ type: 'link', url: 'https://b.example/' }], timestamp: at });
  fake.addPost('t:art', { content: [{ type: 'text', text: 'see here', formatting: [{ type: 'link', start: 4, end: 8, url: 'https://b.example/' }] }], timestamp: at });
  const d = api.newDraft({ blog: 't:art' });
  api.saveDraft({ id: d.id, revision: d.revision, blog: 't:art', options: {}, doc: { v: 1, rows: [], blocks: [
    { id: 'l', type: 'link', url: 'https://a.example/' },
  ] } });
  const d2 = api.newDraft({ blog: 't:art' });
  api.saveDraft({ id: d2.id, revision: d2.revision, blog: 't:art', options: {}, doc: { v: 1, rows: [], blocks: [
    { id: 't', type: 'text', text: 'see here', formatting: [{ type: 'link', start: 4, end: 8, url: 'https://a.example/' }] },
  ] } });
  const orig = fake.createPost;
  fake.createPost = async () => { throw netFail(true); };
  api.publish({ id: d.id }); api.publish({ id: d2.id });
  await run();
  fake.createPost = orig;
  const jobs = svc.jobs.list({}).filter(j => j.kind === 'post.publish');
  assert.deepEqual(jobs.map(j => j.status), ['unknown', 'unknown']);
  assert.equal(api.draft({ id: d.id }).status, 'publishing');
  assert.equal(api.draft({ id: d2.id }).status, 'publishing');
});

test('publish: a lost response is still found when Tumblr returns the link percent-encoded', async () => {
  const { fake, svc, api, run } = setup();
  svc.pass(); await run();
  svc.db.run(`UPDATE blogs SET role = 'share'`);
  const d = api.newDraft({ blog: 't:art' });
  api.saveDraft({ id: d.id, revision: d.revision, blog: 't:art', options: {}, doc: { v: 1, rows: [], blocks: [
    { id: 't', type: 'text', text: 'wiki 赤足队', formatting: [{ type: 'link', start: 5, end: 8, url: 'https://zh.example.org/赤足队' }] },
  ] } });
  const orig = fake.createPost;
  fake.createPost = async (blog, json, files) => {
    const c = JSON.parse(JSON.stringify(json.content));
    c[0].formatting[0].url = new URL(c[0].formatting[0].url).href; // Tumblr keeps an encoded URL as is
    await orig(blog, { ...json, content: c }, files);
    throw netFail(true);
  };
  api.publish({ id: d.id });
  await run();
  fake.createPost = orig;
  assert.equal(fake.calls.filter(c => c === 'create:t:art').length, 1);
  assert.equal(api.draft({ id: d.id }).status, 'published');
});

test('composer picker: sections, presets, relations offered once members are picked, per-tag overrides, saved combos', () => {
  const { svc, api } = setup();
  const same = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);
  const PACK = {
    format: 'tth-template-pack', id: 'mf', name: 'My fandom', version: '1', base: ['my fandom'],
    types: { romance: 'Romance', friendship: 'Friends' },
    characters: [{ id: 'alice', name: 'Alice', tags: ['alice my fandom'] }, { id: 'bob', name: 'Bob', tags: ['bob my fandom'] }],
    relations: [{ id: 'ab', members: ['alice', 'bob'], type: 'romance', tags: ['alicebob'] }, { id: 'abf', name: 'A & B', members: ['alice', 'bob'], type: 'friendship', tags: [] }],
    presets: [{ id: 'cast', name: 'Cast', members: ['alice', 'bob'] }],
  };
  svc.db.setMeta('packs', [{ raw: PACK, source: 'test' }]);
  let v = api.packView({ id: 'mf', picks: [] });
  assert.ok(v.sections.flatMap(s => s.items).every(it => !it.rel), 'relations are not browsed until their members are picked');
  assert.equal(v.combos.length, 0);
  let picks = api.togglePick({ id: 'mf', picks: [], item: 'cast' });
  same(picks.sort(), ['alice', 'bob'], 'a preset picks its members');
  picks = api.togglePick({ id: 'mf', picks, item: 'ab' });
  v = api.packView({ id: 'mf', picks });
  assert.equal(v.combos.length, 1);
  same(v.combos[0].options.map(o => [o.id, o.relName, o.picked]), [['ab', 'Romance', true], ['abf', 'Friends', false]]);
  same(api.togglePick({ id: 'mf', picks, item: 'alice' }), ['bob'], 'dropping a member drops their relations');
  // a template tag turned off by hand leaves the final list and is shown as left out
  const on = api.composeTags({ pack: 'mf', picks });
  assert.ok(on.tags.some(x => x.tag === 'alicebob'));
  const off = api.composeTags({ pack: 'mf', picks, overrides: { alicebob: false } });
  assert.ok(!off.tags.some(x => x.tag === 'alicebob'));
  same(off.rows.filter(r => !r.on).map(r => [r.tag, r.why]), [['alicebob', 'off']]);
  api.saveTplFav({ pack: 'mf', name: 'Pair', ids: picks });
  same(api.packView({ id: 'mf', picks: [] }).favs.map(f => f.name), ['Pair']);
  api.deleteTplFav({ index: 0 });
  assert.equal(api.packView({ id: 'mf', picks: [] }).favs.length, 0);
});

test('links: URLs go out percent-encoded; a dropped formatting is named when verify fails', async () => {
  const c = compile({ blocks: [
    { id: 't', type: 'text', text: 'see 游戏王', formatting: [{ type: 'link', start: 4, end: 7, url: ' https://zh.wikipedia.org/wiki/游戏王 ' }] },
    { id: 'l', type: 'link', url: 'https://example.com/文 章?q=图' },
  ] });
  assert.equal(c.content[0].formatting[0].url, 'https://zh.wikipedia.org/wiki/%E6%B8%B8%E6%88%8F%E7%8E%8B');
  assert.equal(c.content[1].url, 'https://example.com/%E6%96%87%20%E7%AB%A0?q=%E5%9B%BE');

  const { fake, svc, api, run } = setup();
  svc.pass(); await run();
  const d = api.newDraft({ blog: 't:art' });
  api.saveDraft({ id: d.id, doc: { v: 1, blocks: [{ id: 'a', type: 'text', text: 'bold then link', formatting: [{ type: 'bold', start: 0, end: 4 }, { type: 'link', start: 10, end: 14, url: 'https://example.com/x' }] }], rows: [] }, options: { categoryIds: [] }, revision: d.revision, blog: 't:art' });
  const orig = fake.createPost;
  // Tumblr keeps the bold and silently drops the link
  fake.createPost = (blog, json, files) => orig.call(fake, blog, { ...json, content: json.content.map(b => ({ ...b, formatting: b.formatting?.filter(f => f.type !== 'link') })) }, files);
  api.publish({ id: d.id, mode: 'draft' });
  for (let i = 0; i < 6; i++) await run();
  const job = svc.jobs.list({}).find(j => j.kind === 'post.publish');
  assert.equal(job.status, 'failed');
  assert.match(job.error, /block 1: Tumblr dropped the link formatting/);
});
