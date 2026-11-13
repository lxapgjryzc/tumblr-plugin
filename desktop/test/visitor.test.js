'use strict';
// Visitor checks (design public_check): observed separately from the owner state, after a delay, with retries
// while the public view settles; a failed check is "unknown", never "hidden". All blogs and ids are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service/service');
const { makeApi } = require('../src/service/api');
const { addVisitor, WAITS } = require('../src/service/visitor');
const { makeFake } = require('./fake-tumblr');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pc-'));
  const clock = { t: Date.UTC(2026, 10, 1) };
  const fake = makeFake({ blogs: [{ uuid: 't:main', name: 'mainblog', primary: true }], now: () => clock.t });
  const svc = createService({ dataDir: dir, tumblr: fake, now: () => clock.t });
  const extra = {};
  addVisitor(svc, extra);
  const api = makeApi(svc, { extra });
  const drain = async (step = 70e3, n = 30) => { for (let i = 0; i < n; i++) { await svc.jobs.drain(svc.ctx); clock.t += step; } };
  return { fake, svc, api, db: svc.db, clock, drain };
}
const check = s => s.db.get('SELECT state, expect, checked_at, route FROM public_checks LIMIT 1');

test('visitor check: pending after the edit, then what a visitor saw; an unsettled view is looked at again', async () => {
  const s = setup();
  const p = s.fake.addPost('t:main', { content: [{ type: 'text', text: 'x' }] });
  s.svc.pass(); await s.drain();
  s.fake.visitorLag[p.id_string] = 1; // the public view still shows it once after hiding
  s.api.visibility({ targets: [{ blog: 't:main', id: p.id_string }], target: 'private' });
  await s.drain(2000, 6); // the owner state is verified; the visitor check waits
  assert.equal(s.fake.posts.get(p.id_string).state, 'private');
  assert.equal(check(s).state, 'pending', 'owner state confirmed, visitor view not checked yet');
  await s.drain(WAITS[0] / 2, 4);
  assert.equal(check(s).state, 'visible', 'first look: still visible (not settled)');
  await s.drain(WAITS[1] / 2, 6);
  assert.equal(check(s).state, 'not_visible_at_check');
  assert.equal(check(s).expect, 'hidden');
  assert.ok(check(s).checked_at && /no login/.test(check(s).route));
});

test('visitor check: an error is unknown, never proof of being hidden', async () => {
  const s = setup();
  const p = s.fake.addPost('t:main', { content: [{ type: 'text', text: 'x' }] });
  s.svc.pass(); await s.drain();
  s.fake.visitorFails = true;
  s.api.publicCheckNow({ blog: 't:main', id: p.id_string });
  await s.drain(2000, 4);
  assert.equal(check(s).state, 'unknown');
});
