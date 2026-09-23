// Opened only because a viewer asked.
//
// DaddyLive refuses an address that opens its pages in bulk. A throwaway
// server warming and sweeping its channels opened 125 of them in thirteen
// minutes on 2026-09-23 and got this server refused outright. So the two
// background jobs that open channels on their own -- the warm-up and the
// channel health sweep -- leave it alone, and only a viewer's click opens one.
// The sweep must also not hide a channel it never looked at.
//
//   node tests/on-demand-sources.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosports-ondemand-'));

const { asValue } = require('awilix');
const container = require('../src/container');
const streams = require('../src/streams');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}${ok ? '' : `  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`}`);
};

const opened = { daddylive: 0, usatv: 0 };
const matches = [
  { id: 'dl_only', title: 'ESPN USA', category: 'networks', date: '0', sources: [{ source: 'daddylive', id: '51' }] },
  { id: 'usatv_only', title: 'ESPN', category: 'networks', date: '0', sources: [{ source: 'usatv', id: 'espn' }] },
  { id: 'both', title: 'ESPN', category: 'networks', date: '0',
    sources: [{ source: 'usatv', id: 'espn' }, { source: 'daddylive', id: '51' }] }
];
container.register({
  cacheService: asValue({ getMatches: () => matches }),
  streamResolveCache: asValue({
    get: () => undefined,
    getOrCreate: (key, fn) => fn(),
    noteFailure() {}, noteSuccess() {}
  }),
  // Both answer "nothing": what is being counted is whether they were asked.
  daddyLiveProvider: asValue({ resolveStream: async () => { opened.daddylive++; return []; } }),
  usaTvProvider: asValue({ resolveStream: async () => { opened.usatv++; return []; } })
});

const outcome = p => p.then(n => ({ count: n }), e => ({ unknown: e.message }));
const reset = () => { opened.daddylive = 0; opened.usatv = 0; };

(async () => {
  // ─── The health sweep ──────────────────────────────────────────────────────
  reset();
  let r = await outcome(streams.countChannelStreams('usatv_only'));
  t({ count: 0 }, r, 'control: a channel whose only source says "none" is counted empty');

  reset();
  r = await outcome(streams.countChannelStreams('dl_only'));
  t(0, opened.daddylive, 'the sweep never opens a DaddyLive channel');
  t(true, 'unknown' in r, '  and calls the answer unknown, which never hides a channel');

  reset();
  r = await outcome(streams.countChannelStreams('both'));
  t([1, 0], [opened.usatv, opened.daddylive], 'a merged channel: the other source is checked, DaddyLive is not');
  t(true, 'unknown' in r, '  and the others finding nothing does not make it empty');

  // ─── The warm-up ───────────────────────────────────────────────────────────
  reset();
  await streams.prewarmMatch(matches[2], {});
  t([1, 0], [opened.usatv, opened.daddylive], 'the warm-up warms the other sources and leaves DaddyLive alone');

  reset();
  await streams.prewarmMatch(matches[0], {});
  t(0, opened.daddylive, 'a DaddyLive-only channel is not warmed at all');

  reset();
  await streams.prewarmMatch(matches[2], {}, undefined, { viewer: true });
  t([1, 1], [opened.usatv, opened.daddylive], 'a viewer opening the channel warms DaddyLive too: that is their click');

  t(true, streams._ON_DEMAND_SOURCES.has('daddylive'), 'DaddyLive is the on-demand source');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
