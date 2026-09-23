/**
 * DaddyLiveProvider — DaddyLive's 24/7 channels, over the home route.
 *
 * DaddyLive lists ~900 channels at /24-7-channels.php. Each one's page embeds
 * a player (assetrage.net, *.dynproclaim.net …) whose HTML carries the stream
 * in an obfuscated `_econfig` blob, and that stream's playlist is signed for
 * the IP address that fetched the embed page. Datacenter addresses are refused
 * outright -- this server gets 403 even on a token it minted itself -- while a
 * home connection's tokens play. So the embed page and the playlist are both
 * fetched through the WireGuard tunnel to zona (egress.js), and the provider
 * stays silent while that tunnel is down rather than listing channels that
 * could only fail. The listing and the channel pages are fetched directly: they
 * carry nothing tied to an address. So are the video segments, by the player
 * itself -- they carry no token at all.
 *
 * Measured 2026-09-23 from zona: a token zona minted returned a live playlist;
 * the same token from Oracle or the owner's Mac, 403; Oracle's own, 403.
 *
 * This is written from scratch against those measurements rather than ported:
 * upstream's provider is 958 lines built around a Cloudflare Worker pool and
 * mints unsigned proxy links that this server's manifest route refuses. The
 * `_econfig` layout is upstream's discovery, credited below.
 */

'use strict';

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { splitRegion } = require('../channelRegions');
const { egressAvailable, needsEgress } = require('../egress');
const { redactUrl } = require('../redact');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// A playlist token lasts about six hours. Re-resolving well inside that keeps a
// channel opened late in the window from inheriting an address about to die;
// the manifest route re-mints one that dies anyway (remint.js).
const RESOLVE_TTL_MS = 60 * 60 * 1000;
const PAGE_FOLDERS = ['stream', 'cast', 'watch', 'player'];

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
    .trim();
}

/**
 * The stream address inside an embed page's `_econfig`. The layout was
 * worked out by rajhodedara/live-sport-plugin: base64, split into four equal
 * pieces, a decoy character at index 3 of each, the pieces base64-decoded
 * into the order [2, 0, 3, 1], and the joined result base64-decoded again to
 * JSON carrying `stream_url`. Returns null for anything that does not decode.
 */
function decodeEconfig(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const order = [2, 0, 3, 1];
    const text = Buffer.from(raw, 'base64').toString('utf8');
    if (text.length < 4) return null;
    const len = Math.ceil(text.length / 4);
    const out = [];
    for (let i = 0; i < 4; i++) {
      const piece = text.substr(i * len, len);
      out[order[i]] = Buffer.from(piece.slice(0, 3) + piece.slice(4), 'base64').toString('utf8');
    }
    return JSON.parse(Buffer.from(out.join(''), 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

/** A manifest address lifted from inline JSON, with its escaping undone. */
function cleanUrl(u) {
  return String(u || '')
    .replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/&amp;/gi, '&')
    .replace(/[\\"']+$/, '');
}

/** Every channel on the 24/7 page: [{ id, name }]. */
function parseChannels(html) {
  const re = /href=["'](?:\/)?watch\.php\?id=(\d+)["'][\s\S]*?<div class="card__title">([^<]+)<\/div>/gi;
  const seen = new Set();
  const out = [];
  for (const m of String(html || '').matchAll(re)) {
    const id = m[1];
    const name = decodeEntities(m[2]);
    if (!id || !name || seen.has(id) || /18\+/.test(name)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

class DaddyLiveProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'DaddyLive';
    this.hosts = BaseProvider.hostList('DADDYLIVE_HOSTS', ['dlive.sx', 'dlstreams.st']);
    this._resolved = new Map();   // channel id -> { streams, until }
    this._warned = new Map();     // what has been said, and when

    this.fetchChannels = this.circuitBreaker.wrap(`${this.name}_channels`, async () => {
      const res = await this.fetchFromHosts('/24-7-channels.php', {
        headers: { 'User-Agent': UA }, timeoutMs: 15000
      });
      return res.text();
    });
  }

  warnOnce(key, ms, msg) {
    const now = Date.now();
    if ((this._warned.get(key) || 0) > now) return;
    this._warned.set(key, now + ms);
    console.log(`[${this.name}] ${msg}`);
  }

  async getMatches() {
    if (!(await egressAvailable())) {
      this.warnOnce('down', 60 * 60 * 1000, 'home route unavailable (egress stack down or not deployed); DaddyLive skipped');
      return [];
    }
    let channels = [];
    try {
      channels = parseChannels(await this.fetchChannels.fire());
    } catch (err) {
      console.error(`[${this.name}] channel list failed:`, err.message);
      return [];
    }
    return channels.map(c => {
      const split = splitRegion(c.name);
      return new MatchEntity({
        id: `dl_ch_${c.id}`,
        title: c.name,
        baseTitle: split.base,
        region: split.region,
        category: 'networks',
        date: '0',
        popular: '0',
        league: 'Live TV',
        sources: [{ source: 'daddylive', id: c.id, channelName: c.name }]
      });
    });
  }

  /** The iframe a channel page embeds, trying the folders the site uses. */
  async _embedFor(channelId) {
    for (const folder of PAGE_FOLDERS) {
      const path = `/${folder}/stream-${encodeURIComponent(channelId)}.php`;
      let res;
      try { res = await this.fetchFromHosts(path, { headers: { 'User-Agent': UA }, timeoutMs: 10000 }); }
      catch (e) { continue; }
      const html = await res.text();
      const m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (!m) continue;
      const page = `https://${this._activeHost || this.hosts[0]}${path}`;
      const src = m[1].startsWith('//') ? 'https:' + m[1] : new URL(m[1], page).toString();
      return { src, page };
    }
    return null;
  }

  async resolveStream(channelId, category, title) {
    const id = String(channelId);
    const hit = this._resolved.get(id);
    if (hit && hit.until > Date.now()) return hit.streams;

    if (!(await egressAvailable())) return [];
    const embed = await this._embedFor(id);
    if (!embed) return [];

    // The token is minted here, for whoever fetches this page -- which is why
    // it has to be zona, and why an embed host not on the route is a dead end.
    if (!needsEgress(embed.src)) {
      this.warnOnce(`embed:${new URL(embed.src).hostname}`, 6 * 60 * 60 * 1000,
        `embed host ${new URL(embed.src).hostname} is not on the home route; add it to EGRESS_HOSTS and the egress proxy's EGRESS_ALLOW`);
      return [];
    }
    let html;
    try {
      const res = await this.proxyFetch(embed.src, { headers: { 'User-Agent': UA, Referer: embed.page }, timeoutMs: 12000 });
      if (!res.ok) return [];
      html = await res.text();
    } catch (e) {
      return [];
    }

    const raw = (html.match(/_econfig\s*=\s*['"]([^'"]+)['"]/) || [])[1];
    const conf = decodeEconfig(raw);
    const manifest = conf && cleanUrl(conf.stream_url || conf.stream_url_nop2p);
    if (!manifest || !/^https?:\/\//.test(manifest)) return [];
    if (!needsEgress(manifest)) {
      this.warnOnce(`manifest:${new URL(manifest).hostname}`, 6 * 60 * 60 * 1000,
        `playlist host ${new URL(manifest).hostname} is not on the home route; add its domain to EGRESS_HOSTS and EGRESS_ALLOW`);
      return [];
    }

    const origin = new URL(embed.src).origin;
    const referer = origin + '/';
    const { BASE_URL } = require('../config');
    const { manifestPath } = require('../manifestLink');
    console.log(`[${this.name}] resolved ${title}: ${redactUrl(manifest)}`);
    const streams = [new StreamEntity({
      name: 'DaddyLive',
      title: `DaddyLive ${title}`,
      url: `${BASE_URL}${manifestPath(manifest, referer, origin)}`,
      behaviorHints: { notWebReady: true },
      resolution: 'HD'
    })];
    this._resolved.set(id, { streams, until: Date.now() + RESOLVE_TTL_MS });
    return streams;
  }
}

module.exports = DaddyLiveProvider;
module.exports._internal = { decodeEconfig, parseChannels, cleanUrl };
