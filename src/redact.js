/**
 * A stream URL, with the part that grants access taken out.
 *
 * A resolved m3u8 is a credential: the signature in its path, and the token in
 * its query, are what let it play. They are short-lived, but "short-lived" is
 * not the same as "safe to paste into a GitHub issue", and asking someone for
 * their logs is the most ordinary thing in support. Logging the whole URL turned
 * every such request into a handout.
 *
 * What stays is what a log is read for -- the host, which provider and which
 * fixture -- so the lines remain as useful for diagnosing as they ever were.
 *
 *   https://lb2.wfty.st/secure/YdM0OCi.../pro/chelsea-hull/2/40187/1789249516/playlist.m3u8
 *   -> https://lb2.wfty.st/secure/…/pro/chelsea-hull/2/40187/1789249516/playlist.m3u8
 */

// Path segments that are signatures rather than names: long, random, and next
// to a marker like /secure/. Also the opaque query tokens these CDNs use.
const SIGNED_SEGMENT = /(\/(?:secure|sig|signature|token|auth|hash)\/)[^/?#]+/gi;
// A long segment with no word separators in it: that is a signature, not a name.
// Requiring the absence of - and _ keeps descriptive slugs readable, which is
// the difference between "live-event_college-gameday-live-stream" (useful in a
// log, and not a secret) and "vdTaTEQUANeyjBxjfegpdSKqULtkJWeM" (neither).
const LONG_OPAQUE = /\/[A-Za-z0-9]{24,}(?=\/|$)/g;
// `s` is DaddyLive's signature (…/hls/<id>.m3u8?s=<sig>&e=<expiry>). Its `e` is
// only an expiry, and stays readable: it is what a log is read for.
const SECRET_QUERY = /([?&](?:_t|_e|_n|s|token|sig|signature|key|auth|hash|md5|expires)=)[^&#]+/gi;

function redactUrl(value) {
  if (typeof value !== 'string' || !value) return value;
  return value
    .replace(SIGNED_SEGMENT, '$1…')
    .replace(SECRET_QUERY, '$1…')
    .replace(LONG_OPAQUE, '/…');
}

/** Redact every URL inside a longer message. */
function redact(message) {
  if (typeof message !== 'string') return message;
  return message.replace(/https?:\/\/\S+/g, m => redactUrl(m));
}

module.exports = { redact, redactUrl };
