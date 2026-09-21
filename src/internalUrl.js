/**
 * Putting the caller's own address on a link that points back at us.
 *
 * Stream rows are minted with BASE_URL in front of them, and BASE_URL is only
 * correct when ADDON_URL is set. Unset -- the documented default, because the
 * addon "guesses from the request, which is usually right" -- it falls back to
 * the machine's own address, which inside a container is the Docker bridge IP.
 * Nothing outside that bridge can reach it. This is what rewrites those links
 * to the scheme and host the request actually arrived on, and if it stops
 * matching a route, that route goes out with an unreachable address on it and
 * the server logs nothing, because the client never arrives.
 *
 * That is exactly what happened in v1.6.3: the proxy path gained a .m3u8
 * extension and the absolute-form pattern demanded '?', '/' or end-of-string
 * immediately after "manifest", so every proxied stream row was handed out
 * carrying 172.x.x.x. /img, /watch and /logo still matched, so artwork went on
 * working and only playback broke. Hence the optional extension below, and
 * hence this file exists at all: the rewriter used to live inline in a
 * middleware where nothing could test it.
 */

// A path this server owns. The optional extension is the point: /api/manifest
// and /api/manifest.m3u8 are one route, and a future .mpd must not repeat the
// outage that taught us this.
const INTERNAL_ROUTE = /^\/(?:img|watch|api\/manifest|logo)(?:\.[A-Za-z0-9]{1,8})?(?:[?\/].*)?$/;

/** The path part of a link that points back at us, or null if it is not ours. */
function internalPath(url) {
  if (!url || typeof url !== 'string') return null;
  // Relative: already just a path.
  if (INTERNAL_ROUTE.test(url)) return url;
  // Absolute: a legacy or static base, or this machine's own LAN address.
  const m = url.match(/^https?:\/\/[^/]+(\/.*)$/);
  return m && INTERNAL_ROUTE.test(m[1]) ? m[1] : null;
}

/** The same link, addressed to `baseUrl`. Anything not ours is returned as-is. */
function rewriteInternalUrl(url, baseUrl) {
  const path = internalPath(url);
  return path === null ? url : `${baseUrl}${path}`;
}

module.exports = { INTERNAL_ROUTE, internalPath, rewriteInternalUrl };
