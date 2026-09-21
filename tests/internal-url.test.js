// Whether a link that points back at us reaches the client.
//
// Stream rows are minted with BASE_URL on the front, and with ADDON_URL unset
// -- the documented default -- BASE_URL is the machine's own address, which in
// a container is the Docker bridge. The rewriter is the only thing that
// replaces it with the host the request actually came in on.
//
// v1.6.3 gave the proxy path a .m3u8 extension. The absolute-form pattern
// demanded '?', '/' or end-of-string right after "manifest", so it stopped
// matching, and every proxied row went to the TV addressed 172.24.0.2:7000.
// Nothing server-side could see it: the playlist answered 200 to anyone who
// could reach the server, and the player never could. /img and /logo still
// matched, so the artwork kept loading while playback died.
//
// Nothing tested this code, which is why it shipped.
//
//   node tests/internal-url.test.js
const { internalPath, rewriteInternalUrl } = require('../src/internalUrl');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

const PUB = 'https://sports.example.org';
const BRIDGE = 'http://172.24.0.2:7000';
const to = (u) => rewriteInternalUrl(u, PUB);
const host = (u) => { try { return new URL(u).host; } catch { return null; } };

// ─── The outage, exactly ────────────────────────────────────────────────────
const BROKEN = `${BRIDGE}/api/manifest.m3u8?url=https%3A%2F%2Flb20.strmd.st%2Fsecure%2Fx&sig=abc`;
t(PUB, to(BROKEN).slice(0, PUB.length), 'a proxy row minted on the bridge address is readdressed');
t('sports.example.org', host(to(BROKEN)), 'and the host is the one the client asked for');
t(false, to(BROKEN).includes('172.24.0.2'), 'the container address is gone');
t(true, to(BROKEN).includes('sig=abc'), 'the signature survives the rewrite');
t(true, to(BROKEN).includes('url=https%3A%2F%2Flb20.strmd.st'), 'and so does the upstream, still encoded');

// Both spellings, both forms.
for (const p of ['/api/manifest', '/api/manifest.m3u8']) {
  t(`${PUB}${p}?url=x&sig=y`, to(`${p}?url=x&sig=y`), `relative ${p} is made absolute`);
  t(`${PUB}${p}?url=x&sig=y`, to(`${BRIDGE}${p}?url=x&sig=y`), `absolute ${p} is readdressed`);
  t(`${PUB}${p}?url=x`, to(`https://old-host.example${p}?url=x`), `a stale base on ${p} is replaced`);
}

// ─── The other routes must not have been collateral ─────────────────────────
t(`${PUB}/img?url=z`, to(`${BRIDGE}/img?url=z`), '/img still rewritten');
t(`${PUB}/img/event?id=1`, to(`${BRIDGE}/img/event?id=1`), '/img/event still rewritten');
t(`${PUB}/img/matchup?a=1`, to('/img/matchup?a=1'), '/img/matchup relative still rewritten');
t(`${PUB}/watch?x=1`, to(`${BRIDGE}/watch?x=1`), '/watch still rewritten');
t(`${PUB}/logo`, to(`${BRIDGE}/logo`), '/logo with no query still rewritten');
// Segment links are written into a playlist as relative paths and resolved by
// the player against the playlist's own address, so they never pass through
// here and must not be claimed by it.
const SEG = `${BRIDGE}/api/segment/seg.ts?url=x`;
t(SEG, to(SEG), 'a segment link is not the rewriter\'s business');
t(null, internalPath('/api/segment/seg.ts?url=x'), 'nor is the relative form');

// ─── What must be left alone ────────────────────────────────────────────────
const UPSTREAM = 'https://cdnlivetv.tv/secure/api/v1/6a288d2e/index.m3u8?tok=1';
t(UPSTREAM, to(UPSTREAM), 'a direct CDN row is untouched');
t(null, internalPath(UPSTREAM), 'and is not recognised as ours');

// A foreign link that merely mentions our path inside its query must not be
// hijacked -- that would send a viewer's request to the wrong server.
const DECOY = 'https://evil.example/x.m3u8?next=/api/manifest';
t(DECOY, to(DECOY), 'our path inside someone else\'s query is not a match');
const DECOY2 = 'https://evil.example/api/manifest.m3u8.mp4?x=1';
t(DECOY2, to(DECOY2), 'a lookalike path with a second extension is not a match');

t(null, internalPath(null), 'null is not a path');
t(null, internalPath(undefined), 'undefined is not a path');
t(null, internalPath(42), 'a number is not a path');
t(42, rewriteInternalUrl(42, PUB), 'a non-string is returned unchanged');
t('', rewriteInternalUrl('', PUB), 'an empty string is returned unchanged');

// ─── The next extension must not repeat this ────────────────────────────────
t(`${PUB}/api/manifest.mpd?url=x`, to(`${BRIDGE}/api/manifest.mpd?url=x`), 'a future .mpd is already covered');
t(`${PUB}/api/manifest.m3u`, to(`${BRIDGE}/api/manifest.m3u`), 'an extension with no query is covered');

// ─── Our own files are not named after their routes ─────────────────────────
// The addon's logo is served as /logo-v2.png. A relative path can only have
// been written by us, so a prefix match is what the rewriter always used --
// and when that was tightened to require the path to end after "logo", the
// manifest advertised a relative logo and clients showed a blank square.
t(`${PUB}/logo-v2.png`, to('/logo-v2.png'), 'the logo file is made absolute');
t(`${PUB}/logo-v2.png?v=3`, to('/logo-v2.png?v=3'), 'even with a cache-buster');
t('/logo-v2.png', internalPath('/logo-v2.png'), 'and is recognised as ours');
t(`${PUB}/img-cover.png`, to('/img-cover.png'), 'the same holds for an /img file');

// A foreign absolute url that merely looks like one of our files is still not
// ours to readdress -- only relative paths get the loose match.
t('https://cdn.example/logo-v2.png', to('https://cdn.example/logo-v2.png'),
  'someone else\'s logo file is left alone');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
