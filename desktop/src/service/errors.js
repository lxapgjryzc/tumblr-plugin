'use strict';
// Typed failures. The job runner decides what happens next from the class, never from message text.

class StudioError extends Error {
  constructor(msg, extra = {}) { super(msg); this.name = this.constructor.name; Object.assign(this, extra); }
}
class AuthError extends StudioError {}          // reconnect needed; job waits for auth
class NetError extends StudioError {}           // offline / timeout; `uncertain` = the request may have landed
class RateError extends StudioError {}          // throttled; `retryAt` (ms)
class HttpError extends StudioError {}          // a definite refusal from Tumblr; `status`, `body`
class UnsupportedError extends StudioError {}   // the adapter can't do this safely (e.g. legacy post)
class StaleError extends StudioError {}         // the plan was made against an older revision

const errText = b => b?.errors?.[0]?.detail || b?.errors?.[0]?.title || b?.meta?.msg || (typeof b === 'string' ? b : JSON.stringify(b));
// Post ids exceed 2^53: quote long integers before parsing so none loses precision
const safeJson = text => { try { return JSON.parse(String(text).replace(/:\s*(-?\d{16,})(?=\s*[,}\]])/g, ':"$1"')); } catch { return null; } };

module.exports = { StudioError, AuthError, NetError, RateError, HttpError, UnsupportedError, StaleError, errText, safeJson };
