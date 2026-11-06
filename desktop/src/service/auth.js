'use strict';
// Tumblr OAuth2 credentials: the user's own app (client id + secret) and the token pair.
// The record is encrypted by a vault (Electron safeStorage = DPAPI on Windows) and replaced atomically on disk.
// Tumblr rotates the refresh token on every refresh, so exactly one refresh runs at a time and its result is
// committed before anything uses the new access token. If that commit fails, dependent work stops.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { safeJson, AuthError, NetError } = require('./errors');

const AUTHORIZE = 'https://www.tumblr.com/oauth2/authorize';
const TOKEN = 'https://api.tumblr.com/v2/oauth2/token';
const SCOPES = 'basic write offline_access';
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

class Credentials {
  // vault: { encrypt(string) -> Buffer, decrypt(Buffer) -> string }
  constructor(file, vault, { fetchFn = fetch, now = Date.now } = {}) {
    this.file = file; this.vault = vault; this.fetch = fetchFn; this.now = now;
    this.rec = null; this.refreshing = null; this.listeners = new Set();
    this.load();
  }
  load() {
    try { this.rec = JSON.parse(this.vault.decrypt(fs.readFileSync(this.file))); }
    catch { this.rec = null; }
    return this.rec;
  }
  save(rec) {
    writeAtomic(this.file, this.vault.encrypt(JSON.stringify(rec)));
    this.rec = rec;
    for (const f of this.listeners) try { f(this.status()); } catch {}
  }
  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  hasApp() { return !!(this.rec?.client_id && this.rec?.client_secret); }
  status() {
    if (!this.hasApp()) return 'no_app';
    if (!this.rec.refresh_token && !this.rec.access_token) return 'not_connected';
    if (this.rec.revoked) return 'reconnect';
    return 'connected';
  }
  setApp(client_id, client_secret) {
    this.save({ client_id: client_id.trim(), client_secret: client_secret.trim(), generation: 0 });
  }
  clientId() { return this.rec?.client_id; }
  forget() { try { fs.unlinkSync(this.file); } catch {} this.rec = null; }

  async tokenRequest(params) {
    let res, text;
    try {
      res = await this.fetch(TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(params),
      });
      text = await res.text();
    } catch (e) { throw new NetError('token request: ' + e.message, { uncertain: true }); }
    const j = safeJson(text);
    if (!res.ok || !j?.access_token) {
      if (res.status >= 500) throw new NetError('token endpoint ' + res.status);
      throw new AuthError(j?.error_description || j?.error || 'token request refused (' + res.status + ')');
    }
    return j;
  }
  commit(j) {
    const rec = { ...this.rec, access_token: j.access_token, expires_at: this.now() + (Number(j.expires_in) || 0) * 1000,
      scope: j.scope ?? this.rec.scope, generation: (this.rec.generation || 0) + 1, revoked: false };
    if (j.refresh_token) rec.refresh_token = j.refresh_token;
    this.save(rec); // throws if the disk write fails: callers must not use the new token then
  }

  // Valid access token, refreshing first when it is about to expire
  async accessToken(force = false) {
    if (!this.hasApp() || this.rec.revoked || !(this.rec.refresh_token || this.rec.access_token)) throw new AuthError('not connected');
    if (!force && this.rec.access_token && this.now() < (this.rec.expires_at || 0) - 60_000) return this.rec.access_token;
    if (!this.refreshing) {
      const gen = this.rec.generation;
      this.refreshing = (async () => {
        if (this.rec.generation !== gen) return; // someone else already refreshed
        if (!this.rec.refresh_token) throw new AuthError('no refresh token');
        try {
          const j = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.rec.refresh_token,
            client_id: this.rec.client_id, client_secret: this.rec.client_secret });
          this.commit(j);
        } catch (e) {
          // A refused refresh token is final: the user has to reconnect. A lost response may have consumed the
          // token on the server; the next attempt finds out (and asks to reconnect if it was consumed).
          if (e instanceof AuthError) this.save({ ...this.rec, revoked: true });
          throw e;
        }
      })().finally(() => { this.refreshing = null; });
    }
    await this.refreshing;
    return this.rec.access_token;
  }

  // Interactive authorisation through the loopback redirect. openUrl opens the system browser.
  authorize(openUrl, { timeoutMs = 600_000 } = {}) {
    if (!this.hasApp()) return Promise.reject(new AuthError('no app credentials'));
    const st = crypto.randomBytes(16).toString('hex');
    const url = AUTHORIZE + '?' + new URLSearchParams({ client_id: this.rec.client_id, response_type: 'code', scope: SCOPES, state: st, redirect_uri: REDIRECT });
    return new Promise((resolve, reject) => {
      let finished = false;
      const end = (err) => { if (finished) return; finished = true; clearTimeout(timer); server.close(); err ? reject(err) : resolve(); };
      const timer = setTimeout(() => end(new AuthError('no answer within 10 minutes')), timeoutMs);
      const server = http.createServer(async (req, res) => {
        const u = new URL(req.url, REDIRECT);
        if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
        const page = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">${msg}</body>`); };
        try {
          if (u.searchParams.get('state') !== st) throw new AuthError('state mismatch');
          if (u.searchParams.get('error')) throw new AuthError('refused: ' + u.searchParams.get('error'));
          const j = await this.tokenRequest({ grant_type: 'authorization_code', code: u.searchParams.get('code'),
            client_id: this.rec.client_id, client_secret: this.rec.client_secret, redirect_uri: REDIRECT });
          this.commit(j);
          page(200, 'Tumblr Studio is connected. You can close this tab. / 已连接，可以关闭此页面。');
          end();
        } catch (e) {
          page(400, 'Failed / 失败: ' + String(e.message).replace(/[<&]/g, ''));
          end(e);
        }
      });
      server.on('error', e => end(e));
      server.listen(PORT, '127.0.0.1', () => openUrl(url));
    });
  }
}

module.exports = { Credentials, writeAtomic, REDIRECT, SCOPES };
