// Smoke test for the browser companion (design 4.3, A52–A55): the real service worker and companion page,
// with fake Chrome APIs, talking to the real Tumblr Studio bridge (desktop/src/service) over a fake loopback.
// Needs Node 24+ (node:sqlite). All blogs, ids and tags are made up.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ext = f => fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8');
const D = p => require(path.join(__dirname, '..', 'desktop', p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

// ----- Tumblr Studio, in memory -----
function makeStudio() {
  const { makeFake } = D('test/fake-tumblr');
  const fake = makeFake({ blogs: [{ uuid: 't:main', name: 'mainblog', primary: true }, { uuid: 't:ref', name: 'refside' }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cp-'));
  const svc = D('src/service/service').createService({ dataDir: dir, tumblr: fake });
  const extra = {};
  D('src/service/writing').addWriting(svc, extra, { dataDir: dir });
  D('src/service/data').addData(svc, extra, { dataDir: dir });
  D('src/service/material').addMaterial(svc, extra, { media: { pixels: async () => new Uint8ClampedArray(64 * 4).fill(128) } });
  const api = D('src/service/api').makeApi(svc, { extra });
  const opened = [];
  const relay = D('src/service/relay').makeRelay({ enabled: () => !!svc.db.getMeta('companion', null) });
  const bridge = D('src/service/bridge').makeBridge(svc, api, { version: 't', relay, approve: async (id, { code }) => code === '4321', checkGrant: g => g === 'g-test', onOpen: o => opened.push(o) });
  return { fake, svc, api, bridge, relay, opened, running: true };
}

// ----- fake Chrome -----
function makeChrome(store, studio, tumblrCalls) {
  const ev = () => { const fns = []; return { addListener: f => fns.push(f), fns }; };
  const changed = ev();
  const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const alarms = new Map([['tth-maintain', { name: 'tth-maintain' }]]);
  const menus = [], toasts = [];
  const chrome = {
    storage: { local: {
      get: async keys => (keys == null ? clone(store) : Object.fromEntries([].concat(keys).filter(k => k in store).map(k => [k, clone(store[k])]))),
      set: async obj => { const ch = {}; for (const [k, v] of Object.entries(obj)) { ch[k] = { oldValue: store[k], newValue: clone(v) }; store[k] = clone(v); } changed.fns.forEach(f => f(ch, 'local')); },
      remove: async keys => { for (const k of [].concat(keys)) delete store[k]; },
    }, onChanged: changed },
    alarms: { get: async n => alarms.get(n), create: (n, o) => alarms.set(n, { name: n, ...o }), clear: async n => alarms.delete(n), onAlarm: ev() },
    runtime: { onInstalled: ev(), onStartup: ev(), onMessage: ev(), getContexts: async () => [], getURL: p => `chrome-extension://${EXT_ID}/${p}`, getManifest: () => ({ version: '0.11.0' }) },
    action: { onClicked: ev() },
    declarativeNetRequest: { updateEnabledRulesets: async () => {} },
    contextMenus: { removeAll: async () => { menus.length = 0; }, create: m => menus.push(m), onClicked: ev() },
    tabs: { created: [], query: async () => [], create: async o => { chrome.tabs.created.push(o.url); }, update: async () => {}, sendMessage: async (id, msg) => { toasts.push(msg.text); } },
    windows: { update: async () => {} },
    i18n: { getUILanguage: () => 'en' },
  };
  // fetch: the loopback goes to the bridge (Chrome adds the extension's Origin), tumblr.com is a fake
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const res = (status, body) => ({ ok: status < 400, status, headers: new Map(), json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (u.hostname === '127.0.0.1') {
      if (!studio.running || u.port !== '47823') throw new TypeError('Failed to fetch');
      const out = await studio.bridge.handle({ origin: 'chrome-extension://' + EXT_ID, host: u.host, auth: init.headers?.Authorization || '', path: u.pathname, body: JSON.parse(init.body || '{}') });
      return res(out.status, out.json);
    }
    tumblrCalls.push(Object.assign(new String((init.method || 'GET') + ' ' + u.pathname), {}));
    if (u.pathname === '/dashboard') return res(200, '<script>{"API_TOKEN":"tok","csrfToken":"c"}</script>');
    if (u.pathname === '/api/v2/user/info') return res(200, { response: { user: { blogs: [{ uuid: 't:main', name: 'mainblog', primary: true }, { uuid: 't:ref', name: 'refside' }] } } });
    if (/^\/api\/v2\/blog\/[^/]+\/posts\/\d+$/.test(u.pathname)) {
      tumblrCalls.at(-1).headers = init.headers;
      return res(200, { response: { id_string: u.pathname.split('/').pop(), via: 'browser', body: init.body ? JSON.parse(init.body) : null } });
    }
    if (/^\/api\/v2\/blog\/[^/]+\/posts$/.test(u.pathname) && init.method === 'POST') {
      if (init.body instanceof FormData) {
        const files = [];
        for (const [k, v] of init.body.entries()) if (k !== 'json') files.push([k, v.name, v.type, Buffer.from(await v.arrayBuffer()).toString()]);
        Object.assign(tumblrCalls.at(-1), { body: JSON.parse(init.body.get('json')), files, contentType: init.headers['Content-Type'] });
        return res(201, { response: { id_string: '900000000000000002' } });
      }
      tumblrCalls.at(-1).body = JSON.parse(init.body || '{}'); return res(201, { response: { id: 900000000000000001, id_string: '900000000000000001' } }); }
    if (/^\/api\/v2\/blog\/[^/]+\/post\/delete$/.test(u.pathname)) { tumblrCalls.at(-1).body = JSON.parse(init.body || '{}'); return res(200, { response: {} }); }
    if (u.pathname === '/api/v2/user/post/reply') { tumblrCalls.at(-1).body = JSON.parse(init.body || '{}'); return res(200, { response: {} }); }
    if (u.pathname === '/api/v2/tagged' || u.pathname === '/api/v2/user/likes' || /^\/api\/v2\/blog\/[^/]+\/notes$/.test(u.pathname)) { tumblrCalls.at(-1).search = u.search; return res(200, { response: [] }); }
    return res(404, {});
  };
  return { chrome, fetch, alarms, menus, toasts };
}

(async () => {
  const studio = makeStudio();
  studio.svc.pass();
  for (let i = 0; i < 10; i++) await studio.svc.jobs.drain(studio.svc.ctx);
  studio.api.saveCollect({ blog: 't:ref', tags: ['reference'] });
  const store = {
    settings: { lang: 'en', hideAds: true, collect: { blog: 't:ref', auto: true, tags: ['reference'] }, blogRoles: {}, rules: {} },
    packs: [], cache: { blogList: [], blogs: {} }, aiKey: 'secret-key',
  };
  const tumblrCalls = [];
  const fx = makeChrome(store, studio, tumblrCalls);
  const ctx = { chrome: fx.chrome, fetch: fx.fetch, console, setTimeout, clearTimeout, AbortController, URL, URLSearchParams, TextDecoder, TextEncoder,
    navigator: { languages: ['en'], language: 'en' }, crypto: require('crypto').webcrypto, Blob, FormData, atob };
  ctx.importScripts = f => vm.runInContext(ext(f), ctx, { filename: f });
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(ext('background.js'), ctx, { filename: 'background.js' });
  const send = msg => new Promise(resolve => { let sync = false; for (const f of fx.chrome.runtime.onMessage.fns) { const r = f(msg, {}, resolve); if (r === true) sync = true; } if (!sync) resolve(undefined); });

  // A55: the old background passes are gone and can't come back
  for (const f of fx.chrome.runtime.onInstalled.fns) await f({ reason: 'update' });
  check(!fx.alarms.has('tth-maintain'), 'update removes the old maintenance alarm');
  check([...fx.alarms.keys()].sort().join() === 'tth-relay,tth-studio-snapshot', 'the alarms left refresh the app snapshot and look for relay work: ' + [...fx.alarms.keys()]);
  check(fx.menus.some(m => m.id === 'tth-collect') && fx.menus.some(m => m.id === 'tth-open'), 'context menu entries for Open / Collect');

  // pairing, then the snapshot arrives for the pages
  check((await send({ type: 'studioRefresh' })).error === 'not_paired', 'no snapshot before pairing');
  // pairing needs the one-time grant the app's own companion page hands over (no grant: refused, nothing sent)
  check((await send({ type: 'studioPair' })).error === 'grant_required', 'pairing without a grant is refused');
  // without a grant the app asks the user, showing the page's code (here: declined for another code)
  check((await send({ type: 'studioPair', code: '1111' })).error === 'declined', 'a pairing the user does not allow is refused');
  const pr = await send({ type: 'studioPair', grant: 'g-test', port: 47823 });
  check(pr.ok && store.bridge?.token && store.bridge.primary === 'mainblog', 'paired with the account the browser is logged into: ' + JSON.stringify(pr));
  check(store.studio?.version && store.studio.cache?.blogs?.['t:main'], 'the app snapshot is stored for the content scripts');

  // Collect from the context menu: one app job; a second click doesn't make another
  const liked = studio.fake.addPost('t:o', { blog: { uuid: 't:o', name: 'painter' }, content: [{ type: 'image', media: [{ url: 'https://64.media.tumblr.com/a/b/s640x960/c.jpg', width: 640 }] }] });
  const click = id => Promise.all(fx.chrome.contextMenus.onClicked.fns.map(f => f({ menuItemId: id, linkUrl: `https://www.tumblr.com/painter/${liked.id_string}` }, { id: 7 })));
  await click('tth-collect');
  await click('tth-collect');
  const jobs = studio.svc.jobs.list({ status: 'open' }).filter(j => j.kind === 'material.collect');
  check(jobs.length === 1, 'one collect job in the app for two clicks: ' + jobs.length);
  check(/collecting/i.test(fx.toasts[0] || '') && /Already/i.test(fx.toasts[1] || ''), 'the page is told what the app did: ' + JSON.stringify(fx.toasts));
  check((store.studioOps || []).length === 2 && store.studioOps.every(o => o.state?.accepted), 'requests are recorded only as acknowledged by the app');
  // Open in Studio
  await click('tth-open');
  check(studio.opened.length === 1, 'Open in Tumblr Studio reaches the app');

  // A54: app quit → nothing is queued here, the page says so
  studio.running = false;
  const before = store.studioOps.length;
  await click('tth-collect');
  check(/isn.t running/.test(fx.toasts.at(-1)) && store.studioOps.length === before, 'with the app quit nothing is queued: ' + fx.toasts.at(-1));
  studio.running = true;

  // the companion page: status, moving the old data, browser-only preferences
  const dom = new JSDOM(ext('companion.html').replace(/<script src="[^"]+"><\/script>/g, ''), { url: `chrome-extension://${EXT_ID}/companion.html`, runScripts: 'outside-only' });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', e => errors.push(e.error || e.message));
  w.chrome = { ...fx.chrome, runtime: { ...fx.chrome.runtime, sendMessage: send } };
  w.eval(ext('core.js') + ';' + ext('companion-ops.js') + ';' + ext('companion.js'));
  await sleep(300);
  const $ = id => w.document.getElementById(id);
  check(/Connected to Tumblr Studio \(mainblog\)/.test($('conn').textContent), 'companion page shows the connection: ' + $('conn').textContent);
  check($('where').querySelectorAll('tr').length >= 15 && !/not in the app yet/.test($('where').textContent) && /Tag upkeep/.test($('where').textContent), 'every former feature is listed with where it is now, none pending');
  check(!w.document.querySelector('[data-act="rbFix"], #posts, #batchTags'), 'no manager, batch or reblog-repair controls');
  w.document.querySelector('[data-act="move"]').click();
  await sleep(300);
  const imported = studio.svc.db.getMeta('lastImport');
  check(!!imported && store.legacyMoved?.at, 'older data was moved into the app');
  check(studio.api.collectSettings().auto === false && studio.api.collectSettings().fromExtension?.auto === true, 'collecting arrives switched off, with a note that it was on');
  const sentExport = JSON.stringify(studio.svc.db.all("SELECT request FROM companion_ops WHERE kind = 'import'"));
  check(!/secret-key/.test(sentExport), 'the AI key is not sent');
  $('hideAiArt').checked = true;
  $('hideAiArt').dispatchEvent(new w.Event('change'));
  await sleep(50);
  check(store.settings.hideAiArt === true && store.settings.collect?.blog === 't:ref', 'a browser preference is saved without touching other stored settings');
  check(errors.length === 0, 'no runtime errors on the companion page: ' + errors.join('; '));

  // The same page served by the app (http://127.0.0.1:<port>/companion/): the page has no chrome.*; the
  // extension's companion-host.js (its own world, simulated by a closure) runs the fixed operations for it
  const served = async withExtension => {
    // the host script is injected while the document is still loading (before the marker meta is parsed)
    const html = ext('companion.html').replace(/<script src="[^"]+"><\/script>/g, '');
    const d = new JSDOM('', { url: 'http://127.0.0.1:47823/companion/', runScripts: 'outside-only' });
    d.window.document.open();
    const errs = [];
    d.window.addEventListener('error', e => errs.push(e.error || e.message));
    // jsdom leaves event.source / event.origin empty; a browser fills them in, and the scripts check both
    d.window.postMessage = (data, target) => {
      if (target !== d.window.location.origin) return;
      setTimeout(() => d.window.dispatchEvent(new d.window.MessageEvent('message', { data: JSON.parse(JSON.stringify(data)), origin: d.window.location.origin, source: d.window })), 0);
    };
    if (withExtension) {
      d.window.__hostChrome = { ...fx.chrome, runtime: { ...fx.chrome.runtime, sendMessage: send } };
      d.window.eval('(function (chrome) {' + ext('companion-ops.js') + ';' + ext('companion-host.js') + '})(window.__hostChrome); delete window.__hostChrome;');
    }
    d.window.document.write(html);
    d.window.document.close();
    d.window.eval(ext('core.js') + ';' + ext('companion.js'));
    await sleep(withExtension ? 400 : 2500);
    return { d, errs, $: id => d.window.document.getElementById(id) };
  };
  const a = await served(true);
  check(typeof a.d.window.chrome === 'undefined' || !a.d.window.chrome.storage, 'the app-served page has no extension API of its own');
  check(/Connected to Tumblr Studio \(mainblog\)/.test(a.$('conn').textContent), 'the app-served page shows the connection through the extension: ' + a.$('conn').textContent);
  a.$('hideRecs').checked = true;
  a.$('hideRecs').dispatchEvent(new a.d.window.Event('change'));
  await sleep(100);
  check(store.settings.hideRecs === true && store.settings.hideAiArt === true, 'a preference set on the app-served page reaches the extension');
  a.d.window.postMessage({ tthCompanion: true, from: 'page', type: 'call', id: 99, fn: 'exportData', args: [] }, 'http://127.0.0.1:47823');
  let raw = null;
  a.d.window.addEventListener('message', e => { if (e.data?.id === 99) raw = e.data.result; });
  a.d.window.postMessage({ tthCompanion: true, from: 'page', type: 'call', id: 100, fn: 'get', args: [null] }, 'http://127.0.0.1:47823');
  await sleep(100);
  check(raw && !/secret-key/.test(JSON.stringify(raw)) && !raw.data.bridge, 'only the fixed operations answer, and the export holds no key or token');
  check(a.errs.length === 0, 'no runtime errors on the app-served page: ' + a.errs.join('; '));
  const b = await served(false);
  check(/isn.t connected to the Tag Helper extension/.test(b.$('conn').textContent) && b.d.window.document.querySelector('section.needs-ext').hidden, 'without the extension the app-served page says so: ' + b.$('conn').textContent);

  // the toolbar icon opens the app: an open app tab is switched to; otherwise the app opens (and signs in) a page
  // itself; with the app not running, the extension's own companion page. The icon's menu opens the companion page.
  const opened0 = studio.opened.length;
  await fx.chrome.action.onClicked.fns[0]();
  check(studio.opened.length === opened0 + 1 && studio.opened.at(-1).fresh === true && fx.chrome.tabs.created.length === 0, 'toolbar icon: the app opens its own page: ' + JSON.stringify(studio.opened.at(-1)) + JSON.stringify(fx.chrome.tabs.created));
  const realQuery = fx.chrome.tabs.query, updated = [];
  fx.chrome.tabs.query = async () => [{ id: 3, windowId: 1, url: 'http://127.0.0.1:47823/companion/' }, { id: 4, windowId: 1, url: 'http://127.0.0.1:47823/' }];
  const realUpdate = fx.chrome.tabs.update;
  fx.chrome.tabs.update = async (id, o) => { updated.push([id, o]); };
  await fx.chrome.action.onClicked.fns[0]();
  check(updated.length === 1 && updated[0][0] === 4 && !updated[0][1].url && studio.opened.length === opened0 + 1, 'toolbar icon: switches to the open app tab: ' + JSON.stringify(updated));
  fx.chrome.tabs.query = realQuery; fx.chrome.tabs.update = realUpdate;
  check(fx.menus.some(m => m.id === 'tth-companion' && m.contexts.includes('action')), 'the icon menu has the companion page');
  await Promise.all(fx.chrome.contextMenus.onClicked.fns.map(f => f({ menuItemId: 'tth-companion' }, undefined)));
  studio.running = false;
  await fx.chrome.action.onClicked.fns[0]();
  studio.running = true;
  check(fx.chrome.tabs.created[0] === 'http://127.0.0.1:47823/companion/' && fx.chrome.tabs.created[1] === `chrome-extension://${EXT_ID}/companion.html`, 'companion page from the icon menu; own page when the app is down: ' + JSON.stringify(fx.chrome.tabs.created));

  // the companion never writes to Tumblr on its own
  check(tumblrCalls.every(c => c.startsWith('GET ')), 'only reads from tumblr.com: ' + JSON.stringify(tumblrCalls.map(String)));

  // Browser relay: the app hands over a read and an edit of its own posts; the browser carries them out in its
  // session and answers. A post on a blog that isn't the account's is refused before anything is sent.
  for (const f of fx.chrome.alarms.onAlarm.fns) f({ name: 'tth-relay' });
  await sleep(50);
  const r1 = studio.relay.send({ method: 'GET', path: '/v2/blog/t%3Amain/posts/11', query: { post_format: 'npf' } });
  const r2 = studio.relay.send({ method: 'PUT', path: '/v2/blog/mainblog/posts/12', query: {}, json: { tags: 'a,b' } });
  const [a1, a2] = await Promise.all([r1, r2]);
  check(a1.status === 200 && JSON.parse(a1.text).response.via === 'browser', 'a read goes through the browser session: ' + JSON.stringify(a1).slice(0, 200));
  check(a2.status === 200 && JSON.parse(a2.text).response.body.tags === 'a,b', 'an edit carries the body from the app unchanged');
  const put = tumblrCalls.find(c => String(c) === 'PUT /api/v2/blog/mainblog/posts/12');
  check(put && put.headers['X-CSRF'] === 'c' && put.headers.Authorization === 'Bearer tok', 'the edit is sent with the web session token and CSRF header');
  // tag search and the account's likes have no blog in the path; they go through with their query
  const n0 = tumblrCalls.length;
  const a4 = await studio.relay.send({ method: 'GET', path: '/v2/tagged', query: { tag: 'a b', limit: '20' } });
  check(a4.status === 200 && tumblrCalls.some(c => String(c) === 'GET /api/v2/tagged' && c.search === '?tag=a+b&limit=20'), 'tag search goes through the browser with its query: ' + tumblrCalls.slice(n0).map(String));
  const a5 = await studio.relay.send({ method: 'GET', path: '/v2/user/likes', query: { npf: 'true' } });
  check(a5.status === 200, 'the account\'s likes go through the browser');
  const r6 = await studio.relay.send({ method: 'POST', path: '/v2/user/unlike', query: {}, json: { id: '1' } }).then(() => 'sent', e => e.message);
  check(r6 !== 'sent', 'unlike is never relayed: ' + r6);

  // one post and its notes on someone else's blog may be read (material checks); writes and post lists may not
  const a7 = await studio.relay.send({ method: 'GET', path: '/v2/blog/someoneelse/posts/13', query: { post_format: 'npf' } });
  check(a7.status === 200, 'one post on another blog is read through the browser');
  const a8 = await studio.relay.send({ method: 'GET', path: '/v2/blog/someoneelse/notes', query: { id: '13', mode: 'conversation' } });
  check(a8.status === 200 && tumblrCalls.some(c => String(c) === 'GET /api/v2/blog/someoneelse/notes' && c.search === '?id=13&mode=conversation'), 'notes on another blog are read through the browser');
  const n = tumblrCalls.length;
  const r3 = await studio.relay.send({ method: 'PUT', path: '/v2/blog/someoneelse/posts/13', query: {}, json: { tags: 'x' } }).then(() => 'sent', e => e.message);
  check(/not_own_blog/.test(r3) && tumblrCalls.length === n, 'an edit on a blog outside the account is refused without a request: ' + r3);
  const r4 = await studio.relay.send({ method: 'GET', path: '/v2/blog/someoneelse/posts', query: {} }).then(() => 'sent', e => e.message);
  check(/not_own_blog/.test(r4) && tumblrCalls.length === n, "another blog's post list is refused, and one refusal doesn't pause the relay: " + r4);
  // a reply (no public API): only as one of the account's own blogs, with the fixed fields
  const reply = json => studio.relay.send({ method: 'POST', path: '/v2/user/post/reply', query: {}, json }).then(r => r, e => e.message);
  const ok = { post_id: '11', reblog_key: 'rk', tumblelog: 'mainblog', reply_text: 'thanks!', reply_as: 'refside' };
  const a9 = await reply(ok);
  check(a9.status === 200 && tumblrCalls.some(c => String(c) === 'POST /api/v2/user/post/reply' && c.body?.reply_as === 'refside'), 'a reply as one of my blogs goes through the browser');
  const m = tumblrCalls.length;
  const r10 = await reply({ ...ok, reply_as: 'someoneelse' });
  const r11 = await reply({ ...ok, extra: 'x' });
  const r12 = await reply({ ...ok, reply_text: ' ' });
  check([r10, r11, r12].every(x => /not_own_blog/.test(x)) && tumblrCalls.length === m, 'a reply as another blog, with extra fields or no text is refused without a request: ' + [r10, r11, r12]);
  // a delete (opt-in in the app): one post on one of my blogs, body exactly { id }
  const del = (blog, json) => studio.relay.send({ method: 'POST', path: `/v2/blog/${blog}/post/delete`, query: {}, json }).then(r => r, e => e.message);
  const d1 = await del('refside', { id: '14' });
  check(d1.status === 200 && tumblrCalls.some(c => String(c) === 'POST /api/v2/blog/refside/post/delete' && c.body?.id === '14'), 'a delete on one of my blogs goes through the browser');
  const k = tumblrCalls.length;
  const d2 = await del('someoneelse', { id: '14' });
  const d3 = await del('refside', { id: '14', extra: 'x' });
  const d4 = await del('refside', { id: 'abc' });
  check(/not_own_blog/.test(d2) && /not_allowed/.test(d3) && /not_allowed/.test(d4) && tumblrCalls.length === k, 'a delete on another blog or with another body is refused without a request: ' + [d2, d3, d4]);
  // creates (opt-in in the app): own blogs, known fields, no new files
  const cre = (blog, json) => studio.relay.send({ method: 'POST', path: `/v2/blog/${blog}/posts`, query: {}, json }).then(r => r, e => e.message);
  const c1 = await cre('refside', { content: [{ type: 'text', text: 'hi' }], state: 'draft', tags: 'a,b' });
  const c2 = await cre('refside', { content: [], state: 'published', tags: 'x', parent_tumblelog_uuid: 't:other', parent_post_id: '5', reblog_key: 'rk' });
  check(c1.status === 201 && c2.status === 201 && tumblrCalls.some(c => String(c) === 'POST /api/v2/blog/refside/posts' && c.body?.reblog_key === 'rk'), 'an original and a reblog on one of my blogs go through the browser');
  const q = tumblrCalls.length;
  const c3 = await cre('someoneelse', { content: [] });
  const c4 = await cre('refside', { content: [{ type: 'image', media: [{ identifier: 'img1' }] }] });
  const c5 = await cre('refside', { content: [], parent_post_id: '5' });
  const c6 = await cre('refside', { content: [], slug: 'x' });
  check(/not_own_blog/.test(c3) && [c4, c5, c6].every(x => /not_allowed/.test(x)) && tumblrCalls.length === q, 'a create on another blog, with a new file, half a parent or unknown fields is refused without a request: ' + [c3, c4, c5, c6]);
  // uploads: the files come with the request and go out as multipart; identifiers must match the files exactly
  const up = (blog, json, files, method = 'POST', p = `/v2/blog/${blog}/posts`) => studio.relay.send({ method, path: p, query: {}, json, files }).then(r => r, e => e.message);
  const file = (id, mime = 'image/png') => ({ identifier: id, filename: id + '.png', mime, b64: Buffer.from('IMG-' + id).toString('base64') });
  const imgPost = ids => ({ content: ids.map(id => ({ type: 'image', media: [{ identifier: id }] })), state: 'draft' });
  const u1 = await up('refside', imgPost(['b1', 'b2']), [file('b1'), file('b2')]);
  const sent = tumblrCalls.find(c => c.files);
  check(u1.status === 201 && sent && !sent.contentType && JSON.stringify(sent.files) === JSON.stringify([['b1', 'b1.png', 'image/png', 'IMG-b1'], ['b2', 'b2.png', 'image/png', 'IMG-b2']]) && sent.body.content.length === 2,
    'a post with new images goes through the browser as multipart: ' + JSON.stringify(u1).slice(0, 300) + JSON.stringify(sent && sent.files));
  const w2 = tumblrCalls.length;
  const u2 = await up('refside', imgPost(['b1']), [file('b1'), file('b9')]);
  const u3 = await up('refside', imgPost(['b1']), [file('b1', 'text/html')]);
  const u4 = await up('refside', { id: '14' }, [file('b1')], 'POST', '/v2/blog/refside/post/delete');
  const u5 = await up('someoneelse', imgPost(['b1']), [file('b1')]);
  check([u2, u3, u4].every(x => /not_allowed/.test(x)) && /not_own_blog/.test(u5) && tumblrCalls.length === w2, 'files not matching the post, another file type, files on a delete or another blog are refused without a request: ' + [u2, u3, u4, u5]);
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.log('TEST CRASH', e.stack || e); process.exit(1); });
