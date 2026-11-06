#!/usr/bin/env node
// Stage 0 capability probe for the desktop design (docs/DESKTOP_PRODUCT_SPEC.md §12).
//
// Talks only to api.tumblr.com with the user's own OAuth2 app and a bearer token. It never reads browser
// cookies, the web client's token or the extension's storage, so a passing run is evidence that the
// operation works with the browser fully exited. Credentials and results live outside the repository in
// %LOCALAPPDATA%\tumblr-studio-stage0 (credentials encrypted with Windows DPAPI for the current user).
//
// Commands (see README.md next to this file):
//   setup | auth | read [--blog B] | write --blog T [--reblog-to R] [--allow-public]
//   block --blog B --target NAME | cleanup [--yes] | report | selftest
// Probes that touch the account refuse to run while a browser process is alive (override: --browser-ok,
// which marks the results as not browser-exited).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawnSync, execFileSync } from 'node:child_process';

const API = 'https://api.tumblr.com';
const AUTHORIZE = 'https://www.tumblr.com/oauth2/authorize';
const TOKEN = API + '/v2/oauth2/token';
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPES = 'basic write offline_access';
const UA = 'tumblr-studio-stage0/0.1';
const TEST_TAG = 'tumblr studio stage0 test';
const DIR = path.join(process.env.LOCALAPPDATA || process.cwd(), 'tumblr-studio-stage0');
const F = {
  creds: path.join(DIR, 'credentials.dpapi'),
  state: path.join(DIR, 'state.json'),
  results: path.join(DIR, 'results.json'),
  report: path.join(DIR, 'report.md'),
};
const BROWSERS = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'arc.exe'];

// ---------- small helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const die = msg => { console.error('\n' + msg); process.exit(1); };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
// Post ids exceed 2^53: quote every long integer before parsing so none loses precision
const safeJson = text => { try { return JSON.parse(text.replace(/:\s*(-?\d{16,})(?=\s*[,}\]])/g, ':"$1"')); } catch { return null; } };
const errText = b => b?.errors?.[0]?.detail || b?.errors?.[0]?.title || b?.meta?.msg || (typeof b === 'string' ? b : JSON.stringify(b));
const httpErr = (status, body) => Object.assign(new Error(`HTTP ${status}: ${errText(body)}`), { status, body });
const errInfo = e => ({ status: e.status ?? null, error: String(e.message || e).slice(0, 300) });
const keysOf = o => Object.keys(o || {}).sort();
const cpLen = s => [...s].length; // NPF formatting indexes count code points

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i]; else out[k] = true;
  }
  return out;
}

function ask(q, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => rl.output.write(s.includes(q) ? s : '*');
    rl.question(q, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

// ---------- credential store (DPAPI, current Windows user) ----------
function dpapi(op, text) {
  // .NET ProtectedData directly: the SecureString cmdlets fail to load when pwsh 7's PSModulePath leaks in
  const P = '[Security.Cryptography.ProtectedData]', U = '[Security.Cryptography.DataProtectionScope]::CurrentUser';
  const script = 'Add-Type -AssemblyName System.Security; ' + (op === 'protect'
    ? `[Convert]::ToBase64String(${P}::Protect([Text.Encoding]::UTF8.GetBytes($env:TTH_IN), $null, ${U}))`
    : `$b = ${P}::Unprotect([Convert]::FromBase64String($env:TTH_IN), $null, ${U}); [Convert]::ToBase64String($b)`);
  const env = { ...process.env, TTH_IN: op === 'protect' ? text : text.trim() };
  delete env.PSModulePath;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env, encoding: 'utf8', maxBuffer: 1 << 24 });
  if (r.status === 0 && op === 'unprotect') return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
  if (r.status !== 0) throw new Error('DPAPI ' + op + ' failed: ' + (r.stderr || '').trim());
  return r.stdout.replace(/\s+$/, '');
}
let creds = null;
function loadCreds() {
  if (!fs.existsSync(F.creds)) die('No credentials yet. Run: node spike/stage0/probe.mjs setup');
  creds = JSON.parse(dpapi('unprotect', fs.readFileSync(F.creds, 'utf8').trim()));
  return creds;
}
function saveCreds(c) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(F.creds, dpapi('protect', JSON.stringify(c))); }

// ---------- results ----------
const state = readJson(F.state, { blogs: [], created: [] });
const results = readJson(F.results, {});
const ctx = { browsers: [] };
function record(key, status, detail = {}) {
  results[key] = { status, detail, at: new Date().toISOString(), browserRunning: ctx.browsers };
  writeJson(F.results, results);
  log(`  [${status.toUpperCase()}] ${key}` + (detail.note ? ` — ${detail.note}` : ''));
}

function runningBrowsers() {
  const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const names = new Set(out.split(/\r?\n/).map(l => l.split('","')[0].replace(/^"/, '').toLowerCase()).filter(Boolean));
  return BROWSERS.filter(b => names.has(b));
}
function gate(args) {
  const b = runningBrowsers();
  if (b.length && !args['browser-ok']) {
    die(`Browser processes are running: ${b.join(', ')}.\nQuit them fully (also from the tray; Edge may keep running in the background) and run again,\nor pass --browser-ok (the results are then marked as run with a browser open).`);
  }
  ctx.browsers = b;
  log(b.length ? `Browser running (${b.join(', ')}): results marked as not browser-exited.` : 'No browser process running.');
}

// ---------- OAuth2 ----------
async function tokenRequest(params) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  const j = safeJson(text);
  if (!res.ok || !j?.access_token) throw httpErr(res.status, j ?? text.slice(0, 300));
  return j;
}
function storeTokens(c, j) {
  c.access_token = j.access_token;
  c.expires_at = Date.now() + (Number(j.expires_in) || 0) * 1000;
  c.scope = j.scope ?? c.scope;
  if (j.refresh_token) { c.refresh_rotated = !!c.refresh_token && c.refresh_token !== j.refresh_token; c.refresh_token = j.refresh_token; }
  saveCreds(c);
}
async function refresh(c) {
  if (!c.refresh_token) throw new Error('No refresh token stored (was offline_access granted?)');
  const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.client_id, client_secret: c.client_secret });
  storeTokens(c, j);
  return j;
}

// ---------- API ----------
// Only reads and edits are retried; a POST creates something and is never sent twice blindly
async function api(pathname, { method = 'GET', query, json, form, body, bearer = true } = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const headers = { 'User-Agent': UA, Accept: 'application/json' };
    if (bearer) {
      if (!creds.access_token || Date.now() > (creds.expires_at || 0) - 60_000) await refresh(creds);
      headers.Authorization = 'Bearer ' + creds.access_token;
    }
    let payload = body;
    if (json) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
    else if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form); }
    const res = await fetch(url, { method, headers, body: payload });
    const text = await res.text();
    const j = safeJson(text);
    if (res.status === 401 && bearer && attempt === 0) { await refresh(creds); continue; }
    if ((res.status === 429 || res.status >= 500) && method !== 'POST' && attempt < 3) {
      await sleep((Number(res.headers.get('retry-after')) || 2 * 2 ** attempt) * 1000); continue;
    }
    if (!res.ok) throw httpErr(res.status, j ?? text.slice(0, 300));
    return j?.response ?? j;
  }
}
const getPost = (blog, id) => api(`/v2/blog/${blog.uuid}/posts/${id}`, { query: { post_format: 'npf' } });
// Reads right after a write can return the old post: poll until ok(post) or give up (returns the last read)
const lag = { worst: 0 };
async function settle(blog, id, ok, tries = 6) {
  const t0 = Date.now();
  let p;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(2000);
    p = await getPost(blog, id);
    if (ok(p)) { const ms = Date.now() - t0; if (i) lag.worst = Math.max(lag.worst, ms); return { p, ok: true, reads: i + 1, ms }; }
  }
  return { p, ok: false, reads: tries, ms: Date.now() - t0 };
}
const newId = r => String(r?.id_string ?? r?.id ?? r?.post?.id_string ?? r?.post?.id ?? '');
// What a logged-out visitor gets: the public API with the app's key and no bearer token. Edge caches can lag.
async function publicView(blog, id) {
  try {
    const r = await api(`/v2/blog/${blog.uuid}/posts`, { bearer: false, query: { api_key: creds.client_id, id, npf: true } });
    const p = (r.posts || [])[0];
    if (!p) return { visible: false };
    return { visible: true, state: p.state, trail: (p.trail || []).length, trailHasContent: (p.trail || []).some(t => (t.content || []).length > 0) };
  } catch (e) { return { visible: false, ...errInfo(e) }; }
}
// The page a logged-out visitor opens (no cookies are sent): status and whether the probe's text is on it
const PROBE_MARK = 'safe to delete';
async function publicPage(blog, id) {
  try {
    const res = await fetch(`https://${blog.name}.tumblr.com/post/${id}`, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    const html = await res.text();
    return { status: res.status, hasOriginalText: html.includes(PROBE_MARK) };
  } catch (e) { return errInfo(e); }
}
// After hiding a post: how long until a visitor no longer sees it (public API and page), up to maxMs
async function waitGone(blog, id, maxMs = 300_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await publicView(blog, id), pg = await publicPage(blog, id);
    if (!v.visible && !pg.hasOriginalText) return { goneAfterMs: Date.now() - t0, api: v, page: pg };
    if (Date.now() - t0 > maxMs) return { goneAfterMs: null, api: v, page: pg };
    await sleep(10_000);
  }
}

async function myBlogs() {
  const info = await api('/v2/user/info');
  state.blogs = (info.user?.blogs || []).map(b => ({ name: b.name, uuid: b.uuid, primary: !!b.primary, type: b.type, admin: b.admin }));
  writeJson(F.state, state);
  return { info, blogs: state.blogs };
}
function resolveBlog(blogs, ref, what) {
  const r = String(ref || '').toLowerCase().replace(/\.tumblr\.com$/, '');
  const b = blogs.find(x => x.name.toLowerCase() === r || String(x.uuid).toLowerCase() === r);
  if (!b) die(`${what}: "${ref}" is not one of your blogs (${blogs.map(x => x.name).join(', ')})`);
  return b;
}
const imageBlock = p => (p?.content || []).find(b => b.type === 'image');
const imageUrl = p => imageBlock(p)?.media?.[0]?.url || null;
const tagsOf = p => (p?.tags || []).map(String);
function fullEdit(p, changes = {}) {
  const out = { content: p.content, layout: p.layout || [], tags: tagsOf(p).join(','), state: p.state === 'published' ? 'published' : p.state };
  const ir = p.interactability_reblog ?? p.interactabilityReblog;
  if (ir) out.interactability_reblog = ir;
  return { ...out, ...changes };
}

// ---------- test image ----------
function makePng(w, h) {
  const row = w * 3 + 1, raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * row + 1 + x * 3;
    raw[o] = (x * 255 / w) | 0; raw[o + 1] = (y * 255 / h) | 0; raw[o + 2] = 160;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- commands ----------
async function cmdSetup() {
  const client_id = process.env.TUMBLR_CLIENT_ID || await ask('OAuth consumer key: ');
  const client_secret = process.env.TUMBLR_CLIENT_SECRET || await ask('OAuth consumer secret (hidden): ', true);
  if (!client_id || !client_secret) die('Both the consumer key and the secret are needed.');
  saveCreds({ client_id, client_secret });
  log(`Saved, encrypted for this Windows user: ${F.creds}`);
  log(`The app's "OAuth2 redirect URLs" must contain exactly: ${REDIRECT}`);
  log('Next: node spike/stage0/probe.mjs auth');
}

async function cmdAuth() {
  const c = loadCreds();
  const st = crypto.randomBytes(16).toString('hex');
  const url = AUTHORIZE + '?' + new URLSearchParams({ client_id: c.client_id, response_type: 'code', scope: SCOPES, state: st, redirect_uri: REDIRECT });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error('No answer within 10 minutes')); }, 600_000);
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const done = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<p>${msg}</p>`); };
      try {
        if (u.searchParams.get('state') !== st) throw new Error('State mismatch');
        if (u.searchParams.get('error')) throw new Error('Authorisation refused: ' + u.searchParams.get('error'));
        const j = await tokenRequest({ grant_type: 'authorization_code', code: u.searchParams.get('code'), client_id: c.client_id, client_secret: c.client_secret, redirect_uri: REDIRECT });
        storeTokens(c, j);
        record('auth.authorize', 'pass', { scope: j.scope, expiresInSeconds: j.expires_in, refreshToken: !!j.refresh_token, redirect: REDIRECT });
        done(200, 'Authorised. You can now quit the browser completely and run the probes.');
        clearTimeout(timer); server.close(); resolve();
      } catch (e) {
        record('auth.authorize', 'fail', errInfo(e));
        done(400, 'Failed: ' + String(e.message).replace(/</g, '&lt;'));
        clearTimeout(timer); server.close(); reject(e);
      }
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      log('Open this URL, sign in and allow access (it should open by itself):\n\n' + url + '\n');
      spawnSync('rundll32', ['url.dll,FileProtocolHandler', url]);
    });
  });
  log('Next: quit every browser process, then: node spike/stage0/probe.mjs read');
}

async function cmdRead(args) {
  gate(args); loadCreds();
  log('\nAuth');
  try {
    const before = creds.access_token;
    const j = await refresh(creds);
    record('auth.refresh', j.access_token && j.access_token !== before ? 'pass' : 'unknown',
      { expiresInSeconds: j.expires_in, refreshTokenRotated: !!creds.refresh_rotated });
  } catch (e) { record('auth.refresh', 'fail', errInfo(e)); }

  log('\nBlogs and posts');
  const { info, blogs } = await myBlogs();
  record('read.userInfo', 'pass', { blogs: blogs.length, blogFields: keysOf(info.user?.blogs?.[0]) });
  const only = args.blog ? [resolveBlog(blogs, args.blog, '--blog')] : blogs;
  const perBlog = {};
  for (const b of only) {
    const d = perBlog[b.name] = { type: b.type, primary: b.primary };
    try {
      const p1 = await api(`/v2/blog/${b.uuid}/posts`, { query: { npf: true, limit: 20 } });
      const posts = p1.posts || [];
      d.totalPosts = p1.total_posts ?? p1.blog?.posts ?? null;
      d.states = [...new Set(posts.map(p => p.state))];
      d.legacyOnFirstPage = posts.filter(p => p.is_blocks_post_format === false).length;
      d.reblogsOnFirstPage = posts.filter(p => p.parent_post_id || (p.trail || []).length).length;
      d.labelFields = keysOf(posts[0]).filter(k => /label/i.test(k));
      d.reblogControlField = posts.some(p => 'interactability_reblog' in p);
      const next = p1._links?.next;
      if (posts.length === 20) {
        const q = next?.query_params || { npf: true, limit: 20, offset: 20 };
        const p2 = await api(`/v2/blog/${b.uuid}/posts`, { query: q });
        const ids1 = new Set(posts.map(p => String(p.id_string ?? p.id)));
        d.page2 = { count: (p2.posts || []).length, overlap: (p2.posts || []).filter(p => ids1.has(String(p.id_string ?? p.id))).length, via: next ? 'links.next' : 'offset' };
      }
      for (const box of ['draft', 'queue']) {
        try { const r = await api(`/v2/blog/${b.uuid}/posts/${box}`, { query: { npf: true, limit: 20 } }); d[box] = (r.posts || []).length; }
        catch (e) { d[box] = errInfo(e); }
      }
    } catch (e) { d.error = errInfo(e); }
    log(`  ${b.name}: ${JSON.stringify(d)}`);
  }
  const failed = Object.values(perBlog).filter(d => d.error).length;
  record('read.posts', failed ? (failed === only.length ? 'fail' : 'partial') : 'pass', { blogs: perBlog });
  const privSeen = Object.values(perBlog).some(d => (d.states || []).includes('private'));
  record('read.privatePostsInList', privSeen ? 'pass' : 'unknown',
    { note: privSeen ? 'private posts come back in the owner\'s list' : 'no private post on the first pages; inconclusive' });

  log('\nFollowers, following, blocks');
  const main = only.find(b => b.primary) || only[0];
  try {
    const f1 = await api(`/v2/blog/${main.uuid}/followers`, { query: { limit: 20 } });
    const u1 = f1.users || [];
    const d = { blog: main.name, total: f1.total_users ?? null, firstPage: u1.length, userFields: keysOf(u1[0]), hasStableId: u1.length ? u1.every(u => u.uuid) : null };
    if (u1.length === 20) {
      const f2 = await api(`/v2/blog/${main.uuid}/followers`, { query: { limit: 20, offset: 20 } });
      const names = new Set(u1.map(u => u.name));
      d.page2 = { count: (f2.users || []).length, overlap: (f2.users || []).filter(u => names.has(u.name)).length };
    }
    record('follower.list', 'pass', d);
    if (d.hasStableId === false) record('follower.stableId', 'unsupported', { note: 'follower entries carry no uuid; renames must be tracked another way' });
    else if (d.hasStableId) record('follower.stableId', 'pass', { note: 'follower entries carry a uuid' });
  } catch (e) { record('follower.list', 'fail', errInfo(e)); }
  try {
    const r = await api('/v2/user/following', { query: { limit: 20 } });
    record('follower.followingList', 'pass', { total: r.total_blogs ?? null, fields: keysOf(r.blogs?.[0]) });
  } catch (e) { record('follower.followingList', 'fail', errInfo(e)); }
  try {
    const r = await api(`/v2/blog/${main.uuid}/blocks`, { query: { limit: 20 } });
    const list = r.blocked_tumblelogs || [];
    record('follower.blockList', 'pass', { blog: main.name, firstPage: list.length, fields: keysOf(list[0]) });
  } catch (e) { record('follower.blockList', 'fail', errInfo(e)); }
  record('follower.report', 'unsupported', { note: 'no reporting endpoint in the public API docs; not attempted (never file a test report)' });
  writeReport();
}

async function cmdWrite(args) {
  gate(args); loadCreds();
  const { blogs } = await myBlogs();
  if (!args.blog) die('--blog TEST_BLOG is required (a blog you agreed to use for test posts)');
  const T = resolveBlog(blogs, args.blog, '--blog');
  const R = args['reblog-to'] ? resolveBlog(blogs, args['reblog-to'], '--reblog-to') : null;
  if (R && R.uuid === T.uuid) die('--reblog-to must be a different blog');
  const allowPublic = !!args['allow-public'];
  const remember = (blog, id, kind) => { state.created.push({ blog: blog.uuid, name: blog.name, id, kind, at: new Date().toISOString() }); writeJson(F.state, state); };

  log(`\nCreate a private image post on ${T.name}`);
  const text = 'Tumblr Studio stage 0 probe, safe to delete. 中文 🎨 bold';
  const content = [
    { type: 'text', text, formatting: [{ type: 'bold', start: cpLen(text) - 4, end: cpLen(text) }] },
    { type: 'image', media: [{ type: 'image/png', identifier: 'img1', width: 256, height: 256 }], alt_text: 'probe gradient' },
  ];
  const fd = new FormData();
  fd.append('json', JSON.stringify({ content, state: 'private', tags: TEST_TAG }));
  fd.append('img1', new Blob([makePng(256, 256)], { type: 'image/png' }), 'probe.png');
  let id;
  try {
    id = newId(await api(`/v2/blog/${T.uuid}/posts`, { method: 'POST', body: fd }));
    if (!id) throw new Error('No post id in the create response');
    remember(T, id, 'original');
  } catch (e) { record('write.createImagePost', 'fail', errInfo(e)); writeReport(); return; }
  let p = await getPost(T, id);
  const fmt = p.content?.[0]?.formatting?.[0];
  record('write.createImagePost', p.state === 'private' && imageUrl(p) && tagsOf(p).includes(TEST_TAG) ? 'pass' : 'fail', {
    id, state: p.state, image: !!imageUrl(p), tags: tagsOf(p), formattingEcho: fmt ? [fmt.start, fmt.end] : null,
    note: 'open the post once to check that "bold" (after the emoji) is the bold word',
  });

  log('\nEdit (full NPF PUT)');
  try {
    const img = imageUrl(p);
    const edited = [{ ...p.content[0], text: p.content[0].text + ' (edited)' }, ...p.content.slice(1)];
    await api(`/v2/blog/${T.uuid}/posts/${id}`, { method: 'PUT', json: fullEdit(p, { content: edited, tags: [...tagsOf(p), 'stage0 edited'].join(',') }) });
    const s1 = await settle(T, id, x => x.content?.[0]?.text?.endsWith('(edited)') && tagsOf(x).includes('stage0 edited'));
    const q = s1.p;
    const ok = s1.ok && imageUrl(q) === img && q.state === 'private';
    record('write.editNpf', ok ? 'pass' : 'fail', { textEdited: q.content?.[0]?.text?.endsWith('(edited)'), sameImage: imageUrl(q) === img, tags: tagsOf(q), state: q.state, reads: s1.reads, ms: s1.ms });
    p = q;
  } catch (e) { record('write.editNpf', 'fail', errInfo(e)); }

  log('\nPartial PUT (tags only) — does it keep the body?');
  try {
    const before = p;
    await api(`/v2/blog/${T.uuid}/posts/${id}`, { method: 'PUT', json: { tags: [...tagsOf(before), 'stage0 partial'].join(',') } });
    const q = (await settle(T, id, x => tagsOf(x).includes('stage0 partial'))).p;
    const d = { tagsApplied: tagsOf(q).includes('stage0 partial'), contentKept: (q.content || []).length === (before.content || []).length, imageKept: imageUrl(q) === imageUrl(before), state: q.state };
    record('write.partialPut', d.contentKept && d.imageKept && d.state === 'private' ? 'pass' : 'observed',
      { ...d, note: d.contentKept && d.imageKept ? 'a tags-only PUT keeps the body' : 'a tags-only PUT does NOT keep everything: always send the full post' });
    if (!d.contentKept || !d.imageKept || d.state !== 'private') {
      await api(`/v2/blog/${T.uuid}/posts/${id}`, { method: 'PUT', json: fullEdit(before, { state: 'private' }) });
    }
    p = await getPost(T, id);
  } catch (e) {
    record('write.partialPut', e.status === 400 ? 'observed' : 'fail', { ...errInfo(e), note: e.status === 400 ? 'a tags-only PUT is refused: always send the full post' : undefined });
  }

  if (allowPublic) {
    log('\nVisibility private → public → private');
    try {
      await api(`/v2/blog/${T.uuid}/posts/${id}`, { method: 'PUT', json: fullEdit(p, { state: 'published' }) });
      const pub = (await settle(T, id, x => x.state === 'published')).p;
      await sleep(5000);
      const seenPublic = await publicView(T, id);
      await api(`/v2/blog/${T.uuid}/posts/${id}`, { method: 'PUT', json: fullEdit(pub, { state: 'private' }) });
      const priv = (await settle(T, id, x => x.state === 'private')).p;
      const seenAfter = await waitGone(T, id);
      record('write.visibility', pub.state === 'published' && priv.state === 'private' && imageUrl(priv) ? 'pass' : 'fail', {
        afterPublish: pub.state, publicViewWhilePublic: seenPublic, afterHide: priv.state, publicViewAfterHide: seenAfter, imageKept: !!imageUrl(priv),
      });
      p = priv;
    } catch (e) { record('write.visibility', 'fail', errInfo(e)); }
  } else {
    record('write.visibility', 'not_run', { note: 'needs --allow-public (publishes the test post on the test blog for ~10 s)' });
  }

  if (!R) {
    record('write.reblog', 'not_run', { note: 'needs --reblog-to OTHER_OWNED_BLOG' });
    writeReport(); return;
  }
  log(`\nReblog onto ${R.name}`);
  const reblog = async (src, st) => newId(await api(`/v2/blog/${R.uuid}/posts`, { method: 'POST', json: {
    parent_tumblelog_uuid: T.uuid, parent_post_id: id, reblog_key: src.reblog_key,
    content: [{ type: 'text', text: 'stage 0 reblog probe' }], state: st, tags: TEST_TAG,
  } }));
  try {
    const rid = await reblog(p, 'private');
    remember(R, rid, 'reblog');
    const r = await getPost(R, rid);
    record('write.reblogOfPrivateOriginal', String(r.parent_post_id ?? '') === id || (r.trail || []).length ? 'pass' : 'fail',
      { id: rid, state: r.state, parent: r.parent_post_id ?? null, trail: (r.trail || []).length });
  } catch (e) { record('write.reblogOfPrivateOriginal', 'observed', { ...errInfo(e), note: 'a private original cannot be reblogged, even onto my own blog' }); }

  if (!allowPublic) {
    record('visibility.hideOriginalEffectOnReblog', 'not_run', { note: 'needs --allow-public as well' });
    writeReport(); return;
  }
  log('\nA38: hide the original, look at the public reblog');
  try {
    await api(`/v2/blog/${T.uuid}/posts/${id}`, { method: 'PUT', json: fullEdit(p, { state: 'published' }) });
    p = (await settle(T, id, x => x.state === 'published')).p;
    const rid = await reblog(p, 'published');
    remember(R, rid, 'reblog');
    let r = (await settle(R, rid, x => x.state === 'published')).p;
    record('write.reblog', r.state === 'published' && (r.trail || []).length ? 'pass' : 'fail', { id: rid, state: r.state, trail: (r.trail || []).length });
    await sleep(5000);
    const before = { api: await publicView(R, rid), page: await publicPage(R, rid) };
    await api(`/v2/blog/${T.uuid}/posts/${id}`, { method: 'PUT', json: fullEdit(p, { state: 'private' }) });
    await settle(T, id, x => x.state === 'private');
    log('  waiting until the hidden original is gone for visitors (up to 5 min)…');
    const originalGone = await waitGone(T, id);
    const after = { api: await publicView(R, rid), page: await publicPage(R, rid) };
    await sleep(60_000);
    const later = { api: await publicView(R, rid), page: await publicPage(R, rid) };
    const ownerView = await getPost(R, rid);
    record('visibility.hideOriginalEffectOnReblog', originalGone.goneAfterMs == null ? 'unknown' : 'observed', {
      originalGone, reblogBefore: before, reblogOnceOriginalGone: after, reblogOneMinuteLater: later,
      ownerViewTrail: (ownerView.trail || []).length, ownerViewTrailContent: (ownerView.trail || []).some(t => (t.content || []).length),
      note: 'compare trail / trailHasContent before and after',
    });
    log('\nHide the reblog (visibility edit on a reblog)');
    await api(`/v2/blog/${R.uuid}/posts/${rid}`, { method: 'PUT', json: fullEdit(ownerView, { state: 'private' }) });
    r = (await settle(R, rid, x => x.state === 'private')).p;
    record('write.reblogVisibility', r.state === 'private' && (r.trail || []).length ? 'pass' : 'fail', { state: r.state, trailKept: (r.trail || []).length });
  } catch (e) { record('visibility.hideOriginalEffectOnReblog', 'fail', errInfo(e)); }
  record('write.readAfterWriteLag', 'observed', { worstMs: lag.worst, note: 'reads right after a write may be stale; verify by polling' });
  writeReport();
  log('\nTest posts are private now. Remove them with: node spike/stage0/probe.mjs cleanup --yes');
}

async function allBlocks(blog) {
  const out = [];
  for (let offset = 0; offset < 2000; offset += 20) {
    const r = await api(`/v2/blog/${blog.uuid}/blocks`, { query: { limit: 20, offset } });
    const list = r.blocked_tumblelogs || [];
    out.push(...list);
    if (list.length < 20) break;
  }
  return out;
}
async function cmdBlock(args) {
  gate(args); loadCreds();
  const { blogs } = await myBlogs();
  if (!args.blog || !args.target) die('Usage: block --blog OWNED_BLOG --target TEST_ACCOUNT_BLOG (an account you control)');
  const B = resolveBlog(blogs, args.blog, '--blog');
  const t = String(args.target).toLowerCase().replace(/\.tumblr\.com$/, '');
  if (blogs.some(b => b.name.toLowerCase() === t)) die('The target is one of the blogs of this account; use a separate test account.');
  const has = list => list.some(x => String(x.name).toLowerCase() === t);
  log(`\nBlock ${t} from ${B.name}, verify, unblock, verify`);
  try {
    if (has(await allBlocks(B))) { record('follower.block', 'observed', { note: 'already blocked before the test; left as it is' }); writeReport(); return; }
    await api(`/v2/blog/${B.uuid}/blocks`, { method: 'POST', form: { blocked_tumblelog: t } });
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) { if (i) await sleep(3000); ok = has(await allBlocks(B)); }
    record('follower.block', ok ? 'pass' : 'fail', { blog: B.name, verifiedInBlockList: ok });
  } catch (e) { record('follower.block', 'fail', errInfo(e)); writeReport(); return; }
  try {
    await api(`/v2/blog/${B.uuid}/blocks`, { method: 'DELETE', query: { blocked_tumblelog: t } });
    let gone = false;
    for (let i = 0; i < 3 && !gone; i++) { if (i) await sleep(3000); gone = !has(await allBlocks(B)); }
    record('follower.unblock', gone ? 'pass' : 'fail', { blog: B.name, verifiedGone: gone });
  } catch (e) { record('follower.unblock', 'fail', errInfo(e)); }
  writeReport();
}

async function cmdCleanup(args) {
  const list = [...state.created].sort((a, b) => (a.kind === 'reblog' ? -1 : 1) - (b.kind === 'reblog' ? -1 : 1));
  if (!list.length) { log('Nothing created by the probe is left.'); return; }
  for (const c of list) log(`  ${c.kind.padEnd(8)} ${c.name}/${c.id}  (${c.at})`);
  if (!args.yes) { log('\nThese are the probe\'s own test posts. Delete them with: cleanup --yes'); return; }
  gate(args); loadCreds();
  for (const c of list) {
    const blog = { uuid: c.blog };
    try {
      await api(`/v2/blog/${c.blog}/post/delete`, { method: 'POST', form: { id: c.id } });
      let gone = false;
      try { await getPost(blog, c.id); } catch (e) { gone = e.status === 404; }
      log(`  ${gone ? 'deleted' : 'delete sent, still readable'}: ${c.name}/${c.id}`);
      if (gone) state.created = state.created.filter(x => x.id !== c.id);
    } catch (e) { log(`  failed ${c.name}/${c.id}: ${e.message}`); }
  }
  writeJson(F.state, state);
}

function writeReport() {
  const order = ['auth.', 'read.', 'write.', 'visibility.', 'follower.'];
  const keys = Object.keys(results).sort((a, b) => order.findIndex(o => a.startsWith(o)) - order.findIndex(o => b.startsWith(o)) || a.localeCompare(b));
  const lines = ['# Stage 0 capability results', '', `Generated ${new Date().toISOString()} from ${F.results}.`, '',
    '| Capability | Result | Browser running | When | Detail |', '|---|---|---|---|---|'];
  for (const k of keys) {
    const r = results[k];
    const d = JSON.stringify(r.detail).replace(/\|/g, '\\|');
    lines.push(`| ${k} | ${r.status} | ${r.browserRunning?.length ? r.browserRunning.join(' ') : 'no'} | ${r.at} | ${d.length > 400 ? d.slice(0, 400) + '…' : d} |`);
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(F.report, lines.join('\n') + '\n');
  log(`\nReport: ${F.report}`);
}

// Read-only: print one post as the owner sees it (content, layout, state, tags, trail size)
async function cmdPeek(args) {
  loadCreds();
  const { blogs } = await myBlogs();
  const b = resolveBlog(blogs, args.blog, '--blog');
  if (args.legacy) {
    const r = (await api(`/v2/blog/${b.uuid}/posts`, { query: { id: String(args.id) } })).posts?.[0] || {};
    log(JSON.stringify({ body: r.body ?? r.caption ?? null, type: r.type }, null, 1)); return;
  }
  const p = await getPost(b, String(args.id));
  log(JSON.stringify({ state: p.state, tags: p.tags, content: p.content, layout: p.layout, trail: (p.trail || []).length,
    reblog_key: !!p.reblog_key, fields: keysOf(p) }, null, 1));
}

async function cmdSelftest() {
  const png = makePng(256, 256);
  const sigOk = png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const idatLen = png.readUInt32BE(33), idat = png.subarray(41, 41 + idatLen);
  const rawOk = zlib.inflateSync(idat).length === (256 * 3 + 1) * 256;
  log('png', sigOk && rawOk ? 'ok' : 'BAD', png.length, 'bytes');
  const secret = 'probe-secret-' + crypto.randomBytes(8).toString('hex') + ' 中文';
  const back = dpapi('unprotect', dpapi('protect', secret));
  log('dpapi round trip', back === secret ? 'ok' : 'BAD');
  const j = safeJson('{"response":{"id":831647300940120064,"x":[1,2],"n":12}}');
  log('long ids', j.response.id === '831647300940120064' && j.response.n === 12 ? 'ok' : 'BAD');
  log('code points', cpLen('a🎨b') === 3 ? 'ok' : 'BAD');
  if (!(sigOk && rawOk && back === secret && j.response.id === '831647300940120064')) process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const cmds = { setup: cmdSetup, auth: cmdAuth, read: cmdRead, write: cmdWrite, block: cmdBlock, cleanup: cmdCleanup, report: writeReport, peek: cmdPeek, selftest: cmdSelftest };
const fn = cmds[args._[0]];
if (!fn) die('Commands: ' + Object.keys(cmds).join(' | ') + '\nSee spike/stage0/README.md');
fn(args).catch(e => die('Stopped: ' + (e.stack || e)));
