// Smoke test for reblogs between my own blogs in the extension: a main blog and a side blog, a fake Tumblr API
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ext = path.join(__dirname, '..', 'extension');
const read = f => fs.readFileSync(path.join(ext, f), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const now = Math.floor(Date.now() / 1000);

// side/10 is an original that main/20 reblogged; side/11 is an original main hasn't reblogged; main/21 is main's own
const post = (id, tags, extra = {}) => ({ object_type: 'post', id_string: id, state: 'published', tags, timestamp: now - +id, content: [{ type: 'text', text: 'post ' + id }], layout: [], reblog_key: 'rk' + id, ...extra });
const store = {
  't:m': { 20: post('20', [], { trail: [{ blog: { name: 'side' }, post: { id: '10' }, content: [] }] }), 21: post('21', ['x']) },
  't:s': { 10: post('10', ['arc v', 'yuto arc v']), 11: post('11', ['arc v']) },
};
const names = { 't:m': 'main', 't:s': 'side', main: 't:m', side: 't:s' };
const puts = [], posts = [];
let nextId = 100;
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const res = (status, body) => ({ ok: status < 400, status, statusText: String(status), json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  if (u.pathname === '/dashboard') return res(200, '<script>{"API_TOKEN":"tok","csrfToken":"csrf"}</script>');
  const parts = u.pathname.split('/').map(decodeURIComponent); // '', 'api', 'v2', 'blog', blog, 'posts', id
  if (u.pathname === '/api/v2/user/info') return res(200, { response: { user: { blogs: [{ name: 'main', uuid: 't:m', primary: true }, { name: 'side', uuid: 't:s' }] } } });
  if (parts[3] !== 'blog') return res(404, {});
  const blog = names[parts[4]]?.startsWith('t:') ? names[parts[4]] : parts[4];
  if (parts[5] === 'posts' && parts[6] && !['draft', 'queue'].includes(parts[6])) {
    const p = store[blog][parts[6]];
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      puts.push({ blog, id: parts[6], body });
      p.tags = body.tags ? body.tags.split(',') : [];
      p.state = body.state;
      return res(200, { response: { id: parts[6] } });
    }
    return res(200, { response: JSON.parse(JSON.stringify(p)) });
  }
  if (parts[5] === 'posts' && init.method === 'POST') {
    const id = String(nextId++);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : JSON.parse(init.body.get('json'));
    posts.push({ blog, id, body, multipart: typeof init.body !== 'string' });
    store[blog][id] = post(id, body.tags ? body.tags.split(',') : [], { state: body.state,
      ...(body.parent_post_id ? { trail: [{ blog: { name: names[body.parent_tumblelog_uuid] }, post: { id: body.parent_post_id }, content: [] }] } : {}) });
    return res(201, { response: { id: +id, id_string: id, state: body.state } });
  }
  if (parts[5] === 'posts') {
    if (parts[6]) return res(200, { response: { posts: [] } });
    return res(200, { response: { posts: Object.values(store[blog]).map(p => JSON.parse(JSON.stringify(p))), total_posts: Object.keys(store[blog]).length } });
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
w.chrome = { storage: { local: {
  get: async keys => Object.fromEntries(keys.filter(k => k in storage).map(k => [k, JSON.parse(JSON.stringify(storage[k]))])),
  set: async obj => { for (const [k, v] of Object.entries(obj)) storage[k] = JSON.parse(JSON.stringify(v)); },
} } };
w.fetch = fakeFetch;
w.confirm = () => true;
w.URL.createObjectURL = () => 'blob:x';
w.URL.revokeObjectURL = () => {};
w.HTMLElement.prototype.scrollIntoView = () => {};
w.eval(read('core.js') + '\n' + read('manager.js'));

(async () => {
  await sleep(800);
  const d = w.document;
  const $ = id => d.getElementById(id);
  const act = a => d.querySelector(`[data-act="${a}"]`).click();
  const tab = n => d.querySelector(`.tab[data-tab="${n}"]`).click();
  const mouse = (el, type) => el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));

  // The main blog: post 20 is a reblog of side/10, so it is marked and can't be selected
  const card20 = () => [...d.querySelectorAll('.post')].find(c => c.querySelector('.sum').textContent === 'post 20');
  check(card20()?.classList.contains('copy') && /Synced/.test(card20().textContent), 'a reblog of my own post is marked as synced');
  mouse(card20(), 'mousedown'); mouse(w, 'mouseup');
  check(!card20().classList.contains('sel') && $('selInfo').textContent.startsWith('0 selected'), 'it cannot be selected');
  act('selAll');
  check($('selInfo').textContent.startsWith('1 selected'), 'select all leaves it out: ' + $('selInfo').textContent);
  act('selNone');

  // Sync the library so the cache knows the reblog links
  tab('lib');
  act('syncFull');
  await sleep(1500);
  check(storage.cache.blogs['t:m'].posts['20'][4] === 'side/10', 'the synced cache keeps the reblog source');

  // Editing the original on the side blog also edits main's reblog
  tab('posts');
  $('blog').value = 't:s';
  $('blog').dispatchEvent(new w.Event('change'));
  await sleep(600);
  const card10 = [...d.querySelectorAll('.post')].find(c => c.querySelector('.sum').textContent === 'post 10');
  mouse(card10, 'mousedown'); mouse(w, 'mouseup');
  const bt = $('batchTags').querySelector('input');
  bt.value = 'new tag';
  bt.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  act('tagsAdd');
  await sleep(2000);
  check(puts.length === 2 && puts[0].blog === 't:s' && puts[1].blog === 't:m' && puts[1].id === '20' && puts[1].body.tags === 'arc v,yuto arc v,new tag',
    'adding a tag to the original gives main\'s reblog the same tags: ' + JSON.stringify(puts.map(p => [p.blog, p.id, p.body.tags])));
  check(/the same change went to 1 post/.test($('log').textContent), 'the log says the reblog was synced');

  // Reblogs page: check finds side/11 not reblogged on main; reblog it into main's queue
  tab('reblogs');
  act('rbScan');
  check(/0 reblog\(s\) differ.*1 post\(s\) not on the main blog/.test($('rbStatus').textContent) && $('rbList').textContent.includes('side/11'),
    'check reblogs lists the side-blog post main has not reblogged: ' + $('rbStatus').textContent);
  $('rbWhen').value = 'queue';
  act('rbReblog');
  await sleep(1200);
  const rbl = posts[0];
  check(rbl && rbl.blog === 't:m' && rbl.body.parent_post_id === '11' && rbl.body.parent_tumblelog_uuid === 't:s' && rbl.body.reblog_key === 'rk11' && rbl.body.state === 'queue' && rbl.body.tags === 'arc v',
    'it is reblogged to main\'s queue with the same tags: ' + JSON.stringify(rbl?.body));
  check(/0 post\(s\) not on the main blog/.test($('rbStatus').textContent), 'after that nothing is missing');

  await sleep(100);
  check(errors.length === 0, 'no runtime errors' + (errors.length ? ': ' + errors.map(e => e?.stack || e).join('\n') : ''));
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(1); });
