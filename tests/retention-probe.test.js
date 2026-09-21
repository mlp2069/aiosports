// The request the extra buffer depends on.
//
// liveDelay only serves a deep window once it has been shown that a host still
// answers for a segment it has stopped listing. That evidence comes from one
// probe, and the probe was built with two faults in the same call: it invoked
// publicAgent, which is a dispatcher instance and not a factory, and it passed
// maxRedirections, which undici refuses whenever a dispatcher is supplied.
//
// Either one throws. askRetention catches everything and writes down "this
// host does not keep its segments", so the answer was always no, on every
// host, from the day the feature shipped -- and the extra buffer did nothing
// at all on the shallow sources it was written for.
//
// Nothing caught it because every existing test injects its own fetch through
// deps.fetch, so the real request was never built. This checks the real one.
//
//   node tests/retention-probe.test.js
const { _internal } = require('../src/liveDelay');
const { publicAgent } = require('../src/netGuard');
const { request } = require('undici');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

// ─── The two faults, named ──────────────────────────────────────────────────
t('object', typeof publicAgent, 'publicAgent is a dispatcher, so it must never be called');
const opts = _internal.probeOptions({ 'User-Agent': 'x', Range: 'bytes=0-1' }, null);
t(false, typeof opts.dispatcher === 'function', 'the dispatcher is passed, not invoked');
t(true, opts.dispatcher === publicAgent, 'and it is the guarded agent itself');
t(false, 'maxRedirections' in opts, 'maxRedirections is absent: undici rejects it with a dispatcher');
t('GET', opts.method, 'a probe is a GET');
t('bytes=0-1', opts.headers.Range, 'asking for two bytes, not a segment');

// ─── undici must actually accept them ───────────────────────────────────────
// The real check: bad options fail validation before a socket is opened, so a
// connection error here means the options were accepted and a validation
// error means they were not. Nothing listens on port 1.
(async () => {
  let name = 'none';
  try {
    await request('http://127.0.0.1:1/probe', _internal.probeOptions({ 'User-Agent': 'x' }, null));
  } catch (err) {
    name = err.name || 'unknown';
  }
  t(false, name === 'InvalidArgumentError', `undici accepted the options (rejected with ${name}, not InvalidArgumentError)`);
  t(false, name === 'TypeError', 'and nothing in them was called by mistake');

  // ─── A failing probe must record a refusal, not crash ─────────────────────
  const ld = require('../src/liveDelay');
  ld._internal.reset();
  await ld.askRetention('https://203.0.113.9/never.ts', '', '', { fetch: async () => { throw new Error('down'); } });
  t(false, ld.retentionOk('https://203.0.113.9/never.ts'), 'a host that errors is not trusted');

  ld._internal.reset();
  await ld.askRetention('https://203.0.113.9/seg.ts', '', '', { fetch: async () => 206 });
  t(true, ld.retentionOk('https://203.0.113.9/seg.ts'), 'a host that answers 206 is trusted');
  t(false, ld.retentionOk('https://other.example/seg.ts'), 'and the answer does not spread to other hosts');

  ld._internal.reset();
  await ld.askRetention('https://203.0.113.9/seg.ts', '', '', { fetch: async () => 403 });
  t(false, ld.retentionOk('https://203.0.113.9/seg.ts'), 'a host that refuses is not trusted');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
