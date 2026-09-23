/**
 * egress-proxy — the only way AIOSports reaches DaddyLive's protected hosts.
 *
 * Komodo runs this as the `egress` stack (deploy/egress/compose.yaml). It runs
 * inside the network namespace of a WireGuard client connected to zona, so every connection it opens leaves from zona's address. That matters
 * because DaddyLive signs each playlist for the IP that fetched the page
 * embedding the player, and refuses datacenter IPs outright: the Oracle box
 * gets 403 even on a token it minted itself, while zona's own tokens play.
 *
 * It does one thing, CONNECT tunnelling, and only for an allow-list of host
 * suffixes -- a bug upstream of it must not be able to turn a home connection
 * into a general-purpose exit. It only answers private addresses: it is
 * reachable from the sports docker network, and nothing else.
 */
'use strict';
const net = require('net');
const http = require('http');

const PORT = Number(process.env.EGRESS_PORT) || 8888;
const ALLOW = String(process.env.EGRESS_ALLOW ||
  'assetrage.net,dynproclaim.net,sportsonlinee.click,7odxv0l067ka.net')
  .split(',').map(s => s.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
const PORTS = new Set([443, 8443]);

const allowedHost = h => { h = String(h || '').toLowerCase(); return ALLOW.some(a => h === a || h.endsWith('.' + a)); };
const privateAddr = a => /^(::ffff:)?(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)/.test(String(a || ''));

let open = 0;
const server = http.createServer((req, res) => { res.writeHead(405); res.end('CONNECT only'); });

server.on('connect', (req, client, head) => {
  const from = client.remoteAddress;
  const [host, portStr] = String(req.url || '').split(':');
  const port = Number(portStr) || 443;
  if (!privateAddr(from)) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  if (!allowedHost(host) || !PORTS.has(port)) {
    console.log(`[egress] refused ${host}:${port}`);
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  let established = false;
  const upstream = net.connect({ host, port, timeout: 15000 }, () => {
    established = true;
    open++;
    upstream.setTimeout(0);   // the connect timeout only; a live stream idles between polls
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const teardown = () => { upstream.destroy(); client.destroy(); };
  upstream.on('timeout', teardown);
  upstream.on('error', () => {
    if (!established) { try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (_) {} }
    teardown();
  });
  upstream.on('close', () => { if (established) { established = false; open = Math.max(0, open - 1); } teardown(); });
  client.on('error', teardown);
  client.on('close', teardown);
});

server.listen(PORT, '0.0.0.0', () => console.log(`[egress] listening on :${PORT}, allowing ${ALLOW.join(', ')}`));
setInterval(() => { if (open) console.log(`[egress] ${open} tunnel(s) open`); }, 10 * 60 * 1000).unref();
