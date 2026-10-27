// Content script on tumblr.com: hides ads (and, if asked, Tumblr's recommendations) as set in the manager's
// settings; changes apply live
(() => {
  'use strict';
  const C = TTHCore;
  const makeStyle = css => Object.assign(document.createElement('style'), { textContent: css });
  const adStyle = makeStyle(C.AD_CSS), recStyle = makeStyle(C.REC_CSS);
  let ads = false;
  // The Premium upsell box is found by its text (see TTHCore.isUpsell), so it is hidden from script
  const hideUpsell = () => {
    if (!ads) return;
    for (const n of document.querySelectorAll(C.UPSELL_SELECTOR)) {
      if (!n.dataset.tthAd && C.isUpsell(n.innerText)) { n.dataset.tthAd = '1'; n.style.setProperty('display', 'none', 'important'); }
    }
  };
  const toggle = (style, on) => { if (on) document.documentElement.appendChild(style); else style.remove(); };
  const apply = (s = {}) => {
    ads = s.hideAds ?? true;
    toggle(adStyle, ads);
    toggle(recStyle, !!s.hideRecs);
    if (ads) return hideUpsell();
    for (const n of document.querySelectorAll('[data-tth-ad]')) { delete n.dataset.tthAd; n.style.removeProperty('display'); }
  };
  new MutationObserver(C.debounce(hideUpsell, 300)).observe(document.documentElement, { childList: true, subtree: true });
  chrome.storage.local.get('settings').then(r => apply(r.settings));
  chrome.storage.onChanged.addListener(ch => { if (ch.settings) apply(ch.settings.newValue); });
})();
