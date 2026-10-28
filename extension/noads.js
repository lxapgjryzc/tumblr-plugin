// Content script on tumblr.com: hides ads (and, if asked, Tumblr's recommendations and posts tagged as
// AI-made) as set in the manager's settings; changes apply live
(() => {
  'use strict';
  const C = TTHCore;
  const makeStyle = css => Object.assign(document.createElement('style'), { textContent: css });
  const adStyle = makeStyle(C.AD_CSS), recStyle = makeStyle(C.REC_CSS);
  let ads = false, noAi = false;
  // The Premium upsell box is found by its text (see TTHCore.isUpsell), so it is hidden from script
  const hideUpsell = () => {
    if (!ads) return;
    for (const n of document.querySelectorAll(C.UPSELL_SELECTOR)) {
      if (!n.dataset.tthAd && C.isUpsell(n.innerText)) { n.dataset.tthAd = '1'; n.style.setProperty('display', 'none', 'important'); }
    }
  };
  // Posts whose tags say they are AI-made (TTHCore.aiArtVerdict, the same rule as the collection's). Tags
  // can render after the post, so every post is looked at again on each change. A tag page the user opened
  // on purpose (/tagged/ai art) is left alone.
  const postBox = a => a.closest('[data-cell-id]') || a.parentElement;
  const hideAiPosts = () => {
    if (!noAi) return;
    const page = decodeURIComponent(location.pathname.match(/^\/tagged\/([^/]+)/)?.[1] || '');
    if (page && C.aiArtSignal(page) === 'yes') return;
    for (const a of document.querySelectorAll('article')) {
      const box = postBox(a);
      if (!box || box.dataset.tthAi) continue;
      const tags = [...a.querySelectorAll('a[href*="/tagged/"]')].map(l => l.textContent.trim().replace(/^#/, ''));
      if (C.aiArtVerdict({ owner: tags }).verdict) { box.dataset.tthAi = '1'; box.style.setProperty('display', 'none', 'important'); }
    }
  };
  const showAiPosts = () => { for (const n of document.querySelectorAll('[data-tth-ai]')) { delete n.dataset.tthAi; n.style.removeProperty('display'); } };
  const scan = () => { hideUpsell(); hideAiPosts(); };
  const toggle = (style, on) => { if (on) document.documentElement.appendChild(style); else style.remove(); };
  const apply = (s = {}) => {
    ads = s.hideAds ?? true;
    noAi = !!s.hideAiArt;
    toggle(adStyle, ads);
    toggle(recStyle, !!s.hideRecs);
    if (noAi) hideAiPosts(); else showAiPosts();
    if (ads) return hideUpsell();
    for (const n of document.querySelectorAll('[data-tth-ad]')) { delete n.dataset.tthAd; n.style.removeProperty('display'); }
  };
  new MutationObserver(C.debounce(scan, 300)).observe(document.documentElement, { childList: true, subtree: true });
  chrome.storage.local.get('settings').then(r => apply(r.settings));
  chrome.storage.onChanged.addListener(ch => { if (ch.settings) apply(ch.settings.newValue); });
})();
