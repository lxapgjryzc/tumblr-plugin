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
    { uuid: 't:demo-cfg', name: 'demo-studiosettings', title: 'Studio settings' },
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
  // fans & interactions: made-up followers and activity
  const fans = ['demo-rain', 'demo-kite', 'demo-boat', 'demo-tree', 'demo-moss', 'demo-lark'];
  fake.followerMap.set('t:demo-main', fans.slice(0, 5).map(name => ({ name, updated: 0 })));
  fake.followerMap.set('t:demo-art', [{ name: 'demo-kite', updated: 0 }, { name: 'demo-lark', updated: 0 }]);
  fans.forEach((name, i) => fake.infos.set(name, { uuid: 't:fan' + i }));
  const target = fake.addPost('t:demo-main', { timestamp: ts(1), tags: ['lighting study'], content: [img(40, 'light'), { type: 'text', text: 'Lighting study' }] });
  const n = (d, type, i, extra = {}) => ({ id: 'n' + d + type + i, type, timestamp: Math.floor((now - d * 3600e3) / 1000), target_tumblelog_uuid: 't:demo-main',
    from_tumblelog_uuid: 't:fan' + i, from_tumblelog_name: fans[i], target_post_id: target.id_string, target_post_summary: 'Lighting study', ...extra });
  // the discussion under it (replies are read through the browser in real use)
  fake.replyStore.set(target.id_string, [{ id: 'r1', uuid: 't:fan0', name: 'demo-rain', text: 'The light here is lovely, which brush did you use?', at: now - 2 * 3600e3, children: [] }]);
  // a post with blocks the editor keeps as they are (a mention, a video) next to a row of two images
  fake.addPost('t:demo-art', { timestamp: ts(2), tags: ['original', 'example series'], content: [
    { type: 'text', text: 'Two colour roughs for the cover' }, img(300, 'A'), img(330, 'B'),
    { type: 'text', text: 'Thanks @demo-kite for the idea', formatting: [{ type: 'mention', start: 7, end: 17, blog: { uuid: 't:fan1', name: 'demo-kite' } }] },
    { type: 'video', provider: 'youtube', url: 'https://www.youtube.com/watch?v=demo' }],
  layout: [{ type: 'rows', display: [{ blocks: [0] }, { blocks: [1, 2] }, { blocks: [3] }, { blocks: [4] }] }] });
  fake.notifs.set('t:demo-main', [
    n(2, 'reply', 0, { reply_text: 'The light here is lovely, which brush did you use?' }),
    n(3, 'reblog_naked', 1, { post_tags: ['that expression', 'want the process'], post_id: '777' }),
    n(5, 'mention_in_post', 2, { reply_text: 'Inviting you to this month’s drawing event!' }),
    n(6, 'like', 3), n(7, 'like', 4), n(30, 'reblog', 0, { added_text: 'saving this for later practice', post_id: '778' }),
    n(50, 'follower', 5, { target_post_id: '' }),
  ]);
  // likes from made-up artists (Materials: collecting likes), newest first
  for (let i = 0; i < 72; i++) {
    const p = fake.addPost('t:like' + i, { blog: { uuid: 't:like' + i, name: 'demo-artist-' + i }, timestamp: ts(10 + i), tags: ['painting'],
      content: i % 9 === 4 ? [{ type: 'text', text: 'A thought about colour' }] : [img((i * 23) % 360, 'like ' + i)] });
    fake.likes.push({ ...JSON.parse(JSON.stringify(p)), liked_timestamp: ts(i / 4) });
  }
  return fake;
}

module.exports = { demoFake };
