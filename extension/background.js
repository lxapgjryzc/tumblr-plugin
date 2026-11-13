// Service worker of the browser companion (Tumblr Studio, design 4.3). It runs no business work of its own: no
// sync, reblog, expiry or collection passes and no AI. It
//  - opens the app from the toolbar icon (the companion page from the icon's right-click menu),
//  - turns the ad-network ruleset on and off with the browser-local "Hide ads" preference,
//  - talks to the running app over its loopback endpoint (pairing, a read-only data snapshot for the pages,
//    typed requests such as "Open in Tumblr Studio" and "Collect with Tumblr Studio"),
//  - carries single API requests the app hands over in this browser's tumblr.com session (browser relay below),
//  - on update, removes the alarms older versions used for their own background passes.
// When the app isn't running, page helpers keep working from the last snapshot and app actions say so; nothing
// is queued here to be sent later.
importScripts('core.js');
const C = TTHCore;
const TUMBLR = 'https://www.tumblr.com';
const PORTS = [47823, 47824, 47825];
const PROTOCOL = 1;

// ---------- The toolbar icon: the app; the companion page from the icon's menu ----------
// The app's own pages are http://127.0.0.1:<port>/ (anything but /companion/). While the app runs and we're
// paired, the icon switches to an open app tab or asks the app to open one (`focus`, fresh: the app opens it
// itself with its own one-time sign-in code; this extension never sees a code or a session). Not paired: the
// companion page, where pairing happens. App not running: this extension's own companion page, which says to
// start the app from its shortcut.
const appTab = (url, port) => { try { const u = new URL(url || ''); return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && +u.port === port; } catch { return false; } };
const companionTab = url => (url || '').startsWith(chrome.runtime.getURL('companion.html')) || /^http:\/\/(127\.0\.0\.1|localhost):\d+\/companion\//.test(url || '');
async function showTab(find, url) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const tab = tabs.find(find);
  if (!tab) return chrome.tabs.create({ url });
  await chrome.tabs.update(tab.id, { active: true, ...(url && !tab.url?.startsWith(url) ? { url } : {}) });
  if (tab.windowId >= 0) chrome.windows.update(tab.windowId, { focused: true });
}
async function appRunning() {
  const r = await studio('/hello', {}, { timeout: 1500 });
  const { bridge = {} } = await chrome.storage.local.get('bridge');
  return r.status === 200 && r.json.app === 'tumblr-studio' && bridge.port ? bridge : null;
}
// While the app runs, its page is the companion page (served by the app at /companion/, with companion-host.js
// giving it this extension's few operations); otherwise this extension's own copy says to start the app.
async function openCompanion() {
  const bridge = await appRunning();
  const url = bridge ? `http://127.0.0.1:${bridge.port}/companion/` : chrome.runtime.getURL('companion.html');
  return showTab(x => companionTab(x.url), url);
}
// App not running: the installed app registers a native host (desktop nativehost.js) that runs its launcher, which
// starts it and opens its page itself. Without that host (not installed, never paired here) the companion page.
async function startApp() {
  try { const r = await chrome.runtime.sendNativeMessage('com.tumblr_studio.launcher', { cmd: 'open' }); return !!r?.ok; } catch { return false; }
}
async function openApp() {
  const bridge = await appRunning();
  if (!bridge && await startApp()) return;
  if (!bridge?.token) return openCompanion();
  const tabs = await chrome.tabs.query({}).catch(() => []);
  if (tabs.some(x => appTab(x.url, bridge.port) && !companionTab(x.url))) return showTab(x => appTab(x.url, bridge.port) && !companionTab(x.url), '');
  const r = await request('focus', { fresh: true });
  if (r.error) return chrome.tabs.create({ url: `http://127.0.0.1:${bridge.port}/` }); // the session cookie may still be good
}
chrome.action.onClicked.addListener(() => openApp());

// ---------- Older versions' background passes are gone for good (A55) ----------
// Their data stays in storage (the companion page can still export it); only the alarms are removed, and
// nothing here can start them again.
chrome.runtime.onInstalled.addListener(async () => {
  for (const name of ['tth-maintain']) await chrome.alarms.clear(name).catch(() => {});
  const { companionSince } = await chrome.storage.local.get('companionSince');
  if (!companionSince) await chrome.storage.local.set({ companionSince: Date.now() });
  await setupMenus();
});

// ---------- Hide ads (browser-local preference) ----------
async function syncAdBlocking(on) {
  await chrome.declarativeNetRequest.updateEnabledRulesets({ [on ? 'enableRulesetIds' : 'disableRulesetIds']: ['ads'] });
}
chrome.storage.local.get('settings').then(r => syncAdBlocking(r.settings?.hideAds ?? true));
chrome.storage.onChanged.addListener(ch => { if (ch.settings) syncAdBlocking(ch.settings.newValue?.hideAds ?? true); });

// ---------- The app ----------
// storage `bridge` = { port, token, primary, at }: the pairing. A request is answered by the app or not at all.
async function studio(path, body = {}, { timeout = 8000, port: only = null } = {}) {
  const { bridge = {} } = await chrome.storage.local.get('bridge');
  // Paired: only the backend that paired us (a work and a test backend may both run on this computer; never hop
  // to the other one). Unpaired: look for any, read only (/hello); pairing names its port.
  const ports = only ? [only] : bridge.token && bridge.port ? [bridge.port] : bridge.port ? [bridge.port, ...PORTS.filter(p => p !== bridge.port)] : PORTS;
  let last = null;
  for (const port of ports) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), path === '/pair' ? 120000 : timeout);
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', ...(bridge.token ? { Authorization: 'Bearer ' + bridge.token } : {}) },
        body: JSON.stringify({ v: PROTOCOL, primary: bridge.primary || undefined, ...body }),
      });
      const json = await res.json().catch(() => ({}));
      if (port !== bridge.port && res.status !== 404) await chrome.storage.local.set({ bridge: { ...bridge, port } });
      return { status: res.status, json };
    } catch (e) { last = e; } finally { clearTimeout(timer); }
  }
  return { status: 0, json: { error: 'not_running', detail: String(last?.message || last || '') } };
}

// The logged-in account's main blog, read from Tumblr (pairing refuses a browser logged into another account)
async function primaryBlog() {
  const html = await (await fetch(TUMBLR + '/dashboard', { credentials: 'include' })).text();
  const { token } = C.parseAuth(html);
  if (!token) return null;
  const r = await fetch(TUMBLR + '/api/v2/user/info', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  return (j?.response?.user?.blogs || []).find(b => b.primary)?.name || null;
}

// With a grant (the app's own companion page) pairing is immediate; without one the app asks the user, showing
// `code`, which the asking page shows too. Port: the given one, else the running app found by /hello.
async function pair(grant, port, code) {
  if (!grant && !/^\d{4}$/.test(String(code || ''))) return { error: 'grant_required' };
  if (!PORTS.includes(port)) {
    const h = await studio('/hello', {}, { timeout: 1500 });
    if (h.status !== 200) return { error: 'not_running' };
    port = (await chrome.storage.local.get('bridge')).bridge?.port;
    if (!PORTS.includes(port)) return { error: 'not_running' };
  }
  const primary = await primaryBlog().catch(() => null);
  const r = await studio('/pair', { primary, ...(grant ? { grant } : { code: String(code) }) }, { port });
  if (r.status !== 200) return { error: r.json.error || 'failed', primary: r.json.primary };
  await chrome.storage.local.set({ bridge: { port, token: r.json.token, primary: r.json.primary, at: Date.now() } });
  await refreshSnapshot(true);
  relayLoop();
  return { ok: true, primary: r.json.primary };
}

// The read-only data the pages use. Fetched when a page asks (at most once a minute) and every 15 minutes.
let lastRefresh = 0;
async function refreshSnapshot(force = false) {
  if (!force && Date.now() - lastRefresh < 60000) return { skipped: true };
  lastRefresh = Date.now();
  const { bridge = {}, studio: cur } = await chrome.storage.local.get(['bridge', 'studio']);
  if (!bridge.token) return { error: 'not_paired' };
  const r = await studio('/snapshot', { have: cur?.version });
  if (r.status !== 200) return { error: r.json.error || 'failed' };
  if (!r.json.unchanged) await chrome.storage.local.set({ studio: r.json });
  return { ok: true, version: r.json.version };
}
const REFRESH = 'tth-studio-snapshot';
chrome.alarms.get(REFRESH).then(a => { if (!a) chrome.alarms.create(REFRESH, { periodInMinutes: 15, delayInMinutes: 1 }); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === REFRESH) refreshSnapshot(true); });

// A typed request to the app. The operation id is made once per click; it is sent once and never replayed:
// if the app doesn't answer, nothing was queued and the page says so.
async function request(kind, req) {
  const op = 'op-' + crypto.randomUUID();
  const r = await studio('/request', { op, kind, request: req });
  if (r.status === 0) return { error: 'not_running' };
  if (r.status !== 200) return { error: r.json.error || 'failed', op };
  const { studioOps = [] } = await chrome.storage.local.get('studioOps');
  await chrome.storage.local.set({ studioOps: [{ op, kind, req, at: Date.now(), state: r.json }, ...studioOps].slice(0, 30) });
  return { ok: true, op, state: r.json };
}

// ---------- Browser relay (desktop service/relay.js) ----------
// While paired, the app may hand over single Tumblr API requests (reads and full-post edits of the account's own
// posts, follower lists, the account's likes, public tag search, and single posts and notes on any blog, read
// only) to carry out in this browser's tumblr.com session, which has no hourly app quota. This
// is an adapter, not business work: the app builds every request, owns the job and verifies the outcome; this
// only checks the request against a fixed list and the logged-in account, sends it and returns the raw answer.
// Nothing is queued here: when the app isn't running the loop just stops, and the alarm looks again later.
// The third field marks reads that may be about any blog (one post, its notes); everything else with a blog in
// the path must be one of the account's own blogs. Writes are always own-blog only.
const RELAY_OK = [
  ['GET', /^\/v2\/blog\/([\w%:.-]{1,80})\/posts(\/draft|\/queue)?$/],
  ['GET', /^\/v2\/blog\/([\w%:.-]{1,80})\/posts\/\d{1,25}$/, 'anyBlog'],
  ['GET', /^\/v2\/blog\/([\w%:.-]{1,80})\/notes$/, 'anyBlog'],
  ['PUT', /^\/v2\/blog\/([\w%:.-]{1,80})\/posts\/\d{1,25}$/],
  ['GET', /^\/v2\/blog\/([\w%:.-]{1,80})\/followers$/],
  ['GET', /^\/v2\/user\/following$/],
  ['GET', /^\/v2\/user\/likes$/],
  ['GET', /^\/v2\/tagged$/], // public tag search, used for tag heat
  ['GET', /^\/v2\/blog\/([\w%:.-]{1,80})\/notifications$/], // fans & interactions: own blogs only
  ['GET', /^\/v2\/blog\/([\w%:.-]{1,80})\/followed_by$/],
  ['GET', /^\/v2\/blog\/([\w%:.-]{1,80})\/post\/\d{1,25}\/replies$/, 'anyBlog'], // read a post's replies
  // a reply the app sends as one of the account's own blogs (Tumblr has no public API for it); body checked in replyOk
  ['POST', /^\/v2\/user\/post\/reply$/, 'reply'],
  // delete one post on the account's (and the app's) own blogs; the app offers this only with its opt-in
  // setting and checks the post is gone before and after. Body: exactly { id }
  ['POST', /^\/v2\/blog\/([\w%:.-]{1,80})\/post\/delete$/, 'delete'],
  // create a post or reblog on one of the account's (and the app's) own blogs, without new files (the app
  // offers this only with its opt-in setting; a lost answer is reconciled there, never resent). Fields checked in createOk
  ['POST', /^\/v2\/blog\/([\w%:.-]{1,80})\/posts$/, 'create'],
];
const CREATE_KEYS = new Set(['content', 'layout', 'state', 'tags', 'publish_on', 'parent_tumblelog_uuid', 'parent_post_id', 'reblog_key', 'interactability_reblog']);
function createOk(json, files) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || Object.keys(json).some(k => !CREATE_KEYS.has(k))) return false;
  if (!Array.isArray(json.content) || (json.layout != null && !Array.isArray(json.layout))) return false;
  if (json.state != null && !['published', 'draft', 'queue', 'private'].includes(json.state)) return false;
  if (json.tags != null && typeof json.tags !== 'string') return false;
  // a reblog names its parent completely; an original names none of it
  const parent = ['parent_tumblelog_uuid', 'parent_post_id', 'reblog_key'].filter(k => json[k] != null).length;
  if (parent !== 0 && parent !== 3) return false;
  // upload identifiers only for the files that come with it (filesOk checks they match exactly)
  if (!files && JSON.stringify(json.content).includes('"identifier"')) return false;
  return JSON.stringify(json).length <= 512 * 1024;
}
// New image files for a create or a full edit (step 3): images/video only, sane names and sizes, and the post's
// upload identifiers are exactly these files, so nothing unrelated rides along.
const FILE_TYPES = /^(image\/(png|jpeg|gif|webp|bmp)|video\/mp4)$/;
function idsIn(content) {
  const out = [];
  for (const b of content || []) for (const m of [].concat(b?.media || [], b?.poster || [])) if (m && typeof m.identifier === 'string') out.push(m.identifier);
  return out;
}
function filesOk(item, rule) {
  if (item.files == null) return true;
  if (!(rule[2] === 'create' || (item.method === 'PUT' && !rule[2]))) return false;
  const f = item.files;
  if (!Array.isArray(f) || !f.length || f.length > 30) return false;
  let total = 0;
  for (const x of f) {
    if (!x || !/^[\w-]{1,64}$/.test(String(x.identifier || '')) || !FILE_TYPES.test(String(x.mime || '')) || typeof x.b64 !== 'string' || typeof x.filename !== 'string' || x.filename.length > 200) return false;
    total += x.b64.length;
  }
  if (total > 80 * 1024 * 1024) return false;
  const want = [...new Set(f.map(x => x.identifier))].sort();
  return want.length === f.length && JSON.stringify([...new Set(idsIn(item.json?.content))].sort()) === JSON.stringify(want);
}
function formOf(json, files) {
  const fd = new FormData();
  fd.append('json', JSON.stringify(json ?? {}));
  for (const x of files) {
    const bin = atob(x.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    fd.append(x.identifier, new Blob([bytes], { type: x.mime }), x.filename);
  }
  return fd;
}
const deleteOk = json => !!json && typeof json === 'object' && Object.keys(json).length === 1 && /^\d{1,25}$/.test(String(json.id ?? ''));
// Only these fields, a short plain text, and reply_as one of the account's (and the app's) own blogs
const REPLY_KEYS = new Set(['post_id', 'reblog_key', 'tumblelog', 'reply_text', 'reply_as']);
function replyOk(json, own) {
  if (!json || typeof json !== 'object' || Object.keys(json).some(k => !REPLY_KEYS.has(k))) return false;
  if (!/^\d{1,25}$/.test(String(json.post_id || ''))) return false;
  if (typeof json.reply_text !== 'string' || !json.reply_text.trim() || json.reply_text.length > 4096) return false;
  if (typeof json.reblog_key !== 'string' || !json.reblog_key || json.reblog_key.length > 64) return false;
  if (typeof json.tumblelog !== 'string' || !/^[\w%:.-]{1,80}$/.test(json.tumblelog)) return false;
  return own(String(json.reply_as || ''));
}
let web = null; // { token, csrf, primary, own: Set of lowercased uuids and names, at }
async function webAuth(force = false) {
  if (web && !force && Date.now() - web.at < 10 * 60e3) return web;
  web = null;
  const { token, csrf } = C.parseAuth(await (await fetch(TUMBLR + '/dashboard', { credentials: 'include' })).text());
  if (!token) return null;
  const r = await fetch(TUMBLR + '/api/v2/user/info', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, credentials: 'include' });
  if (!r.ok) return null;
  const blogs = (await r.json().catch(() => ({})))?.response?.user?.blogs || [];
  web = { token, csrf, primary: blogs.find(b => b.primary)?.name || null, own: new Set(blogs.flatMap(b => [b.uuid, b.name]).filter(Boolean).map(x => x.toLowerCase())), at: Date.now() };
  return web;
}

async function carry(item, appBlogs, bridge) {
  const rid = item.rid;
  const rule = RELAY_OK.find(([m, re]) => m === item.method && re.test(item.path));
  if (!rule) return { rid, refused: 'not_allowed' };
  let a = await webAuth().catch(() => null);
  if (!a) return { rid, refused: 'signed_out' };
  if (!bridge.primary || String(a.primary || '').toLowerCase() !== bridge.primary.toLowerCase()) return { rid, refused: 'other_account' };
  if (rule[2] === 'delete' && !deleteOk(item.json)) return { rid, refused: 'not_allowed' };
  if (rule[2] === 'create' && !createOk(item.json, item.files)) return { rid, refused: 'not_allowed' };
  if (!filesOk(item, rule)) return { rid, refused: 'not_allowed' };
  if (rule[2] === 'reply' && !replyOk(item.json, b => a.own.has(b.toLowerCase()) && appBlogs.has(b.toLowerCase()))) return { rid, refused: 'not_own_blog' };
  const blog = rule[1].exec(item.path)[1];
  if (blog && rule[2] !== 'anyBlog') {
    const b = decodeURIComponent(blog).toLowerCase();
    if (!a.own.has(b) || !appBlogs.has(b)) return { rid, refused: 'not_own_blog' };
  }
  const qs = new URLSearchParams(Object.entries(item.query || {}).map(([k, v]) => [k, String(v)])).toString();
  const url = TUMBLR + '/api' + item.path + (qs ? '?' + qs : '');
  for (let retry = 0; ; retry++) {
    const headers = { Authorization: 'Bearer ' + a.token, Accept: 'application/json' };
    // with files: multipart like the official API (the browser sets the boundary); otherwise JSON
    if (item.method !== 'GET') { if (!item.files) headers['Content-Type'] = 'application/json'; if (a.csrf) headers['X-CSRF'] = a.csrf; }
    const body = item.method === 'GET' ? undefined : item.files ? formOf(item.json, item.files) : JSON.stringify(item.json ?? {});
    let res;
    try { res = await fetch(url, { method: item.method, headers, credentials: 'include', body }); }
    catch { return { rid, status: 0 }; } // may have reached Tumblr: the app treats a write as uncertain and reads first
    if (res.status === 401 && retry === 0) { a = await webAuth(true).catch(() => null); if (!a) return { rid, refused: 'signed_out' }; continue; }
    return { rid, status: res.status, text: await res.text(), retryAfter: Number(res.headers.get('retry-after')) || 0 };
  }
}

let relayRunning = false;
async function relayLoop() {
  if (relayRunning) return;
  relayRunning = true;
  try {
    for (;;) {
      const { bridge = {} } = await chrome.storage.local.get('bridge'); // an extension call: keeps the worker alive
      if (!bridge.token) break;
      const r = await studio('/relay/next', { wait: 20000 }, { timeout: 26000 });
      if (r.status !== 200 || !r.json.enabled) break;
      const items = r.json.items || [];
      if (!items.length) continue;
      const appBlogs = new Set((r.json.blogs || []).map(x => String(x).toLowerCase()));
      const answers = await Promise.all(items.map(it => carry(it, appBlogs, bridge).catch(() => ({ rid: it.rid, status: 0 }))));
      await studio('/relay/done', { answers });
    }
  } finally { relayRunning = false; }
}
const RELAY = 'tth-relay';
chrome.alarms.get(RELAY).then(a => { if (!a) chrome.alarms.create(RELAY, { periodInMinutes: 1 }); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === RELAY) relayLoop(); });
relayLoop();

// ---------- Contextual entry points ----------
// A post link (or the post page itself): www.tumblr.com/<blog>/<id>[/slug] or <blog>.tumblr.com/post/<id>
function postOf(url) {
  try {
    const u = new URL(url);
    let m = u.hostname === 'www.tumblr.com' && u.pathname.match(/^\/(?:blog\/view\/)?([\w-]+)\/(\d{6,25})(?:\/|$)/);
    if (m) return { blog: m[1], id: m[2] };
    m = u.hostname.match(/^([\w-]+)\.tumblr\.com$/) && u.pathname.match(/^\/post\/(\d{6,25})/);
    if (m) return { blog: u.hostname.split('.')[0], id: m[1] };
  } catch { /* not a URL */ }
  return null;
}
const MENU_PATTERNS = ['https://www.tumblr.com/*/*', 'https://*.tumblr.com/post/*'];
async function setupMenus() {
  const { t } = C.makeI18n(() => '', () => [chrome.i18n?.getUILanguage?.() || navigator.language]);
  await chrome.contextMenus.removeAll().catch(() => {});
  for (const [id, key] of [['tth-open', 'ctxOpen'], ['tth-collect', 'ctxCollect']]) {
    chrome.contextMenus.create({ id, title: t(key), contexts: ['link'], targetUrlPatterns: MENU_PATTERNS });
    chrome.contextMenus.create({ id: id + '-page', title: t(key), contexts: ['page'], documentUrlPatterns: MENU_PATTERNS });
  }
  chrome.contextMenus.create({ id: 'tth-companion', title: t('ctxCompanion'), contexts: ['action'] });
}
chrome.runtime.onStartup?.addListener(setupMenus);
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'tth-companion') return openCompanion();
  const post = postOf(info.linkUrl || info.pageUrl || '');
  const say = text => tab?.id >= 0 && chrome.tabs.sendMessage(tab.id, { type: 'studioToast', text }).catch(() => {});
  const { settings = {} } = await chrome.storage.local.get('settings');
  const { t } = C.makeI18n(() => settings.lang || '', () => [settings.tumblrLang]);
  if (!post) return say(t('ctxNoPost'));
  const kind = info.menuItemId.startsWith('tth-open') ? 'open' : 'collect';
  const r = await request(kind, post);
  if (r.error === 'not_running') return say(t('studioNotRunning'));
  if (r.error) return say(t('studioRefused', r.error));
  say(kind === 'open' ? t('ctxOpened') : r.state.result?.already ? t('ctxAlready') : t('ctxQueued'));
});

// ---------- Messages from the pages ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const answer = p => { p.then(reply, e => reply({ error: C.errMsg(e) })); return true; };
  switch (msg?.type) {
    case 'openStudio': return answer(request('focus', { page: msg.page || '' }));
    case 'studioRefresh': return answer(refreshSnapshot(false));
    case 'studioHello': return answer(studio('/hello').then(r => ({ ...r.json, running: r.status !== 0 })));
    case 'studioStatus': return answer(studio('/status').then(r => ({ status: r.status, ...r.json })));
    case 'studioPair': return answer(pair(msg.grant, msg.port, msg.code));
    case 'studioUnpair': return answer((async () => { await studio('/unpair'); await chrome.storage.local.remove(['bridge', 'studio']); return { ok: true }; })());
    case 'studioImport': return answer(request('import', { export: msg.export }));
    case 'studioResult': return answer(studio('/result', { op: msg.op }).then(r => r.json));
    default: return false;
  }
});
