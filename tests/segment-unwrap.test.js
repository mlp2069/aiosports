// A chunk disguised as an image, and the players that believe the disguise.
//
// Streamed.pk's chunks come from a TikTok bucket wrapped in a 42-byte fake
// WebP/EXIF header. ExoPlayer resyncs past it; libmpv (NuvioDesktop, the
// iPhone app) probes the head, finds an image and refuses to play. For libmpv
// the relay now cuts the disguise off. For every other player nothing changes,
// and the most important test here is the one that says so byte for byte.
//
//   node tests/segment-unwrap.test.js
const { tsStart, createUnwrap, playerMode } = require('../src/segmentUnwrap');
const { rewritePlaylist } = require('../src/playlistRewrite');
const { verifyUnwrapQuery, verifySegmentQuery, segmentPath } = require('../src/manifestLink');
const { Readable, Writable, promises: sp } = require('stream');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}${ok ? '' : `  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`}`);
};

// The real disguise, byte for byte, as captured from lb*.strmd.st's TikTok
// bucket on 2026-09-22: RIFF .... WEBPVP8L .... EXIF .... then the stream.
const DISGUISE = Buffer.from(
  '52494646e2271e00574542505650384c0d0000002f00000010071011118888fe0700455849' +
  '46c0271e00', 'hex');
// A transport stream: packets of 188 bytes, each opening 0x47, with enough
// bytes of 0x47 inside the payload to tempt a sloppy scan.
function tsPackets(n) {
  const b = Buffer.alloc(188 * n);
  for (let i = 0; i < n; i++) {
    b[188 * i] = 0x47;
    for (let j = 1; j < 188; j++) b[188 * i + j] = (i * 7 + j * 13) & 0xff;
    b[188 * i + 5] = 0x47;   // a stray sync byte that is not at the stride
  }
  return b;
}
const STREAM = tsPackets(400);                      // ~75 KB of video
const WRAPPED = Buffer.concat([DISGUISE, STREAM]);

async function run(input, sizes) {
  const parts = [];
  let at = 0, i = 0;
  while (at < input.length) { const n = sizes[i++ % sizes.length]; parts.push(input.subarray(at, at + n)); at += n; }
  const out = [];
  let decided = null;
  await sp.pipeline(
    Readable.from(parts),
    createUnwrap((cut, found) => { decided = [cut, found]; }),
    new Writable({ write(c, e, cb) { out.push(c); cb(); } })
  );
  return { out: Buffer.concat(out), decided };
}

(async () => {
  // ─── Finding the stream ─────────────────────────────────────────────────
  t(42, DISGUISE.length, 'the captured disguise is 42 bytes');
  t(42, tsStart(WRAPPED), 'the stream is found right after the disguise');
  t(0, tsStart(STREAM), 'a clean chunk starts at 0');
  t(-1, tsStart(Buffer.from('RIFF not a stream at all')), 'a short buffer is "not yet", not a guess');
  t(-1, tsStart(Buffer.alloc(20000, 0x11)), 'bytes with no stream in them find nothing');
  // A stray 0x47 in the payload must not be taken for a packet start.
  t(0, tsStart(tsPackets(10)), 'a stray sync byte off the 188 stride is ignored');

  // ─── Cutting it off, however the bytes arrive ──────────────────────────
  for (const sizes of [[1], [7], [41, 1, 3], [100], [4096], [65536], [WRAPPED.length]]) {
    const { out, decided } = await run(WRAPPED, sizes);
    t(true, out.equals(STREAM), `disguise removed exactly, chunks of ${sizes.join('/')}`);
    t([42, true], decided, `  and it says it cut 42 bytes`);
  }
  {
    const { out, decided } = await run(STREAM, [1000]);
    t(true, out.equals(STREAM), 'a clean chunk passes through untouched');
    t([0, true], decided, '  as found, nothing cut');
  }
  {
    const junk = Buffer.alloc(200000, 0x5a);
    const { out, decided } = await run(junk, [8192]);
    t(true, out.equals(junk), 'a chunk with no stream in it passes through as it came');
    t([0, false], decided, '  and says nothing was found');
  }
  {
    const tiny = Buffer.from('RIFF');
    const { out } = await run(tiny, [2]);
    t(true, out.equals(tiny), 'a chunk shorter than the scan still comes out whole');
  }

  // ─── Who gets it ────────────────────────────────────────────────────────
  t('mpv', playerMode({}, 'Lavf/60.16.100'), 'ffmpeg underneath libmpv is recognised');
  t('mpv', playerMode({}, 'libmpv'), 'libmpv is recognised');
  t('mpv', playerMode({}, 'mpv 0.38.0'), 'the mpv player is recognised');
  t('', playerMode({}, 'Mozilla/5.0 (Linux; Android 13; Android TV) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'),
    'the TV (ExoPlayer) is not');
  t('', playerMode({}, 'ExoPlayerLib/2.19.1'), 'nor ExoPlayer by its own name');
  t('', playerMode({}, ''), 'nor a request with no user agent');
  t('mpv', playerMode({ pl: 'mpv' }, 'ExoPlayerLib/2.19.1'), 'a viewer who chose Mac/PC/iPhone gets it regardless');
  t('', playerMode({ pl: 'exo' }, 'Lavf/60.16.100'), 'a viewer who chose TV never does, whatever the user agent');

  // ─── The playlist ───────────────────────────────────────────────────────
  const target = 'https://lb7.strmd.st/secure/abc/1/playlist.m3u8';
  const seg = 'https://p16-common-sign.tiktokcdn-us.com/tos-x/abc~tplv-tiktokx-origin.image?x-expires=1&x-signature=Z';
  const media = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:7',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k.image"',
    '#EXTINF:4,', seg, '#EXTINF:4,', 'https://cdn.example/live/plain-0042.ts'].join('\n');
  const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1', 'https://lb7.strmd.st/secure/abc/1/low.m3u8'].join('\n');
  const opts = { targetUrl: target, finalUrl: target, referer: 'https://embed.st/', origin: 'https://embed.st', hosts: [] };

  // The TV path: not one byte different with the new option absent or false.
  const before = rewritePlaylist(media, opts);
  t(before, rewritePlaylist(media, { ...opts, unwrap: false }), 'TV path: media playlist byte-identical with unwrap off');
  t(rewritePlaylist(master, { ...opts, buf: 10 }), rewritePlaylist(master, { ...opts, buf: 10, unwrap: false }),
    'TV path: master playlist byte-identical with unwrap off');
  t(true, before.includes(seg + '#.ts'), 'TV path still hands the disguised chunk over direct with its hint');

  const mac = rewritePlaylist(media, { ...opts, unwrap: true }).split('\n');
  const chunk = mac.find(l => l.startsWith('/api/segment/'));
  t(true, !!chunk && chunk.startsWith('/api/segment/seg.ts?'), 'Mac path: the disguised chunk goes through the relay as seg.ts');
  const q = Object.fromEntries(new URL(chunk, 'http://x').searchParams);
  t('1', q.u, '  marked for unwrapping');
  t(seg, q.url, '  carrying the real upstream address');
  t(true, verifyUnwrapQuery(q), '  with a valid unwrap signature');
  t(false, verifySegmentQuery(q), '  that is not spendable as an ordinary relay link');
  t(true, mac.includes('https://cdn.example/live/plain-0042.ts'), 'Mac path: a real .ts chunk still goes direct');
  t(true, mac.some(l => l.includes('URI="https://keys.example/k.image#.ts"') || l.includes('URI="https://keys.example/k.image"')),
    'Mac path: a key is never cut, whatever it is named');
  const macMaster = rewritePlaylist(master, { ...opts, buf: 10, unwrap: true });
  t(true, /&buf=10&pl=mpv$/m.test(macMaster), 'Mac path: the variant carries the buffer and the player choice');

  // An ordinary relay link cannot be promoted by adding u=1.
  const ordinary = Object.fromEntries(new URL(segmentPath(seg, 'https://embed.st/', 'https://embed.st'), 'http://x').searchParams);
  t(false, verifyUnwrapQuery({ ...ordinary, u: '1' }), 'an ordinary relay link with u=1 added does not verify as an unwrap');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
