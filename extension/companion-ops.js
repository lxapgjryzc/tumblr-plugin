// The companion page's operations (design 4.3), one fixed list used two ways:
//  - directly by the extension's own companion.html (the fallback while the app isn't running), and
//  - through companion-host.js on the page Tumblr Studio serves at http://127.0.0.1:<port>/companion/, so the
//    page itself belongs to the app and can be opened like any web page.
// Only these operations exist: no raw storage access, and nothing secret (bridge token, AI key) leaves here.
// eslint-disable-next-line no-unused-vars
function makeCompanionOps(chrome) {
  const PREFS = ['hideAds', 'hideRecs', 'hideAiArt', 'lang'];
  const send = msg => chrome.runtime.sendMessage(msg).catch(e => ({ error: String(e?.message || e) }));

  // Everything the app can import, minus secrets (the AI key stays here; enter it in the app)
  async function exportData() {
    const all = await chrome.storage.local.get(null);
    for (const k of ['aiKey', 'bridge', 'studio', 'studioOps', 'writer']) delete all[k];
    return { format: 'tth-export', version: 1, exported: new Date().toISOString(), extension: chrome.runtime.getManifest().version, data: all };
  }

  return {
    async state() {
      const { settings = {}, bridge = {}, studio, legacyMoved } = await chrome.storage.local.get(['settings', 'bridge', 'studio', 'legacyMoved']);
      return {
        prefs: { hideAds: true, hideRecs: false, hideAiArt: false, lang: '', ...Object.fromEntries(PREFS.filter(k => k in settings).map(k => [k, settings[k]])) },
        tumblrLang: settings.tumblrLang || '',
        paired: !!bridge.token, primary: bridge.primary || null,
        snapshot: studio?.at ? { at: studio.at, blogs: Object.keys(studio.cache?.blogs || {}).length, packs: (studio.packs || []).length } : null,
        legacyMoved: legacyMoved || null,
        version: chrome.runtime.getManifest().version,
      };
    },
    // only the browser-local preferences are written; other stored settings are left exactly as they are
    async savePrefs(patch = {}) {
      const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => PREFS.includes(k)).map(([k, v]) => [k, k === 'lang' ? (['', 'en', 'zh'].includes(v) ? v : '') : !!v]));
      const cur = (await chrome.storage.local.get('settings')).settings || {};
      await chrome.storage.local.set({ settings: { ...cur, ...clean } });
      return { ok: true };
    },
    hello: () => send({ type: 'studioHello' }),
    pair: () => send({ type: 'studioPair' }),
    unpair: () => send({ type: 'studioUnpair' }),
    focus: () => send({ type: 'openStudio' }),
    refresh: () => send({ type: 'studioRefresh' }),
    async move() {
      const r = await send({ type: 'studioImport', export: await exportData() });
      if (!r?.error) await chrome.storage.local.set({ legacyMoved: { at: Date.now(), op: r.op } });
      return r;
    },
    exportData,
    onChange(fn) { chrome.storage.onChanged.addListener(ch => { if (ch.studio || ch.bridge || ch.settings || ch.legacyMoved) fn(); }); },
  };
}
if (typeof module !== 'undefined') module.exports = { makeCompanionOps };
