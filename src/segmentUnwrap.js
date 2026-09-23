/**
 * segmentUnwrap.js — the video inside a chunk dressed up as an image.
 *
 * Streamed.pk's CDN serves its media from a TikTok bucket, and every chunk
 * arrives as `…~tplv-tiktokx-origin.image`, Content-Type image/webp, opening
 * with a fake WebP/EXIF header:
 *
 *   52 49 46 46 e2 27 1e 00 57 45 42 50 56 50 38 4c  RIFF.'..WEBPVP8L
 *   …                                   47 40 00 13  ....G@..
 *
 * After those 42 bytes it is an ordinary MPEG transport stream. ExoPlayer
 * never looks: the playlist says the file is a segment, so its TS extractor
 * scans forward for the sync byte and resyncs past the junk. ffmpeg -- and so
 * libmpv, which is what NuvioDesktop and the iPhone app play through -- probes
 * the head of the file, finds an image, and stops. Same bytes, same server;
 * one player plays them and the other does not.
 *
 * So for those players the relay hands over the transport stream alone. The
 * prefix is found, not assumed: 42 is what was measured, and a hardcoded 42
 * would break silently the day the disguise changes size. A transport stream
 * is a run of 188-byte packets that each begin 0x47, so the payload starts at
 * the first offset where that byte repeats at that stride. A chunk that is
 * already clean starts at 0 and passes through untouched; one where no stream
 * can be found is also passed through untouched rather than guessed at.
 */

'use strict';

const { Transform } = require('stream');

const TS_PACKET = 188;
const TS_SYNC = 0x47;
// Five packets in a row: one sync byte by chance is likely, five at exactly
// the right stride inside a header is not.
const SYNC_RUN = 5;
// How far into a chunk to look for the stream before giving up. The measured
// prefix is 42 bytes; a disguise a thousand times larger would still be found.
const SCAN_LIMIT = 64 * 1024;

/**
 * The offset where a transport stream begins in `buf`, or -1 if none can be
 * seen yet. -1 on a short buffer means "not enough bytes", which the stream
 * form below waits out; the caller of a complete buffer reads it as "none".
 */
function tsStart(buf, limit = SCAN_LIMIT) {
  const span = TS_PACKET * (SYNC_RUN - 1);
  const last = Math.min(limit, buf.length - span - 1);
  for (let p = 0; p <= last; p++) {
    if (buf[p] !== TS_SYNC) continue;
    let ok = true;
    for (let k = 1; k < SYNC_RUN; k++) {
      if (buf[p + TS_PACKET * k] !== TS_SYNC) { ok = false; break; }
    }
    if (ok) return p;
  }
  return -1;
}

/**
 * A stream that holds a chunk's head just long enough to find where the video
 * starts, drops everything before it, and passes the rest through as it
 * arrives. `onDecided(offset, found)` is told how many bytes were cut, and
 * whether a stream was found at all: a clean chunk is (0, true), one with no
 * recognisable stream in it is (0, false) and goes through as it came.
 */
function createUnwrap(onDecided = () => {}) {
  let head = [];
  let held = 0;
  let decided = false;

  const decide = (self, buf, offset, found) => {
    decided = true;
    head = null;
    onDecided(offset, found);
    if (buf.length > offset) self.push(offset ? buf.subarray(offset) : buf);
  };

  return new Transform({
    transform(chunk, enc, cb) {
      if (decided) return cb(null, chunk);
      head.push(chunk);
      held += chunk.length;
      const buf = head.length === 1 ? head[0] : Buffer.concat(head, held);
      head = [buf];
      const at = tsStart(buf);
      if (at >= 0) { decide(this, buf, at, true); return cb(); }
      // Far enough in that the stream would have shown itself: this chunk is
      // not what it was taken for, and is passed on exactly as it came.
      if (held >= SCAN_LIMIT + TS_PACKET * SYNC_RUN) { decide(this, buf, 0, false); return cb(); }
      cb();
    },
    flush(cb) {
      if (!decided && head && held) {
        const buf = head.length === 1 ? head[0] : Buffer.concat(head, held);
        const at = tsStart(buf);
        decide(this, buf, at >= 0 ? at : 0, at >= 0);
      }
      cb();
    }
  });
}

/**
 * Which players need this. The link can say so outright -- a viewer who told
 * the setup page where they watch -- and otherwise the request speaks for
 * itself: libmpv identifies as "libmpv" and ffmpeg underneath it as
 * "Lavf/<version>", neither of which any other player sends. A viewer who
 * chose the TV path is never switched, whatever their user agent says.
 */
function playerMode(query = {}, userAgent = '') {
  const asked = String(query.pl || '').toLowerCase();
  if (asked === 'mpv') return 'mpv';
  if (asked === 'exo') return '';
  return /\b(lavf|libmpv|mpv)\b/i.test(String(userAgent || '')) ? 'mpv' : '';
}

module.exports = { tsStart, createUnwrap, playerMode, TS_PACKET, SCAN_LIMIT };
