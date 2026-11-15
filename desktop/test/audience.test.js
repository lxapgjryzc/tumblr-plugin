'use strict';
// Fans & interactions (docs/FAN_RELATIONSHIP_SPEC.md) against made-up fixtures. Nothing here writes to Tumblr.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service/service');
const { makeApi } = require('../src/service/api');
const { addFollowers } = require('../src/service/followers');
const { addAudience, normalize } = require('../src/service/audience');
const { makeFake } = require('./fake-tumblr');

const BLOGS = [{ uuid: 't:main', name: 'mainblog', primary: true, followers: 3 }, { uuid: 't:art', name: 'artblog', followers: 1 }];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-a-'));
  const clock = { t: Date.UTC(2026, 10, 1, 12) };
  const fake = makeFake({ blogs: BLOGS, now: () => clock.t });
  const svc = createService({ dataDir: dir, tumblr: fake, now: () => clock.t });
  const extra = {};
  addFollowers(svc, extra);
  addAudience(svc, extra);
  const api = makeApi(svc, { extra });
  const run = async (n = 12) => { for (let i = 0; i < n; i++) { await svc.jobs.drain(svc.ctx); clock.t += 70e3; } };
  const follow = (blog, name, uuid) => {
    const list = fake.followerMap.get(blog) || [];
    list.unshift({ name, updated: 0 });
    fake.followerMap.set(blog, list);
    if (uuid) fake.infos.set(name, { uuid });
  };
  const unfollow = (blog, name) => fake.followerMap.set(blog, (fake.followerMap.get(blog) || []).filter(u => u.name !== name));
  let seq = 1;
  const notify = (blog, n) => {
    const list = fake.notifs.get(blog) || [];
    const row = { id: String(1000 + seq++), timestamp: Math.floor(clock.t / 1000), target_tumblelog_uuid: blog, ...n };
    list.push(row);
    fake.notifs.set(blog, list);
    return row;
  };
  return { fake, svc, api, run, follow, unfollow, notify, clock };
}

test('normalize: reblog words and tags are kept apart from likes and plain reblogs (FR08)', () => {
  const base = { id: '1', timestamp: 100, from_tumblelog_uuid: 't:x', from_tumblelog_name: 'x', target_tumblelog_uuid: 't:main', target_post_id: '5' };
  assert.equal(normalize({ ...base, type: 'reblog_naked', post_tags: ['so cute', 'want more'] }, 0).kind, 'reblog');
  assert.deepEqual(normalize({ ...base, type: 'reblog_naked', post_tags: ['so cute', 'want more'] }, 0).tags, ['so cute', 'want more']);
  assert.equal(normalize({ ...base, type: 'reblog_naked', post_tags: [] }, 0).kind, 'reblog_plain');
  assert.equal(normalize({ ...base, type: 'reblog', added_text: '<p>love the light</p>' }, 0).text, 'love the light');
  assert.equal(normalize({ ...base, type: 'like' }, 0).kind, 'like');
  // camelCase (web client) reads the same
  assert.equal(normalize({ id: '2', type: 'reply', replyText: 'which brush?', timestamp: 1, fromTumblelogUuid: 't:y' }, 0).text, 'which brush?');
  // unknown types are kept as "other", not dropped or called spam
  assert.equal(normalize({ ...base, type: 'brand_new_type' }, 0).kind, 'other');
  // not about my blog
  assert.equal(normalize({ ...base, type: 'what_you_missed' }, 0), null);
  // an anonymous ask is never tied to a guessed person (FR18)
  const ask = normalize({ ...base, type: 'ask', is_anonymous: true, question: 'hi' }, 0);
  assert.equal(ask.from_uuid, null); assert.equal(ask.from_name, null);
});

test('normalize: the structured "generic" notification gives a reply its sender, post and text (2026-11-16)', () => {
  // the exact shape found in this computer's studio.db: type generic, subtype reply, title mention, actions + body
  const n = {
    id: '833218340121149440', type: 'generic', subtype: 'reply', timestamp: 1794618930,
    title: { text_content: { type: 'text', text: 'slyeantex', formatting: [{ type: 'bold', start: 0, end: 9 }, { type: 'mention', start: 0, end: 9, blog: { name: 'slyeantex', url: 'https://www.tumblr.com/slyeantex/', uuid: 't:_ZhQz_nBIjCK-_rJdqiuOA' } }] } },
    actions: { tap: { href: 'https://www.tumblr.com/0961685962arcv/833217773830275072/replies/833218340099096576' }, long_tap: { meta: { post_id: '833217773830275072' } } },
    body: { content: [{ type: 'text', text: 'Replied to your post' }, { type: 'text', subtype: 'indented', text: 'Hello are  you going to receive COMM? If yes ...' }] },
  };
  const r = normalize(n, 0);
  assert.equal(r.kind, 'reply');
  assert.equal(r.from_uuid, 't:_ZhQz_nBIjCK-_rJdqiuOA');
  assert.equal(r.from_name, 'slyeantex');
  assert.equal(r.post_id, '833217773830275072');
  assert.equal(r.text, 'Hello are you going to receive COMM? If yes ...');
  // the same shape carries asks and mentions
  const ask = normalize({ ...n, id: '2', subtype: 'ask', body: { content: [{ type: 'text', text: 'How are you?' }] } }, 0);
  assert.equal(ask.kind, 'ask');
  assert.equal(ask.text, 'How are you?');
});

test('generic replies are screened: the cut text is read in full, the sender opens a case (2026-11-16)', async () => {
  const { svc, api, run, notify, fake, clock } = setup();
  api.setFansConfig({ collect: true });
  api.setFollowerGuard({ mode: 'review' });
  const id = '833218340121149440';
  notify('t:main', {
    id, type: 'generic', subtype: 'reply',
    title: { text_content: { type: 'text', text: 'slyeantex', formatting: [{ type: 'mention', start: 0, end: 9, blog: { name: 'slyeantex', uuid: 't:sly' } }] } },
    actions: { tap: { href: 'https://www.tumblr.com/mainblog/77/replies/123' }, long_tap: { meta: { post_id: '77' } } },
    body: { content: [{ type: 'text', text: 'Replied to your post' }, { type: 'text', subtype: 'indented', text: 'Hello are  you going to receive COMM? If yes ...' }] },
  });
  fake.replyStore.set('77', [{ id: 'r1', uuid: 't:sly', name: 'slyeantex', text: 'Hello are  you going to receive COMM? If yes reach out to me', at: clock.t, children: [] }]);
  svc.pass(); await run();
  const row = svc.db.get('SELECT kind, text, from_uuid, from_name, post_id FROM interactions WHERE id = ?', id);
  assert.equal(row.kind, 'reply');
  assert.equal(row.from_uuid, 't:sly');
  assert.equal(row.from_name, 'slyeantex');
  assert.equal(row.post_id, '77');
  assert.match(row.text, /reach out to me/, 'the cut notification was read in full before judging');
  const c = svc.db.get('SELECT status, assessment FROM follower_cases WHERE uuid = ?', 't:sly');
  assert.equal(c.status, 'review', 'a hit only opens the case for review');
  assert.match(c.assessment, /commission_bait/);
});

test('repair: a notification stored as "other" before its shape was known is read again and screened (2026-11-16)', async () => {
  const { svc, api, run, notify, fake, clock } = setup();
  api.setFansConfig({ collect: true, notifications: false });
  api.setFollowerGuard({ mode: 'review' });
  const n = notify('t:main', {
    id: 'old-generic', type: 'generic', subtype: 'reply',
    title: { text_content: { type: 'text', text: 'slyeantex', formatting: [{ type: 'mention', start: 0, end: 9, blog: { name: 'slyeantex', uuid: 't:sly' } }] } },
    actions: { long_tap: { meta: { post_id: '77' } } },
    body: { content: [{ type: 'text', text: 'Replied to your post' }, { type: 'text', subtype: 'indented', text: 'Hello are  you going to receive COMM? If yes ...' }] },
  });
  // what the old build stored: the notification id, no sender, post or text
  svc.db.run(`INSERT INTO interactions (id, blog, type, kind, from_uuid, from_name, post_id, text, at, fetched_at, state, state_at)
    VALUES (?, 't:main', 'generic', 'other', NULL, NULL, NULL, NULL, ?, ?, 'digest', 0)`, n.id, clock.t, clock.t);
  fake.replyStore.set('77', [{ id: 'r1', uuid: 't:sly', name: 'slyeantex', text: 'Hello are  you going to receive COMM? If yes reach out to me', at: clock.t, children: [] }]);
  svc.jobs.add('audience.remap', { blog: 't:main', id: n.id, at: clock.t, before: Math.floor(clock.t / 1000) + 1 }, { priority: 9 });
  await run();
  const row = svc.db.get('SELECT kind, text, from_uuid, post_id FROM interactions WHERE id = ?', n.id);
  assert.equal(row.kind, 'reply');
  assert.equal(row.from_uuid, 't:sly');
  assert.equal(row.post_id, '77');
  assert.match(row.text, /reach out to me/);
  assert.equal(svc.db.get('SELECT status FROM follower_cases WHERE uuid = ?', 't:sly').status, 'review');
});

test('collection: the first scan and the backfill are history; later ones reach the to-do list (FR04)', async () => {
  const { svc, api, run, follow, notify, clock } = setup();
  for (let i = 0; i < 30; i++) follow('t:main', 'old' + i);
  notify('t:main', { type: 'reply', reply_text: 'old question', from_tumblelog_uuid: 't:o', from_tumblelog_name: 'oldfan', target_post_id: '9' });
  clock.t += 1000;
  api.setFansConfig({ collect: true });
  svc.pass(); await run();
  assert.equal(svc.db.get('SELECT COUNT(*) n FROM followers WHERE baseline = 1').n, 30);
  assert.equal(api.fansToday().items.length, 0, 'nothing from before switching on is a to-do');
  assert.equal(svc.db.get(`SELECT state FROM interactions`).state, 'old');
  assert.equal(svc.db.get('SELECT COUNT(*) n FROM audience_changes').n, 0, 'no flood of "new follower" changes');
  assert.equal(svc.db.get('SELECT COUNT(*) n FROM jobs WHERE kind = ?', 'follower.inspect').n, 0, 'collection alone never inspects (protection is off)');
  // later activity
  follow('t:main', 'newfan', 't:nf');
  notify('t:main', { type: 'reblog_naked', post_tags: ['this face', 'more please'], from_tumblelog_uuid: 't:nf', from_tumblelog_name: 'newfan', target_post_id: '9' });
  notify('t:main', { type: 'like', from_tumblelog_uuid: 't:l', from_tumblelog_name: 'liker', target_post_id: '9' });
  notify('t:main', { type: 'reblog_naked', post_tags: [], from_tumblelog_uuid: 't:art', from_tumblelog_name: 'artblog', target_post_id: '9' }); // my own side blog
  clock.t += 7 * 3600e3; // past the 6-hour list interval
  svc.pass(); await run();
  const today = api.fansToday();
  assert.deepEqual(today.items.map(i => i.from_name), ['newfan'], 'tags-only reblog is a to-do; likes and my own blogs are not');
  assert.deepEqual(today.items[0].tags, ['this face', 'more please']);
  assert.equal(today.digest.likes, 1);
  assert.equal(today.digest.follows, 1);
});

test('notifications: same-second page edges are read again and deduped; a stuck page stops with a gap (FR07)', async () => {
  const { svc, api, run, notify, fake, clock } = setup();
  api.setFansConfig({ collect: true, enabledAt: clock.t - 3600e3 });
  // 120 events, 60 of them in one second at the first page boundary
  const t0 = Math.floor(clock.t / 1000) - 100;
  for (let i = 0; i < 60; i++) notify('t:main', { type: 'like', timestamp: t0 + 50, from_tumblelog_uuid: 't:a' + i, from_tumblelog_name: 'a' + i });
  for (let i = 0; i < 40; i++) notify('t:main', { type: 'like', timestamp: t0 + 50 + i + 1, from_tumblelog_uuid: 't:b' + i, from_tumblelog_name: 'b' + i });
  for (let i = 0; i < 20; i++) notify('t:main', { type: 'like', timestamp: t0 - i, from_tumblelog_uuid: 't:c' + i, from_tumblelog_name: 'c' + i });
  svc.pass(); await run();
  // 40 newer + 50 of the same second fill page 1; page 2 starts at that second: all 60 and older come in, the 50 again
  const n = svc.db.get('SELECT COUNT(*) n FROM interactions').n;
  const st = svc.db.getMeta('notif:t:main');
  // the fake can't page past 50 events in one second: the walk stops instead of looping, and says so
  assert.ok(n >= 90 && n <= 120, 'read ' + n);
  assert.equal(new Set(svc.db.all('SELECT id FROM interactions').map(r => r.id)).size, n, 'no duplicates');
  assert.ok(st.gaps?.length === 1, 'stuck paging is recorded as a gap');
  assert.ok(fake.calls.filter(c => c.startsWith('notifications:')).length < 8, 'no endless paging');
  // a second run only reads the newest page
  const before = fake.calls.length;
  svc.pass(); await run();
  assert.equal(fake.calls.slice(before).filter(c => c.startsWith('notifications:')).length, 1);
  assert.equal(svc.db.get('SELECT COUNT(*) n FROM interactions').n, n);
});

test('relationships: missing followers are checked before they count as gone; errors stay unknown (FR05)', async () => {
  const { svc, api, run, follow, unfollow, fake, clock } = setup();
  for (const n of ['stay', 'leave', 'hidden', 'renamed']) follow('t:main', n);
  api.setFansConfig({ collect: true });
  svc.pass(); await run();
  unfollow('t:main', 'leave'); unfollow('t:main', 'hidden'); unfollow('t:main', 'renamed');
  fake.hiddenFollowers = new Set(['hidden']);           // the list missed them, followed_by says yes
  fake.followedByFail = new Set(['renamed']);           // 404: renamed or deleted
  clock.t += 7 * 3600e3;
  svc.pass(); await run();
  const row = n => svc.db.get('SELECT * FROM followers WHERE name = ?', n);
  assert.ok(row('leave').gone_at, 'confirmed gone');
  assert.equal(row('hidden').gone, 0, 'still following: restored');
  assert.equal(row('renamed').gone_at, null, 'unconfirmed stays missing');
  assert.match(row('renamed').check_note, /not found/);
  const changes = svc.db.all('SELECT name, kind, since FROM audience_changes');
  assert.deepEqual(changes.map(c => c.name + ':' + c.kind), ['leave:unfollow']);
  assert.ok(changes[0].since, 'an interval, not a moment');
  // a failed scan page never marks anyone missing
  fake.fail.next = { method: 'GET', error: new (require('../src/service/errors').NetError)('reset') };
  clock.t += 7 * 3600e3;
  svc.pass(); await run(4);
  assert.equal(row('stay').gone, 0);
});

test('people: one record per identity across blogs; notes need a uuid and survive a rename (FR02, FR03)', async () => {
  const { svc, api, run, follow, notify, fake, clock } = setup();
  follow('t:main', 'pal'); follow('t:art', 'pal');
  api.setFansConfig({ collect: true, blogs: ['t:main', 't:art'] });
  svc.pass(); await run();
  let list = api.fansPeople({ rel: 'followers' }).rows;
  assert.equal(list.length, 1, 'one person');
  assert.deepEqual(list[0].follows.sort(), ['t:art', 't:main']);
  assert.equal(list[0].uuid, null, 'name only so far');
  // saving a note resolves the identity first
  fake.infos.set('pal', { uuid: 't:pal' });
  const { key } = await api.savePerson({ key: list[0].key, patch: { note: 'shares brushes', star: true, labels: ['painter'] } });
  assert.equal(key, 't:pal');
  // a rename seen in a notification keeps the note and the old name
  notify('t:main', { type: 'reply', reply_text: 'hi again', from_tumblelog_uuid: 't:pal', from_tumblelog_name: 'pal-new', target_post_id: '3' });
  clock.t += 600e3; svc.pass(); await run();
  const p = api.fansPerson({ key: 't:pal' });
  assert.equal(p.note, 'shares brushes');
  assert.equal(p.name, 'pal-new');
  assert.deepEqual(p.oldNames, ['pal']);
  // someone else taking the old name gets nothing of it
  notify('t:main', { type: 'reply', reply_text: 'new person', from_tumblelog_uuid: 't:other', from_tumblelog_name: 'pal', target_post_id: '3' });
  clock.t += 600e3; svc.pass(); await run();
  const other = api.fansPerson({ key: 't:other' });
  assert.equal(other.note ?? null, null); assert.equal(other.star, 0);
  // a star is not the protection allowlist (FR14)
  assert.equal(svc.db.get('SELECT COUNT(*) n FROM allowlist').n, 0);
  // search covers notes, labels and old names
  assert.equal(api.fansPeople({ q: 'brush' }).rows[0].uuid, 't:pal');
  assert.equal(api.fansPeople({ label: 'painter' }).rows.length, 1);
});

test('workflow: done/later/undo are local; a new interaction opens again; history never reopens (FR10, FR11)', async () => {
  const { svc, api, run, notify, fake, clock } = setup();
  api.setFansConfig({ collect: true, enabledAt: clock.t - 1000 });
  notify('t:main', { type: 'reply', reply_text: 'q1', from_tumblelog_uuid: 't:f', from_tumblelog_name: 'f', target_post_id: '1' });
  svc.pass(); await run();
  const [item] = api.fansToday().items;
  const writes = fake.calls.filter(c => /^(block|unblock|delete|reblog|put)/.test(c)).length;
  const prev = api.setFansEvents({ ids: [item.id], state: 'done' });
  assert.equal(api.fansToday().items.length, 0);
  api.setFansEvents({ restore: prev });
  assert.equal(api.fansToday().items.length, 1, 'undo');
  api.setFansEvents({ ids: [item.id], state: 'later', until: clock.t + 3600e3 });
  assert.equal(api.fansToday().items.length, 0);
  clock.t += 2 * 3600e3;
  assert.equal(api.fansToday().items.length, 1, 'later comes back when due');
  api.markReplied({ id: item.id });
  assert.equal(svc.db.get('SELECT replied, state FROM interactions WHERE id = ?', item.id).state, 'done');
  // a new reply on the same post is its own open item
  notify('t:main', { type: 'reply', reply_text: 'q2', from_tumblelog_uuid: 't:f', from_tumblelog_name: 'f', target_post_id: '1' });
  clock.t += 600e3; svc.pass(); await run();
  assert.deepEqual(api.fansToday().items.map(i => i.text), ['q2']);
  assert.equal(svc.db.get('SELECT state FROM interactions WHERE id = ?', item.id).state, 'done', 'the old one stays done');
  assert.equal(fake.calls.filter(c => /^(block|unblock|delete|reblog|put)/.test(c)).length, writes, 'no remote writes');
});

test('reminders: due today shows once, done and snooze work (FR12)', async () => {
  const { api, fake, clock } = setup();
  fake.infos.set('friend', { uuid: 't:fr' });
  const { id } = await api.addReminder({ key: 'name:friend', text: 'send the brush link', due: clock.t + 3600e3 });
  assert.equal(api.fansToday().reminders.length, 1);
  api.setReminder({ id, due: clock.t + 3 * 86400e3 });
  assert.equal(api.fansToday().reminders.length, 0);
  api.setReminder({ id, status: 'done' });
  assert.equal(api.fansReminders().length, 0);
  assert.equal(api.fansPerson({ key: 't:fr' }).reminders[0].status, 'done');
});

test('switches are independent: protection keeps running without collection, and a fans blog does not widen blocking (FR13)', async () => {
  const { svc, api, run, follow } = setup();
  svc.pass(); await run();
  api.setFollowerGuard({ mode: 'review' });
  await run();
  api.setFansConfig({ collect: true, blogs: ['t:main', 't:art'] });
  await run();
  follow('t:art', 'artfan', 't:af'); follow('t:main', 'mainfan', 't:mf');
  svc.pass(); await run();
  const inspected = svc.db.all(`SELECT payload FROM jobs WHERE kind = 'follower.inspect'`).map(j => JSON.parse(j.payload).name);
  assert.deepEqual(inspected, ['mainfan'], 'only protection blogs are inspected');
  assert.deepEqual(api.followerGuard().config.blogs, ['t:main']);
  api.setFansConfig({ collect: false });
  follow('t:main', 'later', 't:lt');
  svc.pass(); await run();
  assert.ok(svc.db.get(`SELECT 1 FROM followers WHERE name = 'later'`), 'protection still scans');
});

test('stats: counts are observations; unknown senders are counted apart (FR06)', async () => {
  const { svc, api, run, notify, clock } = setup();
  api.setFansConfig({ collect: true, enabledAt: clock.t - 1000 });
  notify('t:main', { type: 'reply', reply_text: 'a', from_tumblelog_uuid: 't:x', from_tumblelog_name: 'x', target_post_id: '1' });
  notify('t:main', { type: 'ask', is_anonymous: true, question: 'anon?', target_post_id: '1' });
  svc.pass(); await run();
  clock.t += 86400e3;
  notify('t:main', { type: 'reblog', added_text: 'again', from_tumblelog_uuid: 't:x', from_tumblelog_name: 'x', target_post_id: '1' });
  svc.pass(); await run();
  const s = api.fansStats({ days: 7 });
  assert.equal(s.interactions.people, 1);
  assert.equal(s.interactions.unresolved, 1);
  assert.equal(s.interactions.repeat, 1);
  assert.equal(s.counts.find(c => c.blog === 't:main').now, 3);
  assert.equal(s.counts.find(c => c.blog === 't:main').comparable, false, 'no earlier observation: no net change claimed');
  assert.equal(s.posts[0].post_id, '1');
});

test('migration: an old "gone" flag is a missing observation, not a confirmed unfollow', () => {
  const { openDb } = require('../src/service/db');
  const db = openDb(':memory:');
  assert.ok(db.all('PRAGMA table_info(followers)').some(c => c.name === 'gone_at'));
  db.run('INSERT INTO followers (blog, name, uuid, gone, baseline) VALUES (?, ?, ?, 1, 1)', 't:main', 'x', 't:x');
  assert.equal(db.get('SELECT gone_at FROM followers').gone_at, null);
});
