/**
 * liveDelay.js — the extra buffer.
 *
 * A live source publishes a short playlist. Measured on this addon's own
 * sources: TotalSportek lists ten segments, forty seconds, and publishes one
 * every 4.02s like a metronome; WatchFooty and TimStreams list four, sixteen
 * and thirteen seconds, and publish in bursts -- eight seconds of nothing,
 * then two segments at once, seven times in under two minutes.
 *
 * A player starts three segments from the end of a live playlist, so it holds
 * about twelve seconds of video ahead of the playhead. Twelve seconds of
 * cushion, minus an eight second pause, is four; a slow chunk on top of that
 * is a stall. That is the little rebuffer that happens while the stream is
 * otherwise fine, and no player setting fixes it, because those playlists do
 * not contain enough video to buffer more than what they list.
 *
 * How far behind the end a player begins is decided once, when playback
 * starts, and it is the whole of the cushion it will ever have. Widening it
 * needs two things, and this server -- which every playlist reload passes
 * through -- can do both:
 *
 *   - Something further back to start from. The segments a source has
 *     published are remembered and kept in what is served after the source
 *     has dropped them, which makes the window deep. Measured: a WatchFooty
 *     segment still answered 206 some seventy-six seconds after it left the
 *     source's own playlist. Hosts that do not keep them are found out by
 *     asking for one (retentionOk below), and are served their own window.
 *
 *   - A player told to use it. #EXT-X-START is where a player reads how far
 *     behind the end to begin. ExoPlayer reads it first of all (Nuvio, the
 *     Android players), hls.js and AVPlayer honour it too; ffmpeg's demuxer
 *     ignores it and keeps its usual three segments, so HOLD-BACK goes out
 *     beside it for the players that read that instead.
 *
 * Nothing is ever held back: the end of the playlist is still the newest
 * segment the source has published, and a viewer who asks for no extra buffer
 * is served what they would have been served before this file existed.
 */

'use strict';

// Segments remembered per stream. At four seconds each this is two minutes --
// more than the largest buffer on offer -- and costs a few hundred bytes of
// addresses, not video.
const MAX_KEEP = 30;
// A stream nobody has asked about for this long is forgotten.
const IDLE_MS = 5 * 60 * 1000;
// Streams remembered at once. A personal instance serves a handful; this is
// for a runaway, not a workload.
const MAX_STREAMS = 200;
// The most a viewer can ask for. Past this the delay stops being a buffer and
// starts being a different broadcast.
const MAX_SECONDS = 120;
// What a player does when the playlist says nothing: three target durations.
const DEFAULT_COUNT = 3;

const streams = new Map();  // key -> { segs, firstSeq, target, version, discSeq, lastAccess }

/** Seconds of extra buffer, as a number a playlist can be built from. */
function bufferSeconds(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_SECONDS, Math.round(n));
}

const EXTINF = /^#EXTINF:([\d.]+)/;

/**
 * A media playlist, as the pieces needed to build another one. Returns null
 * for anything that is not one -- a master playlist naming variants has no
 * segments to remember, and is served as it arrived.
 */
function parse(body) {
  const lines = String(body).split('\n');
  const out = { version: '', target: 0, mediaSequence: 0, discSequence: null, ended: false, segs: [] };
  let key = null, map = null, pending = [], dur = 0, gotInf = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#')) {
      let m;
      if ((m = /^#EXT-X-VERSION:(\d+)/.exec(l))) { out.version = m[1]; continue; }
      if ((m = /^#EXT-X-TARGETDURATION:([\d.]+)/.exec(l))) { out.target = Number(m[1]); continue; }
      if ((m = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(l))) { out.mediaSequence = Number(m[1]); continue; }
      if ((m = /^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(l))) { out.discSequence = Number(m[1]); continue; }
      // A key or an init section applies to every segment after it. Each
      // remembered segment carries the one that was in force, because the
      // segment that follows it here may not be the one that followed it
      // upstream.
      if (/^#EXT-X-KEY\b/.test(l)) { key = l; continue; }
      if (/^#EXT-X-MAP\b/.test(l)) { map = l; continue; }
      if ((m = EXTINF.exec(l))) { dur = Number(m[1]); gotInf = true; pending.push(l); continue; }
      if (/^#EXT-X-(DISCONTINUITY|BYTERANGE|PROGRAM-DATE-TIME|GAP)\b/.test(l)) { pending.push(l); continue; }
      if (/^#EXT-X-ENDLIST\b/.test(l)) { out.ended = true; continue; }
      continue;  // playlist-level, and rebuilt below
    }
    if (!gotInf) { pending = []; continue; }
    out.segs.push({ uri: l, dur, key, map, tags: pending });
    pending = []; dur = 0; gotInf = false;
  }
  return out.segs.length ? out : null;
}

function evictIdle(now) {
  for (const [k, st] of streams) if (now - st.lastAccess > IDLE_MS) streams.delete(k);
  if (streams.size <= MAX_STREAMS) return;
  const byAccess = [...streams.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  for (let i = 0; i < streams.size - MAX_STREAMS; i++) streams.delete(byAccess[i][0]);
}

/**
 * What this stream has published, updated with what it is publishing now.
 *
 * Segments are recognised by their address. Where the window that just
 * arrived overlaps what is remembered, only the new ones are appended; where
 * it does not overlap at all the source has restarted, and what came before
 * it is not the same stream -- kept numbering, fresh content, a joint the
 * player is told about.
 */
function remember(key, parsed, now = Date.now()) {
  let st = streams.get(key);
  if (!st) {
    st = {
      segs: [], firstSeq: parsed.mediaSequence, target: parsed.target,
      version: parsed.version, discSeq: parsed.discSequence, lastAccess: now
    };
    streams.set(key, st);
    evictIdle(now);
  }
  st.lastAccess = now;
  if (parsed.target > st.target) st.target = parsed.target;
  if (!st.version) st.version = parsed.version;
  if (st.discSeq === null) st.discSeq = parsed.discSequence;

  const known = new Set(st.segs.map(s => s.uri));
  const fresh = parsed.segs.filter(s => !known.has(s.uri));
  const overlaps = parsed.segs.some(s => known.has(s.uri));
  if (st.segs.length && !overlaps) {
    st.firstSeq += st.segs.length;
    st.segs = [];
    if (fresh.length) fresh[0] = { ...fresh[0], tags: ['#EXT-X-DISCONTINUITY', ...fresh[0].tags] };
  }
  st.segs.push(...fresh);
  if (st.segs.length > MAX_KEEP) {
    const drop = st.segs.length - MAX_KEEP;
    st.segs.splice(0, drop);
    st.firstSeq += drop;
  }
  return st;
}

/**
 * The playlist to serve: what is remembered, ending where the source's own
 * playlist ends, with the start offset a player reads to know where to begin.
 *
 * `retained` is whether this host has been shown to keep a segment past its
 * own window. Without that, only what the source is still listing goes out --
 * a deep window of addresses that answer 404 is worse than a shallow one.
 */
function render(st, parsed, seconds, { retained = false } = {}) {
  const target = Math.max(1, Math.ceil(st.target || parsed.target || 4));
  let segs = st.segs;
  let firstSeq = st.firstSeq;
  if (!retained) {
    const live = new Set(parsed.segs.map(s => s.uri));
    const from = segs.findIndex(s => live.has(s.uri));
    if (from > 0) { firstSeq += from; segs = segs.slice(from); }
    else if (from === -1) { firstSeq += segs.length - parsed.segs.length; segs = parsed.segs; }
  }
  if (!segs.length) return null;

  // Only as deep as the start offset will actually reach, plus a segment or
  // two to seek in. Everything remembered is kept -- the next viewer starts
  // where this one did -- but listing a minute of video nobody will fetch
  // only puts addresses in front of a player that the host may have stopped
  // serving. The front moves forward as the window fills, which is what a
  // live playlist does anyway; it never moves back.
  const need = DEFAULT_COUNT * target + seconds + 2 * target;
  let deep = 0, cut = segs.length;
  for (let i = segs.length - 1; i >= 0; i--) {
    deep += segs[i].dur || 0;
    cut = i;
    if (deep >= need) break;
  }
  if (cut > 0) { firstSeq += cut; segs = segs.slice(cut); }

  const lines = ['#EXTM3U'];
  if (st.version) lines.push(`#EXT-X-VERSION:${st.version}`);
  lines.push(`#EXT-X-TARGETDURATION:${target}`);
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${firstSeq}`);
  if (st.discSeq !== null && st.discSeq !== undefined) lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${st.discSeq}`);

  // Where to begin. The default is three target durations from the end, so
  // the extra buffer is added to that -- and then held to what the window
  // actually holds, less one segment, because a player started on the oldest
  // segment listed is a player started on the next one to be dropped.
  const window = segs.reduce((n, s) => n + (s.dur || 0), 0);
  const want = DEFAULT_COUNT * target + seconds;
  const offset = Math.min(want, Math.max(0, window - target));
  if (seconds > 0 && !parsed.ended && offset > DEFAULT_COUNT * target) {
    lines.push(`#EXT-X-START:TIME-OFFSET=-${offset.toFixed(3).replace(/\.?0+$/, '')}`);
    // For a player that reads HOLD-BACK rather than EXT-X-START. The spec
    // floors it at three target durations, which is where this already is.
    lines.push(`#EXT-X-SERVER-CONTROL:HOLD-BACK=${offset.toFixed(3).replace(/\.?0+$/, '')}`);
  }

  let curKey = null, curMap = null;
  for (const s of segs) {
    if (s.key && s.key !== curKey) { lines.push(s.key); curKey = s.key; }
    if (s.map && s.map !== curMap) { lines.push(s.map); curMap = s.map; }
    for (const tag of s.tags) lines.push(tag);
    lines.push(s.uri);
  }
  if (parsed.ended) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/**
 * The playlist a player gets, given how much extra buffer was asked for.
 *
 * Every media playlist that passes through is remembered whatever the answer,
 * because the viewer who asks for a buffer next is only served one if there
 * is already something to serve. A body that is not a media playlist, or a
 * request for no extra buffer at all, comes back exactly as it arrived.
 */
function applyBuffer(body, { key, seconds = 0, retained = false, now = Date.now() } = {}) {
  const parsed = parse(body);
  if (!parsed || !key) return { body, parsed: null, state: null };
  const st = remember(key, parsed, now);
  const want = bufferSeconds(seconds);
  if (!want) return { body, parsed, state: st };
  // Whether this host's dropped segments may be served is a question about
  // addresses this file does not resolve, so the caller answers it once the
  // playlist has been read.
  const keep = typeof retained === 'function' ? !!retained(st, parsed) : !!retained;
  const out = render(st, parsed, want, { retained: keep });
  return { body: out || body, parsed, state: st };
}

/** The segments remembered for this stream that its source no longer lists. */
function expiredSegments(st, parsed) {
  if (!st || !parsed) return [];
  const live = new Set(parsed.segs.map(s => s.uri));
  return st.segs.filter(s => !live.has(s.uri));
}

// ─── Does this host keep a segment it has stopped listing? ──────────────────
// One range request per host, the same shape segmentPolicy uses, and the
// answer stands for hours. Unknown means no: the deep window waits for
// evidence rather than assuming it.

const RETENTION_TTL_MS = 6 * 60 * 60 * 1000;
const RETENTION_MISS_TTL_MS = 30 * 60 * 1000;
const RETENTION_ERROR_TTL_MS = 2 * 60 * 1000;
const PROBE_MS = 6000;
const PROBE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const kept = new Map();      // host -> { ok, until }
const asking = new Set();    // hosts with a probe in flight

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}

/** What is known right now, without asking anything. */
function retentionOk(url) {
  const e = kept.get(hostOf(url));
  return !!(e && e.ok && Date.now() < e.until);
}

/**
 * Ask, once, whether a segment this host has dropped can still be fetched.
 * Fire and forget: the answer is for the next playlist, not this one.
 */
async function askRetention(sampleUrl, referer = '', origin = '', deps = null) {
  const host = hostOf(sampleUrl);
  if (!host || asking.has(host)) return;
  const e = kept.get(host);
  if (e && Date.now() < e.until) return;
  asking.add(host);
  try {
    const fetchHead = (deps && deps.fetch) || defaultProbe;
    const headers = { 'User-Agent': PROBE_UA, Range: 'bytes=0-1' };
    if (referer) headers.Referer = referer;
    if (origin) headers.Origin = origin;
    const status = await fetchHead(sampleUrl, headers);
    const ok = status >= 200 && status < 300;
    kept.set(host, { ok, until: Date.now() + (ok ? RETENTION_TTL_MS : RETENTION_MISS_TTL_MS) });
  } catch (err) {
    kept.set(host, { ok: false, until: Date.now() + RETENTION_ERROR_TTL_MS });
  } finally {
    asking.delete(host);
  }
}

async function defaultProbe(url, headers) {
  const { request } = require('undici');
  const { assertPublicUrl, publicAgent } = require('./netGuard');
  await assertPublicUrl(url);
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), PROBE_MS);
  try {
    const res = await request(url, {
      method: 'GET', headers, signal: control.signal,
      dispatcher: publicAgent(), maxRedirections: 2
    });
    try { await res.body.dump(); } catch (e) { /* nothing to read */ }
    return res.statusCode;
  } finally { clearTimeout(timer); }
}

module.exports = {
  applyBuffer, bufferSeconds, expiredSegments, retentionOk, askRetention,
  MAX_SECONDS,
  _internal: {
    parse, remember, render, streams, kept,
    reset() { streams.clear(); kept.clear(); asking.clear(); },
    setRetention(host, ok) { kept.set(host, { ok, until: Date.now() + RETENTION_TTL_MS }); }
  }
};
