// Service worker: opens the manager page, blocks ad networks while "Hide ads" is on, and every 10 minutes
// keeps reblogs between my blogs in line (TTHCore.autoMaintain) while that setting is on
importScripts('core.js');
const C = TTHCore;
const TUMBLR = 'https://www.tumblr.com';

// Clicking the toolbar icon opens the manager page
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
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
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) maintain(); });

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
    const done = await C.autoMaintain(C.makeApi(request), t, since);
    if (done.length) await chrome.storage.local.set({ autoLog: [{ at: Date.now(), done }, ...autoLog].slice(0, 30) });
  } catch (e) {
    // not logged in or offline: try again next time, and say so once
    if (autoLog[0]?.error !== C.errMsg(e)) await chrome.storage.local.set({ autoLog: [{ at: Date.now(), error: C.errMsg(e) }, ...autoLog].slice(0, 30) });
  } finally {
    busy = false;
  }
}
