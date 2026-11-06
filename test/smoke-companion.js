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
  const bridge = D('src/service/bridge').makeBridge(svc, api, { version: 't', approve: async () => true, onOpen: o => opened.push(o) });
  return { fake, svc, api, bridge, opened, running: true };
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
    const res = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (u.hostname === '127.0.0.1') {
      if (!studio.running || u.port !== '47823') throw new TypeError('Failed to fetch');
      const out = await studio.bridge.handle({ origin: 'chrome-extension://' + EXT_ID, host: u.host, auth: init.headers?.Authorization || '', path: u.pathname, body: JSON.parse(init.body || '{}') });
      return res(out.status, out.json);
    }
    tumblrCalls.push((init.method || 'GET') + ' ' + u.pathname);
    if (u.pathname === '/dashboard') return res(200, '<script>{"API_TOKEN":"tok","csrfToken":"c"}</script>');
    if (u.pathname === '/api/v2/user/info') return res(200, { response: { user: { blogs: [{ name: 'mainblog', primary: true }] } } });
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
    navigator: { languages: ['en'], language: 'en' }, crypto: require('crypto').webcrypto, Blob };
  ctx.importScripts = f => vm.runInContext(ext(f), ctx, { filename: f });
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(ext('background.js'), ctx, { filename: 'background.js' });
  const send = msg => new Promise(resolve => { let sync = false; for (const f of fx.chrome.runtime.onMessage.fns) { const r = f(msg, {}, resolve); if (r === true) sync = true; } if (!sync) resolve(undefined); });

  // A55: the old background passes are gone and can't come back
  for (const f of fx.chrome.runtime.onInstalled.fns) await f({ reason: 'update' });
  check(!fx.alarms.has('tth-maintain'), 'update removes the old maintenance alarm');
  check([...fx.alarms.keys()].every(n => n === 'tth-studio-snapshot'), 'the only alarm left refreshes the app snapshot: ' + [...fx.alarms.keys()]);
  check(fx.menus.some(m => m.id === 'tth-collect') && fx.menus.some(m => m.id === 'tth-open'), 'context menu entries for Open / Collect');

  // pairing, then the snapshot arrives for the pages
  check((await send({ type: 'studioRefresh' })).error === 'not_paired', 'no snapshot before pairing');
  const pr = await send({ type: 'studioPair' });
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

  // the toolbar icon opens the app's page while it runs, the extension's own copy when it doesn't
  await fx.chrome.action.onClicked.fns[0]();
  studio.running = false;
  await fx.chrome.action.onClicked.fns[0]();
  studio.running = true;
  check(fx.chrome.tabs.created[0] === 'http://127.0.0.1:47823/companion/' && fx.chrome.tabs.created[1] === `chrome-extension://${EXT_ID}/companion.html`, 'toolbar icon: app page when running, own page otherwise: ' + JSON.stringify(fx.chrome.tabs.created));

  // the companion never writes to Tumblr itself
  check(tumblrCalls.every(c => c.startsWith('GET ')), 'only reads from tumblr.com: ' + JSON.stringify(tumblrCalls));
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.log('TEST CRASH', e.stack || e); process.exit(1); });
