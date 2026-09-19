// The extra buffer: what a player is served when a viewer asks for one.
//
// The owner's report: streams do not really break, but they microbuffer --
// "the stream catches up too fast then buffers". Measured on this addon's own
// sources: WatchFooty lists four segments (16s) and pauses eight seconds
// seven times in under two minutes; a player starting three segments from the
// end has twelve seconds of cushion and an eight second pause spends most of
// it. The fix is a deeper window and a player told to start further back in
// it -- and, above all, a live edge that still ends where the source's does.
//
//   node tests/live-delay.test.js
const { applyBuffer, bufferSeconds, expiredSegments, _internal } = require('../src/liveDelay');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

const seg = (n) => `https://cdn.example/live/seg${n}.ts`;
const playlist = (seq, first, count, opts = {}) => {
  const { target = 4, dur = 4, keys = {} } = opts;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${seq}`];
  for (let i = first; i < first + count; i++) {
    if (keys[i]) lines.push(keys[i]);
    lines.push(`#EXTINF:${dur.toFixed(3)},`);
    lines.push(seg(i));
  }
  return lines.join('\n') + '\n';
};
const body = (out) => out.body;
const lines = (s) => s.split('\n').filter(Boolean);
const tagOf = (s, tag) => lines(s).find(l => l.startsWith(tag)) || '';
const uris = (s) => lines(s).filter(l => !l.startsWith('#'));

// ─── A body that is not a media playlist is not touched ─────────────────────
_internal.reset();
{
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000\nhttps://cdn.example/v/720.m3u8\n';
  t(master, body(applyBuffer(master, { key: 'k', seconds: 30, retained: true })), 'a master playlist passes through');
  t(true, _internal.streams.size === 0, 'a master playlist is not remembered');
}

// ─── No buffer asked for is the playlist as it arrived ──────────────────────
_internal.reset();
{
  const p = playlist(0, 0, 4);
  t(p, body(applyBuffer(p, { key: 'k', seconds: 0, retained: true })), 'seconds=0 hands back the source playlist');
  t(4, _internal.streams.get('k').segs.length, 'it is remembered all the same');
}

// ─── A four segment window is too shallow to promise anything ───────────────
_internal.reset();
{
  const out = body(applyBuffer(playlist(0, 0, 4), { key: 'k', seconds: 20, retained: true }));
  t('', tagOf(out, '#EXT-X-START'), 'no start offset while the window is only 16s');
  t(4, uris(out).length, 'and the window is what the source listed');
}

// ─── The window deepens as the source publishes ─────────────────────────────
_internal.reset();
{
  // A sliding four-segment window, the way WatchFooty publishes one.
  let out = '';
  for (let i = 0; i <= 8; i++) out = body(applyBuffer(playlist(i, i, 4), { key: 'k', seconds: 20, retained: true }));
  const got = uris(out);
  // Twelve segments are remembered; what goes out is as deep as the offset
  // reaches plus two segments to seek in -- 32s + 8s, so ten of them.
  t(10, got.length, 'ten segments listed once the window has filled');
  t(seg(2), got[0], 'the front has moved forward, as a live playlist\'s does');
  t(seg(11), got[got.length - 1], 'and the newest is the one the source lists now');
  t(12, _internal.streams.get('k').segs.length, 'while all twelve stay remembered for the next viewer');
  t('#EXT-X-MEDIA-SEQUENCE:2', tagOf(out, '#EXT-X-MEDIA-SEQUENCE'), 'numbering follows the front');
  // 3 x 4s of default, plus the 20s asked for, inside a 48s window.
  t('#EXT-X-START:TIME-OFFSET=-32', tagOf(out, '#EXT-X-START'), 'a player is told to start 32s back');
  t('#EXT-X-SERVER-CONTROL:HOLD-BACK=32', tagOf(out, '#EXT-X-SERVER-CONTROL'), 'and so is one that reads HOLD-BACK');
}

// ─── The offset never points past the oldest segment but one ────────────────
_internal.reset();
{
  let out = '';
  for (let i = 0; i <= 3; i++) out = body(applyBuffer(playlist(i, i, 4), { key: 'k', seconds: 300, retained: true }));
  const window = uris(out).length * 4;
  const offset = Number(/TIME-OFFSET=-([\d.]+)/.exec(tagOf(out, '#EXT-X-START'))[1]);
  t(true, offset <= window - 4, `offset ${offset} stays inside the ${window}s window`);
}

// ─── The live edge is never moved back ──────────────────────────────────────
_internal.reset();
{
  let ok = true, seqs = [];
  for (let i = 0; i <= 10; i++) {
    const out = body(applyBuffer(playlist(i, i, 4), { key: 'k', seconds: 30, retained: true }));
    const got = uris(out);
    if (got[got.length - 1] !== seg(i + 3)) ok = false;   // what the source lists last
    seqs.push(Number(/:(\d+)/.exec(tagOf(out, '#EXT-X-MEDIA-SEQUENCE'))[1]));
  }
  t(true, ok, 'every reload ends on the segment the source published last');
  t(true, seqs.every((n, i) => i === 0 || n >= seqs[i - 1]), 'the media sequence never goes backwards');
}

// ─── A host that drops its segments is served its own window ────────────────
_internal.reset();
{
  let out = '';
  for (let i = 0; i <= 8; i++) out = body(applyBuffer(playlist(i, i, 4), { key: 'k', seconds: 20, retained: false }));
  t(4, uris(out).length, 'without evidence the host keeps them, only what it lists goes out');
  t(seg(8), uris(out)[0], 'starting where the source starts');
  t('#EXT-X-MEDIA-SEQUENCE:8', tagOf(out, '#EXT-X-MEDIA-SEQUENCE'), 'and numbered as the source numbers it');
}

// ─── A key carries with the segment it applied to ───────────────────────────
_internal.reset();
{
  const k1 = '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/k1.key"';
  const k2 = '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/k2.key"';
  applyBuffer(playlist(0, 0, 4, { keys: { 0: k1 } }), { key: 'k', seconds: 20, retained: true });
  // The window slides by two, so it still overlaps what is remembered -- the
  // key the source now prints covers only the segments that arrive under it.
  const out = body(applyBuffer(playlist(2, 2, 4, { keys: { 4: k2 } }), { key: 'k', seconds: 20, retained: true }));
  const l = lines(out);
  t(true, l.indexOf(k1) !== -1 && l.indexOf(k1) < l.indexOf(seg(2)), 'the first key is written before the segments it covers');
  t(true, l.indexOf(k2) > l.indexOf(seg(3)), 'the second key is written where the source changed it');
  t(1, l.filter(x => x === k1).length, 'and neither key is repeated per segment');
}

// ─── A source that restarts is a joint, not a rewind ────────────────────────
_internal.reset();
{
  applyBuffer(playlist(0, 0, 4), { key: 'k', seconds: 20, retained: true });
  const before = Number(/:(\d+)/.exec(tagOf(body(applyBuffer(playlist(1, 1, 4), { key: 'k', seconds: 20, retained: true })), '#EXT-X-MEDIA-SEQUENCE'))[1]);
  const restarted = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n'
    + ['#EXTINF:4.000,', 'https://cdn.example/other/a.ts', '#EXTINF:4.000,', 'https://cdn.example/other/b.ts'].join('\n') + '\n';
  const out = body(applyBuffer(restarted, { key: 'k', seconds: 20, retained: true }));
  const after = Number(/:(\d+)/.exec(tagOf(out, '#EXT-X-MEDIA-SEQUENCE'))[1]);
  t(true, after >= before, 'numbering carries on forward across a restart');
  t(true, lines(out).includes('#EXT-X-DISCONTINUITY'), 'and the player is told the content changed');
  t(2, uris(out).length, 'nothing from before the restart is offered');
}

// ─── What is remembered is bounded ──────────────────────────────────────────
_internal.reset();
{
  for (let i = 0; i <= 60; i++) applyBuffer(playlist(i, i, 4), { key: 'k', seconds: 20, retained: true });
  const st = _internal.streams.get('k');
  t(30, st.segs.length, 'no more than thirty segments are kept');
  t(true, st.firstSeq === 34, 'and the numbering accounts for the ones dropped');
}

// ─── The segments a source has stopped listing ──────────────────────────────
_internal.reset();
{
  let last = null;
  for (let i = 0; i <= 5; i++) last = applyBuffer(playlist(i, i, 4), { key: 'k', seconds: 20, retained: true });
  const gone = expiredSegments(last.state, last.parsed).map(s => s.uri);
  t([seg(0), seg(1), seg(2), seg(3), seg(4)], gone, 'are the ones outside its window');
}

// ─── How much buffer a request can ask for ──────────────────────────────────
t(0, bufferSeconds(''), 'nothing asked for is no buffer');
t(0, bufferSeconds('0'), 'zero is no buffer');
t(0, bufferSeconds('-30'), 'a negative is no buffer');
t(0, bufferSeconds('banana'), 'nonsense is no buffer');
t(20, bufferSeconds('20'), 'twenty seconds is twenty seconds');
t(120, bufferSeconds('99999'), 'and there is a ceiling');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
