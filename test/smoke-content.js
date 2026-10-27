// Smoke test for the content script: a fake copy of the official mass editor (legacy jQuery page) plus a
// post-editor page, both against a fake Tumblr API and a fake chrome.storage
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ext = f => fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8');
const src = ext('core.js') + ';\n' + ext('content.js');
const megaMain = ext('mega-main.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const now = Math.floor(Date.now() / 1000);

// ----- fake API, reached with fetch('/api/...') -----
function makeServer() {
  const store = {
    '1': { object_type: 'post', id_string: '1', state: 'published', tags: ['yuuto (arc v)', 'ygo'], timestamp: now, layout: [], date: 'd',
      content: [1, 2, 3].map(n => ({ type: 'image', media: [{ url: `https://img/${n}_640`, width: 640 }, { url: `https://img/${n}_250`, width: 250 }] })) },
    '2': { object_type: 'post', id_string: '2', state: 'private', tags: ['ygo'], timestamp: now, content: [], layout: [], date: 'd' },
    '3': { object_type: 'post', id_string: '3', state: 'published', tags: ['ygo', 'rare'], timestamp: now, content: [], layout: [], date: 'd' },
  };
  const puts = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url, 'https://www.tumblr.com');
    const json = (status, body) => ({ ok: status < 400, status, statusText: String(status), json: async () => body, text: async () => JSON.stringify(body) });
    if (u.pathname.startsWith('/tagged/')) {
      // tag page header: followers decide popularity (ygo > yuuto (arc v) > rare)
      const tag = decodeURIComponent(u.pathname.slice(8));
      const followers = { ygo: 50000, 'yuuto (arc v)': 178, rare: 3 }[tag] ?? 500;
      return { ok: true, status: 200, text: async () => `<script>{"isTrending":false,"followersCount":"${followers}","followersCountInt":${followers},"showFollowersCount":false,"postCountInt":1000}</script>` };
    }
    if (u.pathname === '/dashboard') return { ok: true, status: 200, text: async () => '<script>window.x={"API_TOKEN":"tok","csrfToken":"csrf"}</script>' };
    if (init.headers?.Authorization !== 'Bearer tok') return json(401, { meta: { msg: 'no token' } });
    const parts = u.pathname.split('/').map(decodeURIComponent);
    if (u.pathname === '/api/v2/tagged') {
      // newest 20 posts per tag, spaced so that ygo is busiest and rare is nearly dead
      const tag = u.searchParams.get('tag');
      const spread = { ygo: 60, 'yuuto (arc v)': 3600, rare: 86400 * 30 }[tag] ?? 600;
      return json(200, { response: Array.from({ length: 20 }, (_, i) => ({ object_type: 'post', id_string: tag + i, tags: [tag], timestamp: now - i * spread })) });
    }
    if (u.pathname === '/api/v2/user/info') return json(200, { response: { user: { blogs: [{ name: 'me', uuid: 't:1', primary: true }] } } });
    if (parts[2] === 'v2' && parts[3] === 'blog' && parts[5] === 'posts' && parts[6]) {
      const id = parts[6];
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body);
        puts.push({ id, body });
        store[id].tags = body.tags ? body.tags.split(',') : [];
        store[id].state = body.state;
        return json(200, { response: { id } });
      }
      return json(200, { response: JSON.parse(JSON.stringify(store[id])) });
    }
    if (parts[2] === 'v2' && parts[3] === 'blog' && parts[5] === 'posts') return json(200, { response: { posts: Object.values(store) } });
    return json(404, { meta: { msg: 'unexpected ' + u.pathname } });
  };
  return { store, puts, fetch };
}

// store is what chrome.storage.local holds; fetchText answers the service worker's pack fetches
function setupWindow(url, html, server, store) {
  const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', e => errors.push(e.error || e.message));
  w.fetch = server.fetch;
  const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const listeners = [];
  w.chrome = {
    storage: {
      local: {
        get: async keys => Object.fromEntries([].concat(keys).filter(k => k in store).map(k => [k, clone(store[k])])),
        set: async obj => {
          const ch = {};
          for (const [k, v] of Object.entries(obj)) { ch[k] = { oldValue: store[k], newValue: clone(v) }; store[k] = clone(v); }
          for (const fn of listeners) fn(clone(ch), 'local');
        },
      },
      onChanged: { addListener: fn => listeners.push(fn) },
    },
    runtime: { sendMessage: async msg => (msg.type === 'fetchText' ? w.fetchText(msg.url) : undefined) },
  };
  w.fetchText = async () => ({ error: 'offline' });
  w.clip = null;
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async v => { w.clip = v; } } });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.confirm = () => true;
  w.alerts = [];
  w.alert = m => w.alerts.push(m);
  return { w, errors };
}

const preset = () => ({
  settings: { autoSync: false, lang: 'en' },
  cache: {
    blogList: [{ uuid: 't:1', name: 'me', primary: true }],
    blogs: { 't:1': { name: 'me', posts: { 1: [['yuuto (arc v)', 'ygo'], now, 'published', 3], 2: [['ygo'], now, 'private', 0], 3: [['ygo', 'rare'], now, 'published', 1] } } },
    hidden: [], custom: [], tagStats: {}, lastAuto: Date.now(),
  },
});

// The official tiles: inline onclick toggles .highlighted and alerts beyond 100 selected
const brick = id => `<a id="post_${id}" class="brick regular" href="#" onclick="this.classList.toggle('highlighted'); if (document.querySelectorAll('.brick.highlighted').length > 100) alert('max'); return false;">
  <div class="highlight"><div id="tag_count_${id}" class="tag_count">2个标签</div></div><div class="overlay"><div class="inner"><div class="date">d</div></div></div></a>`;
const MEGA = `<!doctype html><html><head></head><body class="old_archive">
<div id="nav_archive"><div class="editor_navigation">
  <div class="header_button"><button id="make_posts_private" class="chrome big_dark"><div class="chrome_button">设为私密</div></button></div>
  <div class="header_button"><button id="remove_tags" class="chrome big_dark"><div class="chrome_button">编辑标签</div></button></div>
  <div class="header_button"><button id="add_tags" class="chrome big_dark"><div class="chrome_button">添加标签</div></button></div>
  <div id="add_tags_widget"><div id="tag_editor"><span id="tokens"></span><input id="tag_editor_input" type="text"></div><button id="add_tag_button"></button></div>
  <div id="remove_tags_widget"><div id="tags"></div><button id="remove_tag_button"></button></div>
  <div id="add_community_labels_widget"><div><p>添加内容标签：</p></div></div>
</div></div>
<div class="l-content">${[1, 2, 3].map(brick).join('')}${Array.from({ length: 105 }, (_, i) => brick(100 + i)).join('')}</div>
</body></html>`;

// Minimal stand-in for the page's jQuery + jQuery UI autocomplete on #tag_editor_input
function fakeJQuery(w) {
  const ac = { options: { source: ['officialonly', 'ygo'], minLength: 1 }, last: null };
  w.jQuery = sel => {
    const el = typeof sel === 'string' ? w.document.querySelector(sel) : sel;
    const self = {
      length: el ? 1 : 0,
      data(k, v) { const s = (el.__jq ||= {}); if (v === undefined) return k === 'autocomplete' ? ac : s[k]; s[k] = v; return self; },
      autocomplete(cmd, k, v) {
        if (cmd === 'option') ac.options[k] = v;
        if (cmd === 'search') ac.options.source({ term: k }, r => { ac.last = r; });
        return self;
      },
      on(ev, fn) { el.addEventListener(ev.split('.')[0], fn); return self; },
      val() { return el.value; },
    };
    return self;
  };
  return ac;
}

(async () => {
  // ===== Official mass editor =====
  const server = makeServer();
  const gm = preset();
  gm.packs = [{ raw: { format: 'tth-template-pack', id: 'tp', name: 'TP', base: ['ygo'],
    characters: [{ id: 'yuto', name: 'Yuto', tags: ['yuto arc v'], retired: ['yuuto (arc v)'] }] }, source: '' }];
  gm.templates = { current: 'tp', picks: [], favs: [] };
  const { w, errors } = setupWindow('https://www.tumblr.com/mega-editor/published/me', MEGA, server, gm);
  const ac = fakeJQuery(w);
  w.eval(src);
  w.eval(megaMain);
  await sleep(50);
  const d = w.document;
  const b = id => d.getElementById('post_' + id);
  const mouse = (el, type, opts = {}) => el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...opts }));
  // each gesture ends with a short pause, like separate user actions
  const clickTile = async (el, opts) => { mouse(el, 'mousedown', opts); mouse(el, 'mouseup', opts); mouse(el, 'click', opts); await sleep(5); };
  const selected = () => [...d.querySelectorAll('.brick.highlighted')].map(x => x.id.replace('post_', ''));

  check(!!d.getElementById('tth_make_public'), 'toolbar: "Make public" button added');
  check(d.getElementById('tth_make_public').closest('.header_button').previousElementSibling.querySelector('#make_posts_private'), 'placed right after "Make private"');
  check(!!d.getElementById('tth_remove_labels'), 'labels popup: "Remove community labels" button added');
  check(b(2).querySelector('.tth-badge')?.textContent === 'Private', 'private badge on post 2');
  check(b(1).querySelector('.tth-tile-tags')?.textContent === '#yuuto (arc v) #ygo', 'tag names in tile overlay');
  await sleep(300);
  check(b(1).querySelector('.tth-mosaic.n3')?.querySelectorAll('img').length === 3 && b(1).querySelector('.tth-imgcount')?.textContent === '🖼 3', 'multi-image post: mosaic of 3 and image count');
  check(!b(2).querySelector('.tth-mosaic'), 'single-image post keeps the official tile');
  mouse(b(1), 'mouseover');
  await sleep(450);
  const pv = w.document.getElementById('tth-host').shadowRoot.querySelector('.preview');
  check(!pv.hidden && pv.querySelectorAll('img').length === 3 && pv.querySelector('img').src.endsWith('_640'), 'hover preview shows all 3 images at the larger size');
  mouse(d.querySelector('.l-content'), 'mouseover');
  check(pv.hidden, 'preview hides when leaving the tile');

  // plain click, drag, shift range
  await clickTile(b(1));
  check(selected().join() === '1', 'plain click selects one tile');
  mouse(b(2), 'mousedown'); mouse(b(3), 'mouseover'); mouse(b(3), 'mouseup'); mouse(d.querySelector('.l-content'), 'click'); await sleep(5);
  check(selected().join() === '1,2,3', 'drag from 2 to 3 selects both: ' + selected().join());
  await clickTile(b(1));
  check(selected().join() === '2,3', 'click again deselects');
  // a fast drag that jumps from tile 100 straight to 103 still selects 101 and 102
  mouse(b(100), 'mousedown'); mouse(b(103), 'mouseover'); mouse(b(103), 'mouseup'); mouse(d.querySelector('.l-content'), 'click'); await sleep(5);
  check(['100', '101', '102', '103'].every(id => selected().includes(id)), 'fast drag fills skipped tiles: ' + selected().join());
  for (const id of ['100', '101', '102', '103']) b(id).click();
  // Shift range from 3 to 204 must stop at the 100 cap without the page's alert
  await clickTile(b(3)); await clickTile(b(3)); // anchor at 3, still selected
  await clickTile(b(204), { shiftKey: true });
  check(selected().length === 100 && w.alerts.length === 0, `shift range stops at 100 without alert (${selected().length}, alerts ${w.alerts.length})`);
  for (const id of selected()) b(id).click(); // clear through the official handler
  check(selected().length === 0, 'cleared');

  // autocomplete in the official "add tags" box
  d.getElementById('tag_editor_input').dispatchEvent(new w.Event('focus'));
  await sleep(10);
  check(ac.options.minLength === 0 && Array.isArray(ac.last) && ac.last[0] === 'ygo' && ac.last.includes('officialonly'), 'add-tags autocomplete fed with library + official tags: ' + ac.last);

  // "Edit tags" popup: counts, decoded names, fill
  await clickTile(b(1)); await clickTile(b(3));
  const tags = d.getElementById('tags');
  tags.innerHTML = ['arc-v', 'ygo', 'yuuto%20%28arc%20v%29', 'rare'].map((tg, i) =>
    `<div><input type="checkbox" id="tag_checkbox_${i}"><label for="tag_checkbox_${i}">${tg}</label></div>`).join('');
  await sleep(400);
  const rows = [...tags.children];
  const rowOf = tg => rows.find(r => r.querySelector('label').textContent === tg);
  check(rowOf('ygo').querySelector('.tth-count')?.textContent === '2/2', 'count 2/2 for ygo');
  check(rowOf('rare').querySelector('.tth-count')?.textContent === '1/2' && !!rowOf('rare').querySelector('.tth-fill'), 'count 1/2 with ⊕ for rare');
  const enc = rowOf('yuuto%20%28arc%20v%29');
  check(enc.querySelector('label').textContent === 'yuuto%20%28arc%20v%29' && enc.querySelector('label').classList.contains('tth-hide')
    && enc.querySelector('.tth-name')?.textContent === 'yuuto (arc v)', 'encoded label untouched, decoded name shown beside it');
  check(tags.firstElementChild.querySelector('label').textContent === 'ygo', 'rows sorted by count');
  const filter = d.querySelector('.tth-rt-filter');
  filter.value = 'yu'; filter.dispatchEvent(new w.Event('input'));
  check(rows.filter(r => r.style.display !== 'none').length === 1, 'filter box narrows the list');
  filter.value = ''; filter.dispatchEvent(new w.Event('input'));

  rowOf('rare').querySelector('.tth-fill').click();
  await sleep(1500);
  check(server.puts.length === 1 && server.puts[0].id === '1' && server.puts[0].body.tags === 'yuuto (arc v),ygo,rare', 'fill adds "rare" to post 1 only: ' + JSON.stringify(server.puts));
  check(d.getElementById('tag_count_1').textContent === '3个标签', 'tile tag count updated');

  // Make public: only the private post changes
  for (const id of selected()) b(id).click();
  await clickTile(b(1)); await clickTile(b(2));
  d.getElementById('tth_make_public').click();
  await sleep(1500);
  const pub = server.puts.slice(1);
  check(pub.length === 1 && pub[0].id === '2' && pub[0].body.state === 'published' && pub[0].body.tags === 'ygo', 'make public edits only the private post: ' + JSON.stringify(pub));
  check(!b(2).querySelector('.tth-badge'), 'private badge removed');

  // Sort tags by popularity: post 1 has yuuto (arc v), ygo, rare
  for (const id of selected()) b(id).click();
  await clickTile(b(1));
  const before = server.puts.length;
  d.getElementById('tth_sort_heat').click();
  await sleep(3000);
  const sorted = server.puts.slice(before);
  check(sorted.length === 1 && sorted[0].id === '1' && sorted[0].body.tags === 'ygo,yuuto (arc v),rare', 'sort by popularity reorders post 1: ' + JSON.stringify(sorted.map(p => p.body.tags)));

  // Tidy by packs: post 1's retired spelling is replaced in place
  for (const id of selected()) b(id).click();
  await clickTile(b(1)); await clickTile(b(3));
  const n1 = server.puts.length;
  d.getElementById('tth_upkeep').click();
  await sleep(300);
  const usr = [...d.querySelectorAll('*')].find(n => n.shadowRoot).shadowRoot;
  check(!usr.querySelector('.tp').hidden && usr.querySelectorAll('[data-upk]').length === 1 && usr.querySelector('[data-upk]').checked && n1 === server.puts.length,
    'mass editor: tidy by packs lists the change first, ticked, and edits nothing yet: ' + usr.querySelector('.tp').textContent.replace(/s+/g, ' '));
  usr.querySelector('[data-tp="applyUpkeep"]').click();
  await sleep(1500);
  const tidy = server.puts.slice(n1);
  check(tidy.length === 1 && tidy[0].id === '1' && tidy[0].body.tags === 'ygo,yuto arc v,rare', 'mass editor: tidy by packs replaces the old spelling, other posts untouched: ' + JSON.stringify(tidy.map(p => [p.id, p.body.tags])));

  // Tag templates on the mass editor edit the selected posts: Yuto is on post 1 only, so he shows "partly"
  d.getElementById('tth_templates').click();
  await sleep(300);
  const sr = [...d.querySelectorAll('*')].find(n => n.shadowRoot).shadowRoot;
  const yutoChip = () => [...sr.querySelectorAll('.tp-body .tp-c')].find(c => c.textContent === 'Yuto');
  check(!sr.querySelector('.tp').hidden && /Edit 2 post/.test(sr.querySelector('.tp-h .ttl').textContent), 'mass editor: "Tag templates" opens the panel in edit mode');
  check(yutoChip().classList.contains('part'), 'mass editor: an item on some of the posts is shown partly');
  yutoChip().click(); // put him on all
  const n0 = server.puts.length;
  sr.querySelector('[data-tp="insert"]').click();
  await sleep(1500);
  const added = server.puts.slice(n0);
  check(added.length === 1 && added[0].id === '3' && added[0].body.tags === 'ygo,rare,yuto arc v', 'mass editor: ticking Yuto adds him only where he is missing (post 1 keeps its order): ' + JSON.stringify(added.map(p => [p.id, p.body.tags])));
  d.getElementById('tth_templates').click();
  await sleep(300);
  check(yutoChip().classList.contains('on'), 'mass editor: now Yuto is on all selected posts');
  yutoChip().click(); // take him off all
  const n2 = server.puts.length;
  sr.querySelector('[data-tp="insert"]').click();
  await sleep(1500);
  const dropped = server.puts.slice(n2);
  check(dropped.length === 2 && dropped.every(p => p.body.tags === 'ygo,rare'), 'mass editor: unticking Yuto takes his tags off every selected post: ' + JSON.stringify(dropped.map(p => [p.id, p.body.tags])));
  check(errors.length === 0, 'no runtime errors on the mass editor' + (errors.length ? ': ' + errors.map(e => e.stack || e).join('\n') : ''));

  // ===== Post editor on a normal page =====
  const s2 = makeServer();
  const ed = setupWindow('https://www.tumblr.com/new/text', '<!doctype html><body><div><div><div><span>#ygo</span><input placeholder="#add tags"></div></div></div></body>', s2, preset());
  ed.w.tumblr = { apiFetch: async () => ({ response: {} }) };
  ed.w.eval(src);
  await sleep(50);
  const inp = ed.w.document.querySelector('input');
  inp.value = 'yu';
  inp.dispatchEvent(new ed.w.Event('input', { bubbles: true }));
  const dd = ed.w.document.getElementById('tth-host').shadowRoot.querySelector('.dd');
  check(!dd.hidden && dd.textContent.includes('#yuuto (arc v)'), 'post editor: suggestions shown');
  check(!ed.w.document.getElementById('tth_make_public'), 'no mass-editor buttons on other pages');
  check(ed.errors.length === 0, 'no runtime errors on the post editor page');

  // ===== Auto language on the legacy mass editor: <html lang> says "en", the page's own buttons are Chinese =====
  const autoGm = preset();
  autoGm.settings = { autoSync: false, lang: '' };
  const auto = setupWindow('https://www.tumblr.com/mega-editor/published/me', MEGA.replace('<html>', '<html lang="en">'), makeServer(), autoGm);
  fakeJQuery(auto.w);
  auto.w.eval(src);
  auto.w.eval(megaMain);
  await sleep(50);
  check(auto.w.document.getElementById('tth_make_public')?.textContent === '设为公开', 'auto language follows the Chinese Tumblr UI: ' + auto.w.document.getElementById('tth_make_public')?.textContent);

  // ===== Mass editor: a reblog of my own post is locked =====
  const lockGm = preset();
  lockGm.cache.blogs['t:1'].posts[2] = [['ygo'], now, 'published', 0, 'side/50', false];
  lockGm.cache.blogs['t:2'] = { name: 'side', posts: { 50: [['ygo'], now, 'published', 0, null, false] } };
  const lk = setupWindow('https://www.tumblr.com/mega-editor/published/me', MEGA, makeServer(), lockGm);
  fakeJQuery(lk.w);
  lk.w.eval(src);
  lk.w.eval(megaMain);
  await sleep(50);
  const lb = id => lk.w.document.getElementById('post_' + id);
  check(lb(2).classList.contains('tth-copy') && !lb(1).classList.contains('tth-copy'), 'mass editor: the reblog of my own post is marked');
  lb(2).click();
  check(!lb(2).classList.contains('highlighted'), 'mass editor: clicking it does not select it');
  lk.w.document.dispatchEvent(new lk.w.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
  check(lb(1).classList.contains('highlighted') && !lb(2).classList.contains('highlighted'), 'mass editor: Ctrl+A leaves it out');
  check(lk.errors.length === 0, 'no runtime errors with a locked tile' + (lk.errors.length ? ': ' + lk.errors.map(e => e.stack || e).join(' | ') : ''));

  // ===== Tag templates in the post editor =====
  const PACK = {
    format: 'tth-template-pack', id: 'test', name: 'Test pack', version: '1', base: ['fandom'],
    types: { romance: 'Romance', friendship: 'Friends', family: 'Family' },
    characters: [
      { id: 'a', name: 'Alice', group: 'Main', kw: ['ali'], tags: ['alice x', 'x alice', 'alice'] },
      { id: 'b', name: 'Bob', group: 'Main', tags: ['bob x'] },
      { id: 'c', name: 'Carol', group: 'Side', tags: ['carol x'] },
    ],
    relations: [
      { id: 'ab', members: ['a', 'b'], type: 'romance', kw: ['abshipping'], tags: ['abshipping'] },
      { id: 'ab-f', name: 'Alice & Bob', members: ['a', 'b'], type: 'friendship', tags: ['ab friends'] },
      { id: 'abc-fam', name: 'Family', members: ['a', 'b', 'c'], type: 'family', tags: [] },
    ],
    presets: [{ id: 'all', name: 'Everyone', members: ['a', 'b', 'c'], relations: ['ab'] }],
    sections: [{ id: 'fmt', name: 'Formats', kind: 'format', items: [{ id: 'art', name: 'My art', tags: ['my art'], base: false }] }],
  };
  const fresh = Date.now();
  const tg = preset();
  tg.cache.tagStats = {
    'alice x': { rate: 5, match: 90, at: fresh }, 'x alice': { rate: 2, match: 10, at: fresh }, alice: { rate: 0, match: null, at: fresh },
    'bob x': { rate: 1, match: 80, at: fresh }, abshipping: { rate: 9, match: 95, at: fresh }, fandom: { rate: 50, match: 99, at: fresh },
  };
  tg.packs = [{ raw: PACK, source: 'https://raw.githubusercontent.com/x/y/packs/test.json' }];
  const s3 = makeServer();
  const te = setupWindow('https://www.tumblr.com/new/text', '<!doctype html><body><div><div><div><input placeholder="#add tags"></div></div></div></body>', s3, tg);
  te.w.tumblr = { apiFetch: async () => ({ response: [] }) };
  te.w.fetchText = async () => ({ text: JSON.stringify({ ...PACK, version: '2' }) });
  const tin = te.w.document.querySelector('input');
  tin.getBoundingClientRect = () => ({ left: 100, right: 500, top: 600, bottom: 630, width: 400, height: 30 });
  const committed = [];
  // Like Tumblr's editor: Enter turns the text into a chip (span[role=button] > span[role=textbox] + remove button)
  tin.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    committed.push(tin.value);
    const chip = te.w.document.createElement('span');
    chip.setAttribute('role', 'button');
    chip.innerHTML = '<span><span role="textbox" contenteditable="true"></span><button aria-label="Remove tag"></button></span>';
    chip.querySelector('[role="textbox"]').textContent = tin.value;
    chip.querySelector('button').addEventListener('click', () => chip.remove());
    tin.before(chip);
    tin.value = '';
  });
  const chipTags = () => [...te.w.document.querySelectorAll('[role="button"] [role="textbox"]')].map(n => n.textContent);
  te.w.eval(src);
  await sleep(600);
  const troot = te.w.document.getElementById('tth-host').shadowRoot;
  const tbtn = troot.querySelector('.tp-btn');
  check(!tbtn.hidden, 'templates: ▦ button shown at the tags input');
  tbtn.click();
  const panel = troot.querySelector('.tp');
  const chipOf = id => panel.querySelector(`.tp-body [data-item="${id}"]`);
  check(!panel.hidden && chipOf('a') && chipOf('c') && chipOf('all'), 'templates: panel lists characters and presets');
  check(!chipOf('ab') && !chipOf('ab-f'), 'templates: relations are not listed while browsing');
  chipOf('a').click(); chipOf('b').click();
  const combo = () => [...panel.querySelectorAll('.tp-combo [data-item]')].map(n => n.dataset.item + (n.classList.contains('on') ? '*' : ''));
  check(combo().join() === 'ab,ab-f', 'templates: picking Alice and Bob offers romance and friendship: ' + combo());
  check(panel.querySelector('.tp-combo [data-item="ab"]').textContent.includes('Alice × Bob'), 'templates: an unnamed relation is named after its members');
  panel.querySelector('.tp-combo [data-item="ab"]').click();
  panel.querySelector('.tp-combo [data-item="ab-f"]').click();
  check(combo().join() === 'ab*,ab-f*', 'templates: several relations of one pair can be ticked: ' + combo());
  panel.querySelector('.tp-combo [data-item="ab-f"]').click();
  const prevTags = () => [...panel.querySelectorAll('.tp-prev .tp-t')].map(n => n.textContent.slice(1) + (n.classList.contains('off') ? '-' : n.classList.contains('flag') ? '?' : ''));
  check(prevTags().join() === 'fandom,alice x,bob x,abshipping,x alice?,alice?', 'templates: preview puts each character\'s best tag first; weak tags flagged but kept: ' + prevTags());
  panel.querySelector('.tp-prev [data-tag="x alice"]').click();
  check(prevTags().includes('x alice-'), 'templates: clicking a tag turns it off');
  panel.querySelector('.tp-prev [data-tag="x alice"]').click();
  check(prevTags().includes('x alice?'), 'templates: clicking again turns it back on');
  panel.querySelector('[data-tp="dropFlagged"]').click();
  check(prevTags().join() === 'fandom,alice x,bob x,abshipping,x alice-,alice-', 'templates: "turn off flagged" turns off only the flagged tags: ' + prevTags());
  panel.querySelector('[data-tp="copy"]').click();
  check(te.w.clip === 'fandom, alice x, bob x, abshipping', 'templates: copy gives the inserted order: ' + te.w.clip);
  panel.querySelector('[data-tp="insert"]').click();
  await sleep(1000);
  check(committed.join() === 'fandom,alice x,bob x,abshipping' && panel.hidden, 'templates: insert commits work, characters, relations in order: ' + committed);

  // A wrong pick: inserting again replaces what the panel inserted; a tag typed by hand stays
  tin.value = 'by hand';
  tin.dispatchEvent(new te.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  tbtn.click();
  check(panel.querySelector('[data-tp="insert"]').textContent === 'Update tags' && !!panel.querySelector('[data-tp="undo"]'), 'templates: after an insert the button says Update tags and Undo appears');
  check(prevTags().includes('alice x') && prevTags().includes('fandom'), 'templates: the preview still lists the tags it inserted');
  chipOf('b').click(); // Bob was a mistake
  panel.querySelector('[data-tp="insert"]').click();
  await sleep(1500);
  check(chipTags().join() === 'by hand,fandom,alice x', 'templates: update removes Bob and the relation, keeps the hand-typed tag: ' + chipTags());
  tbtn.click();
  panel.querySelector('[data-tp="undo"]').click();
  await sleep(800);
  check(chipTags().join() === 'by hand', 'templates: undo removes everything the panel inserted: ' + chipTags());

  // presets, a marker-only relation, saved combos, search
  tbtn.click();
  panel.querySelector('[data-tp="clear"]').click();
  check(!panel.querySelector('.tp-body .on'), 'templates: clear removes the picks');
  chipOf('all').click();
  check(['a', 'b', 'c'].every(id => chipOf(id).classList.contains('on')) && combo().includes('ab*') && combo().includes('abc-fam'), 'templates: a preset picks its members and relations: ' + combo());
  panel.querySelector('.tp-combo [data-item="abc-fam"]').click();
  check(combo().includes('abc-fam*') && !prevTags().some(x => x.startsWith('Family')), 'templates: a relation without tags only marks the type');
  te.w.prompt = () => 'ABC';
  panel.querySelector('[data-tp="fav"]').click();
  panel.querySelector('[data-tp="clear"]').click();
  panel.querySelector('[data-fav]').click();
  check(chipOf('c').classList.contains('on') && combo().includes('abc-fam*'), 'templates: a saved combo restores its picks');
  const q = panel.querySelector('.tp-q');
  q.value = 'shipping'; q.dispatchEvent(new te.w.Event('input'));
  check(!!chipOf('ab') && !chipOf('c'), 'templates: search also finds relations by kw');
  q.value = ''; q.dispatchEvent(new te.w.Event('input'));

  // packs: update from the source URL, install by paste, reject bad JSON
  panel.querySelector('[data-tp="manage"]').click();
  panel.querySelector('[data-tp="update"]').click();
  await sleep(50);
  check(tg.packs[0].raw.version === '2', 'templates: update re-reads the pack from its URL');
  panel.querySelector('.tp-paste').value = JSON.stringify({ ...PACK, id: 'second', name: 'Second' });
  panel.querySelector('[data-tp="installPaste"]').click();
  check(tg.packs.length === 2 && tg.templates.current === 'second', 'templates: paste installs a second pack');
  panel.querySelector('.tp-paste').value = '{"format":"nope"}';
  panel.querySelector('[data-tp="installPaste"]').click();
  check(troot.querySelector('.toast').textContent.includes('not a template pack'), 'templates: a bad pack is rejected with a message');

  // ===== Template pack upkeep: offtopic tags, review and apply =====
  // Every tag sampled and fresh, so nothing is refetched: carol (y) is mostly another fandom's,
  // alice x's posts often carry "alice art" (on topic) and "wrong art" (another fandom's)
  const f = (rate, co, sample = 10) => ({ rate, match: 90, notes: 1, followers: 10, posts: 100, trending: false, sample, co, at: Date.now() });
  const ustats = {
    fandom: f(50, [['fandom', 10]]), 'alice x': f(5, [['fandom', 9], ['alice art', 9], ['wrong art', 8]]),
    'x alice': f(4, [['fandom', 8]]), alice: f(3, [['fandom', 8]]), 'bob x': f(2, [['fandom', 8]]),
    'carol x': f(2, [['fandom', 7]]), 'carol (y)': f(9, [['other show', 10]]), abshipping: f(6, [['fandom', 9]]),
    'ab friends': f(1, [['fandom', 9]]), 'my art': f(40, [['fandom', 2]]),
    'alice art': f(1, [['fandom', 5]], 5), 'wrong art': f(1, [['other show', 5]], 5),
  };
  const UPACK = JSON.parse(JSON.stringify(PACK));
  UPACK.characters[2].tags = ['carol x', 'carol (y)'];
  const ug = preset();
  ug.cache.tagStats = ustats;
  ug.packs = [{ raw: UPACK, source: '' }];
  const ue = setupWindow('https://www.tumblr.com/new/text', '<!doctype html><body><div><div><div><input placeholder="#add tags"></div></div></div></body>', makeServer(), ug);
  ue.w.tumblr = { apiFetch: async () => ({ response: [] }) };
  ue.w.confirm = () => true;
  const uin = ue.w.document.querySelector('input');
  uin.getBoundingClientRect = () => ({ left: 100, right: 500, top: 600, bottom: 630, width: 400, height: 30 });
  ue.w.eval(src);
  await sleep(600);
  const uroot = ue.w.document.getElementById('tth-host').shadowRoot;
  uroot.querySelector('.tp-btn').click();
  const up = uroot.querySelector('.tp');
  up.querySelector('.tp-body [data-item="c"]').click();
  const uprev = () => [...up.querySelectorAll('.tp-prev .tp-t')].map(n => n.textContent.slice(1) + (n.classList.contains('off') ? '-' : ''));
  check(uprev().includes('carol (y)-') && uprev().includes('carol x'), 'upkeep: a tag mostly used by another fandom starts off: ' + uprev());
  check(up.querySelector('.tp-prev [data-tag="carol (y)"]').title.includes('another fandom'), 'upkeep: and says why');
  up.querySelector('[data-tp="manage"]').click();
  up.querySelector('[data-tp="review"]').click();
  await sleep(1500); // "other show" (co-occurring with carol (y)) is sampled first
  const rv = () => [...up.querySelectorAll('.tp-rv')].map(n => n.textContent.trim().split(' ')[0] + ' ' + n.textContent.trim().split(' ').slice(1, 2) + (n.querySelector('input').checked ? '*' : ''));
  const rvText = up.textContent;
  check(rvText.includes('#carol (y)') && up.querySelector('.tp-rv.bad input').checked, 'upkeep: review lists the offtopic tag for removal, ticked: ' + rv());
  check(rvText.includes('#alice art') && !rvText.includes('#wrong art'), 'upkeep: add suggestions skip tags of another fandom');
  const addBox = [...up.querySelectorAll('.tp-rv')].find(n => n.textContent.includes('#alice art')).querySelector('input');
  check(!addBox.checked, 'upkeep: add suggestions start unticked');
  addBox.checked = true; addBox.dispatchEvent(new ue.w.Event('change', { bubbles: true }));
  up.querySelector('[data-tp="applyReview"]').click();
  const saved = ug.packs[0];
  check(saved.edited && saved.raw.characters[2].tags.join() === 'carol x' && saved.raw.characters[0].tags.includes('alice art'),
    'upkeep: applying writes the ticked changes into the pack: ' + JSON.stringify(saved.raw.characters.map(c => c.tags)));
  check(ue.errors.length === 0, 'no runtime errors in pack upkeep' + (ue.errors.length ? ': ' + ue.errors.map(e => e.stack || e).join('\n') : ''));

  // straight against core: relative cold flags, spelling cut with many characters, 20/30 markers, old pack shape
  const core = new Function(fs.readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8') + ';return TTHCore;')();
  const cpack = core.parsePack(PACK);
  const cstats = { 'alice x': { rate: 5, followers: 900 }, 'x alice': { rate: 4, followers: 3 }, alice: { rate: 3, followers: 800 },
    'bob x': { rate: 1, followers: 1 }, 'carol x': { rate: 1, followers: 50 }, fandom: { rate: 50, followers: 5000 } };
  const crows = core.composeTemplate(cpack, { ids: ['a', 'b', 'c'], stats: cstats, rules: { coldPct: 34, manyAt: 9 } }).rows;
  const flag = tg => crows.find(r => r.tag === tg).flag;
  check(flag('x alice') === 'cold' && flag('bob x') === null && flag('carol x') === null && flag('alice') === null && crows.every(r => r.on),
    'templates: bottom 34% by heat is flagged cold, except the only tag of a character; nothing turned off: ' + crows.map(r => r.tag + ':' + r.flag));
  check(core.composeTemplate(cpack, { ids: ['a'], stats: { 'alice x': { rate: 1 }, alice: { rate: 9 } } }).rows.every(r => r.flag === null), 'templates: no relative cold flags with fewer than 3 samples');
  const many = core.composeTemplate(cpack, { ids: ['a', 'b', 'c'], stats: cstats, rules: { manyAt: 3, spellings: 2 } });
  check(many.rows.filter(r => r.item === 'a' && r.on).map(r => r.tag).join() === 'alice x,alice' && many.rows.find(r => r.tag === 'x alice').why === 'extra',
    'templates: with many characters each keeps its 2 hottest spellings');
  const old = core.parsePack({ format: 'tth-template-pack', id: 'old', relations: { romance: 'R' }, sections: [
    { id: 's', kind: 'char', items: [{ id: 'x', tags: ['x'] }, { id: 'y', tags: ['y'] }] },
    { id: 'r', kind: 'ship', items: [{ id: 'xy', tags: ['xy'], with: ['x', 'y'], rel: 'romance' }] }] });
  check(old.types.romance === 'R' && core.suggestCombos(old, ['x', 'y']).length === 1, 'templates: the older sections-only pack shape still loads');
  check(te.errors.length === 0, 'no runtime errors with templates' + (te.errors.length ? ': ' + te.errors.map(e => e.stack || e).join('\n') : ''));

  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(1); });
