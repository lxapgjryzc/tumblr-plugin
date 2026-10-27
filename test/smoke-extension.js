// Smoke test for the Chrome extension's manager page, with fake chrome.storage and a fake Tumblr API
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ext = path.join(__dirname, '..', 'extension');
const read = f => fs.readFileSync(path.join(ext, f), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const now = Math.floor(Date.now() / 1000);

const store = {
  '1': { object_type: 'post', id_string: '1', state: 'published', tags: ['yuuto', 'yuuto%20%28arc%20v%29', 'ygo'], timestamp: now - 1000,
    content: [{ type: 'text', text: 'hello world' }], layout: [], note_count: 5, post_url: 'https://x/1', date: 'd' },
  '2': { object_type: 'post', id_string: '2', state: 'private', tags: ['ygo', 'rare tag'], timestamp: now - 2000, summary: '[image]',
    content: [{ type: 'image', media: [{ url: 'https://img/2', width: 400 }] }], layout: [], note_count: 0, date: 'd' },
};
const puts = [], created = [];
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const res = (status, body) => ({ ok: status < 400, status, statusText: String(status), json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  if (u.origin !== 'https://www.tumblr.com') return res(404, {});
  if (u.pathname === '/dashboard') return res(200, '<script>{"API_TOKEN":"tok","csrfToken":"csrf"}</script>');
  if (u.pathname.startsWith('/tagged/')) {
    // tag page header: followers decide popularity (ygo > yuuto > yuuto (arc v))
    const tag = decodeURIComponent(u.pathname.slice(8));
    const followers = { ygo: 50000, yuuto: 900, 'yuuto (arc v)': 178 }[tag] ?? 1000;
    return res(200, `<script>{"isTrending":${tag === 'ygo'},"followersCount":"${followers}","followersCountInt":${followers},"showFollowersCount":false,"postCountInt":1000}</script>`);
  }
  if (init.headers?.Authorization !== 'Bearer tok' || init.credentials !== 'include') return res(401, { meta: { msg: 'auth' } });
  const parts = u.pathname.split('/').map(decodeURIComponent); // '', 'api', 'v2', ...
  if (u.pathname === '/api/v2/user/info') return res(200, { response: { user: { blogs: [{ name: 'me', uuid: 't:1', primary: true }] } } });
  if (u.pathname === '/api/v2/tagged') {
    const tag = u.searchParams.get('tag');
    if (tag === 'yuuto (arc v)') return res(200, { response: Array.from({ length: 20 }, (_, i) => ({ id_string: 'y' + i, tags: i < 3 ? [tag] : ['yuuto', 'arc v'], timestamp: now - i * 60 })) });
    const spread = tag === 'yuuto' ? 3600 : 60; // yuuto is active but less busy than the rest
    return res(200, { response: Array.from({ length: 20 }, (_, i) => ({ id_string: 'h' + i, tags: [tag], timestamp: now - i * spread })) });
  }
  if (parts[3] === 'blog' && parts[5] === 'posts' && !parts[6] && init.method === 'POST') {
    const json = JSON.parse(init.body.get('json'));
    created.push({ json, files: [...init.body.keys()].filter(k => k !== 'json').map(k => [k, init.body.get(k).name]) });
    return res(201, { response: { id: 555, id_string: '555', state: json.state, display_text: 'Posted to me' } });
  }
  if (parts[3] === 'blog' && parts[5] === 'posts' && parts[6] && !['draft', 'queue'].includes(parts[6])) {
    const id = parts[6];
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      puts.push({ id, body });
      store[id].tags = body.tags ? body.tags.split(',') : [];
      store[id].state = body.state;
      return res(200, { response: { id } });
    }
    return res(200, { response: JSON.parse(JSON.stringify(store[id])) });
  }
  if (parts[3] === 'blog' && parts[5] === 'posts') {
    if (parts[6] === 'draft') return res(200, { response: { posts: [{ object_type: 'post', id_string: '9', state: 'draft', tags: [], content: [] }] } });
    const list = Object.values(store).map(p => JSON.parse(JSON.stringify(p)));
    list.splice(1, 0, { object_type: 'backfill_ad' });
    return res(200, { response: { posts: list, total_posts: 2 } });
  }
  return res(404, { meta: { msg: 'unexpected ' + u.pathname } });
}

const html = read('manager.html').replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
const dom = new JSDOM(html, { url: 'chrome-extension://abc/manager.html', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const errors = [];
w.addEventListener('error', e => errors.push(e.error || e.message));
process.on('unhandledRejection', e => errors.push(e));
const storage = { settings: { delay: 200, autoSync: false, lang: 'en' } };
w.chrome = {
  storage: { local: {
    get: async keys => Object.fromEntries(keys.filter(k => k in storage).map(k => [k, JSON.parse(JSON.stringify(storage[k]))])),
    set: async obj => { for (const [k, v] of Object.entries(obj)) storage[k] = JSON.parse(JSON.stringify(v)); },
  } },
};
w.fetch = fakeFetch;
w.confirm = () => true;
w.URL.createObjectURL = () => 'blob:x';
w.URL.revokeObjectURL = () => {};
w.HTMLElement.prototype.scrollIntoView = () => {};
// one evaluation: separate <script> tags share top-level const in browsers, separate eval calls don't
w.eval(read('core.js') + '\n' + read('manager.js'));

(async () => {
  await sleep(800);
  const d = w.document;
  const $ = id => d.getElementById(id);
  const act = a => d.querySelector(`[data-act="${a}"]`).click();
  const tab = n => d.querySelector(`.tab[data-tab="${n}"]`).click();
  const mouse = (el, type) => el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));

  check($('login').hidden, 'logged in (token read from /dashboard)');
  check($('blog').options.length === 1 && $('blog').options[0].textContent === 'me (main)', 'blog list loaded');
  check(d.querySelector('[data-tab="clean"]').textContent === 'Cleanup', 'English UI');
  check(![...d.querySelectorAll('#cats input')].some(c => c.checked), 'no community label pre-ticked');
  const cards = d.querySelectorAll('.post');
  check(cards.length === 2, 'posts auto-loaded, non-post entry filtered out: ' + cards.length);
  check(cards[0].querySelector('.tg').textContent.includes('#yuuto (arc v)'), 'encoded tag shown decoded');
  check(cards[0].querySelector('.sum').textContent === 'hello world' && cards[1].querySelector('img.thumb'), 'text summary and image thumbnail');

  mouse(cards[0], 'mousedown'); mouse(cards[1], 'mouseover'); mouse(w, 'mouseup');
  check($('selInfo').textContent.startsWith('2 selected'), 'drag selects two cards');
  const chips = () => [...$('selTags').querySelectorAll('.stag')];
  check(chips().some(c => c.textContent.startsWith('#ygo2/2')), 'selected-tags panel shows ygo 2/2');
  chips().find(c => c.textContent.includes('rare tag')).click();
  act('removeMarked');
  await sleep(1200);
  check(puts.length === 1 && puts[0].id === '2' && puts[0].body.tags === 'ygo' && puts[0].body.state === 'private', 'removed marked tag from post 2 only');
  chips().find(c => c.textContent.startsWith('#yuuto1/2')).querySelector('[data-fill]').click();
  await sleep(1200);
  check(puts.length === 2 && puts[1].id === '2' && puts[1].body.tags === 'ygo,yuuto', 'fill adds yuuto to post 2 only, other tags untouched');

  act('setPublic');
  await sleep(1200);
  check(puts.length === 3 && puts[2].id === '2' && puts[2].body.state === 'published', 'make public edits only the private post');

  d.querySelector('#box [data-box="draft"]').click();
  await sleep(500);
  check(d.querySelectorAll('.post').length === 1 && d.querySelector('.post .st').textContent === 'Draft', 'drafts box loads drafts');
  d.querySelector('#box [data-box=""]').click();
  await sleep(500);

  tab('lib');
  act('syncFull');
  await sleep(1200);
  check(/Sync finished/.test($('syncStatus').textContent), 'sync: ' + $('syncStatus').textContent);
  check($('lib').textContent.includes('#ygo'), 'library lists tags');

  tab('clean');
  act('cleanScan');
  await sleep(2500);
  const found = [...$('cleanList').querySelectorAll('.n')].map(n => n.textContent);
  check(found.includes('#yuuto (arc v)') && !found.includes('#ygo') && !found.includes('#yuuto'), 'cleanup flags only the relatively cold, fuzzy-search tag: ' + found.join(', '));
  check($('cleanList').textContent.includes('rank 3 / 3') && $('cleanList').textContent.includes('178 followers') && /bottom 20% of all my tags/.test($('cleanRules').textContent), 'cleanup shows why, rank and followers, and the shared rules: ' + $('cleanList').textContent.replace(/\s+/g, ' '));
  check(storage.cache.tagStats.ygo.followers === 50000 && storage.cache.tagStats.ygo.trending === true, 'tag page header parsed into tagStats');
  const box = [...$('cleanList').querySelectorAll('input')].find(c => c.dataset.k === 'yuuto (arc v)');
  box.checked = true;
  box.dispatchEvent(new w.Event('change', { bubbles: true }));
  act('cleanRemove');
  await sleep(1200);
  const last = puts[puts.length - 1];
  check(last.id === '1' && last.body.tags === 'yuuto,ygo', 'cleanup removed the encoded tag from post 1: ' + last.body.tags);

  // Sort tags by popularity on post 1 (now yuuto, ygo); samples are cached from the cleanup scan
  tab('posts');
  act('selNone');
  mouse(d.querySelectorAll('.post')[0], 'mousedown'); mouse(w, 'mouseup');
  const n0 = puts.length;
  act('sortHeat');
  await sleep(1500);
  check(puts.length === n0 + 1 && puts[n0].id === '1' && puts[n0].body.tags === 'ygo,yuuto', 'sort by popularity: ' + JSON.stringify(puts.slice(n0).map(p => p.body.tags)));
  check(d.querySelectorAll('.post')[0].querySelector('.tg').textContent.startsWith('#ygo #yuuto'), 'card shows the new order');

  // Packs: install by paste, then upkeep replaces the retired spelling 'yuuto' on both posts, in place
  tab('packs');
  $('packPaste').value = JSON.stringify({ format: 'tth-template-pack', id: 't', name: 'Test pack', base: ['ygo'],
    characters: [{ id: 'yuto', name: 'Yuto', tags: ['yuto arc v'], retired: ['yuuto'] }] });
  act('packInstallPaste');
  await sleep(100);
  check($('packList').textContent.includes('Test pack') && storage.packs?.length === 1, 'pack installed from pasted JSON and saved');
  act('upkScan');
  const rules = [...$('upkList').querySelectorAll('input[data-rule]')];
  check(rules.length === 1 && rules[0].checked && $('upkList').textContent.includes('#yuuto → #yuto arc v') && /2 post/.test($('upkStatus').textContent),
    'upkeep scan lists one ticked rule on 2 posts: ' + $('upkList').textContent.replace(/\s+/g, ' '));
  const n1 = puts.length;
  act('upkApply');
  await sleep(1500);
  check(puts.length === n1 + 2 && puts.slice(n1).every(p => p.body.tags === 'ygo,yuto arc v'), 'upkeep replaced the old spelling in place: ' + JSON.stringify(puts.slice(n1).map(p => p.body.tags)));
  check(/All your posts are already in line/.test($('upkStatus').textContent), 'rescan finds nothing left');

  // Edit by template on the posts page: Yuto is on both selected posts; untick him, apply, then add him back
  tab('posts');
  act('selAll');
  const tplChip = () => $('tplItems').querySelector('[data-item="yuto"]');
  check(!$('tplCard').hidden && tplChip()?.classList.contains('on') && tplChip().textContent.includes('2/2'), 'edit by template: Yuto is on 2/2 selected posts');
  tplChip().click();
  check(tplChip().classList.contains('off') && /2 of 2 posts will change/.test($('tplPlan').textContent), 'edit by template: unticking plans to change both posts: ' + $('tplPlan').textContent);
  const n2 = puts.length;
  act('tplApply');
  await sleep(1500);
  check(puts.length === n2 + 2 && puts.slice(n2).every(p => p.body.tags === 'ygo'), 'edit by template: Yuto taken off both posts: ' + JSON.stringify(puts.slice(n2).map(p => p.body.tags)));
  $('tplAdd').value = 'yut';
  $('tplAdd').dispatchEvent(new w.Event('input'));
  $('tplFound').querySelector('[data-add="yuto"]').click();
  const n3 = puts.length;
  act('tplApply');
  await sleep(1500);
  check(puts.length === n3 + 2 && puts.slice(n3).every(p => p.body.tags === 'ygo,yuto arc v'), 'edit by template: Yuto added back from the search box: ' + JSON.stringify(puts.slice(n3).map(p => p.body.tags)));

  tab('settings');
  $('lang').value = 'zh';
  $('lang').dispatchEvent(new w.Event('change'));
  check(d.querySelector('[data-tab="clean"]').textContent === '清理' && storage.settings.lang === 'zh', 'switch to Chinese and saved');
  check([...$('lang').options].length === 3, 'language list is auto + en + zh');
  check(storage.cache && Object.keys(storage.cache.blogs).length === 1, 'cache saved to chrome.storage');

  await sleep(100);
  check(errors.length === 0, 'no runtime errors' + (errors.length ? ': ' + errors.map(e => e?.stack || e).join('\n') : ''));
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(1); });
