// Recognising the same feed under a new address.
//
// The owner's report: "i was just watching espn through timstreams and it
// dropped then i refreshed streams and it was gone". Measured on the live
// rows: TotalSportek hands out an address carrying ?e= that dies about thirty
// minutes after it is minted -- halfway through a football match -- while
// WatchFooty puts a six hour expiry in the path. The stream is still on; the
// address is what goes stale.
//
// The addresses below are the real shapes, with the tokens replaced.
//
//   node tests/remint.test.js
const remint = require('../src/remint');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

// TotalSportek: the feed is the `path` hash; `e` and `sig` are the moment.
const TSK = (e, sig) =>
  `https://hls.hockey.do/secure_hls.php?path=c39a7e658e9c50b484d2e841aebb3181%2Findex.m3u8&e=${e}&sig=${sig}`;
// A different game on the same host.
const TSK_OTHER =
  'https://hls.hockey.do/secure_hls.php?path=9f1e2d3c4b5a69788796a5b4c3d2e1f0%2Findex.m3u8&e=1789999999&sig=ZZZZ';
// WatchFooty: /secure/<token>/<flavour>/<slug>/<stream no>/<match id>/<expiry>/<file>
const WF = (tok, exp, num = '1') =>
  `https://lb6.wfty.st/secure/${tok}/hd/arsenal-vs-chelsea/${num}/4757668/${exp}/index.m3u8`;

// ─── The same feed, minted again ────────────────────────────────────────────
t(true, remint.sameFeed(TSK('1789922808', 'mSGTLUfE1BXsBUQRDKUV'), TSK('1789926408', 'QQQQbbbbCCCCddddEEEE')),
  'TotalSportek: a new expiry and signature is the same feed');
t(true, remint.sameFeed(WF('a1b2c3d4e5f60718293a4b5c6d7e8f90', '1789950000'), WF('0f9e8d7c6b5a49382716f5e4d3c2b1a0', '1789971600')),
  'WatchFooty: a new token and expiry is the same feed');

// ─── Not the same feed ──────────────────────────────────────────────────────
t(false, remint.sameFeed(TSK('1789922808', 'aaaa'), TSK_OTHER),
  'TotalSportek: a different path hash is a different game');
t(false, remint.sameFeed(WF('tok11111111111111111111', '1789950000', '1'), WF('tok22222222222222222222', '1789950000', '2')),
  'WatchFooty: a different stream number is a different feed');
t(false, remint.sameFeed(TSK('1789922808', 'aaaa'), 'https://lb6.wfty.st/secure/x/hd/a/1/2/1789950000/index.m3u8'),
  'a different host is never the same feed');

// ─── Picking the replacement out of a freshly resolved list ─────────────────
{
  const dead = TSK('1789922808', 'mSGTLUfE1BXsBUQRDKUV');
  const fresh = [TSK_OTHER, TSK('1789926408', 'NEWSIGNATURE0000'), WF('tok11111111111111111111', '1789950000')];
  t(TSK('1789926408', 'NEWSIGNATURE0000'), remint.pickFresh(dead, fresh),
    'the exact same feed is chosen over another game on the same host');

  t(null, remint.pickFresh(dead, [WF('tok11111111111111111111', '1789950000')]),
    'nothing on the dead address\'s host means nothing to substitute');

  t(null, remint.pickFresh(dead, []), 'an empty list substitutes nothing');

  // A provider that changed its address scheme entirely: same host, no exact
  // match. Better to hand back another feed of the same match than nothing.
  const reshaped = 'https://hls.hockey.do/secure_hls.php?path=totally-different%2Findex.m3u8&e=1&sig=b';
  t(reshaped, remint.pickFresh(dead, [reshaped]),
    'a reshaped address on the same host is still offered');
}

// ─── What an expired address looks like coming back ─────────────────────────
t(true, remint.looksExpired({ status: 403 }), '403 is how most of them say it');
t(true, remint.looksExpired({ status: 401 }), 'so is 401');
t(true, remint.looksExpired({ status: 404 }), 'and 404, which several use for a stale token');
t(true, remint.looksExpired({ status: 410 }), 'and 410');
t(true, remint.looksExpired({ status: 200, body: 'Not found' }),
  'a polite 200 whose body is not a playlist is an expiry too');
t(false, remint.looksExpired({ status: 200, body: '#EXTM3U\n#EXTINF:4,\nseg.ts' }),
  'a real playlist is not an expiry');
t(false, remint.looksExpired({ status: 500 }), 'a 500 is the host stumbling, not the token');
t(false, remint.looksExpired({ status: 502 }), 'nor is a 502');

// ─── Re-minting is bounded: a dead stream must not become a hammer ──────────
{
  remint._internal.reset();
  const url = TSK('1', 'a');
  t(true, remint.mayAttempt(url), 'the first attempt is allowed');
  remint.noteAttempt(url);
  t(false, remint.mayAttempt(url), 'a second attempt within the quiet period is not');
  // Walk it past the quiet period without waiting.
  remint._internal.attempts.get(url).at = Date.now() - (remint._internal.RETRY_EVERY_MS + 1000);
  t(true, remint.mayAttempt(url), 'after the quiet period it may try again');
  for (let i = 0; i < remint._internal.MAX_ATTEMPTS; i++) {
    remint.noteAttempt(url);
    const a = remint._internal.attempts.get(url);
    a.at = Date.now() - (remint._internal.RETRY_EVERY_MS + 1000);
  }
  t(false, remint.mayAttempt(url), 'and gives up once the attempts are spent');
}

// ─── A substitution stands in for the address the player still polls ────────
{
  remint._internal.reset();
  const dead = TSK('1', 'a'), fresh = TSK('2', 'b');
  t(null, remint.getSubstitute(dead), 'nothing stands in to begin with');
  remint.setSubstitute(dead, fresh);
  t(fresh, remint.getSubstitute(dead), 'once set, the fresh address is used');
  remint.setSubstitute(dead, dead);
  t(fresh, remint.getSubstitute(dead), 'an address never stands in for itself');
}

// ─── What an address was minted for ─────────────────────────────────────────
{
  remint._internal.reset();
  const url = TSK('1', 'a');
  t(null, remint.lookup(url), 'an unknown address is not tracked');
  remint.remember(url, { src: { source: 'totalsportek' }, match: { id: 'm1' }, config: {} });
  const rec = remint.lookup(url);
  t('totalsportek', rec && rec.src.source, 'the source it came from is remembered');
  t('m1', rec && rec.match.id, 'and the match');
}

// ─── A token in the path is never mistaken for the feed ─────────────────────
t('hls.hockey.do/secure_hls.php?path=c39a7e658e9c50b484d2e841aebb3181/index.m3u8',
  remint.skeleton(TSK('1789922808', 'sig')),
  'the skeleton keeps the identifying hash and drops the moment');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
