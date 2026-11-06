'use strict';
// In-memory Tumblr with the behaviours stage 0 observed: partial PUTs are refused, a private original can't be
// reblogged, reads right after a write may be stale, total_posts leaves out private posts.
// All names and ids are made up.

const { HttpError, NetError } = require('../src/service/errors');

function makeFake({ blogs = [], staleReads = 0, now = Date.now } = {}) {
  let seq = 1000000000000000000n;
  const posts = new Map(); // id -> post
  const followerMap = new Map(); // blog uuid -> [{ name, updated }]
  const blockMap = new Map(); // blog uuid -> Set(name)
  const following = [];
  const infos = new Map(); // public blog name -> { uuid, posts: [] }
  const calls = [];
  let stale = new Map(); // id -> remaining stale reads (returns previous version)
  const fail = { next: null }; // inject one failure: { method, error }

  const nextId = () => String(++seq);
  const blogOf = u => blogs.find(b => b.uuid === u || b.name === u);
  function addPost(blog, fields = {}) {
    const id = fields.id || nextId();
    const p = { id_string: id, blog: { uuid: blog, name: blogOf(blog)?.name }, state: 'published', timestamp: Math.floor(now() / 1000),
      tags: [], content: [{ type: 'text', text: 'post ' + id }], layout: [], trail: [], note_count: 0, reblog_key: 'rk' + id, ...fields, id_string: id };
    posts.set(id, p);
    return p;
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  function check(method) {
    if (fail.next && fail.next.method === method) { const e = fail.next.error; fail.next = null; throw e; }
  }

  const T = {
    calls, posts, followerMap, blockMap, following, infos, fail, addPost,
    async blogs() { calls.push('blogs'); return { name: 'me', blogs: blogs.map(b => ({ ...b })) }; },
    async postsPage(blog, { box = '', next = null, limit = 20 } = {}) {
      calls.push('page:' + blog + ':' + box);
      check('GET');
      const want = box === 'draft' ? ['draft'] : box === 'queue' ? ['queue'] : ['published', 'private'];
      const all = [...posts.values()].filter(p => p.blog.uuid === blog && want.includes(p.state)).sort((a, b) => b.timestamp - a.timestamp || (BigInt(b.id_string) > BigInt(a.id_string) ? 1 : -1));
      const off = Number(next?.offset || 0);
      const page = all.slice(off, off + limit);
      return { posts: page.map(clone), next: off + limit < all.length ? { offset: off + limit } : null };
    },
    async getPost(blog, id) {
      calls.push('get:' + id);
      check('GET');
      const p = posts.get(String(id));
      if (!p || (p.blog.uuid !== blog && p.blog.name !== blog)) throw new HttpError('HTTP 404', { status: 404 });
      const s = stale.get(String(id));
      if (s && s.n > 0) { s.n--; return clone(s.prev); }
      return clone(p);
    },
    async putPost(blog, id, body) {
      calls.push('put:' + id);
      check('PUT');
      const p = posts.get(String(id));
      if (!p) throw new HttpError('HTTP 404', { status: 404 });
      if (!body.content) throw new HttpError('HTTP 400: partial edit', { status: 400 });
      if (staleReads) stale.set(String(id), { n: staleReads, prev: clone(p) });
      Object.assign(p, { content: body.content, layout: body.layout, state: body.state, tags: body.tags ? body.tags.split(',').filter(Boolean) : [] });
      return {};
    },
    async createPost(blog, json, files = []) {
      calls.push('create:' + blog);
      check('POST');
      const p = addPost(blog, { content: json.content, layout: json.layout || [], state: json.state || 'published', tags: (json.tags || '').split(',').filter(Boolean), _files: files.map(f => f.identifier) });
      return p.id_string;
    },
    async reblog(dest, { parentBlog, parentId, reblogKey, state = 'published', tags = [], content = [] }) {
      calls.push('reblog:' + dest + ':' + parentId);
      check('POST');
      const parent = posts.get(String(parentId));
      if (!parent || parent.state !== 'published') throw new HttpError('HTTP 404', { status: 404 });
      if (parent.interactability_reblog === 'noone' && !blogOf(dest)) throw new HttpError('HTTP 403', { status: 403 });
      const rootTrail = parent.trail?.length ? parent.trail : [];
      const trail = [...rootTrail, { blog: { uuid: parent.blog.uuid, name: parent.blog.name }, post: { id: parent.id_string }, content: parent.content, layout: parent.layout }];
      const p = addPost(dest, { parent_tumblelog_uuid: parentBlog, parent_post_id: parentId, trail, content, state, tags });
      return p.id_string;
    },
    // Likes (newest first by liked_timestamp) and the generic request the core adapter uses
    likes: [],
    visitorLag: {}, visitorFails: false,
    tagged: {}, // sitewide tag search: tagged[tag] = [{ tags, note_count }] (made-up sample posts)
    async request(path, { method = 'GET', json } = {}) {
      calls.push('req:' + method + ':' + path.split('?')[0]);
      check(method);
      const u = new URL('https://api.test' + path);
      if (u.pathname === '/v2/user/likes') {
        const before = Number(u.searchParams.get('before')) || Infinity;
        const all = T.likes.filter(p => p.liked_timestamp < before).sort((a, b) => b.liked_timestamp - a.liked_timestamp);
        return { liked_posts: all.slice(0, 20).map(clone), liked_count: T.likes.length };
      }
      if (u.pathname === '/v2/user/unlike' && method === 'POST') { T.likes = T.likes.filter(p => p.id_string !== String(json.id)); return {}; }
      const m = u.pathname.match(/^\/v2\/blog\/([^/]+)\/posts\/(\d+)$/);
      if (m && method === 'GET') {
        const p = posts.get(m[2]);
        const b = decodeURIComponent(m[1]);
        if (!p || (p.blog.uuid !== b && p.blog.name !== b)) throw new HttpError('HTTP 404', { status: 404 });
        return clone(p);
      }
      const pub = u.pathname.match(/^\/v2\/blog\/([^/]+)\/posts$/);
      if (pub && method === 'GET' && u.searchParams.get('id')) {
        if (T.visitorFails) throw new Error('network down (fake)');
        const p = posts.get(u.searchParams.get('id'));
        const b = decodeURIComponent(pub[1]);
        // T.visitorLag[id] = n: the public view still shows the post for the next n looks (it hasn't settled)
        const id = u.searchParams.get('id');
        let visible = !!p && (p.blog.uuid === b || p.blog.name === b) && p.state === 'published';
        if (p && T.visitorLag[id] > 0) { T.visitorLag[id]--; visible = true; }
        return { posts: visible ? [clone(p)] : [] };
      }
      if (u.pathname === '/v2/tagged') {
        return clone((T.tagged[u.searchParams.get('tag')] || []).map((p, i) => ({ object_type: 'post', id_string: '9' + i, blog: { name: 'x' + i }, timestamp: Math.floor(now() / 1000) - i * 600, ...p })));
      }
      if (u.pathname === '/v2/user/info') return { user: { name: 'me', blogs: blogs.map(b => ({ ...b })) } };
      throw new HttpError('HTTP 404 (fake: ' + u.pathname + ')', { status: 404 });
    },
    async deletePost(blog, id) { calls.push('delete:' + id); posts.delete(String(id)); return {}; },
    async followers(blog, offset = 0, limit = 20) {
      calls.push('followers:' + blog + ':' + offset);
      check('GET');
      const all = followerMap.get(blog) || [];
      return { total_users: all.length, users: all.slice(offset, offset + limit).map(clone) };
    },
    async following(offset = 0, limit = 20) { return { total_blogs: following.length, blogs: following.slice(offset, offset + limit) }; },
    async blocks(blog, offset = 0, limit = 20) {
      const all = [...(blockMap.get(blog) || [])].map(n => ({ name: n, uuid: infos.get(n)?.uuid }));
      return { blocked_tumblelogs: all.slice(offset, offset + limit) };
    },
    async block(blog, target) { calls.push('block:' + blog + ':' + target); check('POST'); if (!blockMap.has(blog)) blockMap.set(blog, new Set()); blockMap.get(blog).add(infos.get(target)?.name || target); return {}; },
    async unblock(blog, target) { calls.push('unblock:' + blog + ':' + target); blockMap.get(blog)?.delete(infos.get(target)?.name || target); return {}; },
    async publicInfo(name) {
      calls.push('info:' + name);
      check('GET');
      const i = infos.get(name);
      if (!i) throw new HttpError('HTTP 404', { status: 404 });
      return { blog: { name, uuid: i.uuid, title: i.title || '', description: i.description || '', posts: (i.posts || []).length, updated: i.updated || 0 } };
    },
    async publicPosts(name) {
      const i = infos.get(name);
      if (!i) throw new HttpError('HTTP 404', { status: 404 });
      return { posts: (i.posts || []).map(clone) };
    },
    budget: { stats: () => ({}) },
  };
  return T;
}

const netFail = (uncertain = true) => new NetError('connection reset', { uncertain });

module.exports = { makeFake, netFail };
