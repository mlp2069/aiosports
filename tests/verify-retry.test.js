// A blip is not a verdict.
//
// The pre-flight check dropped a stream on a single bad answer. Its own
// comment said a throttle or a timeout "has said nothing about the stream
// itself" -- and then dropped the row anyway, which is a working stream lost
// to one bad moment. A transient answer is now asked a second time; a 404 or a
// 403 is an answer about the stream and is still taken at its word.
//
//   node tests/verify-retry.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosports-retry-'));
process.env.VERIFY_RETRY_DELAY_MS = '1';   // no real waiting in tests

// The fetch has to be stubbed before streams.js destructures it at require time.
const impitPath = require.resolve('../src/impitClient');
const realImpit = require(impitPath);
let calls = [];
let script = [];
require.cache[impitPath].exports = {
  ...realImpit,
  safeFetch: async (url) => {
    calls.push(url);
    const next = script.shift();
    if (!next) throw new Error('fetch called more times than the test scripted');
    if (next.throw) throw new Error(next.throw);
    return { status: next.status, text: async () => next.body === undefined ? '#EXTM3U\n#EXT-X-VERSION:3\n' : next.body };
  },
};

const streams = require('../src/streams');
const verifyStreams = streams._verifyStreams;
const isTransientCheck = streams._isTransientCheck;

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

const resolveCache = { noteFailure() {}, noteSuccess() {} };
// The verifier reads quality off the playlist head once the checks pass; a
// stub is enough, but it must exist -- passing null made every success path
// throw and look like a drop.
const m3u8Parser = { parseManifestText: () => null };
const row = () => ([{ url: 'https://cdn.example/live/stream.m3u8', name: 'x', title: 'x', _source: 'watchfooty' }]);
const run = async (plan) => {
  script = plan; calls = [];
  const out = await verifyStreams(row(), null, m3u8Parser, resolveCache, {});
  return { kept: out.filter(Boolean).length, attempts: calls.length };
};

(async () => {
  // ─── What the fix is for ──────────────────────────────────────────────────
  let r = await run([{ status: 503 }, { status: 200 }]);
  t({ kept: 1, attempts: 2 }, r, 'a 503 then a good answer: the stream survives');

  r = await run([{ throw: 'socket hang up' }, { status: 200 }]);
  t({ kept: 1, attempts: 2 }, r, 'a dropped socket then a good answer: survives');

  r = await run([{ status: 429 }, { status: 200 }]);
  t({ kept: 1, attempts: 2 }, r, 'a throttle then a good answer: survives');

  r = await run([{ status: 408 }, { status: 200 }]);
  t({ kept: 1, attempts: 2 }, r, 'a request timeout then a good answer: survives');

  // ─── What must still be dropped ───────────────────────────────────────────
  r = await run([{ status: 404 }]);
  t({ kept: 0, attempts: 1 }, r, 'a 404 is about the stream: dropped, and not asked twice');

  r = await run([{ status: 403 }]);
  t({ kept: 0, attempts: 1 }, r, 'a 403 is about the stream: dropped, and not asked twice');

  r = await run([{ status: 503 }, { status: 503 }]);
  t({ kept: 0, attempts: 2 }, r, 'a host that is genuinely down is dropped after the second ask');

  r = await run([{ throw: 'timeout' }, { throw: 'timeout' }]);
  t({ kept: 0, attempts: 2 }, r, 'two timeouts: dropped');

  r = await run([{ status: 200, body: 'Not found' }]);
  t({ kept: 0, attempts: 1 }, r, 'a fake 200 with no #EXT is dropped without a retry');

  // ─── Exactly one retry, never a storm ─────────────────────────────────────
  r = await run([{ status: 500 }, { status: 502 }]);
  t({ kept: 0, attempts: 2 }, r, 'the second answer stands; there is no third attempt');

  // ─── The classification itself ────────────────────────────────────────────
  t(true, isTransientCheck(500), '500 is transient');
  t(true, isTransientCheck(502), '502 is transient');
  t(true, isTransientCheck(503), '503 is transient');
  t(true, isTransientCheck(429), '429 is transient');
  t(true, isTransientCheck(408), '408 is transient');
  t(false, isTransientCheck(404), '404 is not transient');
  t(false, isTransientCheck(403), '403 is not transient');
  t(false, isTransientCheck(200), '200 is not transient');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
