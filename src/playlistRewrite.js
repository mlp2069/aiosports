/**
 * playlistRewrite.js — what the manifest proxy hands a player.
 *
 * Every address in an upstream playlist is made absolute and, where the host
 * will not serve a player directly, pointed back at this server: sub-playlists
 * always, because they need the Referer a player cannot send; media segments,
 * keys and init sections on the hosts in PROXY_SEGMENT_HOSTS.
 *
 * Streamed's CDN (strmd.st) is the one measured to need the second: it refuses
 * any client whose TLS handshake is not a browser's, whatever headers it
 * sends -- a playlist fetched fine through this server's browser-fingerprint
 * client, and its segments, handed to the player as plain links, got 403s.
 * The same stream played in a browser on a Mac and stalled in Nuvio. Every
 * other source's segments answered a plain client and a browser alike, so
 * they stay direct: a relay costs this server the video's bandwidth. Hosts
 * not on the list are tried once each (segmentPolicy.js) and relayed only if
 * they behave the same way.
 */

'use strict';

const { manifestPath, segmentPath } = require('./manifestLink');

const DEFAULT_HOSTS = ['strmd.st'];

/** PROXY_SEGMENT_HOSTS=off: nothing is relayed and no host is probed. */
function relayDisabled() {
  return /^(0|off|none|false|no)$/i.test(String(process.env.PROXY_SEGMENT_HOSTS || '').trim());
}

/**
 * The hosts whose media this server relays without asking: the default list
 * plus whatever PROXY_SEGMENT_HOSTS adds. Other hosts are decided by a probe
 * (segmentPolicy.js).
 */
function proxiedHosts() {
  if (relayDisabled()) return [];
  const raw = String(process.env.PROXY_SEGMENT_HOSTS || '');
  const added = raw.split(',').map(s => s.trim().toLowerCase().replace(/^\*\./, '')).filter(Boolean);
  return [...new Set([...DEFAULT_HOSTS, ...added])];
}

/** Whether a host is one of the configured ones, which name a domain and everything under it. */
function needsSegmentProxy(hostname, hosts = proxiedHosts()) {
  const h = String(hostname || '').toLowerCase();
  return !!h && hosts.some(x => h === x || h.endsWith('.' + x));
}

/**
 * An entry made absolute: resolved against where the playlist was served
 * from, and given the asked-for playlist's query parameters -- a token,
 * typically -- when it has none of its own. The probe resolves a sample the
 * same way, so it tries the address the player or the relay will fetch.
 */
function absoluteEntry(raw, targetUrl, finalUrl) {
  try {
    const entry = new URL(raw, finalUrl || targetUrl);
    const asked = new URL(targetUrl);
    asked.searchParams.forEach((val, key) => {
      if (!entry.searchParams.has(key)) entry.searchParams.set(key, val);
    });
    return entry.toString();
  } catch (err) {
    return raw;
  }
}

// Tags whose URI attribute names a file the player will fetch.
const TAG_WITH_URI = /^#EXT-X-(KEY|SESSION-KEY|MAP|MEDIA|I-FRAME-STREAM-INF)\b/;
const URI_ATTR = /URI="([^"]*)"/;
// An address that is not a fetch: a key carried inline, a FairPlay
// identifier. Nothing to make absolute and nothing to relay.
const OPAQUE = /^(data|skd|blob|about):/i;

/**
 * The playlist body a player gets. `finalUrl` is where the upstream playlist
 * was actually served from (after redirects), which relative addresses are
 * resolved against; `targetUrl` is the address asked for, whose query string
 * -- a token, typically -- each entry inherits when it has none of its own.
 * `hosts`, when given, are the exact hosts whose media is relayed (what
 * segmentPolicy decided for this playlist); without it the configured
 * domains apply.
 */
function rewritePlaylist(body, { targetUrl, finalUrl, referer = '', origin = '', hosts, buf = 0 } = {}) {
  const exact = hosts ? new Set(hosts.map(h => String(h).toLowerCase())) : null;
  const relayed = (host) => (exact ? exact.has(host.toLowerCase()) : needsSegmentProxy(host));
  const absolute = (raw) => absoluteEntry(raw, targetUrl, finalUrl);
  const route = (abs, kind = '') => {
    // A variant playlist is read back through here, so the buffer the viewer
    // asked for has to travel with it: the media playlist it names is the one
    // the window is deepened in (liveDelay.js).
    if (abs.includes('.m3u8')) {
      const link = manifestPath(abs, referer, origin);
      return buf > 0 ? `${link}&buf=${buf}` : link;
    }
    let host = '';
    try { host = new URL(abs).hostname; } catch (err) { return abs; }
    if (relayed(host)) return segmentPath(abs, referer, origin, kind);
    // A segment named .image or .js is a segment all the same; the fragment
    // tells a player that reads the extension so.
    if ((abs.includes('.image') || abs.includes('.js')) && !abs.includes('.ts')) return abs + '#.ts';
    return abs;
  };
  const rewrite = (raw, kind = '') => (OPAQUE.test(raw.trim()) ? raw : route(absolute(raw), kind));
  return String(body).split('\n').map(line => {
    const l = line.trim();
    if (!l) return line;
    if (l.startsWith('#')) {
      if (!TAG_WITH_URI.test(l)) return line;
      // What the tag says the file is, for the relay: a key is bytes long,
      // an init section small, and neither is a chunk that failed.
      const kind = /^#EXT-X-(KEY|SESSION-KEY)\b/.test(l) ? 'key' : (/^#EXT-X-MAP\b/.test(l) ? 'map' : '');
      return line.replace(URI_ATTR, (m, uri) => `URI="${rewrite(uri, kind)}"`);
    }
    return rewrite(l);
  }).join('\n');
}

module.exports = { rewritePlaylist, absoluteEntry, needsSegmentProxy, proxiedHosts, relayDisabled, DEFAULT_HOSTS };
