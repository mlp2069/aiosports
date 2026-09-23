/**
 * index.js — AIOSports Addon Entry Point
 *
 * Builds a single Express server that serves:
 *   - /manifest.json          → addon manifest (via SDK getRouter)
 *   - /catalog/tv/*.json      → match lists
 *   - /meta/tv/*.json         → match detail
 *   - /stream/tv/*.json       → stream URLs
 *   - /watch                  → HTML proxy page for embed streams
 *
 * CORS headers are explicitly set so Nuvio can reach the manifest
 * from any origin without a networkError_manifestLoadError.
 */

// Before every other require: config.js reads process.env as it loads, so a
// .env read any later would arrive after PORT and BASE_URL were already fixed.
//
// dotenv has been a dependency all along but nothing ever called it, so an
// AUTH_KEY written into .env -- the one thing anyone locking this down would do
// -- was read by nobody, and the site stayed open with no sign anything was
// wrong. Docker escaped it only because Compose does its own .env substitution.
// `override: false` keeps real environment variables winning over the file.
require('dotenv').config({ override: false, quiet: true });

const express = require('express');
const cors    = require('cors');
const { getRouter } = require('stremio-addon-sdk');
const { createProxyMiddleware } = require('http-proxy-middleware');
const child_process = require('child_process');
const path = require('path');
const fs = require('fs');

const { builder } = require('./manifest');
const crypto = require('crypto');
const cardWarmer = require('./services/CardWarmer');
const { handleCatalog, handleMeta } = require('./catalog');
const { handleStream, remintUpstream } = require('./streams');
const { PORT, BASE_URL, getRequestBaseUrl } = require('./config');
const container = require('./container');



// Removed global User-Agent fix because it causes ECONNRESET on Streamed.pk

// ─── Spawn the Streamed.pk Resolver ───────────────────────────────────────────

// Use a dynamic random port between 20000-60000 for the internal resolver to prevent EADDRINUSE on shared hosts
const RESOLVER_PORT = process.env.RESOLVER_PORT || "7003";
let resolverProcess = null;
let isShuttingDown = false;

function spawnResolver() {
  if (isShuttingDown) return;
  const spawnEnv = { ...process.env, PORT: RESOLVER_PORT, HOST: '127.0.0.1' };
  if (process.env.LOW_MEMORY_MODE === 'true') {
    /* spawnEnv.NODE_OPTIONS removed to prevent 502 crashes */
  }

  // Decode 'server.js' from base64 at runtime so Webpack's asset relocator ignores it
  const scriptName = Buffer.from('c2VydmVyLmpz', 'base64').toString('utf8');
  const scriptPath = process.cwd() + '/resolver/src/' + scriptName;
  const args = [];
  args.push(scriptPath);

  resolverProcess = child_process['sp' + 'awn']('node', args, {
    stdio: 'inherit',
    env: spawnEnv
  });
  
  resolverProcess.on('error', (err) => console.error('[FATAL] Resolver spawn error:', err));
  
  resolverProcess.on('exit', (code, signal) => {
    if (isShuttingDown) return;
    console.error(`[FATAL] Resolver process exited with code ${code} and signal ${signal}. Restarting in 2 seconds...`);
    setTimeout(spawnResolver, 2000);
  });
}

spawnResolver();

// Ensure child process is killed when the parent exits
function shutdownResolver() {
  isShuttingDown = true;
  if (resolverProcess && !resolverProcess.killed) {
    console.log('Shutting down Stream Resolver...');
    resolverProcess.kill();
  }
  // Shut down the headless browser sniffer if it was ever launched
  try { container.resolve('browserSniffer').shutdown(); } catch (_) {}
}
process.on('exit', shutdownResolver);
process.on('SIGINT', () => { shutdownResolver(); process.exit(0); });
process.on('SIGTERM', () => { shutdownResolver(); process.exit(0); });

// ─── Register Addon Handlers ──────────────────────────────────────────────────

builder.defineCatalogHandler(({ type, id, extra, config }) => handleCatalog(type, id, extra, config));
builder.defineMetaHandler(({ type, id, config })           => handleMeta(type, id, config));
builder.defineStreamHandler(({ type, id, config })         => handleStream(type, id, config));

// ─── Build Express App ────────────────────────────────────────────────────────

const app = express();

// This runs behind Caddy, so the address of the immediate peer is the proxy's,
// not the caller's. Left unsaid, every visitor on the internet arrives wearing a
// private address -- which the local-network rule below would have trusted, and
// which would have made one attacker's failed guesses lock out everybody.
//
// Trust is limited to proxies on loopback or a private range. A request that
// arrives straight from a public address cannot forge X-Forwarded-For to claim
// it came from inside.
// TRUST_PROXY widens this when the proxy is not on a private address -- a hop
// count ("1") or a list of addresses/CIDRs. Never "true" on a public box: that
// takes the leftmost X-Forwarded-For from anyone, which is the caller's to
// invent. A line setting exactly that used to sit immediately below this one
// and silently won, because Express keeps the last value it is given.
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').trim();
app.set(
  'trust proxy',
  !TRUST_PROXY
    ? ['loopback', 'linklocal', 'uniquelocal']
    : /^\d+$/.test(TRUST_PROXY)
      ? Number(TRUST_PROXY)
      : TRUST_PROXY.split(',').map(s => s.trim()).filter(Boolean)
);

app.use(cors());
app.disable('x-powered-by');

// Per-address ceilings on the routes that cost this server real work or reach
// out to somebody else's: artwork renders, playlist fetches, embed fetches.
// Set far above what a household asks for -- one address can be a TV and two
// phones each opening every tab, and the Channels tab alone is about 540
// covers -- so they only bite on something hammering the server. A cover
// refused here is a blank tile in somebody's player. The card warmer comes
// from loopback and is exempt. RATE_LIMIT=off turns them off.
const RATE_RULES = [
  { prefix: '/img', perMinute: 6000 },
  { prefix: '/api/manifest', perMinute: 1200 },
  // A live viewer fetches a segment every few seconds: twenty-odd a minute.
  { prefix: '/api/segment', perMinute: 1200 },
  { prefix: '/api/proxy-embed', perMinute: 60 }
];
const rateHits = new Map();   // "rule|address" -> { start, count }
app.use((req, res, next) => {
  if (/^(0|off|false|no)$/i.test(String(process.env.RATE_LIMIT || '').trim())) return next();
  // Lower-cased, because Express routes match /API/MANIFEST as readily as
  // /api/manifest, and a limit that only knew one spelling was no limit.
  const reqPath = req.path.toLowerCase();
  const rule = RATE_RULES.find(r => reqPath === r.prefix || reqPath.startsWith(r.prefix + '/'));
  if (!rule) return next();
  // Exempt only this process's own loopback requests -- the card warmer. Read
  // from the socket, not req.ip: behind a private-address peer that forwards
  // headers as sent, req.ip is whatever X-Forwarded-For claims, 127.0.0.1 included.
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if ((peer === '127.0.0.1' || peer === '::1') && !req.headers['x-forwarded-for']) return next();
  const address = String(req.ip || '').replace(/^::ffff:/, '');
  const now = Date.now();
  const key = rule.prefix + '|' + address;
  let rec = rateHits.get(key);
  if (!rec || now - rec.start >= 60000) {
    rec = { start: now, count: 0 };
    rateHits.set(key, rec);
    // Keyed by address, so it is swept, and dropped whole if a flood of
    // addresses outruns the sweep.
    if (rateHits.size > 20000) {
      for (const [k, v] of rateHits) if (now - v.start >= 60000) rateHits.delete(k);
      if (rateHits.size > 50000) rateHits.clear();
    }
  }
  if (++rec.count > rule.perMinute) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rec.start + 60000 - now) / 1000))));
    return res.status(429).send('Too many requests');
  }
  next();
});

// Artwork is drawn from URLs other people control. Whatever comes back, a
// browser must treat it as an image and nothing more: no sniffing it into a
// page, and no script even if an SVG gets through.
app.use('/img', (req, res, next) => {
  // The warmer steps aside while a player is loading artwork.
  if (req.get('user-agent') !== cardWarmer.WARMER_UA) cardWarmer.noteClient();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
  next();
});

// A saved profile, wearing the URL of an ordinary config.
//
//   /saved/...                  the profile made before profiles existed
//   /p/<uuid>/...               one of several named profiles
//
// Rewriting here rather than adding routes means every path that already
// understands a config segment -- the manifest, the SDK's catalog, meta and
// stream routes, even /configure -- keeps working without knowing this exists.
// It has to run before all of them, which is why it sits this early.
app.use((req, res, next) => {
  const m = req.url.match(/^\/(?:saved|p\/([^/?]+))(\/|$|\?)/);
  if (!m) return next();

  const id = m[1] ? decodeURIComponent(m[1]) : LEGACY_ID;
  const prefixLen = m[1] ? ('/p/' + m[1]).length : '/saved'.length;
  const saved = loadProfile(id);

  if (!saved) {
    // Someone who followed a profile link wants the page, not a paragraph of
    // JSON about why they cannot have it. Send them where they were going.
    const rest = req.url.slice(prefixLen);
    const wantsPage = /^(\/configure\/?)?(\?|$)/.test(rest)
      || String(req.get('accept') || '').includes('text/html');
    if (wantsPage) return res.redirect(302, '/configure');

    // A player asking for the manifest gets an answer it can act on.
    return res.status(404).json({
      error: 'No such saved profile. Open /configure, set it up, and press Save.'
    });
  }

  const encoded = encodeConfigSegment(saved);
  const rest = req.url.slice(prefixLen);

  // The configure PAGE is redirected rather than rewritten, because the page
  // reads its settings out of its own address bar -- and a rewrite is invisible
  // there. Left as a rewrite, /p/<uuid>/configure showed the browser a uuid
  // where the page expected an encoded config, so it decoded nothing, opened on
  // defaults, and the next Save wrote those defaults over the profile.
  //
  // The id rides along as ?profile= so the page still knows which profile it is
  // editing, and the uuid never has to be decodable for that to work.
  const asPage = rest.match(/^\/configure\/?(\?(.*))?$/);
  if (asPage) {
    // The redirect carries the whole config in its Location, so it goes only
    // to someone allowed to open the configure page. Before this, a signed-out
    // visitor read /saved/configure's settings straight out of the 302.
    if (process.env.AUTH_KEY && !isAuthed(req)) return res.redirect(302, '/login');
    const extra = asPage[2] ? '&' + asPage[2] : '';
    return res.redirect(302, '/' + encoded + '/configure?profile=' + encodeURIComponent(id) + extra);
  }

  req.url = '/' + encoded + rest;
  next();
});

/**
 * Every artwork URL the catalogs hand out -- posters, the wide backgrounds a TV
 * shows in its rows, corner logos -- grouped by catalog, so the warmer can take
 * the top of every tab before the bottom of any. Upcoming is included: people
 * open it, and not all of its cards are in the other tabs.
 */
async function collectWarmUrls() {
  const { manifest } = require('./manifest');
  // Your Teams and Local draw on a viewer's config; their tiles are in the
  // other tabs already.
  const ids = (manifest.catalogs || []).map(c => c.id).filter(id => !/_(teams|local)$/.test(id));
  const perCatalog = [];
  for (const id of ids) {
    try {
      const { metas } = await handleCatalog('tv', id, {}, {}, { revalidate: false });
      perCatalog.push(cardWarmer.urlsFrom(metas));
    } catch {
      // One tab failing to enumerate costs that tab's warmth, nothing else.
    }
  }
  return { perCatalog };
}

/**
 * Warm the cards. Runs 45 s after boot, after a catalog re-sync (at most every
 * ten minutes), every WARM_INTERVAL_MS from the last run, straight after the
 * cache is cleared, and from the dashboard's Warm button.
 */
function startWarm(reason = 'manual') {
  return Promise.resolve(cardWarmer.warm(collectWarmUrls, reason))
    .catch(err => console.error('[CardWarmer]', err.message));
}

const WARM_INTERVAL_MS = Number(process.env.WARM_INTERVAL_MS) || 4 * 60 * 60 * 1000;

// Serve the web debugger UI and Configuration Page
app.use(guardStaticPages);
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

app.get('/', requirePage, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

/** Exchange AUTH_KEY for the site cookie. */
app.post('/api/login', (req, res) => {
  const key = process.env.AUTH_KEY;
  if (!key) return res.json({ authenticated: true, keyRequired: false });
  if (throttled(req)) return res.status(429).json({ error: 'Too many failed sign-ins. Wait a few minutes.' });
  if (!isAuthed(req)) {
    noteFailureOnce(req);
    return res.status(403).json({ error: 'That password was not accepted.' });
  }
  FAILURES.delete(failureKey(req));
  res.cookie(AUTH_COOKIE, mintTicket(key), {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 24 * 3600 * 1000
  });
  res.json({ authenticated: true, keyRequired: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE);
  res.clearCookie(ADMIN_COOKIE);
  res.json({ authenticated: false });
});

/**
 * Which build this is.
 *
 * The image records a UTC stamp at build time because .dockerignore keeps .git
 * out of the context, so a container genuinely has no commit to report. Running
 * from a working tree there IS one, so it is read from git instead -- the same
 * line ends up more precise for whoever is actually developing.
 */
const BUILD_INFO = (() => {
  const read = f => { try { return fs.readFileSync(path.join('/app', f), 'utf8').trim(); } catch (e) { return ''; } };
  let build = read('BUILD_ID');
  let sha = read('BUILD_SHA');
  if (!sha) {
    try {
      sha = child_process.execSync('git rev-parse --short HEAD', {
        cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000
      }).toString().trim();
    } catch (e) { sha = ''; }
  }
  if (!build) {
    try {
      build = child_process.execSync('git log -1 --date=format:%Y.%m.%d.%H%M --format=%cd', {
        cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000
      }).toString().trim();
    } catch (e) { build = ''; }
  }
  return { version: require('./manifest').manifest.version, build, sha };
})();

app.get('/api/version', (req, res) => res.json(BUILD_INFO));

app.get('/api/site/auth', (req, res) => {
  res.json({ authenticated: isAuthed(req), keyRequired: !!process.env.AUTH_KEY });
});

/**
 * Whether a saved configuration exists, and whether saving one is worth doing.
 *
 * `durable` is the honest part: in a container with nothing mounted at DATA_DIR,
 * a save survives a restart but not the next rebuild, and someone should be told
 * that before they rely on it rather than after they lose their settings.
 */
app.get('/api/config/saved', (req, res) => {
  // Which profile the page is asking about; absent means the legacy one.
  const id = typeof req.query.id === 'string' && req.query.id ? req.query.id : LEGACY_ID;
  const saved = loadProfile(id);
  const base = getRequestBaseUrl(req);
  res.json({
    id,
    exists: !!saved,
    durable: savedConfigIsDurable(),
    url: base + (id === LEGACY_ID ? '/saved' : '/p/' + id) + '/manifest.json',
    // Whether this caller may change it: signed in with a real key, or holding
    // the profile's own edit key (see mayEditProfile).
    canEdit: !!saved && mayEditProfile(req, id),
    // No AUTH_KEY: profiles are guarded by their edit keys alone.
    open: !process.env.AUTH_KEY,
    // Only to someone signed in with a real key. The uuid IS the secret -- it
    // is the entire reason a profile is private -- so handing the list to
    // anyone who asks would give away every profile on the server. On an
    // instance with no AUTH_KEY everybody counts as signed in, which is why
    // this is not isAuthed().
    profiles: ownsEverything(req)
      ? listProfiles().map(pid => ({
          id: pid,
          url: base + (pid === LEGACY_ID ? '/saved' : '/p/' + pid) + '/manifest.json'
        }))
      : []
  });
});

// A change of cities starts a catalog sync, and a sync is the most expensive
// thing this process does. One this way every few minutes at most, whatever a
// script does to a profile's cities; the four-hourly sync picks up the rest.
let lastMarketSyncAt = 0;
const MARKET_SYNC_EVERY_MS = 5 * 60 * 1000;

app.post('/api/config/save', express.json({ limit: '64kb' }), (req, res) => {
  // The configure page is what AUTH_KEY guards, and this is that page's save
  // button, so it is gated the same way: signed in, or the site is open anyway.
  if (!isAuthed(req)) {
    return res.status(403).json({ error: 'Sign in before saving.' });
  }
  const config = req.body && req.body.config !== undefined ? req.body.config : req.body;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return res.status(400).json({ error: 'Expected a configuration object.' });
  }

  // No id means "make me a new one". An id must already exist, so a caller
  // cannot choose where their profile lands, and changing one takes the right
  // to: a real sign-in, or that profile's edit key.
  let id = typeof req.body.id === 'string' ? req.body.id : '';
  let editKey = '';
  if (!id) {
    // Where anybody may create one, there is a ceiling on how many, or a
    // script could fill the disk with them.
    if (!ownsEverything(req) && listProfiles().length >= OPEN_PROFILE_LIMIT) {
      return res.status(403).json({ error: 'This server has reached its limit of saved profiles.' });
    }
    id = crypto.randomUUID();
    editKey = crypto.randomBytes(24).toString('base64url');
  } else if (id !== LEGACY_ID && !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'Not a profile id.' });
  } else if (!loadProfile(id) && !(id === LEGACY_ID && ownsEverything(req))) {
    return res.status(404).json({ error: 'No such profile. Press New profile and save to create one.' });
  } else if (!mayEditProfile(req, id)) {
    return res.status(403).json({
      error: 'This profile was saved from another browser. Open its edit link to change it, '
        + 'sign in to the dashboard with ADMIN_TOKEN, or press New profile and save your own.'
    });
  }

  const marketsBefore = String((loadProfile(id) || {}).markets || '');
  try {
    // The key first: a profile written without one could never be changed.
    if (editKey) writeEditKey(id, editKey);
    writeProfile(id, config);
  } catch (err) {
    console.error('[profiles] could not write', id, err.message);
    return res.status(500).json({
      error: 'Could not write the profile. ' +
             'Mount a volume at the data directory (see the README) or set DATA_DIR somewhere writable.'
    });
  }

  // A new city's stations are listed by the next sync. Start one now rather
  // than leave the viewer who just typed it looking at an empty Local tab.
  if (String(config.markets || '') !== marketsBefore && Date.now() - lastMarketSyncAt >= MARKET_SYNC_EVERY_MS) {
    const cron = container.resolve('cronService');
    // A sync already under way read the profiles before this save. The next
    // revalidation picks the change up, and the cooldown is not spent on it.
    if (!cron.syncing) {
      lastMarketSyncAt = Date.now();
      Promise.resolve(cron.runSync()).catch(err => console.warn('[profiles] re-sync after a market change failed:', err.message));
    }
  }

  const base = getRequestBaseUrl(req);
  const home = base + (id === LEGACY_ID ? '/saved' : '/p/' + id);
  res.json({
    saved: true,
    id,
    durable: savedConfigIsDurable(),
    url: home + '/manifest.json',
    // Handed over once. It is what lets this profile be changed from another
    // device when there is no AUTH_KEY; the server keeps only its hash.
    ...(editKey ? { editKey, editUrl: home + '/configure#key=' + editKey } : {})
  });
});

app.delete('/api/config/saved', (req, res) => {
  if (!isAuthed(req)) return res.status(403).json({ error: 'Sign in first.' });
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  const file = profilePath(id);
  if (!file) return res.status(400).json({ error: 'Not a profile id.' });
  if (!mayEditProfile(req, id)) {
    return res.status(403).json({ error: 'Only the browser that saved this profile, or someone signed in, can delete it.' });
  }
  try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
  try { fs.unlinkSync(editKeyPath(id)); } catch (e) { /* never had one */ }
  _profiles.delete(id);
  res.json({ deleted: true, id });
});

app.get('/dashboard', requirePage, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

/**
 * Anything that changes state is guarded. This addon is meant to be reachable
 * from the internet -- that is how a phone gets at it -- so an unguarded button
 * that empties a cache or restarts a sync is a button anyone can press, all day.
 *
 * With ADMIN_TOKEN set, the token is the key. Without one nothing that changes
 * state is reachable at all -- see isAdmin for why an address cannot carry that
 * decision when the caller writes the header it is read from.
 */
// Failed sign-ins per address. A dashboard anyone can reach is a dashboard
// anyone can guess at, and a short password falls quickly at a few thousand
// tries a second. Kept in memory: this protects a login, not a ledger, and
// losing the count on a restart costs one window.
const FAILURES = new Map();
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const FAIL_LIMIT = 8;

function failureKey(req) {
  return String(req.ip || '').replace(/^::ffff:/, '') || 'unknown';
}

function throttled(req) {
  const key = failureKey(req);
  const rec = FAILURES.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > FAIL_WINDOW_MS) { FAILURES.delete(key); return false; }
  return rec.count >= FAIL_LIMIT;
}

function noteFailure(req) {
  const key = failureKey(req);
  const now = Date.now();
  const rec = FAILURES.get(key);
  if (!rec || now - rec.first > FAIL_WINDOW_MS) FAILURES.set(key, { count: 1, first: now });
  else rec.count++;
  // Keyed by address, so it would otherwise grow without limit.
  if (FAILURES.size > 5000) {
    for (const [k, v] of FAILURES) if (now - v.first > FAIL_WINDOW_MS) FAILURES.delete(k);
  }
}

/** Count a failure at most once per request, however many checks saw it. */
function noteFailureOnce(req) {
  if (req._failureNoted) return;
  req._failureNoted = true;
  noteFailure(req);
}

/**
 * Compare a password a caller supplied in a header or the query string.
 *
 * Every wrong one counts toward the same lockout as the sign-in forms, and a
 * caller already locked out is not compared at all. Only the forms used to
 * count, so /api/site/auth?key=… and /api/cache/auth?token=… answered "right"
 * or "wrong" to as many guesses as anyone cared to send.
 *
 * Compared as bytes. A password with any character outside ASCII has a byte
 * length that differs from its string length, and timingSafeEqual throws on a
 * length mismatch -- so comparing string lengths first would have turned one
 * accented character in the password into a 500 on every attempt.
 */
function suppliedSecretMatches(req, given, secret) {
  if (!given) return false;
  if (throttled(req)) return false;
  const a = Buffer.from(String(given), 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  noteFailureOnce(req);
  return false;
}

/**
 * A signed, expiring ticket for the browser. The password itself never goes in
 * the cookie -- this is an HMAC over the expiry keyed by the password, so a
 * stolen cookie cannot be turned back into the password, and editing the expiry
 * invalidates the signature.
 */
function mintTicket(token, ttlMs = 30 * 24 * 3600 * 1000) {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac('sha256', token).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}

function ticketValid(value, token) {
  const [exp, sig] = String(value || '').split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', token).update(exp).digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(want, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

// Two doors with two keys. AUTH_KEY opens the site -- the catalog page and the
// configure page. ADMIN_TOKEN opens the dashboard and the buttons that change
// state. Someone you let in to browse is not thereby allowed to empty a cache.
const AUTH_COOKIE = 'ls_auth';
const ADMIN_COOKIE = 'ls_admin';

function isAdmin(req) {
  const token = process.env.ADMIN_TOKEN;
  if (token) {
    if (ticketValid(cookieValue(req, ADMIN_COOKIE), token)) return true;
    return suppliedSecretMatches(req, req.get('x-admin-token') || req.query.token || '', token);
  }
  // No token, no admin. There used to be a fallback here that granted admin to
  // any caller on a private address, and under Docker -- which is how almost
  // everyone runs this -- it granted admin to everyone: the container's peer is
  // always the bridge gateway, 172.17.0.1, which is itself a private address.
  // Measured on the shipped image with ADMIN_TOKEN unset, /api/cache/stats
  // returned 200 to a plain request from outside the host, no header needed.
  //
  // An address cannot carry that decision. Behind a proxy it is a header the
  // caller writes, and in a container it is the same private gateway for the
  // whole internet. So the dashboard stays shut until a token exists, and the
  // boot banner says so rather than leaving it to be discovered.
  return false;
}

function requireAdmin(req, res) {
  // A signed-in admin's cookie is honoured before the lockout. The lockout is
  // counted per address, and wrong guesses from a shared one -- a household,
  // carrier NAT -- must not shut out the admin who has already signed in.
  const token = process.env.ADMIN_TOKEN;
  if (token && ticketValid(cookieValue(req, ADMIN_COOKIE), token)) return true;
  if (throttled(req)) {
    res.status(429).json({ error: 'Too many failed sign-ins. Wait a few minutes and try again.' });
    return false;
  }
  if (isAdmin(req)) { FAILURES.delete(failureKey(req)); return true; }
  noteFailureOnce(req);
  // Say which rule is actually in force. Telling someone who has already set a
  // token to go and set one sends them to check a setting that is already right.
  res.status(403).json({
    error: process.env.ADMIN_TOKEN
      ? 'This action needs the admin token. Open the dashboard as /dashboard?token=… '
        + 'with the ADMIN_TOKEN set on the container.'
      : 'Nothing may change state until ADMIN_TOKEN is set on the container. '
        + 'Set it, then open the dashboard as /dashboard?token=\u2026'
  });
  return false;
}

/**
 * The only thing the dashboard may ask before signing in: which door it is
 * looking at. It deliberately says nothing else -- no counts, no uptime, no
 * versions -- because it is the one endpoint an unauthenticated caller reaches.
 */
app.get('/api/cache/auth', (req, res) => {
  res.json({ authenticated: isAdmin(req), tokenRequired: !!process.env.ADMIN_TOKEN });
});

/**
 * Exchange the password for a cookie. A browser navigating to a page cannot
 * send a header, so signing in has to leave something behind that an ordinary
 * navigation carries.
 */
app.post('/api/cache/login', (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.json({ authenticated: isAdmin(req), tokenRequired: false });
  if (!requireAdmin(req, res)) return;
  res.cookie(ADMIN_COOKIE, mintTicket(token), {
    httpOnly: true,      // script cannot read it, so a page flaw cannot leak it
    sameSite: 'lax',
    secure: req.secure,  // https here, so it never travels in the clear
    maxAge: 30 * 24 * 3600 * 1000
  });
  res.json({ authenticated: true, tokenRequired: true });
});

app.post('/api/cache/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.json({ authenticated: false });
});

/** May this caller see the site at all? The admin key opens every door. */
function isAuthed(req) {
  const key = process.env.AUTH_KEY;
  if (!key) return true;                       // no site key configured: open
  if (isAdmin(req)) return true;               // admin implies access
  if (ticketValid(cookieValue(req, AUTH_COOKIE), key)) return true;
  return suppliedSecretMatches(req, req.get('x-auth-key') || req.query.key || '', key);
}

/**
 * The pages a person reads are behind AUTH_KEY; the endpoints an addon reads
 * cannot be, because Nuvio and AIOStreams have no way to sign in and the catalog
 * would simply stop working. What stays open is sports listings and artwork --
 * no settings, no state, nothing about the household.
 */
function requirePage(req, res, next) {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Sign in first.' });
  return res.redirect('/login');
}

/**
 * express.static sits in front of these routes and would hand out the very
 * files they guard -- /index.html reaches the page that /  refuses. Anything
 * ending .html goes through the site gate first, except the login page itself,
 * which has to be reachable by someone who cannot yet get in.
 */
function guardStaticPages(req, res, next) {
  if (!/\.html?$/i.test(req.path)) return next();
  if (/^\/login\.html?$/i.test(req.path)) return next();
  return requirePage(req, res, next);
}

app.get('/api/cache/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    images: imageService.cacheStats(),
    // Whether warming is actually surviving to the click: a rising evictions
    // count against a flat hits count is the cap being too small for the board.
    streams: container.resolve('streamResolveCache').stats(),
    // Which channels the background check found with no streams, and are hidden.
    channels: require('./services/ChannelHealth').status(),
    warmer: cardWarmer.status(),
    matches: container.resolve('cacheService').getMatches().length,
    admin: isAdmin(req),
    tokenRequired: !!process.env.ADMIN_TOKEN,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576)
  });
});

app.post('/api/cache/clear', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const what = String(req.query.what || 'all');
  if (!['cards', 'upstream', 'all'].includes(what)) {
    return res.status(400).json({ error: 'what must be cards, upstream or all' });
  }
  const cleared = imageService.clearCache(what);
  // Emptying the server's caches changes nothing a player already holds: they
  // keep images by URL. A new generation gives every card a new URL, the
  // catalogs (sent no-cache) hand those out on the next open, and the warmer
  // starts drawing them now rather than on the next browse.
  const generation = require('./services/ArtGeneration').bump('clear:' + what);
  cardWarmer.restart(collectWarmUrls, 'clear').catch(err => console.error('[CardWarmer]', err.message));
  res.json({ cleared, what, generation, warmer: cardWarmer.status() });
});

app.post('/api/cache/warm', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (cardWarmer.status().running) return res.json({ started: false, reason: 'already running', warmer: cardWarmer.status() });
  startWarm('manual');
  res.json({ started: true, warmer: cardWarmer.status() });
});

app.post('/api/cache/warm/cancel', (req, res) => {
  if (!requireAdmin(req, res)) return;
  cardWarmer.cancel();
  res.json({ cancelled: true, warmer: cardWarmer.status() });
});

app.get(['/configure', '/:config/configure'], requirePage, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'configure.html'));
});

app.get('/api/matches', requirePage, (req, res) => {
  const matches = container.resolve('cacheService').getMatches();
  res.json(matches);
});

// ─── Self-hosted image pipeline ───────────────────────────────────────
// /img?url=...          → cached upstream image, or a generated category-colored
//                         placeholder on any failure (dead URL, non-image body,
//                         timeout) so the client never sees a broken image.
// /img/placeholder?...  → generated poster card. Replaces the external
//                         placehold.co dependency.
const imageService = require('./services/ImageService');
const homeAwayService = require('./services/HomeAwayService');

// Prime the home/away index at boot so the first catalog request finds it warm
// rather than paying the cold-start wait. Failure is silent by design: the
// catalog falls back to reading orientation off the title separator.
homeAwayService.ensureFresh().catch(() => {});

const PASSTHROUGH_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

app.get('/img/placeholder', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (imageService.sendCachedCard(req, res)) return;
  const svg = imageService.svgPlaceholder(req.query.text || 'Live Sports', req.query.color || '333333');
  const current = imageService.isCurrentArt(req);
  await imageService.sendCard(req, res, svg,
    current ? imageService.CACHE_CONTROL.FULL : imageService.CACHE_CONTROL.STALE_URL,
    { remember: current });
});

app.get('/img', async (req, res) => {
  const text = req.query.text || 'Live Sports';
  const color = req.query.color || '333333';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  const entry = await imageService.getImage(req.query.url);
  // Passed on as it arrived only in a format that cannot carry script.
  // Anything else that decodes -- an SVG above all -- is redrawn as a PNG.
  // The redrawn copy rides on the cached entry, so it is drawn once per fetch.
  const image = entry && (PASSTHROUGH_IMAGE_TYPES.has(entry.contentType)
    ? entry
    : (entry.png || (entry.png = await imageService.toPng(entry.buffer))));
  if (image) {
    res.setHeader('Content-Type', image.contentType);
    // A copy past its freshness is being replaced right now: kept briefly.
    res.setHeader('Cache-Control', imageService.isStaleEntry(entry)
      ? imageService.CACHE_CONTROL.SECOND_CHOICE
      : imageService.CACHE_CONTROL.FULL);
    return res.send(image.buffer);
  }
  // Upstream image unavailable: a generated card stands in, rasterised like
  // every other generated card so it doesn't arrive as an SVG a client can't draw.
  const svg = imageService.svgPlaceholder(text, color);
  await imageService.sendCard(req, res, svg, imageService.CACHE_CONTROL.FALLBACK);
});

// /img/event?text=&mark=&mark2=&kicker=&color=  -> badge card for an event that
// isn't team-vs-team. Same candidate pattern as /img/matchup: the marks are
// tried in order and the plain name card is what happens when none of them
// loads, so a dead badge costs the badge and never the card.
app.get('/img/event', async (req, res) => {
  const text = req.query.text || 'Live Sports';
  const color = req.query.color || '333333';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  // A card made before -- by a player or by the warmer -- goes straight out,
  // without fetching its logo again.
  if (imageService.sendCachedCard(req, res)) return;

  const current = imageService.isCurrentArt(req);
  const M = await firstImage([req.query.mark, req.query.mark2].filter(Boolean));
  const coverParam = req.query.cover === '1';
  if (!M) {
    if (coverParam) {
      // A channel with no logo still gets its cover -- the name alone on the
      // grey -- so the tab reads as one set rather than covers and gradient
      // cards. When a logo was asked for and missed, the card is not
      // cacheable: a player loading a whole tab at once can miss logos under
      // the burst, and players keep images far past any max-age.
      const asked = !!(req.query.mark || req.query.mark2);
      return imageService.sendCard(req, res,
        imageService.svgEvent(text, null, color, { kicker: req.query.kicker || '', cover: true }),
        asked
          ? imageService.CACHE_CONTROL.FALLBACK
          : (current ? imageService.CACHE_CONTROL.FULL : imageService.CACHE_CONTROL.STALE_URL),
        { remember: !asked && current });
    }
    return imageService.sendCard(req, res, imageService.svgPlaceholder(text, color), imageService.CACHE_CONTROL.FALLBACK);
  }
  // A channel cover sits its logo straight on flat grey, so a logo that ships
  // on its own solid rectangle has that rectangle taken out first.
  // A dark logo also has its dark parts lifted, or navy on grey disappears.
  const cover = coverParam || (req.query.plate === '0' && req.query.notext === '1');
  const entry = coverParam
    ? await imageService.coverMark(M.entry)
    : cover
      ? ((await imageService.knockoutBackground(M.entry.buffer)) || M.entry)
      : M.entry;
  // The logo's own size, so the cover never draws it larger than it is.
  const size = coverParam ? await imageService.imageSize(entry.buffer) : { width: 0, height: 0 };
  // The second mark stood in for a first one that failed a moment ago, or the
  // logo drawn is a copy past its freshness that is being replaced right now.
  const secondChoice = (!!req.query.mark && M.url !== req.query.mark) || imageService.isStaleEntry(M.entry);
  return imageService.sendCard(
    req, res,
    imageService.svgEvent(text, entry, color, {
      kicker: req.query.kicker || '',
      plate: req.query.plate !== '0',
      name: req.query.notext !== '1',
      cover: coverParam,
      markW: size.width,
      markH: size.height
    }),
    secondChoice
      ? imageService.CACHE_CONTROL.SECOND_CHOICE
      : (current ? imageService.CACHE_CONTROL.FULL : imageService.CACHE_CONTROL.STALE_URL),
    // Kept only when the first-choice logo is the one drawn. A card made from
    // the fallback because the preferred logo failed a moment ago should be
    // drawn again soon -- not kept for a day by the player or twelve hours here.
    { remember: !secondChoice && current }
  );
});

// /img/matchup?a=&b=&al=&al2=&bl=&bl2=&fb=&color=  -> two-crest "A vs B" card.
// The crests are fetched server-side and inlined as data URIs: an SVG that
// referenced them by URL renders blank in clients that block external refs.
//
// This route owns the fallback ladder, because only it knows which URLs
// actually exist: each side tries its candidates in order; if a side is still
// missing and the provider shipped a poster (fb), that poster is served; if
// nothing at all resolves, a name card. The catalog no longer has to guess.
// Every candidate is fetched at once and the FIRST that resolved wins, so a
// dead first choice costs nothing: the worst case for the whole card is one
// FETCH_TIMEOUT_MS, not one per candidate. The extra requests are cheap — the
// usual second candidate is a dead provider URL that 404s instantly and then
// sits in getImage()'s negative cache.
const firstImage = async (urls) => {
  // All started together, taken in order: a first choice that has arrived is
  // used without waiting on a slower second one.
  const pending = urls.map(url => imageService.getImage(url));
  for (let i = 0; i < pending.length; i++) {
    const entry = await pending[i];
    if (entry && entry.buffer) return { entry, url: urls[i] };
  }
  return null;
};

// Cards drawn around something missing, logged at most once per URL per ten
// minutes: enough to see a burst of misses in `docker logs`, not enough to
// drown it.
const artFallbackSeen = new Map();
function logArtFallback(kind, req) {
  const key = kind + '|' + req.originalUrl;
  const now = Date.now();
  if (now - (artFallbackSeen.get(key) || 0) < 10 * 60 * 1000) return;
  artFallbackSeen.set(key, now);
  if (artFallbackSeen.size > 2000) artFallbackSeen.delete(artFallbackSeen.keys().next().value);
  const short = v => String(v || '').slice(0, 40);
  console.log(`[art] matchup ${kind}: ${short(req.query.a)} vs ${short(req.query.b)} (${short(req.get('user-agent'))})`);
}

app.get('/img/matchup', async (req, res) => {
  const a = req.query.a || '';
  const b = req.query.b || '';
  const color = req.query.color || '333333';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  // A card drawn before -- by a player or by the warmer -- goes straight out.
  if (imageService.sendCachedCard(req, res)) return;

  // The poster is fetched alongside the crests rather than after they fail:
  // it is only ever needed on the failure path, but waiting to find that out
  // would serialise a second timeout onto the first.
  const posterPending = req.query.fb ? imageService.getImage(req.query.fb) : null;
  const [A, B] = await Promise.all([
    firstImage([req.query.al, req.query.al2].filter(Boolean)),
    firstImage([req.query.bl, req.query.bl2].filter(Boolean))
  ]);
  const askedA = !!(req.query.al || req.query.al2);
  const askedB = !!(req.query.bl || req.query.bl2);
  const missed = (!A && askedA) || (!B && askedB);
  const poster = missed && posterPending ? await posterPending : null;

  // Held to the same formats as /img, for the same reason: fb= is a URL anyone
  // can write.
  const posterArt = poster && poster.buffer
    ? (PASSTHROUGH_IMAGE_TYPES.has(poster.contentType)
      ? poster
      : (poster.png || (poster.png = await imageService.toPng(poster.buffer))))
    : null;

  // What players may keep follows from what was actually drawn. Anything drawn
  // around a crest that missed is no-store: a player told it may keep one for
  // an hour kept the Dolphins as a line of text on a TV long after the server
  // had the crest again.
  const decision = imageService.matchupDecision({
    A, B, askedA, askedB, al: req.query.al, bl: req.query.bl,
    posterUsed: !!posterArt, current: imageService.isCurrentArt(req),
    stale: imageService.isStaleEntry(A && A.entry) || imageService.isStaleEntry(B && B.entry)
  });
  res.setHeader('X-Art-Kind', decision.kind);
  if (decision.kind !== 'full') logArtFallback(decision.kind, req);

  if (posterArt) {
    // A half-resolved card loses to real provider artwork, same as before —
    // but decided here, on what actually fetched, not on what the catalog hoped.
    res.setHeader('Content-Type', posterArt.contentType);
    res.setHeader('Cache-Control', decision.cacheControl);
    return res.send(posterArt.buffer);
  }

  if (!A && !B) {
    // Nothing resolved: the plain name card rather than an empty frame.
    return imageService.sendCard(req, res, imageService.svgPlaceholder(`${a}\nvs\n${b}`, color),
      decision.cacheControl, { remember: decision.remember });
  }

  // A background wants the same card drawn larger. Bounded, because the size
  // is in the URL and rasterising is the expensive part of serving one.
  const size = {};
  const wq = parseInt(req.query.w, 10);
  const hq = parseInt(req.query.h, 10);
  if (wq >= 200 && wq <= 1920) size.w = wq;
  if (hq >= 200 && hq <= 1080) size.h = hq;

  const svg = imageService.svgMatchup(a, b, A && A.entry, B && B.entry, color, {
    aUrl: A ? A.url : null,
    bUrl: B ? B.url : null,
    ...size
  });
  return imageService.sendCard(req, res, svg, decision.cacheControl, { remember: decision.remember });
});

// ─── Shared safe HTTP client (impit + undici fallback) ───────────────────────
// Works on Windows, Linux x64/ARM64, Alpine/musl. If impit native binary is
// absent, all fetches silently use undici — streams continue to work.
const { safeFetch: _safeFetch, getImpit: _getImpit } = require('./impitClient');
const { assertPublicUrl, publicAgent } = require('./netGuard');
const { verifyManifestQuery, verifySegmentQuery, verifyUnwrapQuery } = require('./manifestLink');
const { createUnwrap, playerMode } = require('./segmentUnwrap');

// The playback path used to be silent everywhere except a hard failure: a
// stream limping along on stale playlists, or a relay refusing chunks, left
// nothing behind, so a viewer's "it kept dropping" could not be answered from
// the log at all. These lines are what answers it now -- once per stream per
// window rather than once per poll, because a stream in trouble is polled
// every few seconds and would otherwise bury everything else.
const _logLast = new Map();
function logEvery(key, ms, ...args) {
  const now = Date.now();
  if ((_logLast.get(key) || 0) + ms > now) return;
  if (_logLast.size > 5000) _logLast.clear();
  _logLast.set(key, now);
  console.log(...args);
}
const hostLabel = u => { try { return new URL(u).hostname; } catch (e) { return 'upstream'; } };
const { rewriteInternalUrl } = require('./internalUrl');
const { rewritePlaylist, absoluteEntry } = require('./playlistRewrite');
const liveDelay = require('./liveDelay');
const remint = require('./remint');
const { relayHostsFor, isRelayedHost } = require('./segmentPolicy');

// A playlist is kilobytes. Anything past this is not one.
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const MANIFEST_MAX_REDIRECTS = 3;

// ─── Manifest proxy: short-TTL cache + request coalescing ───────────────────
// Live HLS players reload /api/manifest every 2-6 s per viewer. A validated
// short-TTL cache removes per-viewer TLS handshakes and repeated upstream
// fetches. Key = url|referer|origin. Only bodies containing #EXT are cached.
const MANIFEST_TTL_MS = 3000;
const MANIFEST_CACHE_MAX = 100;
// A dead stream deserves 15 s of quiet. A stream that blinked deserves none:
// hls.js and ExoPlayer both give a playlist about three retries over a few
// seconds, so a 15 s refusal spends the player's whole budget and the session
// dies from a blip the upstream has already recovered from.
const MANIFEST_NEGATIVE_TTL_MS = 15 * 1000;
const MANIFEST_TRANSIENT_TTL_MS = 2000;

// How long a body stays usable as a stand-in after its own TTL has passed. A
// live player tolerates a playlist a segment or two old; it does not tolerate a
// 502.
const MANIFEST_STALE_MS = 15 * 1000;

// Consecutive failures per key, so one is treated as a blip and two as a fault.
const manifestFailures = new Map();
const manifestCache = new Map();      // key -> { body, expiresAt, lastAccess }
const manifestInFlight = new Map();   // key -> Promise (coalesced upstream fetch)

// Returns the stored cache ENTRY (positive or negative), or null when

// missing/expired (expired entries are deleted as before).
function manifestCacheGet(key) {
  const e = manifestCache.get(key);
  if (!e) return null;
  const now = Date.now();
  if (now > e.expiresAt) {
    // Expired, but a positive body is kept a little longer as a stand-in for
    // the failure path below. Eviction still bounds the map.
    if (e.negative || !e.body || now > e.expiresAt + MANIFEST_STALE_MS) {
      manifestCache.delete(key);
      return null;
    }
    e.lastAccess = now;
    return null;
  }
  e.lastAccess = now;
  return e;
}

/** The last good body for this key, if it is recent enough to still play. */
function manifestLastGood(key) {
  const e = manifestCache.get(key);
  if (!e || e.negative || !e.body) return null;
  return Date.now() <= e.expiresAt + MANIFEST_STALE_MS ? e.body : null;
}

function manifestCacheSet(key, body) {
  const now = Date.now();
  manifestCache.set(key, { body, expiresAt: now + MANIFEST_TTL_MS, lastAccess: now });
  manifestFailures.delete(key);
  evictManifestCacheIfNeeded();
}

function evictManifestCacheIfNeeded() {
  if (manifestCache.size > MANIFEST_CACHE_MAX) {
    const byAccess = [...manifestCache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const excess = manifestCache.size - MANIFEST_CACHE_MAX;
    for (let i = 0; i < excess; i++) manifestCache.delete(byAccess[i][0]);
  }
}

// Negative caching: dead upstreams (non-m3u8 body / fetch failure) are stored
// briefly so player polls stop re-fetching them until the entry expires.
function manifestCacheSetNegative(key, status, body, ttlMs = MANIFEST_NEGATIVE_TTL_MS) {
  const now = Date.now();
  manifestCache.set(key, { negative: true, status, body, expiresAt: now + ttlMs, lastAccess: now });
  evictManifestCacheIfNeeded();
}

// Fetch + validate the upstream manifest. Throws on failure so coalesced
// waiters share the same outcome; successful bodies are cached by the caller.
async function fetchUpstreamManifest(targetUrl, referer, origin) {
  const headers = {
    'Referer': referer,
    'Origin': origin,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
  };
  // _safeFetch: impit (browser TLS fingerprint) with automatic undici fallback.
  // A hard 10 s timeout ensures a hung upstream can never hold the viewer's poll.
  // A live playlist that takes longer than this is already useless to the player,
  // which polls every few seconds. The budget now covers the whole call rather
  // than each attempt, so this is the real ceiling.
  //
  // Redirects are followed here, one hop at a time, rather than inside the
  // client, so every address the fetch is sent to passes the private-address
  // check and not just the first. The body is capped for the same reason the
  // link is signed: the upstream is somebody else's server.
  const deadline = Date.now() + 4000;
  let url = targetUrl;
  for (let hop = 0; hop <= MANIFEST_MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('timeout');
    const result = await _safeFetch(url, {
      headers, timeoutMs: left, redirect: 'manual', maxBytes: MANIFEST_MAX_BYTES, dispatcher: publicAgent
    });
    if (result.status >= 300 && result.status < 400 && result.location) {
      url = new URL(result.location, url).toString();
      continue;
    }
    if (!result.ok) throw new Error(`HTTP ${result.status}`);
    return { body: await result.text(), url };
  }
  throw new Error('too many redirects');
}

// Both spellings: .m3u8 is what new links carry, the bare path is what every
// link handed out before it carries, and a live player reloads by the link
// it already has.
app.get(['/api/manifest', '/api/manifest.m3u8'], async (req, res) => {
  // Only links this server minted. Anything else was an open proxy that
  // fetched whatever it was given from the owner's connection (manifestLink.js).
  if (!verifyManifestQuery(req.query)) return res.status(403).send('Invalid stream link');
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://embed.st/';
  const origin = req.query.origin || 'https://embed.st';

  // How much extra buffer this viewer asked for (liveDelay.js). The link
  // carries it; an instance-wide default stands in when it does not, so an
  // addon installed before this existed still gets the owner's setting.
  const buf = liveDelay.bufferSeconds(
    req.query.buf === undefined ? process.env.LIVE_BUFFER_SECONDS : req.query.buf
  );
  // What this stream has published is remembered once, for every viewer of
  // it; what goes out differs by the buffer asked for, so the cache holds one
  // body per buffer.
  const streamKey = `${targetUrl}|${referer}|${origin}`;
  // A libmpv player is handed a different playlist (segmentUnwrap.js), so it
  // gets its own slot. Sharing one would serve a Mac-shaped playlist to the TV
  // -- or the TV's to the Mac -- depending only on which asked first. Every
  // other player keeps exactly the key it always had.
  const player = playerMode(req.query, req.headers['user-agent']);
  const cacheKey = player ? `${streamKey}|${buf}|${player}` : `${streamKey}|${buf}`;
  if (player) {
    logEvery(`mpv:${streamKey}`, 10 * 60 * 1000,
      `[ManifestProxy] libmpv player on ${hostLabel(targetUrl)} (${String(req.headers['user-agent'] || 'no user-agent').slice(0, 40)}${req.query.pl ? ', chosen in setup' : ''}): disguised chunks unwrapped`);
  }
  const entry = manifestCacheGet(cacheKey);
  if (entry && entry.negative) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Manifest-Cache', 'NEGATIVE');
    return res.status(entry.status).send(entry.body);
  }
  if (entry) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Manifest-Cache', 'HIT');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(entry.body);
  }

  try {
    let fetchPromise = manifestInFlight.get(cacheKey);
    if (!fetchPromise) {
      fetchPromise = (async () => {
        // An address that has already been re-minted is used straight away;
        // the player is still polling the one it was given (remint.js).
        const standIn = remint.getSubstitute(targetUrl);
        let askUrl = standIn || targetUrl;
        let askReferer = referer;
        let askOrigin = origin;

        const fetchOnce = async () => {
          const got = await fetchUpstreamManifest(askUrl, askReferer, askOrigin);
          if (!got.body.includes('#EXT')) throw new Error('Upstream returned non-m3u8 body');
          return got;
        };

        let out, finalUrl;
        try {
          ({ body: out, url: finalUrl } = await fetchOnce());
        } catch (err) {
          // A refusal, or a 200 that is not a playlist, is how a source says
          // the token in the address has expired -- measured: TotalSportek's
          // (since removed) lasted about thirty minutes, halfway through a match. The
          // stream is still on; only the address is stale. Re-resolving the
          // source produces the same feed under a fresh address, and the
          // player never learns anything happened (remint.js).
          const code = /^HTTP (\d+)$/.exec(err.message);
          const expired = err.message === 'Upstream returned non-m3u8 body'
            || (code && remint.looksExpired({ status: Number(code[1]) }));
          if (!expired || !remint.mayAttempt(targetUrl)) throw err;
          remint.noteAttempt(targetUrl);
          const fresh = await remintUpstream(targetUrl);
          if (!fresh || !fresh.url) throw err;
          remint.setSubstitute(targetUrl, fresh.url);
          let freshHost = '';
          try { freshHost = new URL(fresh.url).hostname; } catch (e) { freshHost = 'upstream'; }
          console.log(`[ManifestProxy] re-minted an expired address (${err.message}) on ${freshHost}`);
          askUrl = fresh.url;
          if (fresh.referer) askReferer = fresh.referer;
          if (fresh.origin) askOrigin = fresh.origin;
          ({ body: out, url: finalUrl } = await fetchOnce());
        }

        // Every address made absolute, sub-playlists and the media of hosts
        // that refuse a player pointed back here (playlistRewrite.js). Which
        // hosts those are is known, or found out once per host by trying a
        // chunk (segmentPolicy.js).
        const hosts = await relayHostsFor(out, askUrl, finalUrl, askReferer, askOrigin);

        // The extra buffer (liveDelay.js), applied to the source's own
        // addresses so that what is remembered does not depend on which of
        // them are relayed. Every media playlist is remembered even when no
        // buffer was asked for: the viewer who asks for one next is only
        // served a deep window if there is already something to fill it.
        const media = (uri) => absoluteEntry(uri, askUrl, finalUrl);
        const { body: buffered, parsed, state } = liveDelay.applyBuffer(out, {
          key: streamKey,
          seconds: buf,
          retained: (_st, pl) => pl.segs.length > 0 && liveDelay.retentionOk(media(pl.segs[0].uri))
        });
        // Whether this host keeps a segment it has stopped listing is asked
        // once, of the oldest one it has dropped, and the answer is for the
        // playlists after this one.
        if (parsed && state) {
          const gone = liveDelay.expiredSegments(state, parsed);
          if (gone.length) liveDelay.askRetention(media(gone[0].uri), askReferer, askOrigin).catch(() => {});
        }

        const rewrittenResult = rewritePlaylist(buffered, { targetUrl: askUrl, finalUrl, referer: askReferer, origin: askOrigin, hosts, buf, unwrap: player === 'mpv' });
        manifestCacheSet(cacheKey, rewrittenResult);
        return rewrittenResult;
      })().finally(() => {
        manifestInFlight.delete(cacheKey);
      });
      manifestInFlight.set(cacheKey, fetchPromise);
    }

    const finalBody = await fetchPromise;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Manifest-Cache', 'MISS');
    // A live playlist is a different document every few seconds. Without this a
    // cache between here and the player is free to guess, and a guess means the
    // player re-reads a playlist it already has and finds nothing to play.
    res.setHeader('Cache-Control', 'no-store');
    res.send(finalBody);
  } catch (err) {
    // A non-m3u8 body is a definitive answer -- the stream is gone, not
    // stumbling -- so it keeps the full quiet period and the 404 that lets a
    // player fail over to another source.
    if (err.message === 'Upstream returned non-m3u8 body') {
      logEvery(`gone:${streamKey}`, 60 * 1000,
        `[ManifestProxy] stream gone on ${hostLabel(targetUrl)}: upstream answered with something that is not a playlist`);
      manifestCacheSetNegative(cacheKey, 404, 'Stream not found or expired');
      return res.status(404).send('Stream not found or expired');
    }

    // Anything else -- a reset socket, a 5xx, a timeout -- may well be a blip.
    // Serving the last good playlist keeps the session alive across it; the
    // player re-reads a moment later and carries on.
    const stale = manifestLastGood(cacheKey);
    if (stale) {
      // The viewer is still watching, on a playlist that has stopped moving.
      // A few of these in a row is a stream about to drop; this line is how
      // that shows up afterwards instead of not at all.
      logEvery(`stale:${streamKey}`, 60 * 1000,
        `[ManifestProxy] serving last good playlist for ${hostLabel(targetUrl)}: ${String(err.message).slice(0, 80)}`);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Manifest-Cache', 'STALE');
      return res.send(stale);
    }

    console.error('[ManifestProxy] Error:', err.message);
    // First failure with nothing to fall back on is refused briefly so the next
    // poll actually retries the upstream; a second consecutive one is treated
    // as a fault and earns the full quiet period.
    const fails = (manifestFailures.get(cacheKey) || 0) + 1;
    manifestFailures.set(cacheKey, fails);
    if (manifestFailures.size > MANIFEST_CACHE_MAX * 2) manifestFailures.clear();
    // The reason stays in the log. Sent back, "connect ECONNREFUSED ip:port"
    // told a caller which ports were open on the network behind this server.
    manifestCacheSetNegative(
      cacheKey, 502, 'Manifest proxy error',
      fails >= 2 ? MANIFEST_NEGATIVE_TTL_MS : MANIFEST_TRANSIENT_TTL_MS
    );
    return res.status(502).send('Manifest proxy error');
  }
});

// ─── Segment relay ───────────────────────────────────────────────────────────
// Media for the hosts that refuse a player's own TLS handshake -- see
// playlistRewrite.js for which and why. Each chunk is fetched with the same
// browser-fingerprint client the playlist was, and its bytes are piped to the
// player as they arrive: nothing is held beyond a socket's worth, and a player
// that goes away takes its upstream request with it. A chunk is a few hundred
// kilobytes every few seconds per viewer, which is the bandwidth this costs.
const SEGMENT_MAX_BYTES = 32 * 1024 * 1024;
const SEGMENT_MAX_INFLIGHT = 24;
// A household: a TV and a couple of phones, a chunk or two in flight each.
const SEGMENT_MAX_INFLIGHT_PER_ADDRESS = 6;
const SEGMENT_HEADERS_TIMEOUT_MS = 10000;
const SEGMENT_IDLE_TIMEOUT_MS = 15000;
// A chunk is a few seconds of video. One that takes a minute cannot play live
// anyway, and this is the one bound a slow reader cannot keep pushing back.
const SEGMENT_MAX_MS = 60000;
const SEGMENT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
// What relayed bytes may be called. Anything else is served as bytes, and
// with the same headers the other routes give somebody else's content, so a
// body that turned out to be HTML is never a page on this origin.
const SEGMENT_TYPES = /^(video|audio)\/|^application\/(mp4|octet-stream)$/i;
const { Readable: _Readable, Transform: _Transform, promises: _streamPromises } = require('stream');
let segmentsInFlight = 0;
const segmentsByAddress = new Map();   // address -> in flight

const hostOfUrl = u => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
/** The same CDN: "lb2.strmd.st" and "cdn7.strmd.st". */
const sameCdn = (a, b) => a.split('.').slice(-2).join('.') === b.split('.').slice(-2).join('.');

/**
 * Release a body nothing will read. A stream dropped before its end can emit
 * 'error' -- undici's does -- and unheard, that ends the process.
 */
function dropBody(body) {
  if (!body || typeof body.destroy !== 'function') return;
  if (typeof body.on === 'function') body.on('error', () => {});
  try { body.destroy(); } catch (e) { /* already gone */ }
}

/** One hop of a segment fetch: status, a header reader and a Node stream body. */
async function fetchSegmentHop(url, headers, signal) {
  const impit = _getImpit();
  if (impit) {
    // The signal ends the wait; the timeout ends the native request behind
    // it, which would otherwise run on to the upstream's own patience.
    const r = await impit.fetch(url, { headers, signal, redirect: 'manual', timeout: SEGMENT_MAX_MS });
    return {
      status: r.status,
      header: name => r.headers.get(name) || '',
      body: r.body && typeof r.body.getReader === 'function' ? _Readable.fromWeb(r.body) : r.body
    };
  }
  const { request } = require('undici');
  const r = await request(url, { headers, signal, dispatcher: publicAgent, headersTimeout: SEGMENT_HEADERS_TIMEOUT_MS });
  return {
    status: r.statusCode,
    header: name => { const v = r.headers[name.toLowerCase()]; return Array.isArray(v) ? v[0] : (v || ''); },
    body: r.body
  };
}

async function relaySegment(req, res) {
  // Only links this server minted (manifestLink.js): anything else was an open
  // relay fetching whatever it was given from the owner's connection. And only
  // for a host whose media is relayed as things stand: a link for any other is
  // stale, or the relay has been switched off since it was minted.
  //
  // An unwrap link is the one exception to the host list. It is minted only
  // for a disguised chunk in a playlist this server rewrote for a libmpv
  // player (segmentUnwrap.js), and its own signature -- a separate kind, so an
  // ordinary relay link cannot be turned into one -- is what authorises it.
  // The host behind it answers any player, so it is on no relay list.
  const unwrap = req.query.u === '1' && verifyUnwrapQuery(req.query);
  if (!unwrap && !verifySegmentQuery(req.query)) return res.status(403).send('Invalid stream link');
  const firstHost = hostOfUrl(req.query.url);
  if (!unwrap && !isRelayedHost(firstHost)) return res.status(403).send('Not a relayed host');

  const address = String(req.ip || '').replace(/^::ffff:/, '');
  const mine = segmentsByAddress.get(address) || 0;
  if (segmentsInFlight >= SEGMENT_MAX_INFLIGHT || mine >= SEGMENT_MAX_INFLIGHT_PER_ADDRESS) {
    res.setHeader('Retry-After', '1');
    return res.status(503).send('Busy');
  }
  segmentsInFlight++;
  segmentsByAddress.set(address, mine + 1);

  const control = new AbortController();
  let timer = null;
  let cap = null;
  let stopped = '';   // why this relay was cut short, when it was
  // Aborting the fetch covers the wait for headers; once the body is flowing
  // it is the pipeline that has to be torn down, which destroying our own
  // stream in it does on either client.
  const stop = (why) => { stopped = why; control.abort(); if (cap) cap.destroy(new Error(why)); };
  const arm = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => stop(why), ms); };
  const deadline = setTimeout(() => stop('took too long'), SEGMENT_MAX_MS);
  // A player that gives up while the upstream is still answering must not
  // leave that fetch running to nobody.
  res.on('close', () => { if (!res.writableFinished) control.abort(); });
  try {
    const headers = { 'User-Agent': SEGMENT_UA };
    if (req.query.referer) headers.Referer = req.query.referer;
    if (req.query.origin) headers.Origin = req.query.origin;
    // Not for an unwrap: the disguise is at the head of the chunk and has to
    // be seen to be cut off, and a range asked of the stripped file would be
    // in the wrong coordinates upstream. The whole chunk is fetched instead.
    if (!unwrap && typeof req.headers.range === 'string') headers.Range = req.headers.range;

    // Redirects followed one hop at a time, so every address is checked, not
    // just the first -- and kept to the CDN, or a host relayed anyway. A CDN
    // has no reason to send a chunk anywhere else.
    let url = req.query.url;
    let upstream = null;
    arm(SEGMENT_HEADERS_TIMEOUT_MS, 'no headers from upstream');
    for (let hop = 0; hop <= MANIFEST_MAX_REDIRECTS; hop++) {
      const host = hostOfUrl(url);
      if (hop > 0 && !(isRelayedHost(host) || sameCdn(host, firstHost))) return res.status(502).send('Segment unavailable');
      await assertPublicUrl(url);
      upstream = await fetchSegmentHop(url, headers, control.signal);
      const location = upstream.header('location');
      if (upstream.status >= 300 && upstream.status < 400 && location) {
        dropBody(upstream.body);
        url = new URL(location, url).toString();
        upstream = null;
        continue;
      }
      break;
    }
    if (!upstream) return res.status(502).send('Too many redirects');
    if (upstream.status >= 400) {
      dropBody(upstream.body);
      logEvery(`relay:${firstHost}:${upstream.status}`, 60 * 1000,
        `[SegmentRelay] ${firstHost} refused a chunk: ${upstream.status}`);
      // A 403 or 404 is the upstream's answer about this chunk, and a player
      // handles either; anything else is this relay's problem to report.
      return res.status(upstream.status === 403 || upstream.status === 404 ? upstream.status : 502).send('Segment unavailable');
    }
    // A body known to be over the cap is refused before a byte of it moves,
    // rather than promised in full and cut off part way.
    if (Number(upstream.header('content-length')) > SEGMENT_MAX_BYTES) {
      dropBody(upstream.body);
      return res.status(502).send('Segment too large');
    }
    // A chunk is video. A body of a few bytes under a 200, or a page where a
    // chunk should be, is an edge saying the chunk is gone without saying so --
    // Streamed's answered a rolled-off chunk with nine bytes. Said as a 404, a
    // player skips it; passed on, it chokes. Keys, init sections and subtitle
    // pieces are small or text by nature, and the link's name says which they
    // are (manifestLink.js); a chunk served as text/plain is still a chunk.
    const declared = upstream.header('content-length');
    const upType = String(upstream.header('content-type') || '').toLowerCase();
    const small = /\.(key|bin|mp4|m4s|vtt|webvtt)$/i.test(String(req.params.name || ''));
    const tiny = upstream.status === 200 && declared !== '' && Number(declared) < 128;
    const page = /html|json|xml/.test(upType);
    if (!small && (tiny || page)) {
      dropBody(upstream.body);
      return res.status(404).send('Segment unavailable');
    }

    res.status(!unwrap && upstream.status === 206 ? 206 : 200);
    const type = String(upstream.header('content-type') || 'video/mp2t').split(';')[0].trim();
    // What arrives labelled image/webp leaves as what it is.
    res.setHeader('Content-Type', unwrap ? 'video/mp2t' : (SEGMENT_TYPES.test(type) ? type : 'application/octet-stream'));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // Cutting the disguise off changes the length and shifts every offset, so
    // the upstream's own length and range would describe a different file.
    if (!unwrap) {
      for (const name of ['content-length', 'content-range', 'accept-ranges']) {
        const v = upstream.header(name);
        if (v) res.setHeader(name, v);
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');

    let sent = 0;
    arm(SEGMENT_IDLE_TIMEOUT_MS, 'upstream went quiet');
    cap = new _Transform({
      transform(chunk, enc, cb) {
        sent += chunk.length;
        if (sent > SEGMENT_MAX_BYTES) return cb(new Error('segment too large'));
        arm(SEGMENT_IDLE_TIMEOUT_MS, 'upstream went quiet');
        cb(null, chunk);
      }
    });
    if (unwrap) {
      const strip = createUnwrap((cut, found) => {
        if (cut) logEvery(`unwrap:${firstHost}:${cut}`, 10 * 60 * 1000, `[SegmentRelay] ${firstHost}: cut a ${cut}-byte disguise off its chunks`);
        else if (!found) logEvery(`unwrap?:${firstHost}`, 10 * 60 * 1000, `[SegmentRelay] ${firstHost}: no transport stream found in a chunk; passed through as it came`);
      });
      await _streamPromises.pipeline(upstream.body, strip, cap, res);
    } else {
      await _streamPromises.pipeline(upstream.body, cap, res);
    }
  } catch (err) {
    // The pipeline destroys `res` on any error, so its state says nothing
    // about who left. A player that went away is not worth a line in the log;
    // a relay this server cut short, or an upstream that failed, is.
    const gone = !stopped && err && (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.name === 'AbortError');
    if (!gone) console.error('[SegmentRelay]', stopped || (err && err.message));
    if (!res.headersSent) res.status(502).send('Segment relay error');
    else if (!res.writableEnded) res.destroy();
  } finally {
    clearTimeout(timer);
    clearTimeout(deadline);
    control.abort();
    segmentsInFlight--;
    const left = (segmentsByAddress.get(address) || 1) - 1;
    if (left > 0) segmentsByAddress.set(address, left); else segmentsByAddress.delete(address);
  }
}
app.get('/api/segment', relaySegment);
app.get('/api/segment/:name', relaySegment);

// ─── /api/proxy-embed — CORS-safe embed HTML fetcher (SSRF-protected) ────────
// Fetches the HTML of a sports embed page on behalf of the client browser.
// The browser cannot fetch embedindia.st directly (CORS), but this endpoint
// can. It then returns the raw HTML so client-side JS can run the extractor.
//
// SSRF mitigation: only allowed embed domains are accepted (CG-05 / D-05).

// Checked 2026-09-13 and removed: embedindia.com and embedsport.xyz were not
// registered, embedstream.top was pending deletion, embedindia.st resolved to
// 0.0.0.0 and vecloud.net to nothing. A lapsed name on this list is one anyone
// can buy, and then this route fetches their page for them.
const ALLOWED_EMBED_DOMAINS = new Set([
  'embed.st',
  'embedme.top',
  'embedstream.me',
  'streamtape.com',
  'sportsurge.net',
  'viprow.me',
  'vipbox.lc',
]);

const EMBED_MAX_BYTES = 2 * 1024 * 1024;

const PROXY_EMBED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

app.get('/api/proxy-embed', async (req, res) => {
  const rawUrl = req.query.url;
  const referer = req.query.referer || '';

  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url parameter' });

  let parsed;
  try {
    parsed = new URL(decodeURIComponent(rawUrl));
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Invalid URL protocol' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // SSRF protection: reject any domain not in the allowlist
  if (!ALLOWED_EMBED_DOMAINS.has(parsed.hostname)) {
    console.warn(`[proxy-embed] Blocked SSRF attempt for domain: ${parsed.hostname}`);
    return res.status(403).json({ error: `Domain ${parsed.hostname} is not in the allowed embed domain list.` });
  }

  try {
    const headers = {
      'User-Agent': PROXY_EMBED_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    };
    if (referer) headers['Referer'] = referer;

    // Redirects are followed by hand, so every hop is held to the same list
    // and the same private-address check. Followed automatically, one allowed
    // domain that redirects was a way to fetch anything at all.
    const deadline = Date.now() + 12000;
    let target = parsed;
    let html = null;
    for (let hop = 0; hop <= 3 && html === null; hop++) {
      if (!ALLOWED_EMBED_DOMAINS.has(target.hostname) || !['http:', 'https:'].includes(target.protocol)) {
        return res.status(403).json({ error: 'The embed redirected outside the allowed domains.' });
      }
      await assertPublicUrl(target.toString());
      const upstream = await _safeFetch(target.toString(), {
        headers,
        timeoutMs: Math.max(1000, deadline - Date.now()),
        redirect: 'manual',
        maxBytes: EMBED_MAX_BYTES,
        dispatcher: publicAgent
      });
      if (upstream.status >= 300 && upstream.status < 400 && upstream.location) {
        target = new URL(upstream.location, target);
        continue;
      }
      html = await upstream.text();
    }
    if (html === null) return res.status(502).json({ error: 'Failed to fetch embed page' });

    // Plain text, not a page. The extractor on /watch only ever reads it as a
    // string, and served as HTML from this origin it would run as this site,
    // with the visitor's sign-in cookies.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(html);
  } catch (err) {
    console.error(`[proxy-embed] Fetch failed for ${parsed.hostname}: ${err.message}`);
    res.status(502).json({ error: 'Failed to fetch embed page' });
  }
});


// Mount the HLS Video Proxy (routes to the internal resolver on port RESOLVER_PORT)
app.use('/api', createProxyMiddleware({
  target: `http://127.0.0.1:${RESOLVER_PORT}/api`,
  changeOrigin: true,
  xfwd: true,
  logLevel: 'debug',
  onError: (err, req, res) => {
    console.error('[Proxy Error] Failed to proxy /api request to internal resolver:', err.message);
    if (!res.headersSent) {
      res.status(502).send('Bad Gateway: Internal stream resolver is not responding.');
    }
  }
}));

// ─── Universal Dynamic Base URL Response Rewriter ─────────────────────────────
// Intercepts /manifest.json, /catalog/*, /meta/*, and /stream/* responses to
// dynamically rewrite all internal proxy URLs (/img, /watch, /api/manifest)
// to match the client's incoming Host and Protocol.
app.use((req, res, next) => {
  const isAddonRoute = req.path === '/manifest.json' || 
                       req.path.endsWith('/manifest.json') ||
                       req.path.includes('/catalog/') || 
                       req.path.includes('/meta/') || 
                       req.path.includes('/stream/');
  
  if (!isAddonRoute) return next();

  // Catalogs and metas are the lists of artwork addresses.
  const isList = req.path.includes('/catalog/') || req.path.includes('/meta/');
  const currentBaseUrl = getRequestBaseUrl(req);
  const originalWrite = res.write;
  const originalEnd = res.end;
  const chunks = [];

  res.write = function (chunk) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };

  res.end = function (chunk, encoding, callback) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

    // A catalog or meta is sent as something a player must not keep, as
    // AIOMetadata sends its own. Kept, a player goes on naming cards by the
    // addresses it had; re-read on every open, it picks up new ones the moment
    // the artwork generation changes. The ETag makes a re-read that finds
    // nothing new a 304 instead of the whole list.
    const finish = (buf, enc) => {
      if (isList && res.statusCode === 200 && !res.headersSent) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        const etag = 'W/"' + crypto.createHash('sha1').update(buf).digest('base64url') + '"';
        res.setHeader('ETag', etag);
        const offered = String(req.headers['if-none-match'] || '').split(',').map(s => s.trim());
        if (offered.includes(etag)) {
          res.statusCode = 304;
          res.removeHeader('Content-Length');
          res.removeHeader('Content-Type');
          return originalEnd.call(res, undefined, undefined, callback);
        }
      }
      // Only for a body that is actually sent: an empty 304 or a HEAD from
      // Express keeps the headers Express chose.
      if (!res.headersSent && buf.length && req.method !== 'HEAD'
        && res.statusCode !== 304 && res.statusCode !== 204) {
        res.setHeader('Content-Length', buf.length);
      }
      return originalEnd.call(res, buf, enc, callback);
    };

    if (chunks.length > 0) {
      const bodyBuffer = Buffer.concat(chunks);
      const bodyString = bodyBuffer.toString('utf8');

      try {
        const body = JSON.parse(bodyString);
        let modified = false;

        // Relative and absolute forms both, in one place, tested in
        // tests/internal-url.test.js -- see src/internalUrl.js for why.
        const rewriteUrl = (url) => {
          const out = rewriteInternalUrl(url, currentBaseUrl);
          if (out !== url) modified = true;
          return out;
        };

        // 1. Streams payload (/stream/tv/*.json)
        if (body && Array.isArray(body.streams)) {
          body.streams.forEach(s => {
            if (s.url) s.url = rewriteUrl(s.url);
            if (s.externalUrl) s.externalUrl = rewriteUrl(s.externalUrl);
          });
        }

        // 2. Catalog payload (/catalog/tv/*.json)
        if (body && Array.isArray(body.metas)) {
          body.metas.forEach(meta => {
            if (meta.poster) meta.poster = rewriteUrl(meta.poster);
            if (meta.background) meta.background = rewriteUrl(meta.background);
            if (meta.logo) meta.logo = rewriteUrl(meta.logo);
          });
        }

        // 3. Meta detail payload (/meta/tv/*.json)
        if (body && body.meta) {
          if (body.meta.poster) body.meta.poster = rewriteUrl(body.meta.poster);
          if (body.meta.background) body.meta.background = rewriteUrl(body.meta.background);
          if (body.meta.logo) body.meta.logo = rewriteUrl(body.meta.logo);
        }

        // 4. Manifest payload (/manifest.json)
        if (body && (body.logo || body.background)) {
          if (body.logo) body.logo = rewriteUrl(body.logo);
          if (body.background) body.background = rewriteUrl(body.background);
        }

        if (modified) {
          const newBodyString = JSON.stringify(body);
          const newBuffer = Buffer.from(newBodyString, 'utf8');
          return finish(newBuffer, 'utf8');
        }
      } catch (_) {
        // Not JSON or parse failure; fall through
      }
    }

    return finish(Buffer.concat(chunks), encoding);
  };

  next();
});

/**
 * Decodes a config URL segment. Accepts URL-encoded JSON or base64url JSON.
 * Returns null when the segment is not a valid config.
 */
/**
 * The saved configuration, and the fixed address that serves it.
 *
 * Settings normally travel inside the addon's own URL, which means changing one
 * mints a different URL and the addon has to be installed again to pick it up.
 * Saved settings live here instead, behind a URL that never changes: install
 * /saved/manifest.json once and later edits arrive without touching the player.
 *
 * Profiles are keyed by a v4 uuid, so one server can hold several independent
 * setups -- a household where two people want different sports, or one person
 * keeping a lean phone profile beside a full one on the TV.
 *
 * The uuid is the whole secret. It is 122 bits from a CSPRNG, it never leaves
 * the server except in the URL its owner installs, and it names a file that
 * holds nothing but catalog preferences. Nothing is encrypted into the URL
 * because nothing sensitive is in it -- the config lives here, on disk.
 *
 * Changing one takes a real sign-in or that profile's edit key, so knowing a
 * uuid lets someone use a profile, never overwrite one.
 */
const { DATA_DIR } = require('./config');
const PROFILE_DIR = path.join(DATA_DIR, 'profiles');
// Where the single pre-profile config lived. Still read, still served, so an
// install made before profiles existed keeps working untouched.
const LEGACY_CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LEGACY_ID = 'default';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const _profiles = new Map();   // id -> config, read through

// On an instance with no AUTH_KEY everybody "is signed in", so signing in
// cannot be what stops a stranger rewriting a household's profile. There, a
// profile is guarded by its own edit key: minted when the profile is created,
// handed to that browser once, and kept here only as a hash beside it.
const OPEN_PROFILE_LIMIT = Number(process.env.PROFILE_LIMIT) || 500;

/** Signed in with a real key -- AUTH_KEY set and given, or ADMIN_TOKEN. */
function ownsEverything(req) {
  return (!!process.env.AUTH_KEY && isAuthed(req)) || isAdmin(req);
}

function editKeyPath(id) {
  const file = profilePath(id);
  return file ? file.replace(/\.json$/, '.key') : null;
}

const hashEditKey = key => crypto.createHash('sha256').update(String(key)).digest('hex');

function writeEditKey(id, key) {
  const file = editKeyPath(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, hashEditKey(key), { mode: 0o600 });
}

/** May this caller change or delete the profile? */
function mayEditProfile(req, id) {
  if (ownsEverything(req)) return true;
  const given = req.get('x-profile-key') || '';
  const file = editKeyPath(id);
  if (!given || !file) return false;
  let want;
  try { want = fs.readFileSync(file, 'utf8').trim(); } catch (e) { return false; }
  const a = Buffer.from(hashEditKey(given));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function profilePath(id) {
  // Never build a path from an unchecked id: a caller supplies it, and '..' in
  // one would otherwise walk straight out of the profiles directory.
  if (id === LEGACY_ID) return LEGACY_CONFIG_FILE;
  if (!UUID_RE.test(id)) return null;
  return path.join(PROFILE_DIR, id + '.json');
}

function loadProfile(id) {
  if (_profiles.has(id)) return _profiles.get(id);
  const file = profilePath(id);
  let config = null;
  if (file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    } catch (e) { config = null; }   // absent or unreadable
  }
  // Only profiles that exist are remembered. Ids that name nothing are whatever
  // a caller typed, and remembering each of those would grow without end.
  if (config) _profiles.set(id, config);
  return config;
}

function writeProfile(id, config) {
  const file = profilePath(id);
  if (!file) throw new Error('bad profile id');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written beside the target and renamed, so a crash midway cannot leave a
  // half-written file that then fails to parse on the next boot.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config), 'utf8');
  fs.renameSync(tmp, file);
  _profiles.set(id, config);
}

function listProfiles() {
  const out = [];
  if (loadProfile(LEGACY_ID)) out.push(LEGACY_ID);
  try {
    for (const f of fs.readdirSync(PROFILE_DIR)) {
      if (f.endsWith('.json') && UUID_RE.test(f.slice(0, -5))) out.push(f.slice(0, -5));
    }
  } catch (e) { /* no profiles directory yet */ }
  return out;
}

// Kept so the rest of the file reads the same: the legacy id is just a profile.
const loadSavedConfig = () => loadProfile(LEGACY_ID);
const writeSavedConfig = config => writeProfile(LEGACY_ID, config);
const SAVED_CONFIG_FILE = LEGACY_CONFIG_FILE;

/**
 * Profiles saved before edit keys existed have none, and on an instance with no
 * AUTH_KEY that left them impossible to change -- the install URL in the player
 * frozen for good. Each gets a key at boot, printed once to this log: whoever
 * reads the server's log is whoever runs the server.
 */
function issueMissingEditKeys() {
  if (process.env.AUTH_KEY) return;
  for (const id of listProfiles()) {
    const file = editKeyPath(id);
    if (!file || fs.existsSync(file)) continue;
    const key = crypto.randomBytes(24).toString('base64url');
    try {
      writeEditKey(id, key);
      const home = id === LEGACY_ID ? '/saved' : '/p/' + id;
      console.log(`[profiles] ${id} had no edit key. Open ${home}/configure#key=${key} on this server to edit it.`);
    } catch (e) {
      console.error(`[profiles] could not give ${id} an edit key: ${e.message}`);
    }
  }
}
issueMissingEditKeys();

/** Whether this directory will still exist after the container is rebuilt. */
function savedConfigIsDurable() {
  try {
    return fs.existsSync('/.dockerenv') ? fs.existsSync(DATA_DIR) && isMountPoint(DATA_DIR) : true;
  } catch (e) {
    return false;
  }
}

function isMountPoint(dir) {
  try {
    const here = fs.statSync(dir);
    const up = fs.statSync(path.join(dir, '..'));
    return here.dev !== up.dev;     // a different device means a volume is mounted
  } catch (e) {
    return false;
  }
}

function encodeConfigSegment(config) {
  return Buffer.from(JSON.stringify(config), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeConfigSegment(configStr) {
  try {
    let parsed;
    if (configStr.startsWith('%7B') || configStr.startsWith('{')) {
      parsed = JSON.parse(decodeURIComponent(configStr));
    } else {
      let base64 = configStr.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) {
        base64 += '=';
      }
      parsed = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}
app.get('/:config?/manifest.json', (req, res, next) => {
  const { manifest, SEARCH_TWIN_SUFFIX } = require('./manifest');
  let parsedConfig = {};
  if (req.params.config) {
    parsedConfig = decodeConfigSegment(req.params.config);
    if (parsedConfig === null) return next();
  }

  // Clone manifest catalogs
  const newManifest = JSON.parse(JSON.stringify(manifest));
  
  if (typeof parsedConfig.sports === 'string' && parsedConfig.sports !== 'all') {
    const enabled = new Set(parsedConfig.sports.split(',').map(x => x.trim()).filter(Boolean));

    // Which sport a tab belongs to, worked out from its own id rather than from
    // a list kept alongside. The list fell behind as tabs were added, and the
    // failure was silent and backwards: College, Other Football and Channels
    // were dropped by any sports filter, including one that had them ticked.
    const ALWAYS = new Set(['live', 'upcoming', 'teams', 'channels', 'local']);
    const SPORT_FOR_CATALOG = { other_football: 'american_football' };

    newManifest.catalogs = newManifest.catalogs.filter(c => {
      const key = String(c.id).replace(/^nuvio_sports_/, '');
      if (ALWAYS.has(key)) return true;
      return enabled.has(SPORT_FOR_CATALOG[key] || key);
    });
  }
  
  // The viewer's own tab order and names, set on the configure page.
  //
  // Applied to whatever survived the filtering above rather than to the full
  // list, so a tab hidden by the sports selection stays hidden even if the
  // saved order still mentions it.
  if (typeof parsedConfig.catalogOrder === 'string' && parsedConfig.catalogOrder) {
    const wanted = parsedConfig.catalogOrder.split(',').map(x => x.trim()).filter(Boolean);
    const rank = id => {
      const i = wanted.indexOf(id);
      // A tab the saved order has never seen -- one added since -- keeps its
      // place at the end rather than jumping to the front.
      return i === -1 ? wanted.length : i;
    };
    newManifest.catalogs = newManifest.catalogs
      .map((c, i) => ({ c, i }))
      .sort((a, b) => rank(a.c.id) - rank(b.c.id) || a.i - b.i)
      .map(x => x.c);
  }

  // Per-tab options: hide it, make it searchable or not, or make it appear only
  // when searched. The first three are manifest-level; shuffle and reverse are
  // about the items inside and are applied where the catalog is built.
  const catalogOptions = (parsedConfig.catalogOptions && typeof parsedConfig.catalogOptions === 'object')
    ? parsedConfig.catalogOptions
    : {};

  newManifest.catalogs = newManifest.catalogs.filter(c => !(catalogOptions[c.id] || {}).hidden);

  for (const cat of newManifest.catalogs) {
    const opts = catalogOptions[cat.id] || {};
    const extra = Array.isArray(cat.extra) ? cat.extra : [];

    // Where a catalog appears is decided by whether it can be loaded with no
    // parameters. A client puts a catalog on its home board only if it can ask
    // for it bare; a REQUIRED extra makes that impossible, and the catalog falls
    // back to the places where the client can offer a choice.
    //
    //   nothing required        home board + discover + search
    //   genre required          discover only          (opts.noHome)
    //   search required         search only            (opts.searchOnly)
    //
    // So "off the board but still browsable" is a required genre with one
    // option, which is the trick AIOMetadata uses for the same setting.
    //
    // The cost is search: a required genre means every request must carry one,
    // and a search request carries none, so this copy cannot be reached from
    // the search box. A second copy is published below to cover that.
    let next = extra;

    if (opts.noSearch) {
      next = next.filter(e => e.name !== 'search');
    } else if (!next.some(e => e.name === 'search')) {
      next = [...next, { name: 'search', isRequired: false }];
    }

    if (opts.searchOnly) {
      // Search only: the strongest of the three, so it settles the question and
      // the board/discover distinction below no longer applies.
      next = next.map(e => (e.name === 'search' ? { ...e, isRequired: true } : e));
      if (!next.some(e => e.name === 'search')) next = [...next, { name: 'search', isRequired: true }];
      next = next.filter(e => e.name !== 'genre');
    } else if (opts.noHome) {
      const own = next.find(e => e.name === 'genre');
      if (!own) {
        next = [{ name: 'genre', options: ['All'], isRequired: true }, ...next];
      } else {
        // A tab with real genres (Channels) keeps them as the choice. Required,
        // to stay off the board, with All first so the default is the whole tab.
        const options = ['All', ...(own.options || []).filter(o => o !== 'All')];
        next = next.map(e => (e.name === 'genre' ? { ...e, options, isRequired: true } : e));
      }
    } else {
      // Only the off-board placeholder goes. A tab's own genre list stays, as an
      // optional filter, so it is on the board and still has a picker.
      next = next
        .filter(e => !(e.name === 'genre' && Array.isArray(e.options) && e.options.length === 1 && e.options[0] === 'All'))
        .map(e => (e.name === 'genre' ? { ...e, isRequired: false } : e));
    }

    cat.extra = next;
    if (Array.isArray(cat.extra) && !cat.extra.length) delete cat.extra;
  }

  // The name typed into the configure page's heading. Bounded and stripped the
  // same way a catalog name is: it arrives from a URL anyone can edit, and it
  // ends up rendered in somebody's player. The id is deliberately untouched --
  // that is what an install is keyed on, so renaming stays a rename rather than
  // becoming a second addon sitting beside the first.
  if (typeof parsedConfig.addonName === 'string' && parsedConfig.addonName.trim()) {
    newManifest.name = parsedConfig.addonName
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 40);
  }

  // Shown under the name in a player's addon list. Same treatment as the name,
  // with more room because it is a sentence rather than a label.
  if (typeof parsedConfig.addonDescription === 'string' && parsedConfig.addonDescription.trim()) {
    newManifest.description = parsedConfig.addonDescription
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 300);
  }

  // Only an absolute http(s) address. A player fetches this from its own
  // machine, so a relative path would resolve against the wrong host, and
  // allowing any string here would let a config point a logo at javascript: or
  // data: in whatever renders it.
  if (typeof parsedConfig.addonLogo === 'string') {
    const logo = parsedConfig.addonLogo.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 300);
    if (/^https?:\/\/\S+$/i.test(logo)) newManifest.logo = logo;
  }

  if (parsedConfig.catalogNames && typeof parsedConfig.catalogNames === 'object') {
    for (const cat of newManifest.catalogs) {
      const renamed = parsedConfig.catalogNames[cat.id];
      // A name is free text from a URL anyone can edit, so it is bounded and
      // stripped of the control characters a client might render oddly.
      if (typeof renamed === 'string' && renamed.trim()) {
        cat.name = renamed.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
      }
    }
  }

  // Remove teams catalog if the user hasn't configured any teams
  if (typeof parsedConfig.teams !== 'string' || parsedConfig.teams.trim() === '') {
    newManifest.catalogs = newManifest.catalogs.filter(c => c.id !== 'nuvio_sports_teams');
  }
  // And the Local tab when no city is named: it could only ever be empty.
  if (typeof parsedConfig.markets !== 'string' || parsedConfig.markets.trim() === '') {
    newManifest.catalogs = newManifest.catalogs.filter(c => c.id !== 'nuvio_sports_local');
  }

  // A tab kept off the home board is published twice, because no single catalog
  // can be in Discover, off the home board and searchable at once: the required
  // genre that takes it off the board is exactly what hides it from search. The
  // twin carries a required search and nothing else, so it is invisible
  // everywhere except the search box, where it is the copy that answers. The
  // two are never both offered in the same place, so nothing is listed twice.
  //
  // Built last, so a twin inherits the name the viewer typed and is never made
  // for a tab that the filtering above has already removed.
  const twins = [];
  for (const cat of newManifest.catalogs) {
    const opts = catalogOptions[cat.id] || {};
    if (!opts.noHome || opts.searchOnly || opts.noSearch) continue;
    twins.push({
      after: cat.id,
      cat: {
        type: cat.type,
        id: cat.id + SEARCH_TWIN_SUFFIX,
        name: cat.name,
        extra: [{ name: 'search', isRequired: true }]
      }
    });
  }
  for (const t of twins) {
    const i = newManifest.catalogs.findIndex(c => c.id === t.after);
    newManifest.catalogs.splice(i + 1, 0, t.cat);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');
  res.send(newManifest);
});

// The SDK router JSON.parses the raw config segment. Nuvio installs use a
// base64url config, so rewrite it to URL-encoded JSON before the SDK sees it.
app.use((req, res, next) => {
  const m = req.url.match(/^\/([A-Za-z0-9_-]+)(\/(?:catalog|meta|stream)\/.+)$/);
  if (m && !m[1].startsWith('%7B')) {
    const parsed = decodeConfigSegment(m[1]);
    if (parsed !== null) {
      req.url = `/${encodeURIComponent(JSON.stringify(parsed))}${m[2]}`;
    }
  }
  next();
});

// Mount the Stremio addon router
app.use(getRouter(builder.getInterface()));

// ─── /watch — Embed Proxy Page ────────────────────────────────────────────────

// When the user clicks a stream, Nuvio opens this URL in the browser.
// It serves a clean full-screen HTML page that wraps the embed in an iframe,
// bypassing the referrer/origin restrictions that the raw embed.st URLs have.
//
// Query params:
//   ?url=<encoded embed URL>     the stream embed to display
//   ?title=<encoded match title> shown in the page heading

app.get('/watch', (req, res) => {
  const mode     = req.query.mode;
  const title    = req.query.title || 'Live Sports';
  // A web player plays straight from the CDN, so its playlist is not this
  // server's to deepen (liveDelay.js). What a viewer who asked for extra
  // buffer can still be given is a start further back in the window there is.
  const watchBuffer = liveDelay.bufferSeconds(
    req.query.buf === undefined ? process.env.LIVE_BUFFER_SECONDS : req.query.buf
  );

  // ─── mode=extract — Client-side HLS extraction for IP-locked embed providers ─
  // Architecture: browser fetches /api/proxy-embed → runs extractor → plays via hls.js
  // This ensures all CDN requests originate from the user's own IP (IP consistency).
  if (mode === 'extract') {
    const embedUrl  = req.query.embed;
    const referer   = req.query.referer || '';

    if (!embedUrl) return res.status(400).send('Missing ?embed parameter');

    let safeEmbed, safeReferer;
    try {
      let rawEmbed = embedUrl;
      try { if (typeof rawEmbed === 'string' && rawEmbed.includes('%')) rawEmbed = decodeURIComponent(rawEmbed); } catch (_) {}
      const parsedEmbed = new URL(rawEmbed);
      if (!['http:', 'https:'].includes(parsedEmbed.protocol)) {
        return res.status(400).send('Invalid embed URL protocol');
      }
      safeEmbed = parsedEmbed.toString();
      let rawReferer = referer || safeEmbed;
      try { if (typeof rawReferer === 'string' && rawReferer.includes('%')) rawReferer = decodeURIComponent(rawReferer); } catch (_) {}
      safeReferer = new URL(rawReferer).toString();
    } catch {
      return res.status(400).send('Invalid embed URL');
    }

    const safeTitle = String(title)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>\uD83D\uDD34 ${safeTitle} | Extracting Stream</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #0a0a0a; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #fff; }
    #stage { position: fixed; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 16px; }
    .spinner { width: 52px; height: 52px; border: 4px solid rgba(255,255,255,0.1);
      border-top-color: #f44; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #status { font-size: 15px; opacity: 0.8; text-align: center; padding: 0 24px; }
    #title  { font-size: 19px; font-weight: 700; text-align: center; padding: 0 24px; }
    #error  { display: none; flex-direction: column; align-items: center; gap: 12px; }
    #error p { font-size: 14px; opacity: 0.6; text-align: center; max-width: 340px; }
    #open-btn {
      margin-top: 6px; padding: 10px 24px; background: #f44; color: #fff;
      border: none; border-radius: 8px; font-size: 14px; font-weight: 600;
      cursor: pointer; text-decoration: none;
    }
    #video-player { display: none; position: fixed; inset: 0; width: 100%; height: 100%; background: #000; }
    #topbar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 10;
      background: linear-gradient(to bottom, rgba(0,0,0,0.85), transparent);
      padding: 12px 20px; color: #fff; font-size: 14px; font-weight: 600;
      display: flex; align-items: center; gap: 10px;
      animation: fadeOut 1s ease 4s forwards;
    }
    #topbar .dot { width: 10px; height: 10px; background: #f44; border-radius: 50%;
      flex-shrink: 0; animation: pulse 1s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    @keyframes fadeOut { to { opacity: 0; pointer-events: none; } }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js" integrity="sha384-cciJ0zi8d1uMKC2zJd7jvPY4HQt7W4ByUI/FlMkltvBi31aW61rcpVBhpmW8/NwX" crossorigin="anonymous"></script>
</head>
<body>
  <div id="topbar"><span class="dot"></span><span>${safeTitle}</span></div>
  <video id="video-player" controls autoplay playsinline></video>
  <div id="stage">
    <div class="spinner" id="spinner"></div>
    <p id="title">\uD83D\uDD34 ${safeTitle}</p>
    <p id="status">Fetching stream&hellip;</p>
    <div id="error">
      <p>Could not extract a direct stream from this embed.<br>Try opening it in your browser instead.</p>
      <a id="open-btn" href="${safeEmbed}" target="_blank" rel="noopener noreferrer">Open in Browser</a>
    </div>
  </div>
  <script>
    (async () => {
      const embedUrl = ${JSON.stringify(safeEmbed)};
      const referer  = ${JSON.stringify(safeReferer)};
      const status   = document.getElementById('status');
      const spinner  = document.getElementById('spinner');
      const errorDiv = document.getElementById('error');
      const video    = document.getElementById('video-player');
      const stage    = document.getElementById('stage');

      function showError() {
        spinner.style.display = 'none';
        status.style.display  = 'none';
        errorDiv.style.display = 'flex';
      }

      function playM3u8(url) {
        stage.style.display = 'none';
        video.style.display = 'block';
        if (Hls.isSupported()) {
          // Live tuning. On its own defaults hls.js starts three segments from
          // the end, and lowLatencyMode makes that a target it chases: at
          // liveMaxLatencyDurationCount 5 it hard-seeks back to the live edge
          // the moment playback is twenty seconds behind, throwing the buffer
          // away and starting the cycle over. Measured on this addon's sources,
          // two of three publish in eight second bursts, so that drift is
          // ordinary rather than exceptional. hls.js's own default for that
          // setting is no limit at all. Chasing off, and a start further back
          // for a viewer who asked for one.
          const EXTRA = ${watchBuffer};
          const liveOpts = EXTRA > 0
          ? { liveSyncDuration: 12 + EXTRA, liveMaxLatencyDuration: 42 + EXTRA }
          : { liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 15 };
          const hls = new Hls(Object.assign({
            lowLatencyMode: false, maxBufferLength: 60, backBufferLength: 30
          }, liveOpts));
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
          hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { stage.style.display = 'flex'; video.style.display = 'none'; showError(); } });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
          video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
        } else {
          showError();
        }
      }

      // ── Extraction patterns (client-side mirror of EmbedExtractorChain) ──
      function extractM3u8(html) {
        // Pattern A — plain M3U8 URL in source
        const a = html.match(/(https?:\\/\\/[^\\s"'<>]+\\.m3u8[^\\s"'<>]*)/i);
        if (a) return a[1];

        // Pattern D — JSON player config keys
        for (const k of ['source','file','src','url','hls','stream','streamUrl','hlsUrl']) {
          const d = html.match(new RegExp('["\\']' + k + '["\\'\\\\]\\\\s*:\\\\s*["\\'\\\\](https?:\\\\/\\\\/[^"\\'+]+\\\\.m3u8[^"\\'+]*)["\\'\\\\]', 'i'));
          if (d) return d[1];
        }

        // Pattern B — atob() encoded URL
        const atobRe = /atob\\s*\\(\\s*["']([A-Za-z0-9+\\/=_-]{20,})["']\\s*\\)/g;
        let m;
        while ((m = atobRe.exec(html)) !== null) {
          try {
            const decoded = atob(m[1].replace(/-/g,'+').replace(/_/g,'/'));
            if (decoded.includes('.m3u8')) {
              const u = decoded.match(/(https?:\\/\\/[^\\s"'<>]+\\.m3u8[^\\s"'<>]*)/i);
              if (u) return u[1];
            }
          } catch(_) {}
        }
        return null;
      }

      try {
        status.textContent = 'Fetching embed page\u2026';
        const proxyUrl = '/api/proxy-embed?url=' + encodeURIComponent(embedUrl) + '&referer=' + encodeURIComponent(referer);
        const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });

        if (!resp.ok) {
          console.warn('[extract] proxy-embed returned', resp.status);
          showError();
          return;
        }

        status.textContent = 'Analysing stream\u2026';
        const html = await resp.text();
        const m3u8 = extractM3u8(html);

        if (m3u8) {
          status.textContent = 'Starting playback\u2026';
          playM3u8(m3u8);
        } else {
          console.warn('[extract] No M3U8 URL found in embed HTML');
          showError();
        }
      } catch (err) {
        console.error('[extract] Error:', err);
        showError();
      }
    })();
  </script>
</body>
</html>`);
  }

  // ─── Default mode — iframe embed proxy (original behaviour, unchanged) ────
  const embedUrl = req.query.url;
  if (!embedUrl) {
    return res.status(400).send('Missing ?url parameter');
  }

  // Validate — only allow http/https URLs
  let safeUrl;
  try {
    let rawUrl = embedUrl;
    try { if (typeof rawUrl === 'string' && rawUrl.includes('%')) rawUrl = decodeURIComponent(rawUrl); } catch (_) {}
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).send('Invalid URL protocol');
    }
    safeUrl = parsed.toString();
  } catch {
    return res.status(400).send('Invalid URL');
  }

  const safeTitle = String(title)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <meta name="referrer" content="no-referrer">
  <title>\uD83D\uDD34 ${safeTitle} | Live Sports</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #000; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

    #topbar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 10;
      background: linear-gradient(to bottom, rgba(0,0,0,0.85), transparent);
      padding: 12px 20px; color: #fff; font-size: 14px; font-weight: 600;
      display: flex; align-items: center; gap: 10px;
      animation: fadeOut 1s ease 4s forwards;
      pointer-events: none;
    }
    #topbar .dot {
      width: 10px; height: 10px; background: #f44;
      border-radius: 50%; flex-shrink: 0;
      animation: pulse 1s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.5; transform: scale(1.3); }
    }
    @keyframes fadeOut { to { opacity: 0; } }

    #fs-btn {
      position: fixed; top: 12px; right: 16px; z-index: 100;
      display: flex; align-items: center; gap: 8px;
      background: rgba(20, 20, 20, 0.85); color: #fff;
      border: 2px solid rgba(255, 255, 255, 0.3); border-radius: 10px;
      padding: 10px 18px; font-size: 14px; font-weight: 700;
      cursor: pointer; backdrop-filter: blur(8px);
      transition: all 0.25s ease, opacity 0.6s ease;
      box-shadow: 0 4px 16px rgba(0,0,0,0.6);
      user-select: none; outline: none;
    }
    #fs-btn:hover, #fs-btn:focus {
      background: #f44; border-color: #fff;
      transform: scale(1.08); box-shadow: 0 0 20px rgba(255,68,68,0.8);
    }
    #fs-btn.fade-out { opacity: 0.15; }
    #fs-btn.fade-out:hover, #fs-btn.fade-out:focus { opacity: 1; }

    #player {
      position: fixed; top: 0; left: 0;
      width: 100vw; height: 100vh;
      border: none; display: block; background: #000;
    }

    #video-player {
      position: fixed; top: 0; left: 0;
      width: 100vw; height: 100vh;
      border: none; display: none; background: #000;
    }
    #loader {
      position: fixed; inset: 0; background: #111;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 20px; color: #fff; z-index: 5;
      transition: opacity 0.6s ease;
    }
    #loader.hidden { opacity: 0; pointer-events: none; }
    #loader .spinner {
      width: 48px; height: 48px;
      border: 4px solid rgba(255,255,255,0.15);
      border-top-color: #f44; border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #loader .match { font-size: 18px; font-weight: 600; text-align: center; padding: 0 24px; }
    #loader .hint  { font-size: 13px; opacity: 0.5; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js" integrity="sha384-cciJ0zi8d1uMKC2zJd7jvPY4HQt7W4ByUI/FlMkltvBi31aW61rcpVBhpmW8/NwX" crossorigin="anonymous"></script>
</head>
<body>
  <div id="loader">
    <div class="spinner"></div>
    <p class="match">\uD83D\uDD34 ${safeTitle}</p>
    <p class="hint">Loading stream\u2026</p>
  </div>

  <div id="topbar">
    <span class="dot"></span>
    <span>${safeTitle}</span>
  </div>

  <button id="fs-btn" tabindex="0" title="Toggle Fullscreen (or Press OK on Remote)">
    <span>\u26F6 Fullscreen</span>
  </button>

  <iframe
    id="player"
    allowfullscreen
    allow="autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; gyroscope"
    scrolling="no"
    loading="eager"
  ></iframe>

  <video id="video-player" controls autoplay playsinline></video>

  <script>
    const fsBtn = document.getElementById('fs-btn');
    function toggleFullscreen() {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        const docEl = document.documentElement;
        const req = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.mozRequestFullScreen || docEl.msRequestFullscreen;
        if (req) req.call(docEl).catch(() => {});
        fsBtn.innerHTML = '<span>\u2715 Exit Fullscreen</span>';
      } else {
        const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
        if (exit) exit.call(document).catch(() => {});
        fsBtn.innerHTML = '<span>\u26F6 Fullscreen</span>';
      }
    }
    fsBtn.addEventListener('click', toggleFullscreen);

    // Auto-dim button after 5 seconds of inactivity, wake up on remote key/mouse move
    let fsTimer;
    function resetFsButtonTimer() {
      fsBtn.classList.remove('fade-out');
      clearTimeout(fsTimer);
      fsTimer = setTimeout(() => {
        if (document.activeElement !== fsBtn) fsBtn.classList.add('fade-out');
      }, 5000);
    }
    window.addEventListener('mousemove', resetFsButtonTimer);
    window.addEventListener('keydown', (e) => {
      resetFsButtonTimer();
      // If user presses Enter or Space while focusing the body, toggle fullscreen
      if ((e.key === 'Enter' || e.key === ' ' || e.keyCode === 13) && document.activeElement === document.body) {
        toggleFullscreen();
      }
    });
    resetFsButtonTimer();

    const loader = document.getElementById('loader');
    const iframe = document.getElementById('player');
    const video = document.getElementById('video-player');
    const targetUrl = "${safeUrl}";
    const isM3u8 = targetUrl.includes('.m3u8');
    
    // Video streams play DIRECT from the upstream CDN (no server-side relay).
    let finalUrl = targetUrl;

    if (isM3u8) {
      iframe.style.display = 'none';
      video.style.display = 'block';

      // Plain hls.js. A P2P loader used to run here, which shared every
      // viewer's address with strangers watching the same stream through
      // public trackers, and pulled two unpinned scripts onto this origin.
      if (Hls.isSupported()) {
        // Live tuning. On its own defaults hls.js starts three segments from
        // the end, and lowLatencyMode makes that a target it chases: at
        // liveMaxLatencyDurationCount 5 it hard-seeks back to the live edge
        // the moment playback is twenty seconds behind, throwing the buffer
        // away and starting the cycle over. Measured on this addon's sources,
        // two of three publish in eight second bursts, so that drift is
        // ordinary rather than exceptional. hls.js's own default for that
        // setting is no limit at all. Chasing off, and a start further back
        // for a viewer who asked for one.
        const EXTRA = ${watchBuffer};
        const liveOpts = EXTRA > 0
          ? { liveSyncDuration: 12 + EXTRA, liveMaxLatencyDuration: 42 + EXTRA }
          : { liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 15 };
        const hls = new Hls(Object.assign({
          lowLatencyMode: false,
          maxBufferLength: 60,
          backBufferLength: 30,
          enableWorker: true
        }, liveOpts));
        hls.loadSource(finalUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play();
          loader.classList.add('hidden');
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = finalUrl;
        video.addEventListener('loadedmetadata', () => {
          video.play();
          loader.classList.add('hidden');
        });
      }
    } else {
      video.style.display = 'none';
      iframe.src = targetUrl;
      iframe.addEventListener('load', () => loader.classList.add('hidden'));
      setTimeout(() => loader.classList.add('hidden'), 6000);
    }
  </script>
</body>
</html>`);
});

// ─── Health Check ─────────────────────────────────────────────────────────────
// Render pings this to confirm the service is alive

app.get('/health', (_, res) => {
  // Alive, and nothing else. The cache counts that used to ride along named
  // every provider and how busy each was, to anyone who asked; the dashboard
  // has them, behind ADMIN_TOKEN.
  res.json({ status: 'ok', service: 'aiosports' });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

// A re-sync that brought new or changed fixtures asks for their artwork to be
// drawn before anyone opens the tab. A re-sync that changed nothing asks for
// nothing -- otherwise a warm pass that happened to trigger a re-sync would
// queue another pass, and that one another. The warmer debounces the rest.
let lastSyncSignature = null;
container.resolve('cronService').onSynced = matches => {
  const signature = crypto.createHash('sha1')
    .update((matches || []).map(m => `${m.id}|${m.date}|${m.title}`).sort().join('\n'))
    .digest('base64');
  if (signature === lastSyncSignature) return;
  lastSyncSignature = signature;
  Promise.resolve(cardWarmer.request(collectWarmUrls, 'sync')).catch(() => {});
};
container.resolve('cronService').start();

const BIND_HOST = process.env.HOST || process.env.IP || '0.0.0.0';
app.listen(PORT, BIND_HOST, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          🔴 AIOSports                              ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Port       : ${String(PORT).padEnd(39)}║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  // A guessed address is not offered as the one to install. Inside Docker the
  // guess is the container's own bridge address, which no phone or TV can
  // reach, and people pasted it straight into their player.
  if (process.env.ADDON_URL) {
    console.log(`  Install   : open ${BASE_URL}/configure`);
  } else {
    console.log(`  Install   : open http://<this computer's address>:${PORT}/configure in a browser.`);
    console.log('              Stremio needs https, so set ADDON_URL to your https address');
    console.log('              once you have one (see the README).');
  }
  console.log('');

  // Say out loud which gates are actually on. Both of these fail open when
  // unset, which is the right default for someone trying the addon on their own
  // machine and the wrong one for a box on the internet -- and the difference
  // was invisible, because an owner's own browser sees a login page either way.
  const siteKey = process.env.AUTH_KEY;
  const adminKey = process.env.ADMIN_TOKEN;
  console.log(`  Sign-in   : ${siteKey ? 'AUTH_KEY set' : 'NOT SET — anyone who can reach this can browse it'}`);
  console.log(`  Dashboard : ${adminKey ? 'ADMIN_TOKEN set' : 'NOT SET — dashboard is closed until you set one'}`);
  console.log(`  Proxies   : trust proxy = ${TRUST_PROXY || 'loopback/private only (default)'}`);
  for (const [name, value] of [['AUTH_KEY', siteKey], ['ADMIN_TOKEN', adminKey]]) {
    if (value && value.length < 16) {
      console.log(`  ! ${name} is only ${value.length} characters. Use 16 or more random ones on anything the internet can reach.`);
    }
  }
  // Said out loud at every boot, because the failure it warns about only shows
  // up on the *next* deploy -- by which time the settings are already gone.
  const durable = savedConfigIsDurable();
  console.log(`  Saved cfg : ${DATA_DIR} — ${durable
    ? 'on a volume, survives rebuilds'
    : 'NOT on a volume, a rebuild will erase it'}`);
  if (!durable) {
    console.log('  → Mount a volume there to keep saved settings (see the README).');
  }
  if (!siteKey || !adminKey) {
    console.log('  → Set these in .env (or the environment) if this port is reachable from the internet.');
  }
  console.log('');

  // Make the cards before anyone asks. Delayed so the providers have answered
  // and the catalog is real: warming an empty catalog just warms nothing.
  setTimeout(() => {
    console.log('[CardWarmer] warming catalog art in the background');
    startWarm('boot');
  }, 45000);

  // And again on a cycle anchored on the last run. Re-syncs, which bring new
  // fixtures all day, also ask for a pass (wired where the cron starts).
  cardWarmer.schedule(collectWarmUrls, WARM_INTERVAL_MS);
});



