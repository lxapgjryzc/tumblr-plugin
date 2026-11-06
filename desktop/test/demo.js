'use strict';
// Demo account for screenshots and manual UI checks (STUDIO_FAKE=1). Everything here is made up.
const { makeFake } = require('./fake-tumblr');

const DAY = 86400e3;
const svg = (hue, label) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,72%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},60%,45%)"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><text x="24" y="370" font-family="sans-serif" font-size="34" fill="white" opacity=".85">${label}</text></svg>`);
const img = (hue, label) => ({ type: 'image', media: [{ url: svg(hue, label), width: 400, height: 400, type: 'image/svg+xml' }] });

function demoFake() {
  const fake = makeFake({ blogs: [
    { uuid: 't:demo-main', name: 'demo-main', title: 'Main blog', primary: true },
    { uuid: 't:demo-art', name: 'demo-art', title: 'Art side blog' },
    { uuid: 't:demo-sketch', name: 'demo-sketch', title: 'Sketchbook' },
    { uuid: 't:demo-ref', name: 'demo-ref', title: 'References' },
  ] });
  const now = Date.now();
  const ts = d => Math.floor((now - d * DAY) / 1000);
  let hue = 10;
  const art = (blog, d, tags, extra = {}) => fake.addPost(blog, { timestamp: ts(d), tags, note_count: Math.floor(Math.random() * 300), content: [img(hue += 37, tags[0] || ''), { type: 'text', text: 'Process notes for ' + (tags[1] || 'a piece') }], ...extra });
  // side originals, reblogged to main
  for (let i = 0; i < 8; i++) {
    const p = art('t:demo-art', 3 + i * 9, ['fanart', 'example series', 'character alpha']);
    fake.reblog('t:demo-main', { parentBlog: 't:demo-art', parentId: p.id_string, reblogKey: p.reblog_key, tags: p.tags });
  }
  // main originals filed into the side blog
  for (let i = 0; i < 4; i++) {
    const p = art('t:demo-main', 20 + i * 25, ['fanart', 'example series', 'alpha beta']);
    fake.reblog('t:demo-art', { parentBlog: 't:demo-main', parentId: p.id_string, reblogKey: p.reblog_key, tags: p.tags });
  }
  // diary entries (text) and old posts
  for (let i = 0; i < 6; i++) fake.addPost('t:demo-main', { timestamp: ts(5 + i * 40), tags: ['diary'], content: [{ type: 'text', text: ['Drew for two hours today, finally fixed the hands.', '今天画了两个小时，终于把手画对了。', 'Trying a new brush set — notes below.', '练习：透视和光影。', 'A quiet week. Small sketches only.', 'Colour studies from the weekend.'][i] }] });
  for (let i = 0; i < 5; i++) art('t:demo-sketch', 40 + i * 60, ['sketch', 'original'], { state: i === 4 ? 'private' : 'published' });
  for (let i = 0; i < 6; i++) fake.addPost('t:demo-ref', { timestamp: ts(2 + i * 3), tags: ['ref', 'lighting'], content: [], trail: [{ blog: { uuid: 't:other', name: 'someone' }, post: { id: String(9000 + i) }, content: [img(200 + i * 20, 'ref')] }], parent_tumblelog_uuid: 't:other', parent_post_id: String(9000 + i) });
  fake.addPost('t:demo-art', { state: 'draft', timestamp: 0, tags: ['wip'], content: [{ type: 'text', text: 'Work in progress' }] });
  return fake;
}

module.exports = { demoFake };
