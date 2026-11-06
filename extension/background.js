// Service worker of the browser companion (Tumblr Studio, design 4.3). It runs no business work of its own: no
// sync, reblog, expiry or collection passes and no AI. It
//  - opens the companion page from the toolbar icon,
//  - turns the ad-network ruleset on and off with the browser-local "Hide ads" preference,
//  - talks to the running app over its loopback endpoint (pairing, a read-only data snapshot for the pages,
//    typed requests such as "Open in Tumblr Studio" and "Collect with Tumblr Studio"),
//  - on update, removes the alarms older versions used for their own background passes.
// When the app isn't running, page helpers keep working from the last snapshot and app actions say so; nothing
// is queued here to be sent later.
importScripts('core.js');
const C = TTHCore;
const TUMBLR = 'https://www.tumblr.com';
const PORTS = [47823, 47824, 47825];
const PROTOCOL = 1;

// ---------- The companion page ----------
// While the app runs, its page is the companion page (served by the app at /companion/, with companion-host.js
// giving it this extension's few operations); otherwise this extension's own copy says to start the app.
async function openCompanion() {
  const r = await studio('/hello', {}, { timeout: 1500 });
  const { bridge = {} } = await chrome.storage.local.get('bridge');
  const url = r.status === 200 && r.json.app === 'tumblr-studio' && bridge.port ? `http://127.0.0.1:${bridge.port}/companion/` : chrome.runtime.getURL('companion.html');
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const tab = tabs.find(x => x.url?.startsWith(url) || x.url?.startsWith(chrome.runtime.getURL('companion.html')) || /^http:\/\/127\.0\.0\.1:\d+\/companion\//.test(x.url || ''));
  if (!tab) return chrome.tabs.create({ url });
  await chrome.tabs.update(tab.id, { active: true, ...(tab.url?.startsWith(url) ? {} : { url }) });
  if (tab.windowId >= 0) chrome.windows.update(tab.windowId, { focused: true });
}
chrome.action.onClicked.addListener(() => openCompanion());

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
async function studio(path, body = {}, { timeout = 8000 } = {}) {
  const { bridge = {} } = await chrome.storage.local.get('bridge');
  const ports = bridge.port ? [bridge.port, ...PORTS.filter(p => p !== bridge.port)] : PORTS;
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

async function pair() {
  const primary = await primaryBlog().catch(() => null);
  const r = await studio('/pair', { primary });
  if (r.status !== 200) return { error: r.json.error || 'failed', primary: r.json.primary };
  await chrome.storage.local.set({ bridge: { ...(await chrome.storage.local.get('bridge')).bridge, token: r.json.token, primary: r.json.primary, at: Date.now() } });
  await refreshSnapshot(true);
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
}
chrome.runtime.onStartup?.addListener(setupMenus);
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
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
    case 'studioPair': return answer(pair());
    case 'studioUnpair': return answer((async () => { await studio('/unpair'); await chrome.storage.local.remove(['bridge', 'studio']); return { ok: true }; })());
    case 'studioImport': return answer(request('import', { export: msg.export }));
    case 'studioResult': return answer(studio('/result', { op: msg.op }).then(r => r.json));
    default: return false;
  }
});
