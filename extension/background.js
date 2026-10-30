// Service worker: opens the manager page, fetches pack URLs for the content script, blocks ad networks while
// "Hide ads" is on, and every 10 minutes keeps reblogs between my blogs in line (TTHCore.autoMaintain) while
// that setting is on, and reblogs new likes onto the collection blog (TTHCore.autoCollect) while that is on
importScripts('core.js');
const C = TTHCore;
const TUMBLR = 'https://www.tumblr.com';

// The manager page, on one of its pages (manager.html#packs): an open manager tab is brought forward, else a new one
async function openManager(page = '') {
  const base = chrome.runtime.getURL('manager.html');
  const url = base + (page ? '#' + page : '');
  // getContexts lists this extension's own open pages without the tabs permission
  const open = await chrome.runtime.getContexts({ contextTypes: ['TAB'] }).catch(() => []);
  const tab = open.find(c => c.documentUrl?.startsWith(base) && c.tabId >= 0);
  if (!tab) return chrome.tabs.create({ url });
  await chrome.tabs.update(tab.tabId, { active: true, ...(page ? { url } : {}) });
  if (tab.windowId >= 0) chrome.windows.update(tab.windowId, { focused: true });
}
chrome.action.onClicked.addListener(() => openManager());

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // the template panel's "Manage packs" link
  if (msg?.type === 'openManager') { openManager(msg.page); return; }
  // The "Redo AI" button on a material blog's post: the AI endpoint is reached from here, where the optional host
  // permission applies and the page's CSP doesn't
  if (msg?.type === 'aiRedo') { aiRedo(msg).then(reply, e => reply({ error: C.errMsg(e) })); return true; }
  // Pack installs from a URL on tumblr.com pages: the page's CSP would block the content script's own fetch
  if (msg?.type !== 'fetchText') return;
  fetch(msg.url).then(async r => {
    if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
    reply({ text: await r.text() });
  }).catch(e => reply({ error: C.errMsg(e) }));
  return true;
});

// A lease (jobLease of the manager, bgLease here) older than this counts as gone: a crashed tab or worker
const LEASE_MS = 2 * 60 * 1000;
const leaseHeld = l => !!l && Date.now() - (l.at || 0) < LEASE_MS;

// AI sort of one post of a material blog, written at once (TTHCore.aiSortPost). The only place outside the
// manager that reads aiKey; it never leaves this worker except to the AI endpoint.
async function aiRedo({ blog, id }) {
  const { settings = {}, cache = {}, aiKey = '', jobLease } = await chrome.storage.local.get(['settings', 'cache', 'aiKey', 'jobLease']);
  const { t } = C.makeI18n(() => settings.lang || '', () => [settings.tumblrLang]);
  const b = (cache.blogList || []).find(x => x.name === blog);
  if (!b || C.blogRole(settings, b) !== 'material') return { error: t('aiRedoNotMaterial') };
  const ai = settings.ai || {};
  if (!ai.base || !ai.model || !aiKey) return { error: t('aiNeedSetup') };
  // permissions.request needs a click on an extension page, so the grant comes from the manager's Test button
  let origin;
  try { origin = new URL(ai.base).origin + '/*'; } catch { return { error: t('aiNeedSetup') }; }
  if (!(await chrome.permissions.contains({ origins: [origin] }))) return { error: t('aiNoAccessPage') };
  if (leaseHeld(jobLease)) return { error: t('aiRedoManagerBusy') };
  const beat = () => chrome.storage.local.set({ bgLease: { at: Date.now() } });
  await beat();
  const timer = setInterval(beat, 30000);
  try {
    return await C.aiSortPost(C.makeApi(request), t, blog, id, ai, aiKey);
  } finally {
    clearInterval(timer);
    await chrome.storage.local.remove('bgLease');
  }
}

// Ad networks are blocked at the request level (rules_ads.json, only for requests made by tumblr.com pages)
// while the "Hide ads" setting is on
async function syncAdBlocking(on) {
  const ids = { [on ? 'enableRulesetIds' : 'disableRulesetIds']: ['ads'] };
  await chrome.declarativeNetRequest.updateEnabledRulesets(ids);
}
chrome.storage.local.get('settings').then(r => syncAdBlocking(r.settings?.hideAds ?? true));
chrome.storage.onChanged.addListener(ch => {
  if (ch.settings) syncAdBlocking(ch.settings.newValue?.hideAds ?? true);
});

// ---------- Reblogs between my blogs, unattended ----------
// Only posts published after the feature was first on (storage key autoSince) are reblogged to the main blog,
// so turning it on doesn't reblog the whole back catalogue. What was done goes to storage key autoLog.
const ALARM = 'tth-maintain';
chrome.alarms.get(ALARM).then(a => { if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 10, delayInMinutes: 1 }); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) maintain().then(collect); });

async function request(path, { method, body }) {
  for (let retry = 0; ; retry++) {
    const html = await (await fetch(TUMBLR + '/dashboard', { credentials: 'include' })).text();
    const { token, csrf } = C.parseAuth(html);
    if (!token) throw Object.assign(new Error('not logged in'), { status: 401 });
    const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
    if (csrf) headers['X-CSRF'] = csrf;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(TUMBLR + '/api' + path, { method, headers, credentials: 'include', body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && retry === 0) continue;
    if (!res.ok) throw Object.assign(new Error(json?.meta?.msg || res.statusText), { status: res.status, body: json });
    return json;
  }
}

let busy = false;
async function maintain() {
  if (busy) return;
  const { settings = {}, autoSince, autoLog = [] } = await chrome.storage.local.get(['settings', 'autoSince', 'autoLog']);
  if (settings.syncReblogs === false) return;
  busy = true;
  try {
    let since = autoSince;
    if (!since) { since = Math.floor(Date.now() / 1000); await chrome.storage.local.set({ autoSince: since }); }
    const { t } = C.makeI18n(() => settings.lang || '', () => []);
    const api = C.makeApi(request);
    // only sharing blogs take part; blogs with no role yet wait for the manager's question (said once in the log)
    const blogs = await C.getBlogs(api);
    const unset = C.unsetBlogs(settings, blogs).map(b => b.name);
    const note = unset.length ? t('rolesUnsetBg', unset.join(', ')) : '';
    if (note && !autoLog.some(e => e.error === note)) {
      autoLog.unshift({ at: Date.now(), error: note });
      await chrome.storage.local.set({ autoLog: autoLog.slice(0, 30) });
    }
    const done = await C.autoMaintain(api, t, since, C.reblogScope(settings, blogs));
    if (done.length) await chrome.storage.local.set({ autoLog: [{ at: Date.now(), done }, ...autoLog].slice(0, 30) });
  } catch (e) {
    // not logged in or offline: try again next time; the same error again moves its entry's time and counts it
    const error = C.errMsg(e);
    const log = autoLog[0]?.error === error ? [{ ...autoLog[0], at: Date.now(), n: (autoLog[0].n || 1) + 1 }, ...autoLog.slice(1)]
      : [{ at: Date.now(), error }, ...autoLog];
    await chrome.storage.local.set({ autoLog: log.slice(0, 30) });
  } finally {
    busy = false;
  }
}

// ---------- Likes onto the collection blog, unattended ----------
// Only likes made after this was turned on (storage key collectSince, a liked timestamp that moves forward
// with each pass) are reblogged; the manager page reblogs older ones on request. Log: storage key collectLog.
let collecting = false;
async function collect() {
  const { settings = {}, collectSince, collectLog = [] } = await chrome.storage.local.get(['settings', 'collectSince', 'collectLog']);
  const col = settings.collect;
  if (!col?.blog || !col.auto || collecting) return;
  collecting = true;
  const note = e => chrome.storage.local.set({ collectLog: [{ at: Date.now(), ...e }, ...collectLog].slice(0, 30) });
  try {
    if (!collectSince) { await chrome.storage.local.set({ collectSince: Math.floor(Date.now() / 1000) }); return; }
    const r = await C.autoCollect(C.makeApi(request), col, collectSince);
    if (r.last > collectSince) await chrome.storage.local.set({ collectSince: r.last });
    if (r.done.length || r.skipped.length || r.error) await note({ done: r.done, skipped: r.skipped, error: r.error });
  } catch (e) {
    if (collectLog[0]?.error !== C.errMsg(e)) await note({ error: C.errMsg(e) });
  } finally {
    collecting = false;
  }
}
