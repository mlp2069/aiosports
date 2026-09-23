/**
 * egress.js — which requests leave through the home connection, and how.
 *
 * DaddyLive signs every playlist for the IP address that fetched the page
 * embedding its player, and refuses datacenter addresses outright. Measured
 * 2026-09-23: this server (Oracle Cloud) gets 403 even on a token it minted
 * itself; zona, on a home connection, mints tokens that play. So the handful
 * of hosts that mint and check those tokens are reached through a WireGuard
 * tunnel to zona, via a CONNECT proxy that lives inside the tunnel
 * (deploy/egress/). Everything else goes out as it always has -- including
 * DaddyLive's video segments, which carry no token and play from anywhere, so
 * the home connection carries a few kilobytes of playlist per poll and none
 * of the video.
 *
 * EGRESS_PROXY names the proxy (default http://dl-egress:8888, the container
 * the egress stack runs on the sports network); "off" disables the route and
 * with it every source that depends on it. EGRESS_HOSTS lists the domains
 * routed, and must agree with the proxy's own allow-list, which refuses the
 * rest.
 */

'use strict';

const net = require('net');

const RAW = process.env.EGRESS_PROXY === undefined ? 'http://dl-egress:8888' : String(process.env.EGRESS_PROXY).trim();
const OFF = /^(|0|off|none|false|no)$/i.test(RAW);

const DEFAULT_HOSTS = ['assetrage.net', 'dynproclaim.net', 'sportsonlinee.click', '7odxv0l067ka.net'];
const HOSTS = (process.env.EGRESS_HOSTS
  ? String(process.env.EGRESS_HOSTS).split(',')
  : DEFAULT_HOSTS
).map(s => s.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);

const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };

/** Whether an address belongs to a host that only answers the home connection. */
function needsEgress(url) {
  const h = hostOf(url);
  return !!h && HOSTS.some(s => h === s || h.endsWith('.' + s));
}

/** The proxy to send this request through, or null to send it as usual. */
function egressProxyFor(url) {
  return !OFF && needsEgress(url) ? RAW : null;
}

// Whether the tunnel is there at all, asked of the proxy's port and remembered
// for a minute. A source that depends on it stays silent while it is down
// rather than handing out rows that can only 403.
const PROBE_TTL_MS = 60 * 1000;
let probe = { at: 0, ok: false, pending: null };

function egressAvailable() {
  if (OFF) return Promise.resolve(false);
  if (Date.now() - probe.at < PROBE_TTL_MS) return Promise.resolve(probe.ok);
  if (probe.pending) return probe.pending;
  let target;
  try { target = new URL(RAW); } catch (e) { return Promise.resolve(false); }
  probe.pending = new Promise(resolve => {
    const s = net.connect({ host: target.hostname, port: Number(target.port) || 80, timeout: 2000 });
    const done = ok => { s.destroy(); probe = { at: Date.now(), ok, pending: null }; resolve(ok); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.once('timeout', () => done(false));
  });
  return probe.pending;
}

module.exports = {
  egressProxyFor, needsEgress, egressAvailable,
  EGRESS_HOSTS: HOSTS, EGRESS_PROXY: OFF ? null : RAW,
  _internal: { reset() { probe = { at: 0, ok: false, pending: null }; } }
};
