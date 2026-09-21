// The extension on a proxy link.
//
// A player deciding how to open a link reads the path for an extension, and
// strips the query first. "/api/manifest?url=...m3u8" therefore told it
// nothing at all -- the .m3u8 it needed was in the part that got cut. Guessing
// wrong costs a failed open, a probe and a re-initialisation on every launch.
//
// So the link carries its own extension now. Two things must hold: the route
// answers to both spellings, and the signature must not have moved, because a
// player mid-stream keeps reloading by the link it was already handed.
//
//   node tests/manifest-path.test.js
const { manifestPath, segmentPath, verifyManifestQuery, verifySegmentQuery } = require('../src/manifestLink');
const express = require('express');
const http = require('http');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};
const parse = (p) => {
  const u = new URL(p, 'http://x');
  return { path: u.pathname, q: Object.fromEntries(u.searchParams) };
};

const UP = 'https://host.example/live/stream.m3u8?e=1758400000';
const link = parse(manifestPath(UP, 'https://ref.example/', 'https://ref.example'));

// ─── The path a player reads ────────────────────────────────────────────────
t('/api/manifest.m3u8', link.path, 'the minted path carries the extension');
t(true, /\.m3u8$/.test(link.path), 'the extension is last, where a player looks');
t(1, link.path.split('.m3u8').length - 1, 'exactly one extension, not doubled');
t('manifest.m3u8', link.path.split('/').pop(), 'the filename alone has it too');

// A client strips the query before looking. That is the whole point.
t('m3u8', link.path.split('?')[0].split('.').pop(), 'survives cutting the query');

// ─── The signature did not move ─────────────────────────────────────────────
// Verification reads the query alone, never the path, which is what keeps a
// link minted before this change alive across the deploy that ships it.
t(true, verifyManifestQuery(link.q), 'a freshly minted link verifies');

// The same query under the old path: byte for byte what an already-running
// player is holding right now.
const queryOnly = manifestPath(UP, 'https://ref.example/', 'https://ref.example').split('?')[1];
const legacy = parse('/api/manifest?' + queryOnly);
t('/api/manifest', legacy.path, 'the legacy link really is the old path');
t(true, verifyManifestQuery(legacy.q), 'a link on the old path still verifies');
t(link.q.sig, legacy.q.sig, 'both spellings carry the identical signature');

// A tampered link must still fail: the extension changed nothing about that.
t(false, verifyManifestQuery({ ...link.q, url: 'https://evil.example/x.m3u8' }), 'a swapped url is rejected');
t(false, verifyManifestQuery({ ...link.q, sig: 'x'.repeat(32) }), 'a forged signature is rejected');
t(false, verifyManifestQuery({ ...link.q, sig: undefined }), 'a missing signature is rejected');

// The two routes stay separate: a playlist link is not a segment link.
t(false, verifySegmentQuery(link.q), 'a manifest link does not verify as a segment');

// ─── Segments are untouched ─────────────────────────────────────────────────
const seg = parse(segmentPath('https://host.example/live/chunk-42.ts', '', ''));
t(true, verifySegmentQuery(seg.q), 'a segment link verifies as a segment');
t(false, verifyManifestQuery(seg.q), 'and not as a manifest');
t('/api/segment/chunk-42.ts', seg.path, 'segment links keep their own name');
t(true, !seg.path.includes('m3u8'), 'a segment is not labelled a playlist');

// ─── The route answers to both ──────────────────────────────────────────────
// Express escapes a dot in a path string, but that is a claim about a library
// version, so ask the router instead of trusting it.
const app = express();
app.get(['/api/manifest', '/api/manifest.m3u8'], (req, res) => res.end('hit:' + req.path));
const srv = http.createServer(app).listen(0, async () => {
  const port = srv.address().port;
  const get = (p) => new Promise((resolve) => {
    http.get({ port, path: p }, (r) => {
      let b = ''; r.on('data', (d) => (b += d));
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
  });

  const withQ = '?' + manifestPath(UP, '', '').split('?')[1];
  const a = await get('/api/manifest.m3u8' + withQ);
  const b = await get('/api/manifest' + withQ);
  const c = await get('/api/manifestXm3u8' + withQ);

  t(200, a.status, 'the new spelling reaches the route');
  t('hit:/api/manifest.m3u8', a.body, 'and arrives as itself');
  t(200, b.status, 'the old spelling still reaches the route');
  t('hit:/api/manifest', b.body, 'and arrives as itself');
  t(404, c.status, 'the dot is literal, not a wildcard');

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
