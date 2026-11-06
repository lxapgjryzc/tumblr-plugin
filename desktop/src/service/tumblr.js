'use strict';
// Official Tumblr API adapter (api.tumblr.com, OAuth2 bearer). No browser session, cookies or web-client token.
// Reads and full-post edits (PUT) are retried a little; creating requests (POST) never are: a lost response
// becomes an uncertain NetError and the caller reconciles before anything is sent again.

const { safeJson, errText, AuthError, NetError, RateError, HttpError } = require('./errors');
const { relayable, RelayMiss } = require('./relay');
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
function makeTumblr({ creds, budget = new Budget(), relay = null, fetchFn = fetch, timeoutMs = 30_000, onRequest = () => {} }) {
  async function viaBrowser(pathname, { method, query, json }) {
    const q = {};
    for (const [k, v] of Object.entries(query || {})) if (v != null) q[k] = String(v);
    let r;
    try { r = await relay.send({ method, path: pathname, query: q, json: json ?? null }); }
    catch (e) {
      if (e instanceof RelayMiss) { relay.noteFallback?.(); return null; }
      // taken but never answered: an edit may have landed (verification decides), a read is just retried
      throw new NetError(`${method} ${pathname} (browser): ${e.message}`, { uncertain: method !== 'GET' });
    }
    onRequest({ method, path: pathname, status: r.status, via: 'browser' });
    // signed out or limited in the browser: nothing was done, so the official API takes this one
    if (r.status === 401 || r.status === 429 || r.status === 0) { relay.noteFallback?.(); return null; }
    const j = safeJson(r.text);
    if (r.status >= 500) throw new NetError(`HTTP ${r.status} on ${method} ${pathname} (browser)`, { uncertain: method !== 'GET', status: r.status });
    if (r.status < 200 || r.status >= 300) throw new HttpError(`HTTP ${r.status}: ${errText(j ?? r.text.slice(0, 200))}`, { status: r.status, body: j });
    return { out: j?.response ?? j };
  }

  async function request(pathname, { method = 'GET', query, json, form, body, bearer = true, retries } = {}) {
    // core.js builds paths with the query string attached; split it off so the relay sees the bare path
    const qi = pathname.indexOf('?');
    if (qi >= 0) {
      query = { ...Object.fromEntries(new URLSearchParams(pathname.slice(qi + 1))), ...(query || {}) };
      pathname = pathname.slice(0, qi);
    }
    if (relay && bearer && !form && !body && relay.available() && relayable(method, pathname)) {
      const r = await viaBrowser(pathname, { method, query, json });
      if (r) return r.out;
    }
    const url = new URL(API + pathname);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
    if (!bearer) url.searchParams.set('api_key', creds.clientId());
    const creates = method === 'POST';
    const maxTry = retries ?? (creates ? 0 : 2);
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
      try {
        res = await fetchFn(url, { method, headers, body: payload, signal: ctl.signal });
        text = await res.text();
      } catch (e) {
        clearTimeout(timer);
        if (!creates && attempt < maxTry) { await sleep(1000 * 2 ** attempt); continue; }
        throw new NetError(`${method} ${pathname}: ${e.name === 'AbortError' ? 'timeout' : e.message}`, { uncertain: method !== 'GET' });
      }
      clearTimeout(timer);
      onRequest({ method, path: pathname, status: res.status });
      const j = safeJson(text);
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
    // NPF create; files: [{ identifier, blob, filename }]
    async createPost(blog, json, files = []) {
      const fd = new FormData();
      fd.append('json', JSON.stringify(json));
      for (const f of files) fd.append(f.identifier, f.blob, f.filename);
      const r = await request(`/v2/blog/${enc(blog)}/posts`, { method: 'POST', body: fd });
      return String(r?.id_string ?? r?.id ?? r?.post?.id_string ?? r?.post?.id ?? '');
    },
    async reblog(dest, { parentBlog, parentId, reblogKey, state = 'published', tags = [], content = [], reblogControl }) {
      const json = { parent_tumblelog_uuid: parentBlog, parent_post_id: parentId, reblog_key: reblogKey, content, state, tags: tags.join(',') };
      if (reblogControl === 'noone') json.interactability_reblog = 'noone';
      const r = await request(`/v2/blog/${enc(dest)}/posts`, { method: 'POST', json });
      return String(r?.id_string ?? r?.id ?? '');
    },
    deletePost: (blog, id) => request(`/v2/blog/${enc(blog)}/post/delete`, { method: 'POST', form: { id } }),
    followers: (blog, offset = 0, limit = 20) => request(`/v2/blog/${enc(blog)}/followers`, { query: { limit, offset } }),
    following: (offset = 0, limit = 20) => request('/v2/user/following', { query: { limit, offset } }),
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

module.exports = { makeTumblr, Budget, API };
