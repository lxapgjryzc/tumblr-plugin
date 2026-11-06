// Content script on the companion page Tumblr Studio serves (http://127.0.0.1:<port>/companion/). That page is
// the app's, so it can't reach this extension's storage; this script answers its calls with the fixed
// operations of companion-ops.js and nothing else. Calls come by window.postMessage from the page itself.
// The page's marker is only there once the document is parsed, so wait for that whatever run_at says.
const tthCompanionHost = () => {
  'use strict';
  if (!location.pathname.startsWith('/companion/') || !document.querySelector('meta[name="tumblr-studio-companion"]')) return;
  const ops = makeCompanionOps(chrome);
  const CALLS = ['state', 'savePrefs', 'hello', 'pair', 'unpair', 'focus', 'refresh', 'move', 'exportData'];
  const post = msg => window.postMessage({ tthCompanion: true, from: 'host', ...msg }, location.origin);
  window.addEventListener('message', async e => {
    const m = e.data;
    if (e.source !== window || e.origin !== location.origin || !m?.tthCompanion || m.from !== 'page') return;
    if (m.type === 'ping') return post({ type: 'ready' });
    if (m.type !== 'call' || !CALLS.includes(m.fn)) return;
    let result;
    try { result = await ops[m.fn](...(Array.isArray(m.args) ? m.args : [])); } catch (err) { result = { error: String(err?.message || err) }; }
    post({ type: 'reply', id: m.id, result });
  });
  ops.onChange(() => post({ type: 'changed' }));
  post({ type: 'ready' });
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tthCompanionHost, { once: true }); else tthCompanionHost();
