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
 * could only fail. The listing and the channel pages go the same way, though
 * they carry nothing tied to an address, because the site stopped answering
 * this server at all (below). Only the video segments are fetched directly,
 * by the player itself -- they carry no token and play from anywhere.
 *
 * Measured 2026-09-23 from zona: a token zona minted returned a live playlist;
 * the same token from Oracle or the owner's Mac, 403; Oracle's own, 403.
 *
 * The site also refuses, at the TCP level, an address that opens its pages in
 * bulk: a warm-up that opened 125 channels in thirteen minutes got this server
 * refused outright the same night, on every port, while zona and the Mac were
 * still served.
 * So nothing here is opened except because a viewer asked (ON_DEMAND_SOURCES
 * in streams.js), and the provider itself refuses to open more than
 * RESOLVES_PER_HOUR channels an hour, one at a time, whoever is asking. The
 * home connection is the one address whose tokens play; it must never be the
 * next one refused.
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
const { safeFetch } = require('../impitClient');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// A playlist token lasts about six hours. Re-resolving well inside that keeps a
// channel opened late in the window from inheriting an address about to die;
// the manifest route re-mints one that dies anyway (remint.js).
const RESOLVE_TTL_MS = 60 * 60 * 1000;
// A channel that yielded nothing is not asked again for a while: a viewer
// retrying a dead channel should not cost the site a page each time.
const EMPTY_TTL_MS = 10 * 60 * 1000;
const PAGE_FOLDERS = ['stream', 'cast', 'watch', 'player'];
// The channel list changes a few times a week. Fetched every six hours rather
// than on every catalog sync, and the last one that parsed is kept through a
// failure, so the site being down does not empty the Channels tab.
const LIST_TTL_MS = 6 * 60 * 60 * 1000;
const LIST_RETRY_MS = 15 * 60 * 1000;
// Channels opened per hour, at most. Opening one costs a channel page and an
// embed page, the second from the home connection. A household flicking
// through channels opens a few dozen; a sweep opens hundreds.
const RESOLVES_PER_HOUR = Number(process.env.DADDYLIVE_RESOLVES_PER_HOUR) || 30;
// Never two at once, and a breath between: a burst is what an abuse filter
// sees, even when the hourly count is modest.
const RESOLVE_GAP_MS = Number(process.env.DADDYLIVE_RESOLVE_GAP_MS) || 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    this._inflight = new Map();   // channel id -> the opening under way
    this._warned = new Map();     // what has been said, and when
    this._list = { channels: null, at: 0 };
    this._opened = [];            // when each channel was opened, for the hourly cap
    this._gate = Promise.resolve();
    this._lastOpenAt = 0;
    this._folder = PAGE_FOLDERS[0];   // the folder that worked last

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
    const channels = await this._channels();
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

  /** The channel list: the saved one while it is fresh, else fetched again. */
  async _channels() {
    const now = Date.now();
    if (this._list.channels && now - this._list.at < LIST_TTL_MS) return this._list.channels;
    try {
      // The breaker answers a failed or skipped fetch with null rather than an
      // error, and that is not an empty page: nothing was read at all.
      const html = await this.fetchChannels.fire();
      if (!html) throw new Error('no answer from the site (unreachable, or refused by the home route)');
      const channels = parseChannels(html);
      if (channels.length) {
        this._list = { channels, at: now };
        return channels;
      }
      this.warnOnce('list-empty', 30 * 60 * 1000, 'channel list had no channels in it; the page has changed');
    } catch (err) {
      this.warnOnce('list-failed', 30 * 60 * 1000, `channel list failed: ${err.message}`);
    }
    // Kept, and asked again in a quarter of an hour rather than on every sync.
    if (this._list.channels) this._list.at = now - LIST_TTL_MS + LIST_RETRY_MS;
    return this._list.channels || [];
  }

  /** Counts one opening against the hour, or says there is none left. */
  _takeBudget() {
    const now = Date.now();
    while (this._opened.length && now - this._opened[0] >= 60 * 60 * 1000) this._opened.shift();
    if (this._opened.length >= RESOLVES_PER_HOUR) return false;
    this._opened.push(now);
    return true;
  }

  /** Runs `fn` once every opening before it has finished, and a gap after. */
  _serial(fn) {
    const run = this._gate.then(async () => {
      const wait = this._lastOpenAt + RESOLVE_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      try { return await fn(); } finally { this._lastOpenAt = Date.now(); }
    });
    this._gate = run.catch(() => {});
    return run;
  }

  /** The iframe a channel page embeds, trying the folders the site uses. */
  async _embedFor(channelId) {
    // The folder that worked last first: the site uses one at a time, so this
    // is one page per channel rather than up to four.
    const folders = [this._folder, ...PAGE_FOLDERS.filter(f => f !== this._folder)];
    for (const folder of folders) {
      const path = `/${folder}/stream-${encodeURIComponent(channelId)}.php`;
      let res;
      try { res = await this.fetchFromHosts(path, { headers: { 'User-Agent': UA }, timeoutMs: 10000 }); }
      catch (e) { continue; }
      const html = await res.text();
      const m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (!m) continue;
      this._folder = folder;
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
    // Two viewers, or a detail page and its play button, asking for the same
    // channel at once share one opening.
    if (this._inflight.has(id)) return this._inflight.get(id);

    const opening = this._serial(async () => {
      const again = this._resolved.get(id);
      if (again && again.until > Date.now()) return again.streams;
      if (!(await egressAvailable())) return [];
      if (!this._takeBudget()) {
        this.warnOnce('budget', 10 * 60 * 1000,
          `${RESOLVES_PER_HOUR} channels opened in the last hour; holding off until the hour rolls over (DADDYLIVE_RESOLVES_PER_HOUR)`);
        return [];
      }
      const streams = await this._open(id, title);
      this._resolved.set(id, { streams, until: Date.now() + (streams.length ? RESOLVE_TTL_MS : EMPTY_TTL_MS) });
      return streams;
    }).finally(() => this._inflight.delete(id));
    this._inflight.set(id, opening);
    return opening;
  }

  /** One channel, opened: its page, its embed, and the stream the embed names. */
  async _open(id, title) {
    const embed = await this._embedFor(id);
    if (!embed) return [];

    // The token is minted here, for whoever fetches this page -- which is why
    // it has to be zona, and why an embed host not on the route is a dead end.
    if (!needsEgress(embed.src)) {
      this.warnOnce(`embed:${new URL(embed.src).hostname}`, 6 * 60 * 60 * 1000,
        `embed host ${new URL(embed.src).hostname} is not on the home route; add it to EGRESS_HOSTS and the egress proxy's EGRESS_ALLOW`);
      return [];
    }
    // Fetched as itself, never through a Cloudflare proxy pool: a token minted
    // for Cloudflare's address plays nowhere. safeFetch sends it home.
    let html;
    try {
      const res = await safeFetch(embed.src, { headers: { 'User-Agent': UA, Referer: embed.page }, timeoutMs: 12000 });
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
    console.log(`[${this.name}] resolved ${title} on ${new URL(manifest).host}`);
    return [new StreamEntity({
      name: 'DaddyLive',
      // The channel alone: the row already says DaddyLive beside it.
      title,
      url: `${BASE_URL}${manifestPath(manifest, referer, origin)}`,
      // The player fetches the video itself, straight from DaddyLive, and the
      // segment host refuses any request without the embed page as Referer
      // (measured: 403 without, 206 with, from any address and any User-Agent).
      // Nothing about the token is involved, so the player can send it: both
      // ExoPlayer and libmpv apply these to every request of the stream. The
      // alternative, relaying the video, would cost this server its bandwidth.
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: { request: { Referer: referer, Origin: origin } }
      },
      resolution: 'HD'
    })];
  }
}

module.exports = DaddyLiveProvider;
module.exports._internal = { decodeEconfig, parseChannels, cleanUrl };
