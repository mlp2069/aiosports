/**
 * remint.js — a stream whose token has expired is not a dead stream.
 *
 * Several sources hand out a playlist address that stops working after a while.
 * Measured on this addon's own rows: TotalSportek's carries `?e=` and dies
 * about thirty minutes after it is minted, which is halfway through a football
 * match; WatchFooty puts an expiry in the path and lasts six hours. When that
 * moment arrives the CDN answers 403 -- or, on the hosts that do it politely,
 * 200 with a body that is not a playlist -- and the player stops. Asking again
 * does not help, because the address itself is what has gone stale.
 *
 * The stream is still there. Re-resolving the source produces the same feed
 * under a fresh address, so this file keeps what is needed to do that: which
 * match and which source an address was minted for, and a way to recognise the
 * same feed in a freshly resolved list.
 *
 * Recognising it is the part worth being careful about. Rather than teaching
 * this file the token shape of every provider -- which is a list that goes out
 * of date -- an address is reduced to its skeleton: the parts that identify the
 * feed, with the parts that identify the moment removed. Path segments that are
 * an epoch or a long opaque blob go; query parameters whose names are the usual
 * words for a token go; everything else stays. TotalSportek's `path=<hash>` is
 * kept, so the same feed is matched exactly, while its `e` and `sig` are
 * dropped. WatchFooty's slug and stream number are kept while its token and
 * expiry are dropped.
 *
 * Candidates only ever come from re-resolving the same match, so the worst a
 * mis-match can do is hand back another feed of the game being watched.
 */

'use strict';

// Addresses remembered at once. Each is a few hundred bytes; the cap is for a
// runaway, not a workload.
const MAX_TRACKED = 500;
// An address nobody has asked about for this long is forgotten. Longer than any
// single event, so a re-mint is still possible late in a match.
const TRACK_TTL_MS = 6 * 60 * 60 * 1000;
// How long a substitution stands before the address is looked at again.
const SUBSTITUTE_TTL_MS = 30 * 60 * 1000;
// A player polls every few seconds. Re-resolving on every poll would hammer the
// provider for a stream that is genuinely gone, so each address gets one
// attempt per this long...
const RETRY_EVERY_MS = 30 * 1000;
// ...and this many attempts in total before it is left alone.
const MAX_ATTEMPTS = 3;

const tracked = new Map();      // upstream url -> { match, src, config, at }
const substitutes = new Map();  // dead url -> { url, at }
const attempts = new Map();     // dead url -> { count, at }

// Query parameters that name a moment rather than a feed.
const TOKEN_KEYS = new Set([
  'e', 'exp', 'expire', 'expires', 'expiry', 'ttl', 'validuntil',
  'sig', 'sign', 'signature', 'hash', 'hmac', 'md5', 'token', 'tok',
  'key', 'auth', 'st', 'sts', 'nonce', 'ts', 'timestamp'
]);

const EPOCH = /^\d{10}(\d{3})?$/;
// A path segment long enough and shapeless enough to be a token rather than a
// name. Hex or base64url, sixteen characters or more.
const OPAQUE_SEGMENT = /^(?:[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/;

/**
 * What is left of an address once the parts that identify the moment are
 * removed: host, the path with its token-ish segments blanked, and the query
 * parameters that are not tokens, sorted so order cannot matter.
 */
function skeleton(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (err) { return null; }
  const path = u.pathname.split('/').map(seg => {
    const s = decodeURIComponent(seg);
    if (!s) return s;
    if (EPOCH.test(s)) return '*';
    if (OPAQUE_SEGMENT.test(s)) return '*';
    return s;
  }).join('/');
  const params = [];
  u.searchParams.forEach((value, key) => {
    const k = key.toLowerCase();
    if (TOKEN_KEYS.has(k)) return;
    if (EPOCH.test(value)) return;
    params.push(`${k}=${value}`);
  });
  params.sort();
  return `${u.hostname.toLowerCase()}${path}?${params.join('&')}`;
}

/** How alike two addresses are, once reduced. Null when they cannot compare. */
function sameFeed(a, b) {
  const sa = skeleton(a);
  const sb = skeleton(b);
  if (!sa || !sb) return false;
  return sa === sb;
}

/**
 * The address in `candidates` that is the same feed as `deadUrl`.
 *
 * An exact skeleton match wins. Failing that, and only when every candidate is
 * on the host that just failed, the one whose path shape is closest is taken --
 * a provider that changes its whole address scheme still leaves the viewer on
 * the match they asked for. Nothing is returned when there is no candidate on
 * that host at all, because then there is nothing to say this is the same feed.
 */
function pickFresh(deadUrl, candidates) {
  const fresh = (candidates || []).filter(Boolean);
  if (!fresh.length) return null;

  const exact = fresh.find(c => sameFeed(deadUrl, c));
  if (exact) return exact;

  let deadHost = '';
  try { deadHost = new URL(deadUrl).hostname.toLowerCase(); } catch (err) { return null; }
  const sameHost = fresh.filter(c => {
    try { return new URL(c).hostname.toLowerCase() === deadHost; } catch (err) { return false; }
  });
  if (!sameHost.length) return null;

  const deadParts = (() => { try { return new URL(deadUrl).pathname.split('/').length; } catch (err) { return 0; } })();
  let best = null, bestGap = Infinity;
  for (const c of sameHost) {
    let parts = 0;
    try { parts = new URL(c).pathname.split('/').length; } catch (err) { continue; }
    const gap = Math.abs(parts - deadParts);
    if (gap < bestGap) { best = c; bestGap = gap; }
  }
  return best;
}

function evict(map, cap, ttl) {
  const now = Date.now();
  for (const [k, v] of map) if (now - (v.at || 0) > ttl) map.delete(k);
  if (map.size <= cap) return;
  const oldest = [...map.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  for (let i = 0; i < map.size - cap; i++) map.delete(oldest[i][0]);
}

/** Remember what a freshly minted address was minted for. */
function remember(url, record) {
  if (!url || !record) return;
  tracked.set(url, { ...record, at: Date.now() });
  evict(tracked, MAX_TRACKED, TRACK_TTL_MS);
}

function lookup(url) {
  const e = tracked.get(url);
  if (!e) return null;
  if (Date.now() - e.at > TRACK_TTL_MS) { tracked.delete(url); return null; }
  return e;
}

/** The address now standing in for one that expired, if there is one. */
function getSubstitute(url) {
  const e = substitutes.get(url);
  if (!e) return null;
  if (Date.now() - e.at > SUBSTITUTE_TTL_MS) { substitutes.delete(url); return null; }
  return e.url;
}

function setSubstitute(deadUrl, freshUrl) {
  if (!deadUrl || !freshUrl || deadUrl === freshUrl) return;
  substitutes.set(deadUrl, { url: freshUrl, at: Date.now() });
  evict(substitutes, MAX_TRACKED, SUBSTITUTE_TTL_MS);
  // A substitution is a fresh start: the next expiry gets its own attempts.
  attempts.delete(deadUrl);
}

/** Whether this address has any attempts left, and is not in its quiet period. */
function mayAttempt(url) {
  const a = attempts.get(url);
  if (!a) return true;
  if (a.count >= MAX_ATTEMPTS) return false;
  return Date.now() - a.at >= RETRY_EVERY_MS;
}

// The timestamp is called `at` because that is the field evict() ages entries
// by. Calling it anything else makes every entry look infinitely old, which
// silently empties this map on each write -- and an empty map is an open gate.
function noteAttempt(url) {
  const a = attempts.get(url) || { count: 0, at: 0 };
  a.count += 1;
  a.at = Date.now();
  attempts.set(url, a);
  evict(attempts, MAX_TRACKED, TRACK_TTL_MS);
}

/**
 * Whether the way an upstream answered is the way an expired address answers:
 * a refusal, or a 200 carrying something that is not a playlist. A 404 is
 * included because several of these hosts spell "your token is stale" that way.
 */
function looksExpired({ status, body }) {
  if (status === 401 || status === 403 || status === 404 || status === 410) return true;
  if (status === 200 && typeof body === 'string' && !body.includes('#EXT')) return true;
  return false;
}

module.exports = {
  remember, lookup, pickFresh, sameFeed, skeleton,
  getSubstitute, setSubstitute, mayAttempt, noteAttempt, looksExpired,
  _internal: {
    tracked, substitutes, attempts,
    MAX_ATTEMPTS, RETRY_EVERY_MS,
    reset() { tracked.clear(); substitutes.clear(); attempts.clear(); }
  }
};
