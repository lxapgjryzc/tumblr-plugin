'use strict';
// The browser relay (service/relay.js): allowed requests go through the paired browser while it is connected,
// don't use the official budget, and fall back to the official API whenever the browser can't take them.
// Blogs and ids are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRelay, relayable, optIn } = require('../src/service/relay');
const { makeTumblr, Budget } = require('../src/service/tumblr');

const creds = { accessToken: async () => 'tok', clientId: () => 'key' };
const official = (calls, status = 200, body = { response: { via: 'official' } }) => async (url, opts) => {
  calls.push({ url: String(url), method: opts.method });
  return { status, ok: status < 300, headers: { get: () => null }, text: async () => JSON.stringify(body) };
};
// a fake extension: takes what the relay hands out and answers with `answer(item)`
async function browser(relay, answer) {
  const items = await relay.next(1000);
  for (const it of items) relay.done({ rid: it.rid, ...answer(it) });
  return items;
}

test('relay: only own-post reads and edits, follower lists, likes and tag search are allowed', () => {
  assert.ok(relayable('GET', '/v2/blog/t%3Aabc/posts'));
  assert.ok(relayable('GET', '/v2/blog/mainblog/posts/draft'));
  assert.ok(relayable('GET', '/v2/blog/mainblog/posts/12345'));
  assert.ok(relayable('PUT', '/v2/blog/mainblog/posts/12345'));
  assert.ok(relayable('GET', '/v2/user/following'));
  assert.ok(relayable('GET', '/v2/user/likes'));
  assert.ok(relayable('GET', '/v2/tagged'));
  assert.ok(relayable('GET', '/v2/blog/someoneelse/notes'));
  assert.ok(!relayable('POST', '/v2/user/unlike'), 'unlike stays official');
  assert.ok(relayable('POST', '/v2/blog/mainblog/posts') && optIn('POST', '/v2/blog/mainblog/posts'), 'creates only when the caller opts in (relayCreate)');
  assert.ok(optIn('POST', '/v2/blog/mainblog/post/delete') && !optIn('PUT', '/v2/blog/mainblog/posts/1'));
  assert.ok(relayable('POST', '/v2/blog/mainblog/post/delete'), 'deletes may be relayed (only when the adapter offers them: relayDelete)');
  assert.ok(!relayable('GET', '/v2/blog/mainblog/info'));
  assert.ok(!relayable('PUT', '/v2/blog/mainblog/posts/12345/../../x'));
});

test('relay: a connected browser carries the request and the official budget is untouched', async () => {
  const relay = makeRelay();
  const budget = new Budget({ perHour: 2 });
  const calls = [];
  const T = makeTumblr({ creds, budget, relay, fetchFn: official(calls) });
  await relay.next(0); // the extension polled: connected
  const p = T.getPost('mainblog', '123');
  const items = await browser(relay, () => ({ status: 200, text: JSON.stringify({ response: { id_string: '123', via: 'browser' } }) }));
  assert.equal(items[0].method, 'GET');
  assert.equal(items[0].path, '/v2/blog/mainblog/posts/123');
  assert.deepEqual(items[0].query, { post_format: 'npf' });
  assert.equal((await p).via, 'browser');
  assert.equal(calls.length, 0);
  assert.equal(budget.stats().hour, 0);
  // an edit carries its body
  const put = T.putPost('mainblog', '123', { content: [], tags: 'a,b' });
  const [it] = await browser(relay, () => ({ status: 200, text: '{"response":{}}' }));
  assert.deepEqual(it.json, { content: [], tags: 'a,b' });
  await put;
  assert.equal(relay.stats().hour, 2);
});

test('relay: core-style paths with the query attached are relayed with the query split off', async () => {
  const relay = makeRelay();
  const calls = [];
  const T = makeTumblr({ creds, relay, fetchFn: official(calls) });
  await relay.next(0);
  const p = T.request('/v2/tagged?tag=moomin%20valley&limit=20');
  const [it] = await browser(relay, () => ({ status: 200, text: '{"response":[]}' }));
  assert.equal(it.path, '/v2/tagged');
  assert.deepEqual(it.query, { tag: 'moomin valley', limit: '20' });
  assert.deepEqual(await p, []);
  const l = T.request('/v2/user/likes?npf=true&limit=20');
  const [it2] = await browser(relay, () => ({ status: 200, text: '{"response":{"liked_posts":[]}}' }));
  assert.equal(it2.path, '/v2/user/likes');
  await l;
  assert.equal(calls.length, 0);
  // the official way gets the same query back
  const off = makeTumblr({ creds, fetchFn: official(calls) });
  await off.request('/v2/blog/x/notes?id=5&mode=reblogs');
  assert.match(calls[0].url, /\/v2\/blog\/x\/notes\?id=5&mode=reblogs$/);
});

test('relay: not connected, signed out, limited or another account → the official API', async () => {
  const calls = [];
  let relay = makeRelay();
  let T = makeTumblr({ creds, relay, fetchFn: official(calls) });
  assert.equal((await T.getPost('mainblog', '1')).via, 'official', 'never polled');

  relay = makeRelay();
  T = makeTumblr({ creds, relay, fetchFn: official(calls) });
  await relay.next(0);
  let p = T.getPost('mainblog', '1');
  await browser(relay, () => ({ status: 401, text: '{}' }));
  assert.equal((await p).via, 'official', 'browser signed out: sent officially');
  assert.equal(relay.available(), false, 'and the browser is left alone for a while');
  assert.equal(relay.stats().coolWhy, 'signed_out');

  relay = makeRelay();
  T = makeTumblr({ creds, relay, fetchFn: official(calls) });
  await relay.next(0);
  p = T.getPost('mainblog', '1');
  await browser(relay, () => ({ refused: 'other_account' }));
  assert.equal((await p).via, 'official');
  assert.equal(relay.stats().coolWhy, 'other_account');

  // one request the browser won't carry (a blog outside the account) goes official, and the relay stays usable
  relay = makeRelay();
  T = makeTumblr({ creds, relay, fetchFn: official(calls) });
  await relay.next(0);
  p = T.putPost('someoneelse', '1', { tags: 'x' });
  await browser(relay, () => ({ refused: 'not_own_blog' }));
  assert.equal((await p).via, 'official');
  assert.equal(relay.stats().coolWhy, null);
  assert.ok(relay.available());

  relay = makeRelay();
  T = makeTumblr({ creds, relay, fetchFn: official(calls) });
  await relay.next(0);
  p = T.getPost('mainblog', '1');
  await browser(relay, () => ({ status: 429, text: '{}', retryAfter: 60 }));
  assert.equal((await p).via, 'official');
  assert.equal(relay.stats().coolWhy, 'limited');

  // disabled in Settings
  relay = makeRelay({ enabled: () => false });
  T = makeTumblr({ creds, relay, fetchFn: official(calls) });
  await relay.next(0);
  assert.equal((await T.getPost('mainblog', '1')).via, 'official');
});

test('relay: creates and visitor checks never use the browser', async () => {
  const relay = makeRelay();
  const calls = [];
  const T = makeTumblr({ creds, relay, fetchFn: official(calls, 200, { response: { id_string: '9' } }) });
  await relay.next(0);
  assert.equal(await T.reblog('mainblog', { parentBlog: 't:x', parentId: '1', reblogKey: 'k' }), '9');
  await T.publicPosts('mainblog');
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /api_key=key/);
});

test('relay: a browser error answer is the same error as from the official API', async () => {
  const relay = makeRelay();
  const T = makeTumblr({ creds, relay, fetchFn: official([]) });
  await relay.next(0);
  const p = T.getPost('mainblog', '404');
  await browser(relay, () => ({ status: 404, text: JSON.stringify({ meta: { status: 404, msg: 'Not Found' } }) }));
  await assert.rejects(p, e => e.status === 404);
});

test('relay: a request the browser never picks up goes the official way', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const relay = makeRelay();
  const calls = [];
  const T = makeTumblr({ creds, relay, fetchFn: official(calls) });
  await relay.next(0);
  const p = T.getPost('mainblog', '1');
  await Promise.resolve();
  t.mock.timers.tick(9000);
  assert.equal((await p).via, 'official');
  assert.equal(calls.length, 1);
});

test('relay: becoming connected wakes what waited for the official limit', async () => {
  let woke = 0;
  const relay = makeRelay({ onConnect: () => woke++ });
  await relay.next(0);
  await relay.next(0);
  assert.equal(woke, 1, 'once per connection');
});

test('relay: usable again after a pause wakes the waiting jobs again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 });
  let woke = 0; const cooled = [];
  const relay = makeRelay({ now: () => Date.now(), onConnect: () => woke++, onCool: why => cooled.push(why) });
  await relay.next(0);
  relay.cool('limited', 60e3);
  assert.deepEqual(cooled, ['limited']);
  await relay.next(0);
  assert.equal(woke, 1, 'still paused');
  t.mock.timers.tick(61e3);
  await relay.next(0);
  assert.equal(woke, 2);
});

test('relay: ads the web API mixes into a post list are dropped, paging continues', async () => {
  const relay = makeRelay();
  const T = makeTumblr({ creds, budget: new Budget({ perHour: 10 }), relay, fetchFn: official([]) });
  await relay.next(0);
  const page = T.postsPage('mainblog');
  await browser(relay, () => ({ status: 200, text: JSON.stringify({ response: {
    posts: [{ object_type: 'post', id_string: '1' }, { object_type: 'backfill_ad', ad_instance_id: 'x' }, { object_type: 'client_side_ad_waterfall', id: 'google_native_1' }],
    _links: { next: { query_params: { offset: 20 } } },
  } }) }));
  const r = await page;
  assert.deepEqual(r.posts.map(p => p.id_string), ['1']);
  assert.deepEqual(r.next, { offset: 20 });
});

test('relay: quota-saving mode waits for the browser instead of using the official API', async () => {
  const { WaitError } = require('../src/service/errors');
  const calls = [];
  let relay = makeRelay();
  let T = makeTumblr({ creds, relay, browserFirst: () => true, fetchFn: official(calls) });
  await assert.rejects(T.getPost('mainblog', '1'), WaitError, 'never polled: waits');
  await assert.rejects(T.putPost('mainblog', '1', { tags: 'x' }), WaitError);
  assert.equal(calls.length, 0);

  // signed out in the browser: nothing sent officially, it waits
  await relay.next(0);
  let p = T.getPost('mainblog', '1');
  await browser(relay, () => ({ status: 401, text: '{}' }));
  await assert.rejects(p, WaitError);
  assert.equal(calls.length, 0);

  // one request the browser won't carry still goes official (it would never be carried)
  relay = makeRelay();
  T = makeTumblr({ creds, relay, browserFirst: () => true, fetchFn: official(calls) });
  await relay.next(0);
  p = T.putPost('someoneelse', '1', { tags: 'x' });
  await browser(relay, () => ({ refused: 'not_own_blog' }));
  assert.equal((await p).via, 'official');

  // creates and visitor checks are unaffected
  const before = calls.length;
  const C = makeTumblr({ creds, relay: makeRelay(), browserFirst: () => true, fetchFn: official(calls, 200, { response: { id_string: '9' } }) });
  assert.equal(await C.reblog('mainblog', { parentBlog: 't:x', parentId: '1', reblogKey: 'k' }), '9');
  await C.publicPosts('mainblog');
  assert.equal(calls.length, before + 2);
});

test('official API: an error answer keeps its status (a 404 is an HttpError with status 404)', async () => {
  const calls = [];
  const T = makeTumblr({ creds, fetchFn: official(calls, 404, { meta: { status: 404, msg: 'Not Found' } }) });
  const e = await T.getPost('mainblog', '1').catch(e => e);
  assert.equal(e.constructor.name, 'HttpError', String(e));
  assert.equal(e.status, 404);
});

test('relay: deletes go through the browser only when turned on, and a lost answer is never resent officially', async () => {
  const { NetError, WaitError } = require('../src/service/errors');
  const calls = [];
  // default: off, even with the browser connected
  let relay = makeRelay();
  let T = makeTumblr({ creds, relay, fetchFn: official(calls) });
  await relay.next(0);
  await T.deletePost('mainblog', '55');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v2\/blog\/mainblog\/post\/delete$/);

  // on and connected: the browser sends { id } as JSON, the official budget is untouched
  const budget = new Budget();
  T = makeTumblr({ creds, budget, relay, browserDelete: () => true, fetchFn: official(calls) });
  let p = T.deletePost('mainblog', '55');
  const [it] = await browser(relay, () => ({ status: 200, text: '{"response":{"id_string":"55"}}' }));
  assert.equal(it.method, 'POST');
  assert.deepEqual(it.json, { id: '55' });
  await p;
  assert.equal(calls.length, 1);
  assert.equal(budget.stats().hour, 0);

  // the browser's fetch failed after sending: uncertain, nothing sent the official way
  p = T.deletePost('mainblog', '56');
  await browser(relay, () => ({ status: 0 }));
  const e = await p.catch(e => e);
  assert.ok(e instanceof NetError && e.uncertain, String(e));
  assert.equal(calls.length, 1);

  // an older extension that doesn't know deletes refuses before sending: the official API takes it
  p = T.deletePost('mainblog', '57');
  await browser(relay, () => ({ refused: 'not_allowed' }));
  await p;
  assert.equal(calls.length, 2);

  // not connected: the official API by default, waiting in quota-saving mode
  relay = makeRelay();
  T = makeTumblr({ creds, relay, browserDelete: () => true, fetchFn: official(calls) });
  await T.deletePost('mainblog', '58');
  assert.equal(calls.length, 3);
  T = makeTumblr({ creds, relay, browserDelete: () => true, browserFirst: () => true, fetchFn: official(calls) });
  await assert.rejects(T.deletePost('mainblog', '59'), WaitError);
  assert.equal(calls.length, 3);
});

test('relay: an edit whose browser request failed is uncertain, not resent the official way', async () => {
  const { NetError } = require('../src/service/errors');
  const calls = [];
  const relay = makeRelay();
  const T = makeTumblr({ creds, relay, fetchFn: official(calls) });
  await relay.next(0);
  const p = T.putPost('mainblog', '1', { tags: 'x' });
  await browser(relay, () => ({ status: 0 }));
  const e = await p.catch(e => e);
  assert.ok(e instanceof NetError && e.uncertain);
  assert.equal(calls.length, 0);
});

test('relay: creates and reblogs go through the browser only when turned on; files and lost answers stay safe', async () => {
  const { NetError, WaitError } = require('../src/service/errors');
  const calls = [];
  const ok = { response: { id_string: '900000000000000001' } };
  // default: off, even with the browser connected
  let relay = makeRelay();
  let T = makeTumblr({ creds, relay, fetchFn: official(calls, 201, ok) });
  await relay.next(0);
  assert.equal(await T.reblog('mainblog', { parentBlog: 't:x', parentId: '1', reblogKey: 'k' }), '900000000000000001');
  assert.equal(calls.length, 1);

  // on and connected: a reblog and an original without files go through the browser as JSON
  const budget = new Budget();
  T = makeTumblr({ creds, budget, relay, browserCreate: () => true, fetchFn: official(calls, 201, ok) });
  let p = T.reblog('mainblog', { parentBlog: 't:x', parentId: '1', reblogKey: 'k', tags: ['a', 'b'] });
  let [it] = await browser(relay, () => ({ status: 201, text: '{"response":{"id":900000000000000002,"id_string":"900000000000000002"}}' }));
  assert.equal(it.path, '/v2/blog/mainblog/posts');
  assert.equal(it.json.reblog_key, 'k');
  assert.equal(await p, '900000000000000002');
  p = T.createPost('mainblog', { content: [{ type: 'text', text: 'hi' }], state: 'private', tags: 'a' });
  [it] = await browser(relay, () => ({ status: 201, text: '{"response":{"id":900000000000000003}}' }));
  assert.deepEqual(it.json, { content: [{ type: 'text', text: 'hi' }], state: 'private', tags: 'a' });
  assert.equal(await p, '900000000000000003', 'a long numeric id keeps its precision');
  assert.equal(calls.length, 1);
  assert.equal(budget.stats().hour, 0);

  // with new files: official (multipart)
  await T.createPost('mainblog', { content: [] }, [{ identifier: 'i', blob: new Blob(['x']), filename: 'a.png' }]);
  assert.equal(calls.length, 2);

  // taken, then the browser's request failed or never answered: uncertain, nothing sent officially
  p = T.reblog('mainblog', { parentBlog: 't:x', parentId: '1', reblogKey: 'k' });
  await browser(relay, () => ({ status: 0 }));
  let e = await p.catch(e => e);
  assert.ok(e instanceof NetError && e.uncertain, String(e));
  p = T.reblog('mainblog', { parentBlog: 't:x', parentId: '1', reblogKey: 'k' });
  await browser(relay, () => ({ status: 502, text: '' }));
  e = await p.catch(e => e);
  assert.ok(e instanceof NetError && e.uncertain, 'a 5xx from the browser is uncertain too');
  assert.equal(calls.length, 2);

  // an older extension refuses before sending: official
  p = T.reblog('mainblog', { parentBlog: 't:x', parentId: '1', reblogKey: 'k' });
  await browser(relay, () => ({ refused: 'not_allowed' }));
  await p;
  assert.equal(calls.length, 3);

  // not connected: official by default, waiting in quota-saving mode
  relay = makeRelay();
  T = makeTumblr({ creds, relay, browserCreate: () => true, fetchFn: official(calls, 201, ok) });
  await T.reblog('mainblog', { parentBlog: 't:x', parentId: '1', reblogKey: 'k' });
  assert.equal(calls.length, 4);
  T = makeTumblr({ creds, relay, browserCreate: () => true, browserFirst: () => true, fetchFn: official(calls, 201, ok) });
  await assert.rejects(T.reblog('mainblog', { parentBlog: 't:x', parentId: '1', reblogKey: 'k' }), WaitError);
  await assert.rejects(T.createPost('mainblog', { content: [] }), WaitError);
  assert.equal(calls.length, 4);
});

test('relay: new image files go through the browser only with uploads on, as base64 beside the JSON', async () => {
  const { NetError } = require('../src/service/errors');
  const calls = [];
  const ok = { response: { id_string: '900000000000000011' } };
  const png = () => [{ identifier: 'b1', blob: new Blob([Buffer.from('PNGDATA')], { type: 'image/png' }), filename: 'a.png' }];
  const relay = makeRelay();
  await relay.next(0);
  // creates on, uploads off: a post with files stays official
  let T = makeTumblr({ creds, relay, browserCreate: () => true, fetchFn: official(calls, 201, ok) });
  await T.createPost('mainblog', { content: [{ type: 'image', media: [{ identifier: 'b1' }] }] }, png());
  assert.equal(calls.length, 1);

  // uploads on: the browser gets the JSON and the file
  T = makeTumblr({ creds, relay, browserCreate: () => true, browserUpload: () => true, fetchFn: official(calls, 201, ok) });
  let p = T.createPost('mainblog', { content: [{ type: 'image', media: [{ identifier: 'b1' }] }], state: 'draft' }, png());
  let [it] = await browser(relay, () => ({ status: 201, text: '{"response":{"id_string":"900000000000000012"}}' }));
  assert.equal(it.method, 'POST');
  assert.deepEqual(it.json.content[0].media[0], { identifier: 'b1' });
  assert.deepEqual(it.files.map(f => [f.identifier, f.filename, f.mime, Buffer.from(f.b64, 'base64').toString()]), [['b1', 'a.png', 'image/png', 'PNGDATA']]);
  assert.equal(await p, '900000000000000012');
  assert.equal(calls.length, 1);

  // an edit that adds a file: PUT with the file
  p = T.putPostFiles('mainblog', '7', { content: [{ type: 'image', media: [{ identifier: 'b1' }] }] }, png());
  [it] = await browser(relay, () => ({ status: 200, text: '{"response":{}}' }));
  assert.equal(it.method, 'PUT');
  assert.equal(it.files.length, 1);
  await p;

  // lost after sending: uncertain, never resent officially
  p = T.createPost('mainblog', { content: [{ type: 'image', media: [{ identifier: 'b1' }] }] }, png());
  await browser(relay, () => ({ status: 0 }));
  const e = await p.catch(e => e);
  assert.ok(e instanceof NetError && e.uncertain);
  // an older extension refuses the files before sending: official
  p = T.createPost('mainblog', { content: [{ type: 'image', media: [{ identifier: 'b1' }] }] }, png());
  await browser(relay, () => ({ refused: 'not_allowed' }));
  await p;
  assert.equal(calls.length, 2);

  // too big to carry: official
  const big = [{ identifier: 'b1', blob: new Blob([Buffer.alloc(51 * 1024 * 1024)], { type: 'image/png' }), filename: 'big.png' }];
  await T.createPost('mainblog', { content: [{ type: 'image', media: [{ identifier: 'b1' }] }] }, big);
  assert.equal(calls.length, 3);
});

test('official API: a full edit whose answer was lost is not resent on the spot', async () => {
  const { NetError } = require('../src/service/errors');
  let n = 0;
  const T = makeTumblr({ creds, fetchFn: async () => { n++; throw new Error('socket hang up'); } });
  const e = await T.putPost('mainblog', '1', { tags: 'x' }).catch(e => e);
  assert.ok(e instanceof NetError && e.uncertain);
  assert.equal(n, 1, 'one attempt; the job re-reads before any other');
});
