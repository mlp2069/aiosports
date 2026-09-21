// What the manifest proxy hands a player, and which media goes through the
// segment relay.
//
// The owner's report: Streamed's streams play in a browser on a Mac and stall
// in Nuvio. Measured: its CDN refuses any client whose TLS handshake is not a
// browser's, headers or no headers, so a player fetching the segments itself
// gets 403s. Those hosts' segments are relayed through this server instead.
//
//   node tests/playlist-rewrite.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosports-rewrite-'));
delete process.env.PROXY_SEGMENT_HOSTS;
const { rewritePlaylist, needsSegmentProxy, proxiedHosts } = require('../src/playlistRewrite');
const { manifestPath, segmentPath, verifyManifestQuery, verifySegmentQuery } = require('../src/manifestLink');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};
const query = link => Object.fromEntries(new URL('http://x' + link).searchParams);
const lines = body => body.split('\n');

console.log('--- which hosts are relayed');
t(true, needsSegmentProxy('cdn7.strmd.st'), 'a subdomain of a listed host');
t(true, needsSegmentProxy('strmd.st'), 'the host itself');
t(false, needsSegmentProxy('notstrmd.st'), 'a host that merely ends the same way');
t(false, needsSegmentProxy('tiktokcdn-us.com'), 'any other host');
t(false, needsSegmentProxy(''), 'no host');
process.env.PROXY_SEGMENT_HOSTS = 'off';
t([], proxiedHosts(), 'PROXY_SEGMENT_HOSTS=off relays nothing');
process.env.PROXY_SEGMENT_HOSTS = '*.example.net, Other.Host';
t(['strmd.st', 'example.net', 'other.host'], proxiedHosts(), 'a list adds to the known host, case and wildcard forgiven');
delete process.env.PROXY_SEGMENT_HOSTS;

console.log('--- a Streamed media playlist');
const target = 'https://cdn7.strmd.st/secure/TOKEN/playlist.m3u8?e=123';
const body = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:100',
  '#EXTINF:4.000,', '/m/AAAA.ts', '#EXTINF:4.000,', 'https://cdn7.strmd.st/m/BBBB.ts', ''].join('\n');
const out = lines(rewritePlaylist(body, { targetUrl: target, finalUrl: target, referer: 'https://embed.st/', origin: 'https://embed.st' }));
t('#EXTM3U', out[0], 'tags are left alone');
t(true, out[5].startsWith('/api/segment/AAAA.ts?'), 'a relative segment is relayed, named after the file');
t('https://cdn7.strmd.st/m/AAAA.ts?e=123', query(out[5]).url, 'resolved against the playlist and given its token');
t('https://embed.st/', query(out[5]).referer, 'the referer rides along for the relay to send');
t(true, verifySegmentQuery(query(out[5])), 'and the link verifies on the segment route');
t(false, verifyManifestQuery(query(out[5])), 'but not on the playlist route');
t(true, out[7].startsWith('/api/segment/BBBB.ts?'), 'an absolute segment on the host too');
t('', out[8], 'the trailing blank line stays');

console.log('--- other hosts stay direct');
const other = 'https://edge.hundxvision.co.uk/live/abc/index.m3u8?tok=1';
const out2 = lines(rewritePlaylist(['#EXTM3U', '#EXTINF:6,', 'seg1.ts', 'https://v.tiktokcdn-us.com/x/seg2.image', 'low/index.m3u8'].join('\n'),
  { targetUrl: other, finalUrl: other, referer: 'https://timstreams.example/', origin: 'https://timstreams.example' }));
t('https://edge.hundxvision.co.uk/live/abc/seg1.ts?tok=1', out2[2], 'a segment elsewhere is a plain absolute link');
t('https://v.tiktokcdn-us.com/x/seg2.image?tok=1#.ts', out2[3], 'a segment named .image is told it is one, after the token it inherits');
t(true, out2[4].startsWith('/api/manifest.m3u8?'), 'a sub-playlist always comes back through the proxy');
t(true, verifyManifestQuery(query(out2[4])), 'with a link that verifies');
t('https://edge.hundxvision.co.uk/live/abc/low/index.m3u8?tok=1', query(out2[4]).url, 'resolved and given the token');

console.log('--- keys, init sections and alternate renditions');
const keyed = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1', '#EXT-X-MAP:URI="init.mp4"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/index.m3u8"', '#EXTINF:4,', 'a.m4s'].join('\n');
const out3 = lines(rewritePlaylist(keyed, { targetUrl: target, finalUrl: target, referer: 'https://embed.st/', origin: 'https://embed.st' }));
t(true, /^#EXT-X-KEY:METHOD=AES-128,URI="\/api\/segment\/key\.bin\?/.test(out3[1]), 'a key on a relayed host is relayed');
t(true, /^#EXT-X-MAP:URI="\/api\/segment\/init\.mp4\?/.test(out3[2]), 'so is an init section');
t(true, /^#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="\/api\/manifest\.m3u8\?/.test(out3[3]), 'an alternate rendition is a playlist, so the proxy');
t(true, out3[5].startsWith('/api/segment/a.m4s?'), 'an fMP4 segment keeps its extension');
const unnamed = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn7.strmd.st/key.php?id=1"', '#EXT-X-MAP:URI="https://cdn7.strmd.st/init?x=1"', '#EXTINF:4,', 'https://cdn7.strmd.st/m/chunk'].join('\n');
const out7 = lines(rewritePlaylist(unnamed, { targetUrl: target, finalUrl: target }));
t(true, /URI="\/api\/segment\/seg\.key\?/.test(out7[1]), 'a key with no telling name is relayed as a key all the same');
t(true, /URI="\/api\/segment\/init\.mp4\?/.test(out7[2]), 'and an init section as one');
t(true, out7[4].startsWith('/api/segment/seg.ts?'), 'a chunk with no telling name is a chunk');
const out4 = lines(rewritePlaylist(keyed, { targetUrl: other, finalUrl: other }));
t('#EXT-X-KEY:METHOD=AES-128,URI="https://edge.hundxvision.co.uk/live/abc/key.bin?tok=1",IV=0x1', out4[1], 'elsewhere a relative key is made absolute for the player');
const inline = '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,QUJDREVGR0hJSktMTU5PUA==",IV=0x1';
t(inline, lines(rewritePlaylist(`#EXTM3U\n${inline}\n#EXTINF:4,\na.ts`, { targetUrl: target, finalUrl: target }))[1], 'a key carried inline is left exactly as it was');
t('#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://abc123"', lines(rewritePlaylist('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://abc123"', { targetUrl: target, finalUrl: target }))[1], 'so is a FairPlay identifier');

console.log('--- the hosts the policy decided are matched exactly');
const twoHosts = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k.bin"', '#EXTINF:4,', 'https://example.com/a.ts'].join('\n');
const out6 = lines(rewritePlaylist(twoHosts, { targetUrl: 'https://example.com/p.m3u8', finalUrl: 'https://example.com/p.m3u8', hosts: ['example.com'] }));
t(true, out6[3].startsWith('/api/segment/a.ts?'), 'the host that was decided is relayed');
t('#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k.bin"', out6[1], 'a host under it that was decided direct is not');

console.log('--- after a redirect');
const moved = 'https://cdn9.strmd.st/secure/TOKEN2/playlist.m3u8';
const out5 = lines(rewritePlaylist('#EXTM3U\n#EXTINF:4,\nchunk.ts', { targetUrl: target, finalUrl: moved, referer: 'https://embed.st/', origin: 'https://embed.st' }));
t('https://cdn9.strmd.st/secure/TOKEN2/chunk.ts?e=123', query(out5[2]).url, 'relative addresses resolve against where the playlist came from');

console.log('--- the link itself');
t(true, segmentPath('https://cdn7.strmd.st/m/AB-12.ts').startsWith('/api/segment/AB-12.ts?url='), 'named after the file');
t(true, segmentPath('https://cdn7.strmd.st/m/').startsWith('/api/segment/seg.ts?'), 'a default name when there is none');
t(true, segmentPath('https://cdn7.strmd.st/m/%3C/html%3E').startsWith('/api/segment/seg.ts?'), 'and when the name is not a file');
t(true, segmentPath('https://content.example.com/x/F8I0JLB.unknown').startsWith('/api/segment/seg.ts?'), 'a chunk in disguise is handed over as what it is');
t(true, segmentPath('https://cdn7.strmd.st/m/chunk-0042.html').startsWith('/api/segment/seg.ts?'), 'never as a page, which the login guard would catch');
t(true, segmentPath('https://cdn7.strmd.st/m/init.mp4').startsWith('/api/segment/init.mp4?'), 'a real media name is kept');
t(false, segmentPath('https://a/x.ts') === manifestPath('https://a/x.ts').replace('/api/manifest', '/api/segment/x.ts'), 'the two routes sign differently');
t(false, verifySegmentQuery({ ...query(segmentPath('https://a/x.ts')), url: 'https://b/y.ts' }), 'a changed url does not verify');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
