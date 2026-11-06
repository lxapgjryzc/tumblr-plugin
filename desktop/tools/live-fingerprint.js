'use strict';
// One-off live check for REBLOG_POLICY version tracking: does a tags-only edit leave the content fingerprint
// (posts.contentFingerprint) unchanged? Adds a temporary tag to one PRIVATE original, reads it back, restores the
// original tags and reads again. Run with the app closed:  npx electron tools/live-fingerprint.js [blog] [id]
const { app, safeStorage } = require('electron');
const path = require('node:path');
app.setPath('userData', path.join(app.getPath('appData'), 'tumblr-studio'));
const { Credentials } = require('../src/service/auth');
const { makeTumblr } = require('../src/service/tumblr');
const { openDb } = require('../src/service/db');
const { editBody, contentFingerprint } = require('../src/service/posts');

const TEMP = 'tth fingerprint check';
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const dataDir = path.join(app.getPath('appData'), 'Tumblr Studio');
  const out = { steps: [] };
  try {
    const creds = new Credentials(path.join(dataDir, 'credentials.bin'), { encrypt: s => safeStorage.encryptString(s), decrypt: b => safeStorage.decryptString(b) });
    const tumblr = makeTumblr({ creds });
    let [blog, id] = process.argv.slice(2).filter(a => !a.startsWith('-') && !a.endsWith('.js'));
    if (!blog) {
      const db = openDb(path.join(dataDir, 'studio.db'));
      const row = db.get(`SELECT p.blog, p.id FROM posts p JOIN blogs b ON b.uuid = p.blog WHERE p.kind = 'original' AND p.state = 'private' AND p.legacy = 0 AND b.role = 'share' ORDER BY p.published_at DESC LIMIT 1`);
      db.close();
      if (!row) throw new Error('no private original found');
      ({ blog, id } = row);
    }
    out.post = { blog, id };
    const p1 = await tumblr.getPost(blog, id);
    if (p1.state !== 'private' || p1.parent_post_id || (p1.trail || []).length) throw new Error('not a private original: ' + p1.state);
    const tags = (p1.tags || []).slice();
    out.tags = tags;
    const fp1 = contentFingerprint(p1.content, p1.layout), raw1 = JSON.stringify([p1.content, p1.layout]);
    out.steps.push({ read: 'before', fp: fp1 });
    await tumblr.putPost(blog, id, editBody(p1, { tags: [...tags, TEMP] }));
    let p2;
    for (let i = 0; i < 10; i++) { await sleep(3000); p2 = await tumblr.getPost(blog, id); if ((p2.tags || []).includes(TEMP)) break; }
    out.steps.push({ read: 'after tag edit', fp: contentFingerprint(p2.content, p2.layout), rawSame: JSON.stringify([p2.content, p2.layout]) === raw1, tags: p2.tags, state: p2.state });
    await tumblr.putPost(blog, id, editBody(p2, { tags }));
    let p3;
    for (let i = 0; i < 10; i++) { await sleep(3000); p3 = await tumblr.getPost(blog, id); if (!(p3.tags || []).includes(TEMP)) break; }
    out.steps.push({ read: 'after restore', fp: contentFingerprint(p3.content, p3.layout), rawSame: JSON.stringify([p3.content, p3.layout]) === raw1, tags: p3.tags, state: p3.state });
    out.fingerprintStable = out.steps.every(s => s.fp === fp1);
    out.restored = JSON.stringify(p3.tags) === JSON.stringify(tags) && p3.state === 'private';
    if (!out.fingerprintStable) out.diff = { before: raw1.slice(0, 3000), after: JSON.stringify([p2.content, p2.layout]).slice(0, 3000) };
  } catch (e) { out.error = String(e.stack || e); }
  console.log(JSON.stringify(out, null, 2));
  app.exit(0);
});
