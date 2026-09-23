// DaddyLive over the home route.
//
// DaddyLive signs each playlist for the IP that fetched the embed page and
// refuses datacenter addresses, so the embed page and the playlist go through
// a WireGuard tunnel to a home connection (src/egress.js) while everything else
// -- the channel list, the channel pages, the video -- goes direct. These tests
// hold the three things that decides: what is routed, what is decoded, and
// that the provider says nothing at all while the route is down.
//
//   node tests/daddylive.test.js

// Pointed at a port nothing listens on, before anything reads it.
process.env.EGRESS_PROXY = 'http://127.0.0.1:1';
delete process.env.EGRESS_HOSTS;

const egress = require('../src/egress');
const DL = require('../src/providers/DaddyLiveProvider');
const { decodeEconfig, parseChannels, cleanUrl } = DL._internal;

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}${ok ? '' : `  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`}`);
};

// The inverse of the site's obfuscation, so the decoder is tested against a
// payload built here rather than a real signed address committed to the repo.
function encodeEconfig(obj) {
  const order = [2, 0, 3, 1];
  let json = JSON.stringify(obj);
  let inner = Buffer.from(json).toString('base64');
  while (inner.length % 4) { json += ' '; inner = Buffer.from(json).toString('base64'); }
  const k = inner.length / 4;
  const parts = [0, 1, 2, 3].map(i => inner.slice(i * k, i * k + k));   // parts[j] is out[j]
  const pieces = [];
  for (let i = 0; i < 4; i++) {
    const b = Buffer.from(parts[order[i]]).toString('base64');
    pieces.push(b.slice(0, 3) + 'X' + b.slice(3));                     // the decoy at index 3
  }
  const lens = new Set(pieces.map(p => p.length));
  if (lens.size !== 1) throw new Error('fixture pieces must be equal length');
  return Buffer.from(pieces.join('')).toString('base64');
}

(async () => {
  // ─── What goes through the tunnel ─────────────────────────────────────────
  t(true, egress.needsEgress('https://assetrage.net/e/7i3s718z15a43'), 'the embed page goes home');
  t(true, egress.needsEgress('https://4169it.7odxv0l067ka.net:8443/hls/x.m3u8?s=a&e=1'), 'the playlist goes home, whatever the subdomain');
  t(true, egress.needsEgress('https://w7.dynproclaim.net/e/abc'), 'the other embed family goes home');
  t(false, egress.needsEgress('https://dlive.sx/24-7-channels.php'), 'the channel list goes direct');
  t(false, egress.needsEgress('https://dlive.sx/stream/stream-51.php'), 'the channel page goes direct');
  t(false, egress.needsEgress('https://lb7.strmd.st/secure/x/playlist.m3u8'), 'other sources are untouched');
  t(false, egress.needsEgress('https://evil7odxv0l067ka.net/x'), 'a lookalike domain is not a match');
  t('http://127.0.0.1:1', egress.egressProxyFor('https://assetrage.net/e/x'), 'a routed host is given the proxy');
  t(null, egress.egressProxyFor('https://dlive.sx/'), 'an unrouted one is not');

  // ─── Decoding ──────────────────────────────────────────────────────────────
  const want = 'https://4169it.7odxv0l067ka.net:8443/hls/o9mvou7h7jmct.m3u8?s=SIG&e=1790147553';
  const conf = decodeEconfig(encodeEconfig({ stream_url: want, stream_url_nop2p: want }));
  t(want, conf && conf.stream_url, 'the stream address comes out of _econfig');
  t(null, decodeEconfig(''), 'empty is nothing');
  t(null, decodeEconfig('not base64 at all !!!'), 'garbage is nothing, not a crash');
  t(null, decodeEconfig(null), 'null is nothing');
  t('https://h/x.m3u8?a=1&b=2', cleanUrl('https:\\/\\/h\\/x.m3u8?a=1\\u0026b=2'), 'JSON-escaped separators are undone, keeping the token');

  // ─── The channel list ──────────────────────────────────────────────────────
  const page = `
    <a href="/watch.php?id=51"><div class="card"><div class="card__title">ESPN USA</div></div></a>
    <a href="watch.php?id=843"><div class="card__title">Pac-12 Network USA</div></a>
    <a href="/watch.php?id=51"><div class="card__title">ESPN USA</div></a>
    <a href="/watch.php?id=999"><div class="card__title">18+ Adult</div></a>
    <a href="/watch.php?id=12"><div class="card__title">A&amp;E USA</div></a>`;
  const ch = parseChannels(page);
  t(['51', '843', '12'], ch.map(c => c.id), 'every channel once, adult channels left out');
  t('A&E USA', ch[2].name, 'names have their entities decoded');

  // ─── Silent while the route is down ────────────────────────────────────────
  egress._internal.reset();
  t(false, await egress.egressAvailable(), 'a proxy that is not there is reported down');
  const CB = require('../src/services/CircuitBreakerService');
  const p = new DL({ circuitBreaker: new CB() });
  let fetched = false;
  p.fetchChannels = { fire: async () => { fetched = true; return page; } };
  t([], await p.getMatches(), 'no channels are listed while the route is down');
  t(false, fetched, 'and the channel list is not even fetched');
  t([], await p.resolveStream('51', 'networks', 'ESPN USA'), 'nor is a stream resolved');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
