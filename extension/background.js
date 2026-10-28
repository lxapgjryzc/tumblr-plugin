// Service worker: opens the manager page, fetches pack URLs for the content script, blocks ad networks while
// "Hide ads" is on, and every 10 minutes keeps reblogs between my blogs in line (TTHCore.autoMaintain) while
// that setting is on, and reblogs new likes onto the collection blog (TTHCore.autoCollect) while that is on
importScripts('core.js');
const C = TTHCore;
const TUMBLR = 'https://www.tumblr.com';

// Clicking the toolbar icon opens the manager page
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
});

// Pack installs from a URL on tumblr.com pages: the page's CSP would block the content script's own fetch
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'fetchText') return;
  fetch(msg.url).then(async r => {
    if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
    reply({ text: await r.text() });
  }).catch(e => reply({ error: C.errMsg(e) }));
  return true;
});

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
  const skip = settings.collect?.blog ? [settings.collect.blog] : [];
  try {
    let since = autoSince;
    if (!since) { since = Math.floor(Date.now() / 1000); await chrome.storage.local.set({ autoSince: since }); }
    const { t } = C.makeI18n(() => settings.lang || '', () => []);
    const done = await C.autoMaintain(C.makeApi(request), t, since, { skip });
    if (done.length) await chrome.storage.local.set({ autoLog: [{ at: Date.now(), done }, ...autoLog].slice(0, 30) });
  } catch (e) {
    // not logged in or offline: try again next time, and say so once
    if (autoLog[0]?.error !== C.errMsg(e)) await chrome.storage.local.set({ autoLog: [{ at: Date.now(), error: C.errMsg(e) }, ...autoLog].slice(0, 30) });
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
