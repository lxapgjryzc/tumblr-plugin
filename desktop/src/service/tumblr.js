'use strict';
// Official Tumblr API adapter (api.tumblr.com, OAuth2 bearer). No browser session, cookies or web-client token.
// Reads are retried a little; writes (creates, full-post edits) never are: a lost response becomes an uncertain
// NetError and the job reads or reconciles before anything is sent again.

const { safeJson, errText, AuthError, NetError, RateError, HttpError, WaitError } = require('./errors');
const { relayable, optIn, RelayMiss } = require('./relay');
const { isPost } = require('./core');

const API = 'https://api.tumblr.com';
const UA = 'tumblr-studio/0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Request budget: a sliding window kept below the app's limits (1000/h, 5000/day for a new app). The server's
// own 429 + retry-after always wins over these numbers.
class Budget {
  constructor({ perHour = 950, perDay = 4800, load = () => [], save = () => {}, now = Date.now } = {}) {
    this.perHour = perHour; this.perDay = perDay; this.now = now; this.save = save;
    this.times = load().filter(t => t > now() - 86400e3);
    this.blockedUntil = 0; this.n = 0;
  }
  take() {
    const t = this.now();
    if (t < this.blockedUntil) throw new RateError('rate limited', { retryAt: this.blockedUntil });
    while (this.times.length && this.times[0] <= t - 86400e3) this.times.shift();
    const hour = this.times.filter(x => x > t - 3600e3);
    if (hour.length >= this.perHour) throw new RateError('hourly budget used', { retryAt: hour[0] + 3600e3 });
    if (this.times.length >= this.perDay) throw new RateError('daily budget used', { retryAt: this.times[0] + 86400e3 });
    this.times.push(t);
    if (++this.n % 20 === 0) this.save(this.times);
  }
  stats() {
    const t = this.now();
    return { hour: this.times.filter(x => x > t - 3600e3).length, day: this.times.length, perHour: this.perHour, perDay: this.perDay, blockedUntil: this.blockedUntil };
  }
}

// relay: the browser relay (relay.js). Requests it allows go through the browser while it is connected and
// don't count against the budget; whatever it can't take goes the official way below.
// browserFirst: the optional quota-saving mode (setting `relaySave`). While it returns true, a request the
// browser may carry never falls back to the official API: it waits for the browser (WaitError → job `waiting`,
// woken when the browser connects). Creates, deletes and visitor checks still go the official way.
// browserDelete / browserCreate / browserUpload: deletes, creates/reblogs, and posts or edits with new files may
// go through the browser too (settings `relayDelete` / `relayCreate` / `relayUpload`; see deletePost, createPost,
// reblog, putPostFiles). Files travel to the extension as base64 next to the JSON (MAX_RELAY_FILES in total).
const MAX_RELAY_FILES = 50 * 1024 * 1024;
async function relayFiles(files) {
  let total = 0;
  const out = [];
  for (const f of files) {
    const buf = Buffer.from(await f.blob.arrayBuffer());
    total += buf.length;
    if (total > MAX_RELAY_FILES) return null; // too big to carry: the official API takes it
    out.push({ identifier: f.identifier, filename: f.filename, mime: f.blob.type || 'application/octet-stream', b64: buf.toString('base64') });
  }
  return out;
}
function makeTumblr({ creds, budget = new Budget(), relay = null, browserFirst = () => false, browserDelete = () => false, browserCreate = () => false, browserUpload = () => false, fetchFn = fetch, timeoutMs = 30_000, onRequest = () => {} }) {
  async function viaBrowser(pathname, { method, query, json, files = null }) {
    const q = {};
    for (const [k, v] of Object.entries(query || {})) if (v != null) q[k] = String(v);
    let r;
    const t0 = Date.now();
    try { r = await relay.send({ method, path: pathname, query: q, json: json ?? null, ...(files ? { files } : {}) }); }
    catch (e) {
      onRequest({ method, path: pathname, status: 0, via: 'browser', ms: Date.now() - t0, error: e instanceof RelayMiss ? 'not taken: ' + e.message : e.message });
      // a refusal of this one request (another blog, not on the list) is not about the browser being usable
      if (e instanceof RelayMiss) return { miss: /^browser refused: (?!signed_out|other_account)/.test(e.message) ? 'request' : 'browser' };
      // taken but never answered: an edit may have landed (verification decides), a read is just retried
      throw new NetError(`${method} ${pathname} (browser): ${e.message}`, { uncertain: method !== 'GET' });
    }
    onRequest({ method, path: pathname, status: r.status, via: 'browser', ms: Date.now() - t0 });
    // the browser's own fetch failed (status 0): a write may have reached Tumblr, so it is uncertain and the job
    // reads fresh state before doing anything again; it is never resent the official way on the spot
    if (r.status === 0 && method !== 'GET') throw new NetError(`${method} ${pathname} (browser): the browser's request failed`, { uncertain: true, status: 0 });
    // signed out or limited in the browser: nothing was done, so the official API takes this one
    if (r.status === 401 || r.status === 429 || r.status === 0) return { miss: 'browser' };
    const j = safeJson(r.text);
    if (r.status >= 500) throw new NetError(`HTTP ${r.status} on ${method} ${pathname} (browser)`, { uncertain: method !== 'GET', status: r.status });
    if (r.status < 200 || r.status >= 300) throw new HttpError(`HTTP ${r.status}: ${errText(j ?? r.text.slice(0, 200))}`, { status: r.status, body: j });
    return { out: j?.response ?? j };
  }

  // Web-only actions (a reply has no public API): the browser or nothing. A request the browser never took, or
  // refused before sending (signed out, limited, not connected), throws WaitError (nothing sent, wait for it);
  // one it took and couldn't finish is uncertain (NetError, the caller reconciles). Never the official API.
  async function viaBrowserOnly(pathname, { method, query, json }) {
    if (!relay || !relay.available()) throw new WaitError('needs the signed-in browser (Tumblr Studio companion)');
    if (!relayable(method, pathname)) throw new WaitError('not a request the browser may carry');
    const q = {};
    for (const [k, v] of Object.entries(query || {})) if (v != null) q[k] = String(v);
    let r;
    const t0 = Date.now();
    try { r = await relay.send({ method, path: pathname, query: q, json: json ?? null }); }
    catch (e) {
      onRequest({ method, path: pathname, status: 0, via: 'browser-only', ms: Date.now() - t0, error: e.message });
      if (e instanceof RelayMiss) throw new WaitError('the browser did not take it (' + e.message + ')');
      throw new NetError(`${method} ${pathname} (browser): ${e.message}`, { uncertain: method !== 'GET' });
    }
    onRequest({ method, path: pathname, status: r.status, via: 'browser-only', ms: Date.now() - t0 });
    if (r.status === 401) throw new WaitError('the browser is signed out of Tumblr');
    if (r.status === 429) throw new WaitError('Tumblr limited the browser', { retryAt: Date.now() + (r.retryAfter || 300) * 1000 });
    // status 0: the browser's fetch failed, which may be after Tumblr got it
    if (r.status === 0 || r.status >= 500) throw new NetError(`HTTP ${r.status} on ${method} ${pathname} (browser)`, { uncertain: method !== 'GET', status: r.status });
    const j = safeJson(r.text);
    if (r.status < 200 || r.status >= 300) throw new HttpError(`HTTP ${r.status}: ${errText(j ?? r.text.slice(0, 200))}`, { status: r.status, body: j });
    return j?.response ?? j;
  }

  // browserJson: the JSON body the browser sends for a request whose official body is a form or multipart
  // browser: an opt-in write (relay.optIn) goes through the browser only when this is true
  // browserFiles: new files for the browser ({ identifier, filename, mime, b64 }), sent with browserJson as multipart
  async function request(pathname, { method = 'GET', query, json, form, body, bearer = true, retries, browserOnly = false, browserJson = null, browserFiles = null, browser = false } = {}) {
    // core.js builds paths with the query string attached; split it off so the relay sees the bare path
    const qi = pathname.indexOf('?');
    if (qi >= 0) {
      query = { ...Object.fromEntries(new URLSearchParams(pathname.slice(qi + 1))), ...(query || {}) };
      pathname = pathname.slice(0, qi);
    }
    if (browserOnly) return viaBrowserOnly(pathname, { method, query, json });
    const bjson = browserJson || json;
    if (relay && bearer && (browserJson || (!form && !body)) && relayable(method, pathname) && (browser || !optIn(method, pathname))) {
      const wait = browserFirst();
      if (wait && !relay.available()) throw new WaitError('waiting for the browser (saving official API quota)');
      if (relay.available()) {
        const r = await viaBrowser(pathname, { method, query, json: bjson, files: browserFiles });
        if (!r.miss) return r.out;
        // quota-saving mode: nothing was sent and the browser can't work right now, so wait for it
        if (wait && r.miss === 'browser') throw new WaitError('the browser could not take it; waiting (saving official API quota)');
        relay.noteFallback?.();
      }
    }
    const url = new URL(API + pathname);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
    if (!bearer) url.searchParams.set('api_key', creds.clientId());
    const creates = method === 'POST';
    // only reads retry on the spot. A write (create, full edit) whose answer was lost is never resent blindly:
    // the job reads fresh state first (an edit may have landed and been changed on Tumblr since)
    const maxTry = retries ?? (method === 'GET' ? 2 : 0);
    for (let attempt = 0; ; attempt++) {
      budget.take();
      const headers = { 'User-Agent': UA, Accept: 'application/json' };
      if (bearer) headers.Authorization = 'Bearer ' + await creds.accessToken();
      let payload = body;
      if (json) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
      else if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form); }
      let res, text;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const t0 = Date.now();
      try {
        res = await fetchFn(url, { method, headers, body: payload, signal: ctl.signal });
        text = await res.text();
      } catch (e) {
        clearTimeout(timer);
        onRequest({ method, path: pathname, status: 0, via: 'official', ms: Date.now() - t0, attempt, error: e.name === 'AbortError' ? 'timeout' : e.message });
        if (!creates && attempt < maxTry) { await sleep(1000 * 2 ** attempt); continue; }
        throw new NetError(`${method} ${pathname}: ${e.name === 'AbortError' ? 'timeout' : e.message}`, { uncertain: method !== 'GET' });
      }
      clearTimeout(timer);
      const j = safeJson(text);
      onRequest({ method, path: pathname, status: res.status, via: 'official', ms: Date.now() - t0, attempt, ...(res.ok ? {} : { error: errText(j ?? text.slice(0, 200)) }) });
      if (res.status === 401 && bearer && attempt === 0) { await creds.accessToken(true); continue; }
      if (res.status === 401) throw new AuthError('unauthorised');
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after')) || 60;
        budget.blockedUntil = Date.now() + ra * 1000;
        throw new RateError('HTTP 429', { retryAt: budget.blockedUntil });
      }
      if (res.status >= 500) {
        if (!creates && attempt < maxTry) { await sleep(2000 * 2 ** attempt); continue; }
        throw new NetError(`HTTP ${res.status} on ${method} ${pathname}`, { uncertain: method !== 'GET', status: res.status });
      }
      if (!res.ok) throw new HttpError(`HTTP ${res.status}: ${errText(j ?? text.slice(0, 200))}`, { status: res.status, body: j });
      return j?.response ?? j;
    }
  }

  const enc = encodeURIComponent;
  const T = {
    request,
    async blogs() {
      const r = await request('/v2/user/info');
      const user = r.user || {};
      return { name: user.name, blogs: (user.blogs || []).map(b => ({
        uuid: b.uuid, name: b.name, title: b.title, primary: !!b.primary, url: b.url, followers: b.followers ?? null,
        avatar: (b.avatar || []).slice().sort((a, b) => Math.abs(a.width - 64) - Math.abs(b.width - 64))[0]?.url || null,
      })) };
    },
    // One page of a blog's posts. box: '' (published + private for the owner) | 'draft' | 'queue'
    async postsPage(blog, { box = '', next = null, limit = 20 } = {}) {
      const base = `/v2/blog/${enc(blog)}/posts${box ? '/' + box : ''}`;
      const query = { npf: true, limit, ...(next || {}) };
      const r = await request(base, { query });
      const qp = r?._links?.next?.query_params || null;
      // The web API (browser relay) mixes ads (backfill_ad, client_side_ad_waterfall…) into post lists: keep posts only.
      // Paging still follows the raw page, so a page of nothing but ads doesn't end the walk.
      const raw = r?.posts || [];
      return { posts: raw.filter(isPost), next: qp && raw.length ? qp : null };
    },
    getPost: (blog, id) => request(`/v2/blog/${enc(blog)}/posts/${enc(id)}`, { query: { post_format: 'npf' } }),
    putPost: (blog, id, body) => request(`/v2/blog/${enc(blog)}/posts/${enc(id)}`, { method: 'PUT', json: body }),
    // A full edit that adds image files (multipart like a create; official API, the relay carries JSON only)
    putPostFiles(blog, id, body, files = []) {
      if (!files.length) return T.putPost(blog, id, body);
      const fd = new FormData();
      fd.append('json', JSON.stringify(body));
      for (const f of files) fd.append(f.identifier, f.blob, f.filename);
      return (async () => {
        const bf = browserUpload() ? await relayFiles(files) : null;
        return request(`/v2/blog/${enc(blog)}/posts/${enc(id)}`, { method: 'PUT', body: fd, ...(bf ? { browserJson: body, browserFiles: bf } : {}) });
      })();
    },
    // The replies under a post, normalised. The web client's own list (/post/{id}/replies: ids and threads)
    // through the browser; otherwise the public notes API in conversation mode (replies without ids). Read only.
    // -> { source: 'replies' | 'notes', replies: [{ id, uuid, name, text, at, children }] }
    async replies(blog, id) {
      if (relay && relay.available()) {
        try {
          const r = await request(`/v2/blog/${enc(blog)}/post/${enc(id)}/replies`, { query: { mode: 'replies', sort: 'asc' } });
          if (r?.timeline) return { source: 'replies', replies: replyTree(r.timeline.elements || []) };
        } catch (e) { if (!(e instanceof HttpError)) throw e; }
      }
      const out = [];
      let before = null;
      for (let page = 0; page < 5; page++) {
        const r = await request(`/v2/blog/${enc(blog)}/notes`, { query: { id, mode: 'conversation', ...(before ? { before_timestamp: before } : {}) } });
        const notes = r?.notes || [];
        for (const n of notes) {
          if (pick(n, 'type') !== 'reply') continue;
          out.push({ id: null, uuid: pick(n, 'blog_uuid') || null, name: pick(n, 'blog_name') || null, text: String(pick(n, 'reply_text') || ''), at: Math.round(Number(pick(n, 'timestamp')) * 1000) || 0, children: [] });
        }
        const next = r?._links?.next?.query_params?.before_timestamp;
        if (!notes.length || !next || String(next) === String(before)) break;
        before = next;
      }
      return { source: 'notes', replies: out.sort((a, b) => a.at - b.at) };
    },
    // Reply to a post as one of my blogs (the web client's own request; no public API): browser only, never retried
    sendReply: ({ postId, postBlog, reblogKey, text, replyAs }) => request('/v2/user/post/reply', { method: 'POST', browserOnly: true,
      json: { post_id: String(postId), reblog_key: reblogKey, tumblelog: postBlog, reply_text: text, reply_as: replyAs } }),
    // NPF create; files: [{ identifier, blob, filename }]
    async createPost(blog, json, files = []) {
      const fd = new FormData();
      fd.append('json', JSON.stringify(json));
      for (const f of files) fd.append(f.identifier, f.blob, f.filename);
      // without new files the browser may carry it as JSON (relayCreate); with files as multipart (also relayUpload)
      let via = {};
      if (browserCreate() && !files.length) via = { browserJson: json, browser: true };
      else if (browserCreate() && browserUpload()) { const bf = await relayFiles(files); if (bf) via = { browserJson: json, browserFiles: bf, browser: true }; }
      const r = await request(`/v2/blog/${enc(blog)}/posts`, { method: 'POST', body: fd, ...via });
      return String(r?.id_string ?? r?.id ?? r?.post?.id_string ?? r?.post?.id ?? '');
    },
    async reblog(dest, { parentBlog, parentId, reblogKey, state = 'published', tags = [], content = [], reblogControl }) {
      const json = { parent_tumblelog_uuid: parentBlog, parent_post_id: parentId, reblog_key: reblogKey, content, state, tags: tags.join(',') };
      if (reblogControl === 'noone') json.interactability_reblog = 'noone';
      const r = await request(`/v2/blog/${enc(dest)}/posts`, { method: 'POST', json, browser: browserCreate() });
      return String(r?.id_string ?? r?.id ?? '');
    },
    // Official: a form. Through the browser (only with `relayDelete` on): the same request as JSON. A delete the
    // browser took without a clear answer is uncertain; the delete jobs check whether the post is gone first.
    deletePost: (blog, id) => request(`/v2/blog/${enc(blog)}/post/delete`, { method: 'POST', form: { id },
      ...(browserDelete() ? { browserJson: { id: String(id) }, browser: true } : {}) }),
    followers: (blog, offset = 0, limit = 20) => request(`/v2/blog/${enc(blog)}/followers`, { query: { limit, offset } }),
    following: (offset = 0, limit = 20) => request('/v2/user/following', { query: { limit, offset } }),
    // Activity of one of my blogs (newest first, paged by `before` = a timestamp in seconds); read only
    notifications: (blog, query = {}) => request(`/v2/blog/${enc(blog)}/notifications`, { query: { rollups: false, ...query } }),
    // Is `name` following my blog `blog`? → { followed_by: bool }
    followedBy: (blog, name) => request(`/v2/blog/${enc(blog)}/followed_by`, { query: { query: name } }),
    blocks: (blog, offset = 0, limit = 20) => request(`/v2/blog/${enc(blog)}/blocks`, { query: { limit, offset } }),
    block: (blog, target) => request(`/v2/blog/${enc(blog)}/blocks`, { method: 'POST', form: { blocked_tumblelog: target } }),
    unblock: (blog, target) => request(`/v2/blog/${enc(blog)}/blocks`, { method: 'DELETE', query: { blocked_tumblelog: target }, retries: 1 }),
    // Public views (app key, no bearer): what a visitor sees
    publicInfo: name => request(`/v2/blog/${enc(name)}/info`, { bearer: false }),
    publicPosts: (name, limit = 10) => request(`/v2/blog/${enc(name)}/posts`, { bearer: false, query: { npf: true, limit } }),
    budget,
    relay,
  };
  return T;
}

// snake_case (official, relay) or camelCase field
function pick(o, snake) {
  if (!o) return undefined;
  if (o[snake] !== undefined) return o[snake];
  return o[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
}
// /replies timeline elements (post_note of type reply; NPF content; children = the thread under it) -> plain rows
function replyTree(elements) {
  const text = el => {
    const c = pick(el, 'content');
    if (Array.isArray(c) && c.length) return c.filter(b => b.type === 'text').map(b => b.text).join('\n');
    return String(pick(el, 'reply_text') || '');
  };
  const one = el => ({
    id: String(pick(el, 'reply_id') || pick(el, 'id') || '') || null,
    uuid: pick(el, 'blog')?.uuid || pick(el, 'blog_uuid') || null,
    name: pick(el, 'blog')?.name || pick(el, 'blog_name') || null,
    text: text(el),
    at: Math.round(Number(pick(el, 'timestamp')) * 1000) || 0,
    children: (pick(el, 'children')?.elements || []).filter(x => pick(x, 'type') === 'reply').map(one),
  });
  return (elements || []).filter(x => pick(x, 'type') === 'reply').map(one);
}

module.exports = { makeTumblr, Budget, API, replyTree };
