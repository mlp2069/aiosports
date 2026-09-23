/**
 * manifestLink.js — signed links to the manifest proxy and the segment relay.
 *
 * /api/manifest fetches the playlist named in its query string, and
 * /api/segment the media chunk named in its. Left open, any URL anyone liked
 * could be fed to either, and the server would fetch it from the owner's own
 * connection. Every link a provider hands out is minted here instead, with an
 * HMAC over the url, referer and origin it carries, and each route refuses a
 * link whose signature does not match. A player follows the links it was
 * given, so nothing it does changes; someone typing their own URL into the
 * query string gets a 403. The two routes sign differently, so a playlist link
 * cannot be replayed as a segment link or the other way round.
 *
 * The key is LINK_SECRET when set. Otherwise one is made once and kept in the
 * data directory, so links handed out before a restart still play after it.
 * Where that directory is not writable the key lasts as long as the process,
 * and a player that was mid-stream across a restart simply asks for streams
 * again.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let secret = null;

function readKey(file) {
  try {
    const key = fs.readFileSync(file, 'utf8').trim();
    return key.length >= 32 ? key : null;
  } catch { return null; }
}

function linkSecret() {
  if (secret) return secret;
  const fromEnv = String(process.env.LINK_SECRET || '').trim();
  if (fromEnv) return (secret = fromEnv);

  const dir = require('./config').DATA_DIR;
  const file = path.join(dir, 'link-secret');
  const kept = readKey(file);
  if (kept) return (secret = kept);

  const made = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 'wx' fails if another start got there first; theirs is then the key.
    fs.writeFileSync(file, made, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    const theirs = readKey(file);
    if (theirs) return (secret = theirs);
    if (err && err.code === 'EEXIST') {
      // There, but not a usable key -- empty after a crash or a full disk.
      // Left alone, every restart would sign with a fresh key and break every
      // link handed out before it, with nothing in the log to say why.
      try {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, made, { mode: 0o600 });
        fs.renameSync(tmp, file);
        console.warn('[manifestLink] replaced an unusable link-secret file');
      } catch { /* this run keeps the key in memory */ }
    }
  }
  return (secret = made);
}

// `kind` separates the two routes' signatures. The playlist route's is the
// original, unprefixed form, so links minted before the relay existed still
// verify after a deploy: a player mid-stream re-reads its playlist by the link
// it was given.
function signature(url, referer, origin, kind = '') {
  return crypto.createHmac('sha256', linkSecret())
    .update(`${kind ? kind + '\n' : ''}${url}\n${referer}\n${origin}`)
    .digest('base64url')
    .slice(0, 32);
}

const query = (url, referer, origin, kind) =>
  `?url=${encodeURIComponent(url)}`
  + `&referer=${encodeURIComponent(referer)}`
  + `&origin=${encodeURIComponent(origin)}`
  + `&sig=${signature(url, referer, origin, kind)}`;

/**
 * The path of a signed proxy link:
 * /api/manifest.m3u8?url=…&referer=…&origin=…&sig=…
 *
 * The extension is for the player, not for us -- both spellings reach the same
 * route. A client that has to work out what a link holds reads the path for an
 * extension, and every one of them cuts the query off first, so the .m3u8
 * sitting in `url=` was never visible: a bare /api/manifest looked like a file
 * of no known kind. A player that guesses wrong opens a playlist as if it were
 * a container, fails, then probes for a Content-Type and starts over.
 *
 * The signature covers the query alone, so a link minted under the old
 * spelling still verifies -- a player mid-stream keeps reloading by the link
 * it was handed.
 */
function manifestPath(url, referer = '', origin = '') {
  return '/api/manifest.m3u8' + query(url, referer, origin, '');
}

/**
 * The path of a signed relay link for a media segment, key or init section:
 * /api/segment/<name>?url=…&sig=… The name is the upstream file's own, so a
 * player that reads the extension to decide what it is looking at sees one.
 */
// Extensions a player can learn something from. A chunk disguised as
// .image, .unknown or .html (the last would meet the login guard on a server
// with AUTH_KEY) is handed over as seg.ts, which is what it is.
const MEDIA_EXT = /\.(ts|m4s|mp4|m4a|m4v|aac|mp3|ac3|ec3|vtt|webvtt|key|bin)$/i;

// A file the playlist names by its tag rather than its address: a key from
// "/key.php?id=…" is a key, whatever it is called, and the relay must know.
const KIND_NAME = { key: 'seg.key', map: 'init.mp4' };

function segmentPath(url, referer = '', origin = '', kind = '') {
  let name = KIND_NAME[kind] || 'seg.ts';
  try {
    const last = new URL(url).pathname.split('/').pop() || '';
    const clean = last.replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '').slice(-48);
    if (MEDIA_EXT.test(clean)) name = clean;
  } catch { /* not a url: the default name */ }
  return `/api/segment/${name}` + query(url, referer, origin, 'segment');
}

/**
 * A relay link for a disguised chunk that is to be handed over as the
 * transport stream inside it (segmentUnwrap.js). Signed under its own kind, so
 * an ordinary relay link cannot be turned into one by adding a parameter, and
 * this one cannot be spent as an ordinary one: each verifies only as what it
 * was minted for. Named .ts because that is what the player will receive.
 */
function unwrapPath(url, referer = '', origin = '') {
  return '/api/segment/seg.ts' + query(url, referer, origin, 'unwrap') + '&u=1';
}

function verifyQuery(q, kind) {
  const str = v => (typeof v === 'string' ? v : null);
  const url = str(q.url);
  const sig = str(q.sig);
  const referer = q.referer === undefined ? '' : str(q.referer);
  const origin = q.origin === undefined ? '' : str(q.origin);
  if (!url || !sig || referer === null || origin === null) return false;
  const want = Buffer.from(signature(url, referer, origin, kind));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** Whether a request's url, referer and origin are the ones that were signed. */
function verifyManifestQuery(q) { return verifyQuery(q, ''); }
function verifySegmentQuery(q) { return verifyQuery(q, 'segment'); }
function verifyUnwrapQuery(q) { return verifyQuery(q, 'unwrap'); }

module.exports = { manifestPath, segmentPath, unwrapPath, verifyManifestQuery, verifySegmentQuery, verifyUnwrapQuery };
