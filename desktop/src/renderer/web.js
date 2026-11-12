'use strict';
// The browser build's bridge to the local backend, in place of Electron's preload: the same window.studio
// interface (call, on, locale). Calls are POSTs to this server with the session cookie and a header a
// cross-site form can't send; events come over server-sent events and, after a reconnect, the page fetches its
// state again (events are hints, never the record).
(() => {
  if (window.studio) return; // the Electron window has its preload
  const enc = v => {
    if (v instanceof Uint8Array) { let s = ''; for (let i = 0; i < v.length; i += 0x8000) s += String.fromCharCode.apply(null, v.subarray(i, i + 0x8000)); return { $b64: btoa(s) }; }
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === 'object' && v.constructor === Object) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
    return v;
  };
  const listeners = [];
  let banner = null;
  function showBanner(text) {
    if (!document.body) return;
    if (!text) { banner?.remove(); banner = null; return; }
    if (!banner) { banner = document.createElement('div'); banner.className = 'conn-banner'; document.body.append(banner); }
    banner.textContent = text;
  }
  async function call(method, args) {
    let res;
    try {
      res = await fetch('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify({ method, args: enc(args) }), credentials: 'same-origin' });
    } catch {
      // not delivered: nothing is claimed; the caller sees an error and nothing was saved
      throw new Error(document.documentElement.lang === 'zh' ? '与后台的连接已断开，这次操作没有送达。' : 'The background service can’t be reached; this wasn’t delivered.');
    }
    if (res.status === 401) { showBanner(document.documentElement.lang === 'zh' ? '登录已失效：请从 Tumblr Studio 快捷方式重新打开。' : 'Signed out: open Tumblr Studio again from its shortcut.'); throw new Error('session'); }
    const j = await res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status }));
    if (j.ok === false || j.error && j.ok === undefined) throw new Error(j.error || 'HTTP ' + res.status);
    return j.value;
  }
  let es = null, wasDown = false;
  function connect() {
    es = new EventSource('/api/events');
    es.onopen = () => { if (wasDown) { wasDown = false; showBanner(null); listeners.forEach(fn => fn({ type: 'reconnected' })); } };
    es.onmessage = e => {
      let ev; try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.type === 'stopped') { showBanner(document.documentElement.lang === 'zh' ? '后台已停止。重新打开快捷方式即可继续。' : 'The background service stopped. Open the shortcut again to continue.'); wasDown = true; }
      listeners.forEach(fn => fn(ev));
    };
    es.onerror = () => { if (!wasDown) { wasDown = true; showBanner(document.documentElement.lang === 'zh' ? '与后台的连接已断开，正在重连…' : 'Disconnected from the background service, reconnecting…'); } };
  }
  window.studio = {
    call,
    on: fn => { listeners.push(fn); if (!es) connect(); },
    trayRefresh: () => {},
    locale: navigator.language,
    web: true,
  };
})();
