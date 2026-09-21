const container = require('./container');
const { bufferSeconds } = require('./liveDelay');
const remint = require('./remint');
const { stationOrder } = require('./services/StationLabel');
const { parseMarkets, marketsSetting } = require('./services/LocalMarkets');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// How long the stream list waits on its sources. Past this, whatever answered
// is what the viewer gets and the rest keep resolving into the cache behind
// them. The second figure applies only when nothing has answered at all, where
// waiting beats handing back an empty list.
const SOURCE_DEADLINE_MS = Number(process.env.STREAM_DEADLINE_MS) || 3500;
const SOURCE_HARD_DEADLINE_MS = Number(process.env.STREAM_HARD_DEADLINE_MS) || 9000;
// SOURCE_DEADLINE_MS no longer ends the wait on its own -- see the wait in
// handleStream -- and is kept as the point past which a partial list would be
// served, should that ever be wanted again.

const SOURCE_PRIORITY = { admin: 1, echo: 1, golf: 1, delta: 1, 'watchfooty': 2, 'cdnlive': 3, 'streamsports99': 4, 'streamic': 5, 'totalsportek': 6, 'streamfree': 8, 'timstreams': 9, 'usatv': 10, 'sportyhunter': 12, 'streamsports': 13, 'iptv-org': 14, 'embedindia': 15 };

// What each source is called on a stream row.
//
// The name is the whole of what the viewer knows about where a row came from,
// and it is the one thing on the list they can act on: a provider that failed
// them last night is a provider they skip tonight. So every source the addon
// resolves needs its own entry here. admin, echo, delta and golf are the names
// streamed.pk gives its own feeds, so they read as the site they belong to.
const PROVIDER_NAMES = {
  streamedpk: 'Streamed.pk',
  admin: 'Streamed.pk', echo: 'Streamed.pk', delta: 'Streamed.pk', golf: 'Streamed.pk',
  watchfooty: 'WatchFooty', cdnlive: 'CDNLiveTV', totalsportek: 'TotalSportek',
  streamsports99: 'StreamSports99', streamsports: 'StreamSports',
  streamic: 'Streamic', streamfree: 'StreamFree', timstreams: 'TimStreams',
  sportyhunter: 'SportyHunter', usatv: 'USA TV', 'iptv-org': 'Direct IPTV',
  embedindia: 'EmbedIndia', embedst: 'Embed.st'
};

// A source nothing here has a name for. Vague, and deliberately so: a row that
// borrows the name of a provider it did not come from is worse than a row that
// admits it does not know, because the viewer has no way to tell it is wrong.
const UNKNOWN_PROVIDER = 'Live stream';

/** What a source is called on screen, or '' when the source itself is unknown. */
function sourceLabel(source) {
  if (!source) return '';
  // A YAML provider is whatever the file that defined it was called, which is
  // also what the configure page shows against it.
  if (source.startsWith('yaml_')) return source.slice('yaml_'.length) || UNKNOWN_PROVIDER;
  return PROVIDER_NAMES[source] || UNKNOWN_PROVIDER;
}

// How each provider's streams have been answering lately.
//
// Verification already pings every playlist before it is served, so which
// providers are handing out links that play and which are handing out dead ones
// is measured on every mint -- it was simply thrown away afterwards. Kept per
// provider rather than per URL, because a token expiring is one stream and a
// provider whose whole edge is down is every stream it will offer next.
//
// The counts halve every quarter of an hour, so an outage fades within the hour
// and only a provider that keeps failing stays marked down. None of it is
// written to disk: a restart re-learns this in minutes, and a verdict formed
// before a restart describes tokens that no longer exist.
const HEALTH_HALF_LIFE_MS = 15 * 60 * 1000;
const sourceHealthTally = new Map();

function decayTally(entry, now) {
  const factor = Math.pow(0.5, (now - entry.at) / HEALTH_HALF_LIFE_MS);
  entry.successes *= factor;
  entry.failures *= factor;
  entry.at = now;
  return entry;
}

/** Record one verification outcome against the provider it belongs to. */
function noteOutcome(source, ok) {
  if (!source) return;
  const now = Date.now();
  const entry = sourceHealthTally.get(source) || { successes: 0, failures: 0, lastFailAt: 0, at: now };
  decayTally(entry, now);
  if (ok) {
    entry.successes += 1;
  } else {
    entry.failures += 1;
    entry.lastFailAt = now;
  }
  sourceHealthTally.set(source, entry);
}

/** A provider's recent record, in the shape the scorer reads, or undefined. */
function sourceHealth(source) {
  const entry = source && sourceHealthTally.get(source);
  if (!entry) return undefined;
  const { successes, failures, lastFailAt } = decayTally(entry, Date.now());
  return { successes, failures, lastFailAt };
}

/**
 * Which provider a verification outcome counts against, or '' for none.
 *
 * The stream carries its own source, and the cache key names it for anything
 * minted before it did. Nothing is counted under `opts.strict`, which is the
 * channel sweep: that sweep walks every channel there is on a timer, including
 * the ones it already believes are dead -- deciding that is the whole of what
 * it is for -- so its failures say nothing about whether a provider is
 * answering a viewer. Counted, they would mark down whichever provider carries
 * the most channels, and iptv-org carries hundreds, on the strength of streams
 * nobody ever asked for.
 */
function tallySource(s, cacheKey, opts = {}) {
  if (opts.strict) return '';
  return (s && s._source) || (cacheKey ? String(cacheKey).split(':')[0] : '');
}

// Source selection (shared by handleStream and prewarmMatch)
function selectSources(matchSources, config) {

  // A user-defined order, set in the configure page, outranks the built-in
  // priorities entirely — it is an explicit preference, where SOURCE_PRIORITY
  // is only a guess at which providers behave. Sources the user never ordered
  // keep their built-in ranking behind the ones they did.
  const userOrder = config && typeof config.sourceOrder === 'string' && config.sourceOrder
    ? config.sourceOrder.split(',').map(s => s.trim()).filter(Boolean)
    : null;
  const userRank = (src) => {
    if (!userOrder) return null;
    const i = userOrder.indexOf(src);
    return i === -1 ? null : i;
  };

  const sortedSources = [...matchSources].sort((a, b) => {
    if (userOrder) {
      const ra = userRank(a.source);
      const rb = userRank(b.source);
      if (ra !== null || rb !== null) {
        if (ra === null) return 1;         // unordered sources sit behind ordered ones
        if (rb === null) return -1;
        if (ra !== rb) return ra - rb;
      }
    }
    // Unknown sources that are not known fallback providers are likely new
    // Streamed.pk sources - priority 1.5 keeps them near the top.
    const getPriority = (src) => SOURCE_PRIORITY[src] ?? (['watchfooty', 'cdnlive', 'streamsports99', 'streamic', 'streamfree', 'timstreams', 'sportyhunter', 'streamsports', 'iptv-org'].includes(src) ? 99 : 1.5);
    const pa = getPriority(a.source);
    const pb = getPriority(b.source);
    if (pa !== pb) return pa - pb;
    return 0;
  });

  // Every source turned off means no streams, not every stream. The page writes
  // 'none' for an empty selection, and skipping the filter on it turned the one
  // setting that should disable everything into the one that enabled everything.
  if (config && config.sources === 'none') return [];

  if (config && typeof config.sources === 'string') {
    const enabled = config.sources.split(',');
    const KNOWN_FALLBACKS = ['watchfooty', 'cdnlive', 'streamsports99', 'streamic', 'totalsportek', 'streamfree', 'timstreams', 'sportyhunter', 'streamsports', 'iptv-org', 'embedindia', 'embedst', 'streamedpk', 'usatv'];
    return sortedSources.filter(src => {
      if (src.source.startsWith('yaml_')) return true;
      const isFallback = KNOWN_FALLBACKS.includes(src.source);
      if (isFallback) {
        return enabled.includes(src.source);
      }
      return false;
    });
  }

  const KNOWN_FALLBACKS = ['watchfooty', 'cdnlive', 'streamsports99', 'streamic', 'totalsportek', 'streamfree', 'timstreams', 'sportyhunter', 'streamsports', 'iptv-org', 'embedst', 'streamedpk', 'usatv'];
  return sortedSources.filter(src => {
    if (src.source.startsWith('yaml_')) return true;
    return KNOWN_FALLBACKS.includes(src.source);
  });
}

// Resolve a single source (extracted from handleStream, logic unchanged)
// `opts.strict` rethrows a provider's error instead of returning no streams;
// only the channel health check asks for it (see countChannelStreams).
async function resolveSource(src, match, config, opts = {}) {
  const streamScorer = container.resolve('streamScorer');
  const sourceName = src.source;
  let resStreams = [];

  try {
    if (sourceName === 'streamfree') {
      const provider = container.resolve('streamFreeProvider');
      const sfCategory = src.original_category || match.category;
      resStreams = await provider.resolveStream(src.id, sfCategory, match.title);
    } else if (sourceName === 'timstreams') {
      const provider = container.resolve('timStreamsProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title);
    } else if (sourceName === 'sportyhunter') {
      const provider = container.resolve('sportyHunterProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title);

    } else if (sourceName === 'watchfooty') {
      const provider = container.resolve('watchFootyProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title);
    } else if (sourceName === 'totalsportek') {
      const provider = container.resolve('totalSportekProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title);
    } else if (sourceName === 'cdnlive') {
      const provider = container.resolve('cdnLiveProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title, { strict: !!opts.strict });
    } else if (sourceName === 'streamsports99') {
      const provider = container.resolve('streamSports99Provider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title);
    } else if (sourceName === 'streamic') {
      const provider = container.resolve('streamicProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
    } else if (sourceName === 'iptv-org') {
      const proxyHeaders = {};
      if (src.user_agent) proxyHeaders['User-Agent'] = src.user_agent;
      if (src.referrer) proxyHeaders['Referer'] = src.referrer;

      resStreams = [{
        name: 'Nuvio Direct',
        title: `24/7 TV (${src.quality || 'Auto'})`,
        url: src.url,
        resolution: src.quality,
        // Which local station this is, when the source knows. Kept apart from
        // the title above, which the scorer and provider detection read.
        station: src.station,
        stationSort: src.stationSort,
        behaviorHints: {
          proxyHeaders: {
            request: proxyHeaders
          }
        }
      }];
    } else if (sourceName === 'embedindia') {
      const provider = container.resolve('embedIndiaProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
    } else if (sourceName === 'embedst') {
      const provider = container.resolve('embedStProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
    } else if (sourceName === 'streamedpk') {
      const provider = container.resolve('streamedPkProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
    } else if (sourceName === 'usatv') {
      const provider = container.resolve('usaTvProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title, { strict: !!opts.strict });
    } else if (sourceName.startsWith('yaml_')) {
      const yamlProviders = container.resolve('yamlProviders');
      const pName = sourceName.replace('yaml_', '');
      const provider = yamlProviders.find(p => p.name === pName);
      if (provider) {
        resStreams = await provider.resolveStream(src.id, match.category, match.title);
      }
    } else {
      // Unknown or unsupported source, ignore
      resStreams = [];
    }

    for (const s of resStreams) {
      s.score = streamScorer.calculateScore(s, sourceName);
      s._source = sourceName;
    }
  } catch (e) {
    console.warn(`[streams.js] Error resolving ${sourceName} for ${src.id}:`, e.message);
    if (opts.strict) throw e;
  }

  return resStreams;
}

// Safe impit+undici helper — works on all platforms (Windows, Linux x64/ARM64, musl).
// impit is tried first for browser TLS fingerprinting; undici is the automatic fallback.
const { safeFetch: _safeFetch } = require('./impitClient');


const { redactUrl } = require('./redact');
// --- Stream Health Verification ---
// Pings each direct stream once and drops dead ones (404/403/5xx, or 200 bodies
// that are not M3U8). Web player links (no url or '/watch?') pass through
// untouched. Runs once per mint (see mintVerifiedSources), not per request, so
// cached results are served without re-verification.
// How many playlists are checked at once. Unbounded, one fixture opened a dozen
// simultaneous requests to the same handful of edge hosts, and prewarm ran eight
// fixtures beside it -- so the addon congested the CDN it was asking about and
// then dropped, as dead, streams it had extracted successfully a second earlier.
// The logs showed exactly that: "Successfully extracted" followed by "Dropped
// timeout/error stream ... impit timeout 5000ms" for the same URL.
const VERIFY_CONCURRENCY = Number(process.env.VERIFY_CONCURRENCY) || 6;
// How long to wait before asking a second time. Long enough for a throttle
// window or a load-balancer blip to pass, short enough that a mint is not held
// up by a host that is simply down.
const VERIFY_RETRY_DELAY_MS = Number(process.env.VERIFY_RETRY_DELAY_MS) || 300;
// An answer about this moment rather than about the stream. A 404 or a 403 is
// about the stream and is taken at its word the first time.
const isTransientCheck = (status) => status === 408 || status === 429 || (status >= 500 && status <= 599);

/** Run `job` over `items`, at most `limit` at a time, preserving order. */
async function mapLimit(items, limit, job) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await job(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// `opts.report`, when given, counts streams dropped because the check itself
// failed -- a timeout, a network error, a 5xx -- apart from streams that are
// plainly dead (404, 403, not a playlist).
async function verifyStreams(streams, cacheKey, m3u8Parser, resolveCache, opts = {}) {

  const checkedStreams = await mapLimit(streams, VERIFY_CONCURRENCY, (async (s) => {
    // We only pre-flight check direct streams (m3u8 urls). Web player links are kept blindly.
    // A web player link is kept blindly, and so is a progressive .mp4: the
    // check below reads the head of a playlist and rejects a body with no
    // #EXT in it, which is every mp4 ever served. WatchFootyProvider mints
    // those as direct streams (WatchFootyProvider.js:95), so without this
    // exemption each one is dropped as a "fake 200" without being played.
    if (!s.url || s.url.includes('/watch?') || s.url.includes('.mp4')) return s;

    // Which provider is answering for this row, for the tally.
    const source = tallySource(s, cacheKey, opts);

    let targetUrl = s.url;
    let referer = '';
    let origin = '';
    // If the stream is routed through our manifest proxy, we extract the true upstream URL to ping
    if (targetUrl.includes('/api/manifest')) {
      try {
        const urlObj = new URL('http://localhost' + targetUrl);
        if (urlObj.searchParams.has('url')) {
          targetUrl = urlObj.searchParams.get('url');
        }
        if (urlObj.searchParams.has('referer')) {
          referer = urlObj.searchParams.get('referer');
        }
        if (urlObj.searchParams.has('origin')) {
          origin = urlObj.searchParams.get('origin');
        }
      } catch (e) {}
    }

    try {

      if (!referer && s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) {
        referer = s.behaviorHints.proxyHeaders.request.Referer || '';
      }
      if (!origin && referer) {
        try { origin = new URL(referer).origin; } catch (_) {}
      }

      let res;
      let bodySample = '';

      const reqHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Referer': referer
      };
      if (origin) reqHeaders['Origin'] = origin;

      // Only the head of the playlist is needed: a valid one starts #EXTM3U on
      // its first line. A server that ignores Range sends the whole body, which
      // is what happened before, so this can only help.
      const attempt = async () => {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), 5000); // slow edge CDNs (wfty/strmd) need the room
        try {
          // _safeFetch handles impit -> undici fallback automatically on all platforms
          const result = await _safeFetch(targetUrl, {
            method: 'GET',
            headers: { ...reqHeaders, Range: 'bytes=0-2047' },
            signal: abortController.signal,
            timeoutMs: 5000,
          });
          return { status: result.status, body: await result.text() };
        } catch (err) {
          return { error: err };
        } finally {
          clearTimeout(timer);
        }
      };

      // A blip is not a verdict. The note under the status checks has said for
      // as long as this function has existed that a throttle or a timeout
      // "has said nothing about the stream itself" -- and the row was dropped
      // all the same, which is a working stream lost to one bad moment. It is
      // asked once more, and the second answer is the one that counts.
      let outcome = await attempt();
      if (outcome.error || isTransientCheck(outcome.status)) {
        await new Promise(resolve => setTimeout(resolve, VERIFY_RETRY_DELAY_MS));
        outcome = await attempt();
        if (opts.report) opts.report.retried = (opts.report.retried || 0) + 1;
      }

      if (outcome.error) {
        if (opts.report) opts.report.errors++;
        console.log(`[Filter] Dropped timeout/error stream: ${redactUrl(targetUrl)} - ${outcome.error.message}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        noteOutcome(source, false);
        return null;
      }

      res = { status: outcome.status };
      bodySample = outcome.body || '';

      // Edge servers return 404 for dead streams, 403 for IP-locked/expired tokens, 502 for upstream failures
      if (res.status === 404 || res.status === 403 || res.status >= 500) {
        if (opts.report && res.status >= 500) opts.report.errors++;
        console.log(`[Filter] Dropped dead stream (${res.status}): ${redactUrl(targetUrl)}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        noteOutcome(source, false);
        return null;
      }

      // A host that is throttling or timing out has said nothing about the stream
      // itself: dropped for now, but counted as a failed check, not a dead one.
      if (res.status === 429 || res.status === 408) {
        if (opts.report) opts.report.errors++;
        console.log(`[Filter] Dropped throttled stream (${res.status}): ${redactUrl(targetUrl)}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        noteOutcome(source, false);
        return null;
      }

      // Some CDNs (like lb8.strmd.st) return 200 OK with "Not found" when token is expired.
      // If it doesn't contain #EXT, it's not a valid m3u8 playlist.
      if (!bodySample.includes('#EXT')) {
        console.log(`[Filter] Dropped fake 200 stream (Invalid M3U8 body): ${redactUrl(targetUrl)}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        noteOutcome(source, false);
        return null;
      }

      // Parse Master Playlist quality, framerate (FPS), and bitrate in real-time
      const parsedQuality = m3u8Parser.parseManifestText(bodySample);
      if (parsedQuality) {
        if (parsedQuality.qualityTag) s.quality = parsedQuality.qualityTag;
        if (parsedQuality.resolution) s.resolution = parsedQuality.resolution;
        if (parsedQuality.bitrateTag) s.bitrate = parsedQuality.bitrateTag;
      }

      if (cacheKey) resolveCache.noteSuccess(cacheKey);
      noteOutcome(source, true);
      return s;
    } catch (err) {
      if (opts.report) opts.report.errors++;
      console.log(`[Filter] Dropped timeout/error stream: ${redactUrl(targetUrl)} - ${err.message}`);
      noteOutcome(source, false);
      return null;
    }
  }));

  return checkedStreams.filter(Boolean);
}

// Mint streams for a single source and health-verify them before they enter the
// cache, so verification runs once per mint instead of on every request.
/** The upstream address, referer and origin inside one of our proxy links. */
function proxyTarget(rowUrl) {
  if (!rowUrl || !rowUrl.includes('/api/manifest')) return null;
  try {
    const q = new URL(rowUrl, 'http://localhost').searchParams;
    const url = q.get('url');
    return url ? { url, referer: q.get('referer') || '', origin: q.get('origin') || '' } : null;
  } catch (err) {
    return null;
  }
}

async function mintVerifiedSources(src, match, config, cacheKey, opts = {}) {
  const resolveCache = container.resolve('streamResolveCache');
  const m3u8Parser = container.resolve('m3u8Parser');
  const streamScorer = container.resolve('streamScorer');
  const minted = await resolveSource(src, match, config, opts);
  const verified = await verifyStreams(minted, cacheKey, m3u8Parser, resolveCache, opts);

  // Scored again, now that something has looked at the stream.
  //
  // The first score is struck before verification, when the only evidence is
  // the sentence the provider wrote, so a stream that turns out to be 1080p was
  // ranked on whether its provider happened to say so. Verification has since
  // read the master playlist and written the real size and bitrate onto the
  // row, and the checks above have said whether this provider is answering at
  // all -- both of which the score should reflect, since this is the score the
  // cache keeps and every later request sorts on.
  for (const s of verified) {
    const source = s._source || src.source;
    s.score = streamScorer.calculateScore(s, source, sourceHealth(source));
    // What this address was minted for, so it can be minted again when its
    // token expires mid-match (remint.js).
    const target = proxyTarget(s.url);
    if (target) remint.remember(target.url, { src, match, config });
  }
  return verified;
}

/**
 * A fresh address for a stream whose own has expired.
 *
 * The source that produced it is resolved again -- which is what mints a new
 * token -- and the feed that matches the dead address is picked out of the
 * result. Returns null when the source is not known, when it no longer offers
 * anything, or when nothing in what it offers is recognisably the same feed;
 * in each case the caller is no worse off than before.
 */
async function remintUpstream(deadUrl) {
  const record = remint.lookup(deadUrl);
  if (!record) return null;
  try {
    // Minted without a cache key: this must go to the provider, not to the
    // cache entry that is holding the address that just failed.
    const fresh = await mintVerifiedSources(record.src, record.match, record.config, null, {});
    const targets = (fresh || []).map(row => proxyTarget(row.url)).filter(Boolean);
    const pick = remint.pickFresh(deadUrl, targets.map(t => t.url));
    if (!pick) return null;
    return targets.find(t => t.url === pick) || null;
  } catch (err) {
    console.log(`[Remint] could not re-mint: ${err.message}`);
    return null;
  }
}

// Prewarm: mint tokens for a match's top sources before the user clicks
// Warm every source a match has, not the first three. The click resolves all of
// them, so warming three left the warm ones returning instantly and then waiting
// on the cold tail -- which is the wait the deadline above now truncates. Warm
// the lot and, in the normal case, the deadline is never reached at all.
async function prewarmMatch(match, config, topN = 12) {
  try {
    if (!match || !match.sources || !match.sources.length) return;
    const resolveCache = container.resolve('streamResolveCache');
    const activeSources = selectSources(match.sources, config || null);
    const targets = activeSources.slice(0, topN);
    if (targets.length === 0) return;
    console.log(`[Prewarm] minting ${targets.length} sources for ${match.id}`);
    await Promise.allSettled(targets.map(src => {
      const key = `${src.source}:${match.id}:${src.id}`;
      if (resolveCache.get(key)) return Promise.resolve(null);
      return resolveCache.getOrCreate(key, () => mintVerifiedSources(src, match, config || null, key));
    }));
  } catch (err) {
    console.warn('[Prewarm] failed:', err.message);
  }
}


/**
 * The host a row will really be played from, seen through our own links.
 *
 * A stream that goes out as an /api/manifest or /api/segment link carries the
 * upstream it stands for in its `url` parameter, and that upstream is the
 * machine that buffers or does not. Our own hostname says nothing about any of
 * them, so it is read out of the query first and only used when there is none.
 */
function upstreamHost(s) {
  const raw = s && s.url;
  if (!raw) return '';
  try {
    const link = new URL(String(raw), 'http://addon.invalid');
    const inner = link.searchParams.get('url');
    if (inner) {
      try { return new URL(inner).hostname; } catch (e) { /* not a url: ours below */ }
    }
    return link.hostname;
  } catch (e) {
    return '';
  }
}

/**
 * Spread the head of the list across hosts.
 *
 * Five rows from five providers are often five links to the same edge server,
 * and when that server is having a bad minute all five have it together: the
 * viewer works down the list and every attempt fails the same way, having
 * looked like five separate chances. Taking the best row per host in turn puts
 * a genuinely different machine second, so the second choice is a second
 * chance. Only the head is alternated: by the time the best row of every host
 * has been offered the viewer has already tried every machine there is, so a
 * further round buys no new chance and would only push a good row below a
 * markedly worse one from a thinner host. Everything after that head keeps the
 * score order it arrived in. Where every host is already different this
 * changes nothing, and it never drops a row or renames one -- the set that
 * goes out is the set that came in, in a different order.
 */
/**
 * The viewer's own source order, as a rank over stream rows.
 *
 * Until now this setting reached only selectSources(), where it decided which
 * provider was *asked* first and nothing about what came back — so dragging the
 * list changed the order work happened in and never the order anybody saw.
 */
function sourceRank(config) {
  const listed = config && typeof config.sourceOrder === 'string' && config.sourceOrder
    ? config.sourceOrder.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  if (!listed.length) return null;
  const rank = new Map(listed.map((s, i) => [s, i]));
  // A source the viewer never placed sits behind every one they did, rather
  // than sharing rank 0 with their first choice.
  return (s) => {
    const r = rank.get((s && s._source) || '');
    return r === undefined ? listed.length : r;
  };
}

/**
 * Which of the two orders the list is built on.
 *
 * An explicit choice wins. Without one, a viewer who has dragged their sources
 * into an order has already said which they want — that drag is not a hint
 * about resolution scheduling, it is a preference about what to watch.
 */
function sortMode(config) {
  const explicit = config && config.sortBy;
  if (explicit === 'source' || explicit === 'rating') return explicit;
  return config && typeof config.sourceOrder === 'string' && config.sourceOrder.trim()
    ? 'source'
    : 'rating';
}

/**
 * Host rotation, applied inside one source rather than across them.
 *
 * Spreading CDNs is a tie-break, not an ordering: promoting a second host's row
 * over the whole of the viewer's first-choice source would undo exactly the
 * order they asked for. Rows arrive already sorted, so inserting in encounter
 * order keeps the sources in theirs.
 */
function spreadRows(rows, bySource) {
  if (!bySource) return spreadHosts(rows);
  const groups = new Map();
  for (const s of rows) {
    const k = (s && s._source) || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const out = [];
  for (const g of groups.values()) out.push(...spreadHosts(g));
  return out;
}

function spreadHosts(rows) {
  const queues = new Map();
  rows.forEach((s, i) => {
    // A row with no upstream of its own -- a web player link -- shares its fate
    // with nobody, so it has no rotation to take part in and earns no place at
    // the head: it stays where its score put it, below the rows that alternate.
    const key = upstreamHost(s);
    if (!key) return;
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(i);
  });
  const promoted = new Set();
  const out = [];
  for (const q of queues.values()) {
    out.push(rows[q[0]]);
    promoted.add(q[0]);
  }
  rows.forEach((s, i) => { if (!promoted.has(i)) out.push(s); });
  return out;
}

// How many sources are resolved at once.
//
// All of them started together, and several mint a token and decrypt a player
// page before they can answer at all. A dozen of those on a two-core host
// contend for the same two cores, so each takes longer than it would have
// alone and the deadline below can expire on work that was only ever waiting
// for a core. Four keeps both cores busy without the queue eating itself.
const SOURCE_CONCURRENCY = 4;

async function handleStream(type, id, config) {
  if (type !== 'tv' || !id.startsWith('nuvio_sport_')) {
    return { streams: [] };
  }

  const matchId = id.replace('nuvio_sport_', '');
  
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  const match = matches.find(m => m.id === matchId);

  if (!match || !match.sources || match.sources.length === 0) {
    return { streams: [] };
  }

  const streams = [];

  const activeSources = selectSources(match.sources, config);
  const streamScorer = container.resolve('streamScorer');

  const resolveCache = container.resolve('streamResolveCache');

  // Wait for the sources, but not for the worst of them.
  //
  // Every source was awaited to completion, so the spinner after Play lasted as
  // long as the slowest one even when a good source had answered in 300 ms --
  // measured at nearly eleven seconds on a match with several sources.
  //
  // Nothing is discarded by giving up on the wait. Each source resolves through
  // resolveCache.getOrCreate, which stores its result whenever it finishes, so
  // a straggler keeps going and lands in the cache regardless -- as do the
  // sources still queued behind it, which the workers below go on starting
  // after this request has answered. They simply arrive for the next request
  // instead of holding up this one.
  const collected = [];
  const startedAt = Date.now();

  const allDone = mapLimit(activeSources, SOURCE_CONCURRENCY, async (src) => {
    const key = `${src.source}:${matchId}:${src.id}`;
    try {
      const minted = await resolveCache.getOrCreate(key, () => mintVerifiedSources(src, match, config, key));
      for (const s of minted) collected.push({ ...s, _cacheKey: key });
    } catch (e) {
      // a failed source is one fewer option, not an error
    }
  }).catch(() => {});

  // Wait for every source, capped by the hard deadline.
  //
  // Returning at the 3.5s deadline is what made the list change between looks:
  // the first open showed whatever had landed by then, the rest arrived in the
  // cache a moment later, and the same match that had just shown 8 streams
  // showed 12 on a reload. The way to see the full list was to ask twice.
  //
  // Two cheaper rules were tried on the live server and both failed the same
  // way. A fixed 2.5s extension cut the slowest sources off at exactly the cap.
  // Waiting only while answers kept arriving did no better: when the quick
  // sources all answer inside a second and one slow source is still working,
  // "nothing has answered lately" and "something is still working" look
  // identical from here, so the wait ended around 3.7s with the slow one still
  // in flight. Four of thirteen cold matches grew on a refresh under each.
  //
  // Nothing observable separates a slow source from a stuck one, so the choice
  // is which mistake to make. A list that changes when you look again is the
  // worse one: it reads as broken, and the only remedy available to the viewer
  // is to keep refreshing until it settles. Waiting costs seconds, and only on
  // a cold open -- a warmed match answers in well under a second, which is what
  // the prewarming in catalog.js is for.
  const remaining = SOURCE_HARD_DEADLINE_MS - (Date.now() - startedAt);
  if (remaining > 0) await Promise.race([allDone, sleep(remaining)]);

  streams.push(...collected);

  // --- Inject relevant 24/7 channels based on category ---
  const isStreamFreeEnabled = !config || !config.sources || config.sources === 'none' || config.sources.split(',').includes('streamfree');
  if (match.category === 'cricket' && isStreamFreeEnabled) {
    try {
      const extraChannels = [
        { id: 'willow', title: 'Willow TV' },
        { id: 'skycricket', title: 'Sky Sports Cricket' }
      ];
      
      const warmed = await Promise.all(extraChannels.map(async (channel) => {
        const key = `streamfree:__channel__:${channel.id}`;
        const resolved = await resolveCache.getOrCreate(key, () => mintVerifiedSources(
          { source: 'streamfree', id: channel.id, original_category: 'cricket' },
          { category: 'cricket', title: channel.title },
          config,
          key
        ));
        return resolved.map((s) => ({ ...s, _cacheKey: key }));
      }));
      warmed.flat().forEach((s) => {
        s._source = 'streamfree';
        s.score = streamScorer.calculateScore(s, 'streamfree', sourceHealth('streamfree'));
        streams.push(s);
      });
    } catch (e) {
      console.warn('[streams.js] Error injecting 24/7 cricket channels:', e.message);
    }
  }

  // Standardize Stream Labels
  const sportIcons = {
    football: '⚽', cricket: '🏏', motorsport: '🏎️',
    basketball: '🏀', american_football: '🏈', rugby: '🏉', networks: '📺'
  };
  const icon = sportIcons[match.category] || '📡';

  streams.forEach(s => {
    let quality = s.resolution || s.quality || 'Auto';
    if (String(quality).includes('x')) {
       const h = String(quality).split('x')[1];
       quality = h + 'p';
    }
    
    const isWeb = !!s.externalUrl || s.name === 'Nuvio Web Player';

    // The row is named after the source it came from, which resolveSource
    // attaches to every stream it returns. Where a stream somehow arrives
    // without one there is nothing left to read but the title the provider
    // wrote, and two of them sign their work there; everything else gets the
    // neutral name. Guessing a provider is worse than admitting none: the
    // viewer's own strategy is "that site worked last night, try it again",
    // and a row wearing somebody else's name quietly ruins it.
    let providerName = sourceLabel(s._source);
    if (!providerName) {
      const said = String(s.title || '').toLowerCase();
      if (said.includes('timstreams')) providerName = 'TimStreams';
      else if (said.includes('sporty')) providerName = 'SportyHunter';
      else providerName = UNKNOWN_PROVIDER;
    }

    let originalTitle = s.title || '';
    let channelName = '';
    let viewersText = '';
    if (originalTitle) {
      const vMatch = originalTitle.match(/👥\s*\d+\s*Viewers/);
      if (vMatch) viewersText = `\n${vMatch[0]}`;

      // "WatchFooty Stream 3": the provider numbers its own mirrors, and that
      // number is the only thing telling six otherwise identical rows apart.
      // Both rules below treat a title carrying the word "Stream" as
      // boilerplate, which threw the number away and left the viewer choosing
      // between six rows that read the same and behave differently.
      const numbered = originalTitle.match(/\bstream\s*#?\s*(\d+)\s*$/i);
      const match = originalTitle.match(/\(([^)]+)\)/);
      if (numbered) {
        channelName = 'Stream ' + numbered[1];
      } else if (match && match[1]) {
        const inner = match[1];
        if (!inner.match(/^[0-9]{3,4}p$/i) && inner !== 'Auto' && !inner.toLowerCase().startsWith('stream')) {
          channelName = inner;
        }
      } else if (!originalTitle.includes('Stream') && !originalTitle.includes('Auto')) {
        channelName = originalTitle;
      }
    }
    // Determine Group
    s.name = isWeb ? '🌐 Web Stream' : '⚡ Direct Stream';
    
    if (channelName) {
      // Don't format title case if it breaks our channel name. Actually, just clean it up slightly.
      channelName = channelName.trim();
    }
    
    const shown = s.station || channelName;
    const channelDisplay = shown ? ` | 📺 ${shown}` : '';
    s.title = `${icon} ${providerName}${channelDisplay}\n📺 Quality: ${quality}${viewersText}`;
    
    // Add behaviorHints to group streams and handle CORS for direct streams
    s.behaviorHints = s.behaviorHints || {};
    s.behaviorHints.bingeGroup = `nuvio_sport_${matchId}`;
    
    // If it's a direct m3u8 stream and not routed through our proxy, mark it notWebReady
    if (s.url && s.url.includes('.m3u8') && !s.url.includes('/api/manifest')) {
      if (providerName !== 'Direct IPTV') {
        s.behaviorHints.notWebReady = true;
      }
      
      let referer = '';
      if (providerName === 'Streamed.pk') referer = 'https://embed.st/';
      else if (providerName === 'WatchFooty') referer = 'https://watchfooty.st/';
      else if (providerName === 'CDNLiveTV') referer = 'https://cdnlivetv.tv/';
      else if (providerName === 'Streamic') referer = 'https://streamic.st/';
      else if (providerName === 'StreamSports99' || providerName === 'StreamSports') referer = 'https://streamsports99.fun/';
      else if (providerName === 'SportyHunter') referer = 'https://sportyhunter.xyz/';
      
      if (referer) {
        if (!s.behaviorHints.proxyHeaders) {
          s.behaviorHints.proxyHeaders = {
            request: {
              "Referer": referer,
              "Origin": referer
            }
          };
        }
      }
    }
    
    // Add extra info if present
    if (providerName === 'Direct IPTV' && s.url) {
      s.title = `📺 ${s.station || channelName || 'Live channel'}\n⚙️ Quality: ${quality}`;
    }
  });

  // No two rows may read identically. Six lines saying "WatchFooty / Quality:
  // HD" are six coin flips: they play different mirrors, one of them works, and
  // nothing on screen says which one has already been tried. Providers that
  // number their own mirrors are handled above; this is the backstop for the
  // ones that do not, and for any that stop.
  const byLabel = new Map();
  for (const s of streams) {
    const key = s.title || '';
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key).push(s);
  }
  for (const group of byLabel.values()) {
    if (group.length < 2) continue;
    group.forEach((s, i) => {
      // Appended to the first line, beside the provider, so the quality line
      // underneath keeps reading the way it does on every other row.
      const nl = String(s.title).indexOf('\n');
      s.title = nl === -1
        ? `${s.title} · ${i + 1}`
        : `${s.title.slice(0, nl)} · ${i + 1}${s.title.slice(nl)}`;
    });
  }

  // Sort streams by kind first, then by score descending.
  //
  // "Direct" means the app can play it itself; "web" means it hands off to a
  // browser. Direct first is the default because it is the better experience,
  // but a user whose direct streams buffer on their setup can invert it from
  // the configure page. Kind is read off the stream itself — a direct stream
  // has a url, a web one has an externalUrl — rather than off its display
  // name, which is cosmetic and has already changed once.
  // A third setting, 'none', turns the grouping off entirely: the viewer does
  // not want either kind promoted, so the list falls back to pure quality
  // order. Only the grouping goes -- score still decides, because unranked is
  // not what "no preference between direct and web" asks for.
  // Within one score -- on a network tile, one quality -- local stations read
  // the viewer's own cities first, then A to Z by city. Rows without a station
  // keep their order: the sort is stable.
  const byStation = stationOrder(parseMarkets(marketsSetting(config)));
  const order = config && config.streamOrder;
  const webFirst = order === 'web';
  const groupByKind = order !== 'none';
  const rank = sourceRank(config);
  const bySource = sortMode(config) === 'source' && !!rank;
  streams.sort((a, b) => {
    if (groupByKind) {
      const aDirect = a.url ? 1 : 0;
      const bDirect = b.url ? 1 : 0;
      if (aDirect !== bDirect) return webFirst ? aDirect - bDirect : bDirect - aDirect;
    }
    if (bySource) {
      const ra = rank(a);
      const rb = rank(b);
      // Within one source the rating still decides, so "my order" means which
      // site to try first, not that its worst stream outranks its best.
      if (ra !== rb) return ra - rb;
    }
    return (b.score - a.score) || byStation(a, b);
  });

  // Then spread the hosts, within each kind's block so that which kind comes
  // first stays the viewer's decision rather than an accident of which CDN a
  // web player happened to point at.
  const direct = () => spreadRows(streams.filter(s => s.url), bySource);
  const web = () => spreadRows(streams.filter(s => !s.url), bySource);
  const spread = !groupByKind ? spreadRows(streams, bySource)
    : webFirst ? [...web(), ...direct()]
    : [...direct(), ...web()];
  streams.length = 0;
  streams.push(...spread);

  for (const s of streams) { delete s.station; delete s.stationSort; }

  // The extra buffer travels on the link, because the manifest proxy serves
  // every viewer of a stream from one remembered window and only the link
  // says how deep this viewer wants it (liveDelay.js). A viewer who has
  // turned it off says so rather than staying quiet, so that their choice
  // outranks whatever the instance defaults to.
  const asked = config && config.buffer;
  if (asked !== undefined && asked !== '') {
    const want = bufferSeconds(asked);
    for (const s of streams) {
      if (s.url && s.url.includes('/api/manifest') && !/[?&]buf=/.test(s.url)) s.url += `&buf=${want}`;
      else if (!s.url && s.externalUrl && s.externalUrl.includes('/watch?') && !/[?&]buf=/.test(s.externalUrl)) {
        s.externalUrl += `&buf=${want}`;
      }
    }
  }

  // Verification now happens once per mint (mintVerifiedSources), not per request.
  // Adaptive per-source TTLs keep tokens fresh, so clients may hold the list 30s.
  return {
    streams,
    // Deliberately not cached by the client.
    //
    // The protocol has no way to deliver streams progressively -- one request,
    // one array -- so a source that resolves after the response cannot be sent.
    // It does land in the cache, though, which makes the client's own reload
    // button the way to see it: pressing it re-asks and gets the fuller list,
    // in milliseconds, because the work is already done. A thirty-second cache
    // defeated exactly that, handing back the same thin list it had just shown.
    cacheMaxAge: 0,
    staleRevalidate: 0,
    staleError: 60
  };
}

/**
 * How many directly playable streams a 24/7 channel opens to, for the
 * background check in ChannelHealth.
 *
 * Throws whenever the honest answer is "unknown" rather than "none", so a
 * channel is only ever hidden on evidence:
 *   - it is not listed right now (a provider blinked between refreshes);
 *   - its only sources are CDNLive and CDNLive was not probed this time -- it is
 *     probed a little at a time (see takeCdnHealthBudget) and never while it
 *     has this server paused -- or nothing it has besides CDNLive played;
 *   - the check ran past its cap;
 *   - it came back with web-player rows and nothing direct, which a working
 *     web-only channel does too.
 * Every source is waited for, with no stream deadline, so a slow channel is
 * counted in full and the sweep does not start the next channel early.
 */
const HEALTH_CHECK_CAP_MS = 60 * 1000;

// CDNLive is checked a little at a time. Decoding its player pages in bulk is
// what got this server rate-limited for an hour, but never checking them left
// every dead CDNLive channel listed for good: its playlists answered 503 a
// hundred and forty times in one hour. Forty an hour covers the lot over a few
// sweeps without a burst.
const CDNLIVE_HEALTH_PER_HOUR = Number(process.env.CDNLIVE_HEALTH_PER_HOUR) || 40;
const cdnHealthTimes = [];
function takeCdnHealthBudget() {
  const now = Date.now();
  while (cdnHealthTimes.length && now - cdnHealthTimes[0] > 60 * 60 * 1000) cdnHealthTimes.shift();
  if (cdnHealthTimes.length >= CDNLIVE_HEALTH_PER_HOUR) return false;
  cdnHealthTimes.push(now);
  return true;
}

async function countChannelStreams(matchId) {
  const match = container.resolve('cacheService').getMatches().find(m => m.id === matchId);
  if (!match || !Array.isArray(match.sources) || !match.sources.length) throw new Error('not listed now');

  const hasCdn = match.sources.some(src => src.source === 'cdnlive');
  let probeCdn = false;
  if (hasCdn) {
    let benched = false;
    try { benched = container.resolve('cdnLiveProvider').isBenched(); } catch (e) { benched = true; }
    probeCdn = !benched && takeCdnHealthBudget();
  }
  const unprobed = hasCdn && !probeCdn;
  const sources = selectSources(match.sources, {}).filter(src => probeCdn || src.source !== 'cdnlive');
  if (!sources.length) throw new Error('no sources this check probes');

  const resolveCache = container.resolve('streamResolveCache');
  const isWeb = s => !!s.externalUrl || s.name === 'Nuvio Web Player';
  const directIn = rows => (Array.isArray(rows) ? rows : []).filter(s => s && s.url && !isWeb(s)).length;

  // Sources whose empty answer is an answer. Streamed.pk and StreamFree fetch
  // through a circuit breaker whose fallback turns an outage or a throttle into
  // an empty list, so from them "nothing" says nothing. CDNLive under strict
  // throws for everything that is not a real answer.
  const EMPTY_MEANS_NONE = new Set(['iptv-org', 'usatv', 'cdnlive']);

  // Each source's outcome. A source someone opened recently counts from the
  // cache when it holds playable streams. Anything else is resolved here,
  // outside the cache and strictly, so that a provider error, a throttle or a
  // playlist that failed to answer comes back as a failure rather than as an
  // empty list -- the resolver and the cache both turn failures into "none".
  const settled = Promise.allSettled(sources.map(async (src) => {
    const key = `${src.source}:${matchId}:${src.id}`;
    const cached = resolveCache.get(key);
    const cachedRows = Array.isArray(cached) ? cached : (cached && cached.streams);
    if (directIn(cachedRows) > 0) return { direct: directIn(cachedRows), errors: 0, web: false, trusted: true };
    const report = { errors: 0 };
    const rows = await mintVerifiedSources(src, match, {}, null, { strict: true, report });
    return {
      direct: directIn(rows),
      errors: report.errors,
      web: rows.some(s => s && isWeb(s)),
      trusted: EMPTY_MEANS_NONE.has(src.source)
    };
  }));

  let timer;
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('check ran past its cap')), HEALTH_CHECK_CAP_MS);
  });
  // Past the cap the answer is unknown, but the scrapes this check started are
  // let finish (up to another cap) before the sweep moves on, so a slow
  // channel's work does not pile up under the next channel's.
  const results = await Promise.race([settled, cap])
    .catch(async (e) => { await Promise.race([settled, sleep(HEALTH_CHECK_CAP_MS)]); throw e; })
    .finally(() => clearTimeout(timer));

  const outcomes = results.map(r => (r.status === 'fulfilled' ? r.value : null));
  const failed = o => !o || o.errors > 0;
  const direct = outcomes.reduce((n, o) => n + (o ? o.direct : 0), 0);
  if (direct > 0) return direct;
  if (unprobed) throw new Error('only unprobed sources left');
  if (outcomes.some(o => o && o.web)) throw new Error('web-player rows only');
  if (outcomes.every(failed)) {
    // Every source failed outright or had every playlist fail to answer.
    // Tagged, so a channel whose hosts stay down check after check can still
    // be hidden (see ChannelHealth), while one bad minute cannot.
    const err = new Error('every source failed');
    err.allFailed = true;
    throw err;
  }
  if (outcomes.some(failed)) throw new Error('a source failed or timed out');
  if (outcomes.some(o => !o.trusted)) throw new Error('empty from a source that hides its failures');
  return 0;
}

module.exports = {
  handleStream,
  remintUpstream,
  _proxyTarget: proxyTarget,
  prewarmMatch,
  countChannelStreams,
  _sourceLabel: sourceLabel,
  _PROVIDER_NAMES: PROVIDER_NAMES,
  _SOURCE_PRIORITY: SOURCE_PRIORITY,
  _noteOutcome: noteOutcome,
  _sourceHealth: sourceHealth,
  _tallySource: tallySource,
  _upstreamHost: upstreamHost,
  _spreadHosts: spreadHosts,
  _spreadRows: spreadRows,
  _verifyStreams: verifyStreams,
  _isTransientCheck: isTransientCheck,
  _sourceRank: sourceRank,
  _sortMode: sortMode,
  _mapLimit: mapLimit,
  _SOURCE_CONCURRENCY: SOURCE_CONCURRENCY
};
