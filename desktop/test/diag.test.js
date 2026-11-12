'use strict';
// The diagnostic log: secrets never written, long text cut, jobs and requests traced, one export file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeDiag, exportBundle, brief } = require('../src/service/diag');
const { createService } = require('../src/service/service');
const { makeFake } = require('./fake-tumblr');

test('brief: secrets redacted, bytes and long text shortened', () => {
  const b = brief({ token: 'abc', clientSecret: 's', code: '123', grant: 'g', key: 'k', aiKey: 'x', nested: { Authorization: 'Bearer z', ok: 'fine' }, bytes: Buffer.from('xyz'), text: 'a'.repeat(400) });
  assert.equal(b.token, '[redacted]');
  assert.equal(b.clientSecret, '[redacted]');
  assert.equal(b.code, '[redacted]');
  assert.equal(b.grant, '[redacted]');
  assert.equal(b.key, '[redacted]');
  assert.equal(b.aiKey, '[redacted]');
  assert.equal(b.nested.Authorization, '[redacted]');
  assert.equal(b.nested.ok, 'fine');
  assert.equal(b.bytes, '[bytes 3]');
  assert.ok(b.text.length < 330 && b.text.includes('…(+100)'));
});

test('diag: calls, job changes and notes go to the day file; export has them without secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-d-'));
  const diag = makeDiag(dir);
  const fake = makeFake({ blogs: [{ uuid: 't:a', name: 'a', primary: true }] });
  const svc = createService({ dataDir: dir, tumblr: fake, diag });
  diag.call('setApp', { clientId: 'id', clientSecret: 'very-secret' }, { ok: false, error: 'bad key', ms: 3 });
  diag.call('status', {}, { ok: true, ms: 1 }); // routine: not written
  svc.jobs.add('sync.blogs', { mode: 'inc' });
  await svc.jobs.drain(svc.ctx);
  diag.write('user.note', { note: 'the reply stayed on checking' });
  const [[name, text]] = diag.recent(1);
  assert.match(name, /^diag-\d{4}-\d\d-\d\d\.log$/);
  const lines = text.trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.some(l => l.kind === 'call.error' && l.method === 'setApp' && l.args.clientSecret === '[redacted]'));
  assert.ok(!lines.some(l => l.method === 'status'));
  assert.ok(lines.some(l => l.kind === 'job' && l.job === 'sync.blogs' && l.status === 'succeeded'));
  assert.ok(lines.some(l => l.kind === 'user.note'));
  const file = exportBundle(diag, { db: svc.db, info: { version: 't' }, note: 'hello' });
  const out = fs.readFileSync(file, 'utf8');
  assert.match(out, /Note: hello/);
  assert.match(out, /== capabilities ==/);
  assert.match(out, /the reply stayed on checking/);
  assert.ok(!out.includes('very-secret'));
  svc.db.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
});
