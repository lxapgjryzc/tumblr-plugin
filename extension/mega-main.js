// Runs in the page's own world on the official mass editor, where the content script can't reach jQuery.
// Feeds the "Add tags" jQuery UI 1.8 autocomplete with suggestions that content.js works out (tth-suggest events).
(() => {
  'use strict';
  let seq = 0;
  function hook() {
    const $ = window.jQuery;
    const $inp = $ && $('#tag_editor_input');
    const inst = $inp?.length && ($inp.data('autocomplete') || $inp.data('ui-autocomplete'));
    if (!inst || $inp.data('tthHooked')) return;
    $inp.data('tthHooked', true);
    const official = Array.isArray(inst.options.source) ? inst.options.source.map(String) : [];
    const tokens = () => [...document.querySelectorAll('#tokens > *')].map(n => n.textContent.replace(/[×✕x]\s*$/i, ''));
    $inp.autocomplete('option', 'source', (req, res) => {
      const id = ++seq;
      const onRes = e => {
        const r = JSON.parse(e.detail);
        if (r.id !== id) return;
        document.removeEventListener('tth-suggest-res', onRes);
        res(r.tags);
      };
      document.addEventListener('tth-suggest-res', onRes);
      document.dispatchEvent(new CustomEvent('tth-suggest', { detail: JSON.stringify({ id, term: req.term, tokens: tokens(), official }) }));
    });
    $inp.autocomplete('option', 'minLength', 0);
    $inp.on('focus.tth', () => $inp.autocomplete('search', $inp.val()));
    if (document.activeElement === $inp[0]) $inp.autocomplete('search', $inp.val());
  }
  hook();
  // The page sets up its autocomplete after document_idle; hook it when the box first gets focus
  document.addEventListener('focusin', e => { if (e.target.id === 'tag_editor_input') hook(); }, true);
})();
