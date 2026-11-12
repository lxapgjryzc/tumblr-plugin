'use strict';
// Browser relay: while the paired browser companion is connected, a fixed set of Tumblr API requests is sent
// through the browser's own tumblr.com session instead of the app's OAuth key. The official API gives a new app
// 1000 requests an hour; the web session has no such app quota, so bulk edits and passes stop running into it.
//
// The app still owns everything: jobs, payloads, verification and records stay here. The extension only carries
// out one validated request at a time (design 4.3: a browser-only adapter for an app-owned operation) and reports
// the raw answer. Anything it can't do (not connected, another account logged in, the web session limited or
// signed out) falls back to the official API for that request, so the official budget stays the backstop.
//
// Transport: the extension long-polls the bridge (/relay/next) and answers with /relay/done. Pure module, no
// sockets, so it can be tested.

const crypto = require('node:crypto');

// What may go through the browser: reads and full-post edits of the account's own posts, follower lists,
// the account's likes (material scans), public tag search (tag heat for upkeep and templates) and, read only,
// single posts and notes on any blog (material checks such as the AI-art clues). The extension holds the same
// list and also checks that writes and post lists are for the account's own blogs.
// Creates and deletes keep the official API (their reconciliation rules are written for it), and public
// visitor checks need a logged-out view, so they never use the browser session. The one exception is a reply
// (no public API at all): it goes through the browser or waits, and its outcome is reconciled from the replies.
const ALLOWED = [
  ['GET', /^\/v2\/blog\/[\w%:.-]{1,80}\/posts(\/draft|\/queue)?$/],
  ['GET', /^\/v2\/blog\/[\w%:.-]{1,80}\/posts\/\d{1,25}$/],
  ['PUT', /^\/v2\/blog\/[\w%:.-]{1,80}\/posts\/\d{1,25}$/],
  ['GET', /^\/v2\/blog\/[\w%:.-]{1,80}\/followers$/],
  ['GET', /^\/v2\/user\/following$/],
  ['GET', /^\/v2\/user\/likes$/],
  ['GET', /^\/v2\/tagged$/],
  ['GET', /^\/v2\/blog\/[\w%:.-]{1,80}\/notes$/],
  ['GET', /^\/v2\/blog\/[\w%:.-]{1,80}\/notifications$/],
  ['GET', /^\/v2\/blog\/[\w%:.-]{1,80}\/followed_by$/],
  ['GET', /^\/v2\/blog\/[\w%:.-]{1,80}\/post\/\d{1,25}\/replies$/],
  // A reply has no public API: replies.js sends it only this way (browserOnly), as one of the account's own blogs
  ['POST', /^\/v2\/user\/post\/reply$/],
];
const relayable = (method, path) => ALLOWED.some(([m, re]) => m === method && re.test(path));

const ONLINE_MS = 45e3;     // the extension counts as connected this long after its last poll
const PICKUP_MS = 8e3;      // not taken by the browser in this time: the request goes the official way
const ANSWER_MS = 90e3;     // taken but not answered: unknown outcome
const COOL_MS = 5 * 60e3;   // after "signed out" / "other account" the browser is left alone this long

class RelayMiss extends Error {} // never reached the browser: safe to send the official way

// onConnect: called when the browser becomes usable (jobs parked on the official limit can run now)
// onCool: called with the reason when the browser is set aside for a while
function makeRelay({ now = Date.now, enabled = () => true, onConnect = () => {}, onCool = () => {} } = {}) {
  const queue = [];               // waiting for pickup: { rid, req, resolve, reject, timer }
  const taken = new Map();        // rid → { resolve, reject, timer }
  let waiters = [];               // pollers waiting for work: resolve fns
  let lastPoll = 0, coolUntil = 0, coolWhy = null, usable = false;
  const count = { relayed: 0, fallback: 0, hourStart: now(), hour: 0 };

  const available = () => enabled() && now() - lastPoll < ONLINE_MS && now() >= coolUntil;

  function cool(why, ms = COOL_MS) {
    coolUntil = now() + ms; coolWhy = why; usable = false;
    try { onCool(why, ms); } catch {}
  }

  // Send one request through the browser. Resolves { status, text, retryAfter }; rejects RelayMiss when the
  // browser never took it (or isn't usable), or an Error with uncertain = true when taken but not answered.
  function send(req) {
    if (!available()) return Promise.reject(new RelayMiss('browser not connected'));
    if (!relayable(req.method, req.path)) return Promise.reject(new RelayMiss('not relayable'));
    return new Promise((resolve, reject) => {
      const rid = crypto.randomUUID();
      const item = { rid, req, resolve, reject };
      item.timer = setTimeout(() => {
        const i = queue.indexOf(item);
        if (i >= 0) { queue.splice(i, 1); reject(new RelayMiss('browser did not pick it up')); }
      }, PICKUP_MS);
      queue.push(item);
      const w = waiters; waiters = [];
      for (const f of w) f();
    });
  }

  // The extension asks for work. Holds up to waitMs when there is none.
  async function next(waitMs = 20e3, max = 4) {
    lastPoll = now();
    // connected, or usable again after a pause: wake what waited for the official limit meanwhile
    const u = available();
    if (u && !usable) { try { onConnect(); } catch {} }
    usable = u;
    if (!queue.length && waitMs > 0) {
      await new Promise(r => {
        const t = setTimeout(r, waitMs);
        waiters.push(() => { clearTimeout(t); r(); });
      });
      lastPoll = now();
    }
    if (!enabled()) return [];
    const out = [];
    while (queue.length && out.length < max) {
      const item = queue.shift();
      clearTimeout(item.timer);
      item.timer = setTimeout(() => {
        if (!taken.delete(item.rid)) return;
        item.reject(Object.assign(new Error('the browser took the request but never answered'), { uncertain: true }));
      }, ANSWER_MS);
      taken.set(item.rid, item);
      out.push({ rid: item.rid, ...item.req });
    }
    return out;
  }

  // The extension's answer: { rid, status, text, retryAfter } or { rid, refused: 'signed_out' | 'other_account' | ... }
  function done(ans = {}) {
    lastPoll = now();
    const item = taken.get(String(ans.rid || ''));
    if (!item) return false;
    taken.delete(item.rid);
    clearTimeout(item.timer);
    if (ans.refused) {
      // refused before anything was sent: the request may go the official way. Only a browser that can't work
      // for this account is set aside; a single request it won't carry (another blog, not on its list) isn't.
      if (ans.refused === 'signed_out' || ans.refused === 'other_account') cool(String(ans.refused));
      item.reject(new RelayMiss('browser refused: ' + ans.refused));
      return true;
    }
    const status = Number(ans.status) || 0;
    if (status === 401) cool('signed_out');
    if (status === 429) cool('limited', (Number(ans.retryAfter) || 300) * 1000);
    tally();
    item.resolve({ status, text: String(ans.text ?? ''), retryAfter: Number(ans.retryAfter) || 0 });
    return true;
  }

  function tally(fallback = false) {
    if (now() - count.hourStart > 3600e3) { count.hourStart = now(); count.hour = 0; }
    if (fallback) count.fallback++; else { count.relayed++; count.hour++; }
  }

  function stats() {
    return { enabled: enabled(), connected: enabled() && now() - lastPoll < ONLINE_MS, coolUntil: coolUntil > now() ? coolUntil : 0, coolWhy: coolUntil > now() ? coolWhy : null, relayed: count.relayed, hour: count.hour, fallback: count.fallback };
  }

  return { send, next, done, available, stats, cool, noteFallback: () => tally(true) };
}

module.exports = { makeRelay, relayable, RelayMiss, ALLOWED };
