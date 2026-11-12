'use strict';
// Functional workflows (docs/FUNCTIONAL_WORKFLOWS_SPEC.md) against made-up fixtures: editing a published
// original in place (FW02-FW04, FW09) and replying to an interaction from the app (FW05-FW08, FW10).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service/service');
const { makeApi } = require('../src/service/api');
const { addWriting, decompile, compile } = require('../src/service/writing');
const { addAudience } = require('../src/service/audience');
const { addReplies } = require('../src/service/replies');
const { contentFingerprint } = require('../src/service/posts');
const { makeFake, netFail } = require('./fake-tumblr');

const BLOGS = [{ uuid: 't:main', name: 'mainblog', primary: true, followers: 3 }, { uuid: 't:art', name: 'artblog' }];
const IMG = n => ({ type: 'image', media: [{ url: `https://64.media.tumblr.com/h${n}/s1280x1920/a.jpg`, width: 1280, height: 1280 }, { url: `https://64.media.tumblr.com/h${n}/s540x810/a.jpg`, width: 540, height: 540 }], alt_text: 'pic ' + n, colors: { c0: 'ffffff' } });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-w-'));
  const clock = { t: Date.UTC(2026, 10, 7, 12) };
  const fake = makeFake({ blogs: BLOGS, now: () => clock.t });
  const svc = createService({ dataDir: dir, tumblr: fake, now: () => clock.t });
  svc.db.capability('edit.labels', 'not_used');
  const extra = {};
  addWriting(svc, extra, { dataDir: dir });
  addAudience(svc, extra);
  addReplies(svc, extra);
  const api = makeApi(svc, { extra });
  const run = async (n = 10) => { for (let i = 0; i < n; i++) { await svc.jobs.drain(svc.ctx); clock.t += 70e3; } };
  svc.jobs.add('sync.blogs', { mode: 'inc' });
  return { dir, clock, fake, svc, api, run, db: svc.db };
}

// An original with text, a mention (locked), a row of two images, a video block (kept as is) and a read-more
function richPost(fake, blog = 't:art', extra = {}) {
  return fake.addPost(blog, {
    tags: ['original art', 'wip'],
    content: [
      { type: 'text', text: 'Hello world' },
      { type: 'text', text: 'thanks @friend', formatting: [{ type: 'mention', start: 7, end: 14, blog: { uuid: 't:friend', name: 'friend' } }] },
      IMG(1), IMG(2),
      { type: 'video', provider: 'youtube', url: 'https://www.youtube.com/watch?v=x' },
      { type: 'text', text: 'after the break' },
    ],
    layout: [{ type: 'rows', display: [{ blocks: [0] }, { blocks: [1] }, { blocks: [2, 3] }, { blocks: [4] }, { blocks: [5] }], truncate_after: 4 }],
    ...extra,
  });
}

test('decompile: rows, read-more, locked and kept blocks round-trip to the same body', () => {
  const fake = makeFake({ blogs: BLOGS });
  const p = richPost(fake);
  const { doc } = decompile(p);
  assert.deepEqual(doc.blocks.map(b => b.type), ['text', 'text', 'image', 'image', 'keep', 'readmore', 'text']);
  assert.equal(doc.blocks[1].locked, true);
  assert.equal(doc.rows.length, 1);
  const c = compile(doc);
  assert.deepEqual(c.problems, []);
  assert.equal(contentFingerprint(c.content, c.layout), contentFingerprint(p.content, p.layout));
  // an ask, or rows in another order, can't be shown faithfully: refused with a reason, never flattened
  assert.equal(decompile({ content: p.content, layout: [{ type: 'ask', blocks: [0] }] }).unsupported, 'layout_ask');
  assert.equal(decompile({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], layout: [{ type: 'rows', display: [{ blocks: [1] }, { blocks: [0] }] }] }).unsupported, 'layout_order');
});

test('edit a published original: same id and state, unsupported blocks kept, a new revision (FW02, FW04)', async () => {
  const { fake, api, run, db } = setup();
  const p = richPost(fake, 't:art', { state: 'private' });
  const d = await api.editPublished({ blog: 't:art', id: p.id_string });
  assert.equal(d.kind, 'edit');
  assert.equal(d.target_id, p.id_string);
  const doc = d.doc;
  doc.blocks[0].text = 'Hello edited world';
  api.saveDraft({ id: d.id, doc, options: d.options, revision: d.revision });
  // a second "edit" of the same post resumes this one
  assert.equal((await api.editPublished({ blog: 't:art', id: p.id_string })).id, d.id);
  api.submitEdit({ id: d.id });
  await run(4);
  const now = fake.posts.get(p.id_string);
  assert.equal(now.content[0].text, 'Hello edited world');
  assert.equal(now.state, 'private', 'visibility never changes in an edit');
  assert.deepEqual(now.tags, ['original art', 'wip']);
  assert.deepEqual(now.content[4], { type: 'video', provider: 'youtube', url: 'https://www.youtube.com/watch?v=x' });
  assert.deepEqual(now.content[1].formatting[0].blog, { uuid: 't:friend', name: 'friend' });
  assert.equal(now.content[2].media[0].url, IMG(1).media[0].url, 'existing images keep their Tumblr media');
  assert.equal(now.layout[0].truncate_after, 4);
  assert.equal(api.draft({ id: d.id }).status, 'published');
  const revs = db.all('SELECT rev FROM source_revisions WHERE blog = ? AND id = ?', 't:art', p.id_string);
  assert.equal(revs.length, 2, 'the edited body is a new source revision');
  assert.ok(!fake.calls.some(c => c.startsWith('create:')), 'an edit never posts a new post');
});

test('edit: Tumblr changed meanwhile -> nothing sent, both kept, you choose (FW03)', async () => {
  const { fake, api, run } = setup();
  const p = richPost(fake);
  const d = await api.editPublished({ blog: 't:art', id: p.id_string });
  d.doc.blocks[0].text = 'mine';
  api.saveDraft({ id: d.id, doc: d.doc, options: d.options, revision: d.revision });
  // edited on the phone after the edit started
  fake.posts.get(p.id_string).content[0] = { type: 'text', text: 'from the phone' };
  api.submitEdit({ id: d.id });
  await run(2);
  assert.ok(!fake.calls.some(c => c.startsWith('put:')), 'nothing was sent');
  const c = api.draft({ id: d.id });
  assert.equal(c.status, 'conflict');
  assert.equal(c.conflict.content[0].text, 'from the phone');
  assert.equal(c.doc.blocks[0].text, 'mine', 'my text is kept');
  assert.throws(() => api.submitEdit({ id: d.id }), /newer version/);
  // take Tumblr's: my text is kept aside and can come back
  const t2 = await api.resolveEdit({ id: d.id, use: 'theirs' });
  assert.equal(t2.doc.blocks[0].text, 'from the phone');
  assert.equal(t2.stash.doc.blocks[0].text, 'mine');
  const back = api.restoreStash({ id: d.id });
  assert.equal(back.doc.blocks[0].text, 'mine');
  // now on top of the phone's version (the new base), sent only when submitted
  api.submitEdit({ id: d.id });
  await run(4);
  assert.equal(fake.posts.get(p.id_string).content[0].text, 'mine');
  assert.equal(api.draft({ id: d.id }).status, 'published');
});

test('edit: tags only vs body; tags made elsewhere are kept when only the body changes (FW04, FW09)', async () => {
  const { fake, api, run, db, svc } = setup();
  const p = richPost(fake);
  // body-only edit while another tool changed the tags: the newer tags stay
  const d = await api.editPublished({ blog: 't:art', id: p.id_string });
  d.doc.blocks[0].text = 'new body';
  api.saveDraft({ id: d.id, doc: d.doc, options: d.options, revision: d.revision });
  fake.posts.get(p.id_string).tags = ['original art', 'wip', 'added on tumblr'];
  api.submitEdit({ id: d.id });
  await run(4);
  assert.deepEqual(fake.posts.get(p.id_string).tags, ['original art', 'wip', 'added on tumblr']);
  assert.equal(api.draft({ id: d.id }).status, 'published');
  const before = db.all('SELECT rev FROM source_revisions WHERE id = ?', p.id_string).length;
  // my reblog of it (an older body), with route automation on: it takes the new tags, its body stays
  const oldBody = [{ type: 'text', text: 'Hello world' }];
  const rb = fake.addPost('t:main', { parent_tumblelog_uuid: 't:art', parent_post_id: p.id_string, tags: ['original art', 'wip'], content: [],
    trail: [{ blog: { uuid: 't:art', name: 'artblog' }, post: { id: p.id_string }, content: oldBody, layout: [] }] });
  db.setMeta('automation', { routes: true });
  svc.pass();
  await run(4);
  const creates = fake.calls.filter(c => c.startsWith('reblog:') || c.startsWith('create:')).length;
  // tags-only edit: no new revision
  const e = await api.editPublished({ blog: 't:art', id: p.id_string });
  // general categories stay in front, as for every tag edit (ops.categoryFirst)
  api.saveDraft({ id: e.id, doc: e.doc, options: { tags: ['new tag', 'original art'] }, revision: e.revision });
  api.submitEdit({ id: e.id });
  await run(4);
  assert.deepEqual(fake.posts.get(p.id_string).tags, ['original art', 'new tag']);
  assert.equal(db.all('SELECT rev FROM source_revisions WHERE id = ?', p.id_string).length, before, 'a tags-only change is not a version');
  assert.equal(fake.posts.get(p.id_string).content[0].text, 'new body');
  await run(4);
  assert.deepEqual(fake.posts.get(rb.id_string).tags, ['original art', 'new tag'], 'my reblog follows the original’s tags');
  assert.deepEqual(fake.posts.get(rb.id_string).trail[0].content, oldBody, 'its body is never rewritten');
  assert.equal(fake.calls.filter(c => c.startsWith('reblog:') || c.startsWith('create:')).length, creates, 'a tags-only change makes no reblog');
});

test('edit: an answer lost after the PUT landed is verified, not seen as a conflict', async () => {
  const { fake, api, run } = setup();
  const p = richPost(fake);
  const d = await api.editPublished({ blog: 't:art', id: p.id_string });
  d.doc.blocks[0].text = 'landed';
  api.saveDraft({ id: d.id, doc: d.doc, options: d.options, revision: d.revision });
  const put = fake.putPost;
  let once = true;
  fake.putPost = async (...a) => { const r = await put(...a); if (once) { once = false; throw netFail(); } return r; };
  api.submitEdit({ id: d.id });
  await run(6);
  assert.equal(api.draft({ id: d.id }).status, 'published');
  assert.equal(fake.calls.filter(c => c.startsWith('put:')).length, 1, 'not sent a second time');
});

test('edit: a new image goes up with the edit; reblogs and unsupported layouts are refused', async () => {
  const { fake, api, run } = setup();
  const p = richPost(fake);
  const d = await api.editPublished({ blog: 't:art', id: p.id_string });
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const a = api.addAsset({ draftId: d.id, name: 'x.png', mime: 'image/png', bytes: [...png], width: 1, height: 1 });
  d.doc.blocks.splice(1, 0, { id: 'bnew', type: 'image', asset: a.id, alt: 'new one' });
  api.saveDraft({ id: d.id, doc: d.doc, options: d.options, revision: d.revision });
  api.submitEdit({ id: d.id });
  await run(4);
  const now = fake.posts.get(p.id_string);
  assert.equal(now.content.filter(b => b.type === 'image').length, 3);
  assert.ok(fake.calls.includes('putfiles:' + p.id_string));
  assert.equal(api.draft({ id: d.id }).status, 'published');
  // a reblog is a frozen snapshot
  const rb = fake.addPost('t:main', { parent_tumblelog_uuid: 't:art', parent_post_id: p.id_string, trail: [{ blog: { uuid: 't:art' }, post: { id: p.id_string }, content: [] }] });
  await assert.rejects(api.editPublished({ blog: 't:main', id: rb.id_string }), /frozen snapshot/);
  const ask = fake.addPost('t:art', { content: [{ type: 'text', text: 'q' }, { type: 'text', text: 'a' }], layout: [{ type: 'ask', blocks: [0] }] });
  await assert.rejects(api.editPublished({ blog: 't:art', id: ask.id_string }), /unsupported:layout_ask/);
});

// ---------- replies ----------
function replyEvent(t, { fake, db }, post) {
  db.run(`INSERT INTO interactions (id, blog, type, kind, from_uuid, from_name, post_id, text, tags, at, fetched_at, state) VALUES (?, 't:art', 'reply', 'reply', 't:fan', 'fan', ?, 'love this', '[]', ?, ?, 'new')`,
    'n1', post.id_string, t, t);
  fake.replyStore.set(post.id_string, [{ id: 'r1', uuid: 't:fan', name: 'fan', text: 'love this', at: t, children: [] }]);
  return 'n1';
}

test('reply: waits for the browser, sends once, confirmed only when seen under the post (FW05, FW06, FW08)', async () => {
  const env = setup();
  const { fake, api, run, db, clock } = env;
  const p = richPost(fake);
  await run(1);
  const ev = replyEvent(clock.t, env, p);
  const th = await api.fansThread({ id: ev });
  assert.equal(th.canReply, true);
  assert.equal(th.replies.list[0].text, 'love this');
  assert.equal(th.defaultAs, 't:art');
  api.fansReplyDraft({ id: ev, text: 'thank you!', reply_as: 't:art' });
  assert.equal((await api.fansThread({ id: ev })).draft.text, 'thank you!', 'unsent text is kept');
  fake.browser = false;
  const r = api.fansReply({ id: ev, text: 'thank you!', reply_as: 't:art', op: 'op-aaaaaaaa1' });
  // a double click / refresh: the same operation, no second job
  assert.equal(api.fansReply({ id: ev, text: 'thank you!', reply_as: 't:art', op: 'op-aaaaaaaa1' }).repeated, true);
  assert.throws(() => api.fansReply({ id: ev, text: 'again', reply_as: 't:art', op: 'op-bbbbbbbb2' }), /still being sent/);
  await run(1);
  let op = api.fansReplyOps({ id: ev })[0];
  assert.equal(op.status, 'waiting', 'no browser: it waits, nothing goes another way');
  assert.equal(fake.replySends, 0);
  assert.equal(db.get('SELECT state FROM interactions WHERE id = ?', ev).state, 'new');
  fake.browser = true;
  svc_wake(env);
  await run(3);
  op = api.fansReplyOps({ id: ev })[0];
  assert.equal(op.status, 'confirmed');
  assert.equal(fake.replySends, 1);
  assert.equal(op.reply_as, 't:art');
  assert.equal(op.text, 'thank you!');
  assert.equal(db.get('SELECT state FROM interactions WHERE id = ?', ev).state, 'done');
  assert.equal(db.capStatus('reply.send'), 'pass');
  assert.equal((await api.fansThread({ id: ev })).draft, null, 'the sent text is no longer a draft');
  assert.equal(r.op.op, 'op-aaaaaaaa1');
});
function svc_wake(env) { env.svc.jobs.wake('browser:'); }

test('reply: a lost answer is found under the post, never resent (FW06)', async () => {
  const env = setup();
  const { fake, api, run, clock } = env;
  const p = richPost(fake);
  await run(1);
  const ev = replyEvent(clock.t, env, p);
  fake.replyLost = true;
  api.fansReply({ id: ev, text: 'hi there', reply_as: 't:art', op: 'op-lost00001' });
  await run(4);
  const op = api.fansReplyOps({ id: ev })[0];
  assert.equal(op.status, 'confirmed');
  assert.equal(fake.replySends, 1);
});

test('reply: not visible stays unknown (never failed or resent) until you say it wasn’t sent; a refusal stays open (FW06, FW10)', async () => {
  const env = setup();
  const { fake, api, run, db, clock, svc } = env;
  const p = richPost(fake);
  await run(1);
  const ev = replyEvent(clock.t, env, p);
  fake.replyHide = 1000;
  api.fansReply({ id: ev, text: 'hello', reply_as: 't:art', op: 'op-hidden001' });
  await run(12);
  let op = api.fansReplyOps({ id: ev })[0];
  assert.equal(op.status, 'unknown');
  assert.equal(fake.replySends, 1);
  assert.equal(db.get('SELECT state FROM interactions WHERE id = ?', ev).state, 'new', 'an unknown send does not close the interaction');
  assert.throws(() => api.fansReply({ id: ev, text: 'hello', reply_as: 't:art', op: 'op-hidden002' }), /unknown outcome/);
  assert.equal(api.fansReplyNotSent({ op: 'op-hidden001' }), true);
  op = api.fansReplyOps({ id: ev })[0];
  assert.equal(op.status, 'not_sent');
  assert.equal((await api.fansThread({ id: ev })).draft.text, 'hello', 'the text comes back as unsent');
  // a refusal: failed, the interaction stays open, the self-report stays separate
  fake.replyHide = 0;
  fake.replyRefuse = 403;
  api.fansReply({ id: ev, text: 'hello again', reply_as: 't:art', op: 'op-refuse001' });
  await run(2);
  op = api.fansReplyOps({ id: ev })[0];
  assert.equal(op.status, 'failed');
  assert.equal(db.get('SELECT state, replied FROM interactions WHERE id = ?', ev).state, 'new');
  // the hand-off to Tumblr is remembered, but is not a send
  api.fansHandoff({ id: ev });
  const th = await api.fansThread({ id: ev });
  assert.ok(th.handoff.at);
  assert.equal(th.handoff.url, `https://www.tumblr.com/artblog/${p.id_string}`);
  assert.ok(!th.ops.some(o => o.status === 'confirmed'));
  // a crash while sending: the next start treats it as unknown, not as unsent
  api.fansReply({ id: ev, text: 'third', reply_as: 't:art', op: 'op-crash0001' });
  const j = db.get(`SELECT id FROM jobs WHERE kind = 'reply.send' ORDER BY id DESC LIMIT 1`).id;
  db.run(`UPDATE jobs SET status = 'running' WHERE id = ?`, j);
  svc.jobs.recover();
  assert.equal(svc.jobs.get(j).status, 'unknown');
});

test('reply: only a reply under my own post is offered; other kinds hand off', async () => {
  const env = setup();
  const { api, db, clock } = env;
  db.run(`INSERT INTO interactions (id, blog, type, kind, from_uuid, from_name, post_id, reblog_id, text, tags, at, fetched_at, state) VALUES ('n2', 't:art', 'reblog', 'reblog', 't:fan', 'fan', '55', '77', 'so good', '[]', ?, ?, 'new')`, clock.t, clock.t);
  const th = await api.fansThread({ id: 'n2' });
  assert.equal(th.canReply, false);
  assert.equal(th.handoff.url, 'https://www.tumblr.com/fan/77');
  assert.throws(() => api.fansReply({ id: 'n2', text: 'x', reply_as: 't:art', op: 'op-nope00001' }), /only a reply/);
});
