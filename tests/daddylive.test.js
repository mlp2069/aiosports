// DaddyLive over the home route.
//
// DaddyLive signs each playlist for the IP that fetched the embed page and
// refuses datacenter addresses, so its site, the embed page and the playlist
// go through a WireGuard tunnel to a home connection (src/egress.js) while the
// video goes direct, from the player. These tests
// hold what that decides: what is routed, what is decoded, that the provider
// says nothing at all while the route is down, and that it never opens the
// site faster than a person would -- a sweep that did got this server refused.
//
//   node tests/daddylive.test.js

// Pointed at a port nothing listens on, before anything reads it.
process.env.EGRESS_PROXY = 'http://127.0.0.1:1';
delete process.env.EGRESS_HOSTS;
process.env.DADDYLIVE_RESOLVES_PER_HOUR = '3';
process.env.DADDYLIVE_RESOLVE_GAP_MS = '5';

// The embed page is fetched with safeFetch, destructured when the provider
// loads, so the stub goes in first. Whether the route is up is switchable for
// the same reason; the real check is kept for the test that exercises it.
const impitPath = require.resolve('../src/impitClient');
const realImpit = require(impitPath);
let embedFetch = null;
require.cache[impitPath].exports = {
  ...realImpit,
  safeFetch: async (url, opts) => (embedFetch ? embedFetch(url, opts) : realImpit.safeFetch(url, opts))
};
const egressPath = require.resolve('../src/egress');
const egress = require(egressPath);
let routeUp = null;   // null: ask the real proxy
require.cache[egressPath].exports = {
  ...egress,
  egressAvailable: () => (routeUp === null ? egress.egressAvailable() : Promise.resolve(routeUp))
};

const DL = require('../src/providers/DaddyLiveProvider');
const { decodeEconfig, parseChannels, cleanUrl } = DL._internal;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  t(true, egress.needsEgress('https://dlive.sx/24-7-channels.php'), 'the channel list goes home: the site refuses this server');
  t(true, egress.needsEgress('https://dlstreams.st/stream/stream-51.php'), 'so do the channel pages, on either domain');
  t(false, egress.needsEgress('https://x.example/hls/seg-1.ts'), 'the video does not: the player fetches it direct');
  t(false, egress.needsEgress('https://lb7.strmd.st/secure/x/playlist.m3u8'), 'other sources are untouched');
  t(false, egress.needsEgress('https://evil7odxv0l067ka.net/x'), 'a lookalike domain is not a match');
  t('http://127.0.0.1:1', egress.egressProxyFor('https://assetrage.net/e/x'), 'a routed host is given the proxy');
  t(null, egress.egressProxyFor('https://lb7.strmd.st/'), 'an unrouted one is not');

  // ─── One User-Agent on the route ──────────────────────────────────────────
  // The token is bound to the User-Agent that fetched the embed page, as well as
  // to the address: minted with one browser string and read with another, it is
  // refused. So the route replaces whatever each caller sends with its own.
  const off = { 'User-Agent': 'caller', Referer: 'r' };
  t(off, egress.egressHeaders('https://lb7.strmd.st/', off), 'off the route, headers pass untouched');
  const on = egress.egressHeaders('https://x.7odxv0l067ka.net/hls/a.m3u8', { 'user-agent': 'Chrome/127', Referer: 'https://assetrage.net/' });
  t(egress.EGRESS_UA, on['User-Agent'], "on it, the route's own User-Agent, whatever the caller sent");
  t(undefined, on['user-agent'], '  with no second copy under another spelling');
  t('https://assetrage.net/', on.Referer, '  and every other header kept');
  const embed = egress.egressHeaders('https://assetrage.net/e/x', { Referer: 'p' });
  t(egress.EGRESS_UA, embed['User-Agent'], 'the embed page gets the same one, even from a caller that sent none');
  t(on['User-Agent'], embed['User-Agent'], 'minting and reading therefore always agree');

  // ─── The signature never reaches a log ─────────────────────────────────────
  const { redactUrl } = require('../src/redact');
  const logged = redactUrl('https://e8975o.7odxv0l067ka.net:8443/hls/abc.m3u8?s=S7OkwVXSh11km3g&e=1790149206');
  t(false, logged.includes('S7OkwVXSh11km3g'), 'the s= signature is masked');
  t(true, logged.includes('e=1790149206'), 'the e= expiry stays readable');

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

  // ─── Opened only as fast as a person would ────────────────────────────────
  routeUp = true;
  const want2 = 'https://x1.7odxv0l067ka.net:8443/hls/abc.m3u8?s=SIG&e=1';
  const site = (p) => {
    const seen = { pages: 0, embeds: 0, active: 0, most: 0 };
    p.fetchFromHosts = async (path) => {
      seen.pages++; seen.active++; seen.most = Math.max(seen.most, seen.active);
      await sleep(15);
      seen.active--;
      const id = (path.match(/stream-(\d+)/) || [])[1];
      // Channel 404 is a page with no player on it.
      return { text: async () => (id === '404' ? '<p>offline</p>' : `<iframe src="https://assetrage.net/e/ch${id}"></iframe>`) };
    };
    embedFetch = async () => {
      seen.embeds++;
      return { ok: true, status: 200, text: async () => `<script>var _econfig = '${encodeEconfig({ stream_url: want2 })}';</script>` };
    };
    return seen;
  };

  let q = new DL({ circuitBreaker: new CB() });
  let seen = site(q);
  const [a, b] = await Promise.all([q.resolveStream('51', 'networks', 'ESPN USA'), q.resolveStream('51', 'networks', 'ESPN USA')]);
  t([1, 1], [a.length, b.length], 'two asks for one channel at once both get the stream');
  t([1, 1], [seen.pages, seen.embeds], '  from a single opening: one channel page, one embed page');
  t('ESPN USA', a[0].title, 'the row is titled with the channel alone, not "DaddyLive ESPN USA"');
  t('https://assetrage.net/', a[0].behaviorHints.proxyHeaders.request.Referer, 'the row tells the player the Referer the video needs');
  await q.resolveStream('51', 'networks', 'ESPN USA');
  t(1, seen.pages, 'asked again within the hour: answered from memory, the site not asked');

  await Promise.all([q.resolveStream('52', 'networks', 'A'), q.resolveStream('53', 'networks', 'B')]);
  t(1, seen.most, 'two different channels are opened one after the other, never together');
  t(3, seen.pages, '  one page each');

  const over = await q.resolveStream('54', 'networks', 'C');
  t([], over, 'past the hourly cap nothing more is opened');
  t(3, seen.pages, '  and the site is not asked at all');

  q = new DL({ circuitBreaker: new CB() });
  seen = site(q);
  t([], await q.resolveStream('404', 'networks', 'Offline'), 'a channel with no player yields nothing');
  const pagesAfterDead = seen.pages;
  t([], await q.resolveStream('404', 'networks', 'Offline'), 'and asked again straight away');
  t(pagesAfterDead, seen.pages, '  it is not opened a second time');

  // ─── The channel list, fetched rarely and kept ─────────────────────────────
  q = new DL({ circuitBreaker: new CB() });
  let lists = 0, listFails = false;
  q.fetchChannels = { fire: async () => { lists++; if (listFails) throw new Error('refused'); return page; } };
  t(3, (await q.getMatches()).length, 'the channel list is listed');
  await q.getMatches();
  t(1, lists, 'a second sync inside six hours does not fetch it again');
  q._list.at -= 7 * 60 * 60 * 1000;
  listFails = true;
  t(3, (await q.getMatches()).length, 'past six hours, a failed fetch keeps the list it had');
  await q.getMatches();
  t(2, lists, '  and waits before asking again, rather than asking on every sync');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
