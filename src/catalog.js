const fs = require('fs');
const path = require('path');
const container = require('./container');
const { getChannelLogo } = require('./services/ChannelLogoService');
const { prewarmMatch, countChannelStreams } = require('./streams');
const { BASE_URL, DATA_DIR } = require('./config');
const MatchEntity = require('./domain/MatchEntity');
const imageService = require('./services/ImageService');
const teamLogoService = require('./services/TeamLogoService');
const homeAway = require('./services/HomeAwayService');
const eventMarks = require('./services/EventMarkService');
const leagueBadges = require('./services/LeagueBadgeService');
const { SEARCH_TWIN_SUFFIX } = require('./manifest');
const channelLogoIndex = require('./services/ChannelLogoIndex');
const { inferGenre } = require('./channelGenres');
const channelHealth = require('./services/ChannelHealth');
const { exclusionReason } = require('./channelExclusions');
const { parseMarkets, marketsSetting, isLocalTo } = require('./services/LocalMarkets');

// Titles that already name the visiting side first: "Rockies @ Yankees",
// "Missouri at Kansas". Anything else ("A vs B", "A - B") conventionally names
// the host first and needs swapping to put the visitor on the left.
const VISITOR_FIRST = /\s(?:@|at)\s/i;

// Matches the suffix the manifest puts on a search twin, escaped from the
// constant so the two can never drift apart.
const SEARCH_TWIN_SUFFIX_RE = new RegExp(SEARCH_TWIN_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');

// How far a provider's kickoff may sit from ESPN's before the card stops
// believing it. A few minutes is rounding, or a listing written before the
// broadcast window was fixed; a whole hour is a provider that read the wrong
// zone, and the providers do that often enough to be worth overruling.
const KICKOFF_DRIFT_MS = 15 * 60 * 1000;

// And how far it may sit before the two are not the same game at all. The index
// answers per board, per day and per team pair, so two meetings of the same two
// sides on one day — a doubleheader, which baseball plays routinely — are a
// single entry naming the first of them. A provider that read the wrong zone is
// out by whole hours, three at the most, since that is the width of the country;
// a second game is further out than that, because the first one has to finish.
const KICKOFF_MISMATCH_MS = 3 * 60 * 60 * 1000;

/**
 * Warm the fixtures a viewer is most likely to open, while they are still
 * reading the list.
 *
 * Warming on the detail page was too late: that request arrives a moment before
 * the click it was meant to cover, so the first click still paid for the first
 * scrape and came back with whatever had resolved by the deadline. Browsing a
 * tab is a much earlier signal, and the seconds spent there are free.
 *
 * Live fixtures only, most imminent first, and one at a time -- a burst of
 * scrapes is the thing this exists to avoid. Bounded by time as well as by
 * count, so a catalog polled in a loop does not warm in a loop.
 */
let lastPrewarmAt = 0;
let prewarmRunning = false;
const PREWARM_EVERY_MS = 30 * 1000;
// Eight covered the top of one tab, and a viewer who scrolled past it opened a
// cold match -- a first click that pays for the whole scrape. Forty covers a
// live board on a busy Saturday, which is exactly when it matters. This is the
// half of the fix that keeps the wait below from being felt.
const PREWARM_MATCHES = 40;
// Three at a time rather than one: twenty-four sequentially outlasts the
// interval below, and rounds that overlap are the burst this exists to avoid.
const PREWARM_CONCURRENCY = 3;
// Popular channels warmed alongside the fixtures; see prewarmTopMatches.
const PREWARM_CHANNELS = 12;

function prewarmTopMatches(matches, conf) {
  const now = Date.now();
  // The interval alone stopped being enough once a round could outlive it.
  if (prewarmRunning || now - lastPrewarmAt < PREWARM_EVERY_MS) return;
  lastPrewarmAt = now;

  // A fixture ESPN listed and nobody streams has nothing to warm: no source to
  // scrape, no token to mint.
  const live = matches.filter(m => m && m.date && !m._scheduleOnly && isMatchLive(m)).slice(0, PREWARM_MATCHES);
  // Popular channels too. A channel has no kickoff, so the live filter above
  // never picks one, and the busiest channels are the slowest to open cold:
  // ESPN carries sixteen Streamed.pk feeds that each need a WASM decrypt, and a
  // cold first open ran past the hard deadline with three of its nineteen
  // streams. Only channels a source marks popular, so this stays a handful.
  const channels = matches.filter(m => m && isChannel(m) && m.popular === '1').slice(0, PREWARM_CHANNELS);
  const targets = [...live, ...channels];
  if (!targets.length) return;

  prewarmRunning = true;
  (async () => {
    const queue = targets.slice();
    const worker = async () => {
      for (;;) {
        const m = queue.shift();
        if (!m) return;
        try {
          await prewarmMatch(m, conf || {});
        } catch {
          // One match failing to warm costs that match's first click, nothing else.
        }
      }
    };
    await Promise.all(Array.from({ length: PREWARM_CONCURRENCY }, worker));
  })().catch(() => {}).finally(() => { prewarmRunning = false; });
}

/**
 * A kickoff as somebody reads it aloud: "1:00 PM (ET)".
 *
 * The zone is named by its abbreviation where one exists, which is what a
 * viewer recognises -- the IANA identifier the config stores is a database key,
 * and "13:00 (America/New_York)" made people decode both halves.
 *
 * Only the US-style zones have a real abbreviation. Asking for one elsewhere
 * returns prose ("United Kingdom Time", "India Time"), which is longer than the
 * identifier it replaced, so anything that is not plainly a set of letters
 * falls back to the offset: GMT+1, GMT+5:30, UTC.
 */
// Building an Intl.DateTimeFormat is expensive -- it loads ICU data -- and this
// was building one per style per dated fixture, so a catalog of a thousand
// fixtures paid for up to two thousand of them on every request. There are only
// ever a handful of distinct (zone, style) pairs, so they are made once.
const _formatters = new Map();
function dtf(key, opts) {
  let f = _formatters.get(key);
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat('en-US', opts); }
    catch { f = null; }        // an unknown zone: remembered as unusable
    // Only a successful build is kept, so the keys are bounded by the valid
    // zones the configure page offers rather than by anything a caller invents.
    if (f) _formatters.set(key, f);
  }
  return f;
}
const zoneFormatter = (timeZone, style) =>
  dtf('z|' + (timeZone || '') + '|' + style, { timeZone, timeZoneName: style });

function zoneLabel(dateObj, timeZone) {
  const name = style => {
    try {
      const f = zoneFormatter(timeZone, style);
      if (!f) return '';
      const parts = f.formatToParts(dateObj);
      return (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
    } catch {
      return '';
    }
  };
  const generic = name('shortGeneric');
  // "ET", "PT", "MST", "AKT" -- but not "GMT+0" or "São Paulo Time".
  if (/^[A-Z]{2,5}$/.test(generic)) return generic;
  return name('short');
}

/** "1:00 PM (ET)", in the viewer's zone when they named one. */
function formatKickoff(dateObj, timeZone, hour12 = true) {
  // 24-hour wants a padded hour: 09:30, not 9:30, which is what that clock
  // looks like everywhere it is used. 12-hour keeps the bare hour.
  const opts = { hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12 };
  if (timeZone) opts.timeZone = timeZone;
  // toLocaleTimeString builds a formatter of its own on every call, which is the
  // larger half of the cost -- the same memo covers it. `hour12` is enough of a
  // key because the hour style is derived from it.
  let time;
  const f = dtf('t|' + (timeZone || '') + '|' + hour12, opts);
  if (f) {
    time = f.format(dateObj);
  } else {
    // An unknown zone in a saved config should cost the label, not the time.
    const bare = { hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12 };
    time = dtf('t||' + hour12, bare).format(dateObj);
    timeZone = undefined;
  }
  const zone = zoneLabel(dateObj, timeZone);
  return zone ? `${time} (${zone})` : time;
}

/**
 * What a category is called on the card. The internal name is the key every
 * provider, merge guard and filter agrees on and does not change; this is only
 * what the reader sees, and it should match the tab the card sits in.
 */
// Competitions worth naming on the card in place of the broad category.
// The categories that have a tab of their own. The Other tab is defined by
// exclusion from this list, and the sports filter needs the same definition --
// keeping two copies is how they came to disagree.
const TOP_LEVEL_CATEGORIES = ['football', 'cricket', 'basketball', 'motorsport', 'hockey',
  'baseball', 'mma', 'golf', 'tennis', 'rugby', 'american_football', 'darts', 'networks', 'college'];

const COMPETITION_LABEL = { nfl: 'NFL', cfl: 'CFL', afl: 'AFL' };

const CATEGORY_LABEL = {
  american_football: 'FOOTBALL',
  // Soccer's internal name is `football`, so once the gridiron tab is called
  // Football the two read identically on the card. The soccer tab has always
  // been called Soccer; its cards now say so too.
  football: 'SOCCER'
};

function categoryLabel(category, competition) {
  const named = COMPETITION_LABEL[String(competition || '')];
  if (named) return named;
  const key = String(category || '');
  return CATEGORY_LABEL[key] || key.toUpperCase();
}

/**
 * An always-on channel rather than a fixture. Most carry no kickoff at all,
 * which is the one thing every fixture has and no channel does. A few are
 * scheduled anyway -- the feed gives NFL RedZone a Sunday start -- and those
 * are still channels: their names resolve to a channel logo, and no fixture's
 * name does.
 */
/**
 * Shuffle, but hold the same shuffle for a while when asked to.
 *
 * A fresh order on every request makes a list impossible to come back to -- the
 * thing someone half-remembers has moved by the time they look again. So the
 * ordering is seeded: the same seed yields the same order, and the seed only
 * changes when its window does. Zero hours means a new order every time, which
 * is what the plain toggle asks for.
 */
function shuffleStable(list, persistHours) {
  const window = persistHours > 0
    ? Math.floor(Date.now() / (persistHours * 3600 * 1000))
    : Math.random();
  let seed = Math.floor(Number(window) * 1e6) % 2147483647;
  if (seed <= 0) seed += 2147483646;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// iptv-org's logo for a channel name, when that provider has loaded. Resolved
// lazily from the container so this module does not import a provider.
function iptvLogoFor(title) {
  try {
    const p = container.resolve('iptvOrgProvider');
    if (!p || typeof p.logoForName !== 'function') return null;
    const words = String(title || '').trim().split(/\s+/);
    const last = (words[words.length - 1] || '').toUpperCase();
    const COUNTRY = { USA: 'US', US: 'US', UK: 'UK', IE: 'IE', NZ: 'NZ', AU: 'AU', CA: 'CA', PL: 'PL',
      DE: 'DE', IT: 'IT', ES: 'ES', PT: 'PT', FR: 'FR', MX: 'MX', BR: 'BR', AR: 'AR', NL: 'NL', BE: 'BE' };
    if (words.length > 1 && COUNTRY[last]) {
      return p.logoForName(words.slice(0, -1).join(' '), COUNTRY[last]);
    }
    return p.logoForName(title, 'US');
  } catch (e) {
    return null;
  }
}

// A channel's group: what its source said, or what its name gives away.
function channelGenre(m) {
  return (m && m.genre) || inferGenre(m && m.title);
}

/**
 * A single club's own channel: CDNLive lists all thirty MLB teams as 24/7
 * channels ("New York Yankees"). They show that club's broadcasts when it has
 * a game and nothing otherwise, which in a tab of networks is thirty tiles of
 * noise. Matched on the exact team name, so "NBC Sports Boston" or "Texas
 * Rangers Classics" are not caught by a club name inside them.
 */
function isTeamChannel(m) {
  if (!m || !m.title) return false;
  const name = String(m.baseTitle || m.title).trim();
  const variants = [name, name.replace(/^Oakland\s+/i, '')];
  for (const v of variants) {
    const crest = teamLogoService.lookupTeam(v, null, ['mlb']);
    const canon = crest && teamLogoService.canonicalName(crest);
    if (canon && teamLogoService.normalize(canon) === teamLogoService.normalize(v)) return true;
  }
  return false;
}

function isChannel(m) {
  if (!m) return false;
  if (m.category === 'networks' || !m.date) return true;
  return !!getChannelLogo(m.title);
}

/**
 * Tidy a team name for display.
 *
 * The feeds disagree with each other on the same club: one writes "Florida A&M",
 * another "Florida A and M", and both end up on cards. They resolve to the same
 * crest either way — normalize() folds "&" to " and " — but the two spellings
 * sit side by side in the catalog and read as a mistake. Only initials are
 * rejoined, so "Bristol and Gloucester" is left alone.
 */
function prettifyName(name) {
  return String(name || '')
    .replace(/\b([A-Z]) and ([A-Z])\b/g, '$1&$2')
    // "ESPN2 US" beside "ESPN 2 BR" reads as two different channels.
    .replace(/\bESPN(\d)\b/g, 'ESPN $1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// How long an event of each kind can still be on, measured from kickoff.
const EVENT_DURATIONS = {
  cricket: 8 * 60 * 60 * 1000,
  mma: 6 * 60 * 60 * 1000,
  fighting: 6 * 60 * 60 * 1000,
  boxing: 5 * 60 * 60 * 1000,
  motorsport: 4 * 60 * 60 * 1000,
  american_football: 4 * 60 * 60 * 1000,
  baseball: 3.5 * 60 * 60 * 1000,
  basketball: 3 * 60 * 60 * 1000,
  tennis: 4 * 60 * 60 * 1000,
  golf: 6 * 60 * 60 * 1000,
  football: 2.5 * 60 * 60 * 1000,
  rugby: 2.5 * 60 * 60 * 1000,
  hockey: 3 * 60 * 60 * 1000,
  darts: 4 * 60 * 60 * 1000
};
const DEFAULT_EVENT_DURATION_MS = 3 * 60 * 60 * 1000;
function eventDurationMs(category) {
  return EVENT_DURATIONS[category] || DEFAULT_EVENT_DURATION_MS;
}

// Stoppage, extra time, a rain delay, a provider whose kickoff is the time the
// match was scheduled rather than the time it started. Generous on purpose:
// dropping a match that is still being played is a worse failure than a tile
// that lingers a little.
const LIVE_STATUS_GRACE_MS = 45 * 60 * 1000;

/**
 * Accurately determines if an event is currently live right now.
 * 24/7 networks are always live.
 * Fixtures with a kickoff time are live starting 15 minutes before kickoff
 * up to the sport-specific max game duration.
 */
function isMatchLive(match) {
  if (!match) return false;
  if (match.category === 'networks' || !match.date) return true;

  // 1. Explicit finished / postponed / cancelled statuses are never live
  if (match.status === 'finished' || match.status === 'ended' || match.status === 'postponed' || match.status === 'cancelled') {
    return false;
  }

  // 2. Explicit live status from provider, for as long as the event could
  // still be on. Six providers stamp 'live' and not one of them ever takes it
  // back, so a card stayed red until the provider stopped listing the event
  // entirely: an Austria GP session was still LIVE 6.2 hours after it started,
  // while every football match on the same board had aged out correctly. The
  // status is still believed -- it is simply held to the same clock as every
  // other route through this function.
  if (match.status === 'live' || match.status === 'in' || match.status === 'in_progress') {
    const startedAt = match.date ? parseInt(match.date, 10) : 0;
    if (!startedAt) return true;   // nothing to hold it against
    return Date.now() <= startedAt + eventDurationMs(match.category) + LIVE_STATUS_GRACE_MS;
  }

  // 3. Explicit upcoming / pre-match status from provider
  if (match.status === 'upcoming' || match.status === 'pre') {
    return false;
  }

  // 4. Time-based evaluation when status is not explicitly set
  const now = Date.now();
  const kickoff = match.date ? parseInt(match.date, 10) : 0;

  if (kickoff > 0) {
    // If kickoff is more than 15 minutes in the future, it's definitely UPCOMING, not live
    if (kickoff > now + 15 * 60 * 1000) {
      return false;
    }

    return now >= (kickoff - 15 * 60 * 1000) && now <= (kickoff + eventDurationMs(match.category));
  }

  return false;
}

function normalizeImageUrl(url, defaultHost = 'https://streamfree.top') {
  if (!url || typeof url !== 'string') return null;
  let u = url.trim();
  if (!u) return null;
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  if (u.startsWith('/')) return `${defaultHost}${u}`;
  return `${defaultHost}/${u}`;
}

function mapMatchToMetaPreview(match, config = {}) {
  const isLive = isMatchLive(match);
  const titleStr = match.title || (isLive ? 'Live Match' : 'Upcoming Match');
  const safeTitle = encodeURIComponent(Array.from(titleStr).slice(0, 30).join(''));
  
  // Dynamic Sport-Specific Posters
  const categoryColors = {
    football: '10b981', // green
    basketball: 'f97316', // orange
    motorsport: 'ef4444', // red
    cricket: '0ea5e9', // light blue
    tennis: 'a3e635', // lime
    rugby: '8b5cf6', // purple
    american_football: '0369a1', // dark blue
    baseball: 'f43f5e', // rose
    hockey: '06b6d4', // cyan
    golf: '22c55e', // emerald
    darts: 'eab308', // yellow
    mma: 'dc2626', // crimson red
    networks: '64748b', // slate
    college: 'd946ef' // fuchsia
  };
  const color = categoryColors[match.category] || '333333';
  
  // Channel logos come from the unified ChannelLogoService (tv-logos CDN + Wikimedia).

  // Resolve both sides of the fixture to ESPN crests where we confidently can.
  // Returns null for a non-fixture title (a 24/7 channel), and either logo may
  // be null on its own — TeamLogoService declines rather than guessing.
  let matchup = teamLogoService.resolveMatchup(match);

  // Put the visiting side on the left and name it first, the way a scoreboard
  // reads. ESPN's scoreboards are the source; when they don't list a fixture,
  // the title's own separator is the fallback — "A at B" and "A @ B" name the
  // visitor first, while "A vs B" and "A - B" conventionally name the host
  // first. That fallback is a convention, not a fact, which is exactly why the
  // scoreboard is consulted first: the feeds write "Florida A&M Rattlers vs
  // Miami Hurricanes" for a game Miami host.
  // Whether this is a two-team fixture at all — and only evidence counts.
  // resolveMatchup() splits on any separator, so "UFC 319: Du Plessis vs
  // Chimaev" and "Spain GP - Formula 1 2026" come back looking like fixtures.
  // Rewriting those produced "Conor Benn @ Ryan Garcia" for a neutral-site
  // fight and "Spain GP @ Formula 1 2026" for a race. ESPN listing the fixture,
  // or both sides resolving to a real crest, is evidence. A separator is not.
  let orientedByEspn = false;
  let isFixture = false;
  let leagueLogo = null;
  // Everything else the scoreboard knows about this fixture: the kickoff it
  // has, and the networks carrying it. Null for a channel and for anything ESPN
  // does not list, which is what keeps both off the tile below.
  let espn = null;
  if (matchup) {
    const known = homeAway.orient(matchup.a, matchup.b, matchup.aLogo, matchup.bLogo, match.category, match.date);
    orientedByEspn = !!known;
    if (known && known.leagueLogo) leagueLogo = known.leagueLogo;
    isFixture = orientedByEspn || (matchup.aLogos.length > 0 && matchup.bLogos.length > 0);

    if (isFixture) {
      // Looked up before the sides are swapped below, though the index answers
      // either order — the two names and the two crests are the same pair.
      espn = homeAway.details(matchup.a, matchup.b, matchup.aLogo, matchup.bLogo, match.category, match.date);
      // A record whose kickoff is further off than any clock error can account
      // for is the other meeting of these two sides that day, and everything it
      // carries belongs to that other game: its hour, and the network showing
      // it. The second game of a doubleheader was being given the first game's
      // evening on its tile and the first game's channel on the line below.
      if (espn && espn.start > 0 && Math.abs(espn.start - parseInt(match.date, 10)) > KICKOFF_MISMATCH_MS) {
        espn = null;
      }

      // Visitor on the left, the way a scoreboard reads. ESPN is the source;
      // without it the title's own separator is the fallback — "A at B" and
      // "A @ B" name the visitor first, "A vs B" and "A - B" the host.
      const flip = known ? known.away !== matchup.a : !VISITOR_FIRST.test(match.title || '');
      if (flip) {
        matchup = {
          ...matchup,
          a: matchup.b, b: matchup.a,
          aLogos: matchup.bLogos, bLogos: matchup.aLogos,
          aLogo: matchup.bLogo, bLogo: matchup.aLogo
        };
      }
    }
  }

  // Generate a clean, readable fallback poster using the match title.
  // NOTE: never substitute match.category here. Replacing the teams with
  // "AMERICAN_FOOTBALL" on long titles is what produced the blank-looking
  // category cards; svgPlaceholder word-wraps, so long names are fine.
  let posterText = match.title;
  if (matchup && isFixture) {
      posterText = `${prettifyName(teamLogoService.canonicalName(matchup.aLogo) || matchup.a)}\n@\n${prettifyName(teamLogoService.canonicalName(matchup.bLogo) || matchup.b)}`;
  } else if (matchup) {
      posterText = `${prettifyName(matchup.a)}\nvs\n${prettifyName(matchup.b)}`;
  } else if (match.team1 && match.team2 && match.team1.name && match.team2.name) {
      posterText = `${match.team1.name}\nvs\n${match.team2.name}`;
  } else {
      posterText = posterText.replace(/ vs /i, '\nvs\n').replace(/ - /i, '\n-\n');
  }

  // Self-hosted fallback poster (replaces the external placehold.co dependency)
  const fallbackPoster = imageService.placeholderUrl(BASE_URL, posterText, color);

  // Self-hosted image proxy: serves the upstream image from cache and falls
  // back to a generated placeholder when the source is dead, so the client
  // never sees a broken image.
  const buildImg = (sourceUrl, fbText, c) =>
    imageService.proxyUrl(BASE_URL, sourceUrl, { text: fbText, color: c });

  let poster = fallbackPoster;

  // Channel logos are keyed by naive substring, so "<Team> vs <Team> | ESPN"
  // used to take ESPN's wordmark as its poster. Only consult the channel table
  // for titles that are actually channels, i.e. not a two-sided fixture.
  // Consulted for anything that isn't a real fixture — not merely anything
  // whose title lacks a separator. "NFL vs RedZone" splits like a fixture and
  // isn't one, which is why the channel with the best-looking artwork in the
  // catalog was the one showing none.
  // A local station wears its network's mark: "FOX 32 Chicago" is looked up
  // as FOX, the name its tile's logo is filed under.
  const logoTitle = match.logoName || match.title;
  const channelLogo = isFixture ? null : getChannelLogo(logoTitle);
  // A 24/7 channel, and the best logo anyone gave us for it: the provider's own
  // first, then the channel table, then whatever artwork came with the entry.
  const is247Channel = !isFixture && (match.category === 'networks' || !match.date);
  const team1Logo = match.team1 && match.team1.logo ? normalizeImageUrl(match.team1.logo) : null;
  const matchPoster = match.poster ? normalizeImageUrl(match.poster) : null;
  const matchThumb = match.thumbnail_url ? normalizeImageUrl(match.thumbnail_url) : null;
  const matchLogo = match.logo ? normalizeImageUrl(match.logo) : null;
  // The artwork a source sent comes last: for too many channels it is a promo
  // still rather than a logo. Before it, the curated logo set filed by country,
  // then iptv-org's own logo for a same-named channel in the same country.
  // A channel found to have no usable logo anywhere is drawn by its name.
  const logoless = is247Channel && channelLogoIndex.isLogoless(match.title);
  // The curated set's logo for exactly this channel, in its own country, beats
  // both what a source sent and the forgiving name table. That table answers
  // "Fox Sports 503" with the Argentine Fox Sports mark and TSN 3 with plain
  // TSN: an audit of every cover found forty-odd channels wearing a sibling's
  // logo that way, and tv-logos had the right file for each.
  const exactLogo = is247Channel && !logoless
    ? channelLogoIndex.lookup(logoTitle, match.region, { strict: true })
    : null;
  const indexedLogo = is247Channel && !logoless && !exactLogo && !matchLogo && !channelLogo
    ? (channelLogoIndex.lookup(logoTitle, match.region) || iptvLogoFor(logoTitle))
    : null;
  const channelMark = is247Channel && !logoless
    ? (exactLogo || matchLogo || channelLogo || indexedLogo || matchThumb)
    : null;

  // The competition's crest is what belongs in the card's logo slot. Before
  // this it was the home side's own crest or, far more often, a dead URL whose
  // failure produced a generated card of the match title rendered at badge size
  // — an unreadable box of words in the corner of every poster.
  // The badge in the card's corner. A competition crest when ESPN named one;
  // otherwise the governing mark for the sport, which is more use than the home
  // side's crest repeated at badge size.
  //
  // The NCAA mark is served from this addon rather than hot-linked: Wikimedia
  // rate-limits a browser user-agent, and ESPN's "ncaa_football" is a generic
  // silhouette, not the NCAA's own mark.
  const SPORT_BADGE = {
    college: `${BASE_URL}/marks/ncaa.png`,
    rugby: 'https://a.espncdn.com/redesign/assets/img/icons/ESPN-icon-rugby.png'
  };
  // A college game shows the ball it is played with. The NCAA mark stands in
  // only for a college fixture whose sport nothing names, which is the one case
  // where there is no ball to show.
  const COLLEGE_BADGE = {
    football: eventMarks.SPORT_ICONS.american_football,
    basketball: eventMarks.SPORT_ICONS.basketball,
    hockey: eventMarks.SPORT_ICONS.hockey,
    baseball: eventMarks.SPORT_ICONS.baseball
  };
  // Which NCAA mark the corner gets. The league names the sport when the feed
  // sends one; failing that ESPN's own crest for the competition does
  // (ESPN-icon-football-college, ncaa_basketball). The plain NCAA mark stands in
  // when nothing says which sport this is.
  const collegeSport = match._collegeSport
    || eventMarks.collegeSport(match.league)
    || (/football/i.test(leagueLogo || '') ? 'football'
      : /basketball/i.test(leagueLogo || '') ? 'basketball'
      : null);
  const sportBadge = match.category === 'college'
    ? (COLLEGE_BADGE[collegeSport] || SPORT_BADGE.college)
    : (SPORT_BADGE[match.category] || leagueBadges.sportMark(match.category) || null);

  // The competition worked out from the two crests, for the fixtures no feed
  // names a league for. Every rugby fixture arrives with an empty league field,
  // and ESPN's scoreboard reaches only part of the soccer calendar.
  const competition = match._competition !== undefined
    ? match._competition
    : (matchup ? leagueBadges.competitionFor(matchup.aLogo, matchup.bLogo) : null);
  const competitionBadge = leagueBadges.badgeForCompetition(competition);

  // A competition this addon carries its own mark for. Those exist precisely
  // where ESPN's crest is useless -- one generic ball for all four rugby
  // competitions, and nothing at all for the CFL -- so the mark outranks it.
  const bundledBadge = competition && leagueBadges.BUNDLED[competition] ? competitionBadge : null;

  // For a college game the governing body outranks the conference: every
  // college fixture carries an NCAA mark, so the corner reads the same whether
  // the feed named a conference or nothing at all. Everywhere else the league
  // is the more specific answer and wins.
  const collegeBadge = match.category === 'college' ? sportBadge : null;

  // A channel's own logo outranks its sport's mark: NFL Network is more use in
  // the corner than a generic football. It sat last while the sport mark only
  // existed for a couple of categories, and giving every sport one put a
  // pictogram in front of all nine channels' branding.
  let logo = collegeBadge || bundledBadge || leagueLogo || competitionBadge || channelLogo
    || sportBadge || matchLogo || team1Logo || null;

  // Matchup card from the resolved crest candidates. The provider's poster
  // rides along as the fallback, so /img/matchup can degrade to it when a
  // candidate turns out not to exist — that decision belongs at fetch time.
  const matchupPoster = matchup
    ? imageService.matchupUrl(BASE_URL, { ...matchup, color, fallback: matchPoster })
    : null;

  // A generated card whenever both sides have a candidate. Provider artwork is
  // inconsistent — a handful of fixtures ship a designed poster and most ship
  // nothing — so one house style across the catalog reads better than a mix.
  // A side with no candidate at all still loses to real provider art.
  const bothSides = matchup && matchup.aLogos.length > 0 && matchup.bLogos.length > 0;

  if (bothSides && matchupPoster) {
    poster = matchupPoster;
  } else if (matchPoster && !is247Channel) {
    // A 24/7 channel gets its cover even when a source also sent a poster. Streamed.pk ships promo art for its channels, and because this
    // branch came first, NFL Network, Tennis Channel, Willow and NFL RedZone --
    // merged under that entry -- showed the promo instead of a cover.
    poster = buildImg(matchPoster, posterText, color) || fallbackPoster;
  } else if (matchupPoster) {
    poster = matchupPoster;
  } else if (is247Channel && channelMark) {
    // A channel's artwork is its logo, and a logo is square or taller while a
    // card is wide. Passing one straight through as the poster is what put a
    // 300x450 crest in a 16:9 frame with bars down either side. Draw it into
    // the house card instead, which is 16:9 by construction, and keep the logo
    // itself for the corner rather than repeating the whole poster there.
    poster = imageService.eventUrl(BASE_URL, {
      text: prettifyName(match.title), mark: channelMark, color,
      // A channel logo is drawn to stand on its own; the white tile a sport
      // badge needs reads as a sticker over the card.
      // A channel cover: the logo centred on flat grey, the channel's name in a
      // quiet line along the top. ESPN US and ESPN NZ share a logo, so the name
      // is still what tells them apart.
      cover: true
    }) || buildImg(channelMark, posterText, color) || fallbackPoster;
    logo = channelMark;
  } else if (is247Channel) {
    // A channel no source has a logo for still gets a cover, its name alone on
    // the grey, instead of the old gradient card -- one look across the tab.
    poster = imageService.eventUrl(BASE_URL, {
      text: prettifyName(match.title), color, cover: true
    }) || fallbackPoster;
    if (logoless) logo = null;
  } else if (channelLogo) {
    poster = buildImg(channelLogo, match.title, '161616') || fallbackPoster;
    logo = channelLogo;
  } else if (matchThumb) {
    const isLogo = match.category === 'networks' || matchThumb.toLowerCase().includes('logo') || matchThumb.toLowerCase().includes('icon');
    poster = buildImg(matchThumb, posterText, color) || fallbackPoster;
    if (isLogo && !logo) {
      logo = matchThumb;
    }
  } else if (team1Logo) {
    poster = buildImg(team1Logo, posterText, color) || fallbackPoster;
    if (!logo) logo = team1Logo;
  } else if (!isFixture) {
    // Not a fixture and no provider artwork: a badge card beats the title alone
    // on a blank panel. Falls back to exactly that panel when no mark loads.
    const mark = eventMarks.markFor(match.title, match.category, match.league);
    if (mark) {
      poster = imageService.eventUrl(BASE_URL, { text: posterText, color, ...mark }) || poster;
    }
  }

  if (logo) {
    logo = buildImg(logo, match.title || 'TV', '161616') || logo;
  }
  
  const matchBackground = match.background ? normalizeImageUrl(match.background) : null;

  // The detail page behind a fixture should be the same card the catalog shows,
  // drawn wide. It was the provider's own artwork, so opening a fixture threw
  // away the crests and colours the tile had just established -- and provider
  // art is whatever they happened to upload, often for a different fixture.
  const wideMatchup = bothSides
    ? imageService.matchupUrl(BASE_URL, {
      ...matchup, color, fallback: matchPoster, w: 1280, h: 720
    })
    : null;

  let background = wideMatchup
    || (matchBackground ? (buildImg(matchBackground, posterText, color) || poster) : poster);

  let timeString = match.category === 'networks' ? 'Live channel' : 'Live Now';
  let relativeTimeStr = '';
  let releasedIso = null;
  
  if (match.date && !isNaN(parseInt(match.date)) && parseInt(match.date) > 0) {
     const provided = parseInt(match.date);
     // Whose clock the card reads by. A provider disagreeing with ESPN by more
     // than a rounding error has typed the wrong hour — every one of them does
     // it — and ESPN is the schedule of record. Only the card changes:
     // match.date is what the aggregator merged on, what the sort below orders
     // by and what the cache is keyed to, so moving it would move all three.
     const shown = espn && espn.start > 0 && Math.abs(espn.start - provided) > KICKOFF_DRIFT_MS
       ? espn.start
       : provided;
     const dateObj = new Date(shown);
     releasedIso = dateObj.toISOString();
     timeString = formatKickoff(dateObj, config && config.timezone, !(config && config.timeFormat === '24'));
     
     const now = Date.now();
     const diff = dateObj.getTime() - now;
     if (diff > 0 && !isLive) {
       const hours = Math.floor(diff / (1000 * 60 * 60));
       const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
       if (hours > 24) {
         relativeTimeStr = ` (in ${Math.floor(hours / 24)} days)`;
       } else if (hours > 0) {
         relativeTimeStr = ` (in ${hours}h ${minutes}m)`;
       } else {
         relativeTimeStr = ` (in ${minutes} mins)`;
       }
     }
  }

  // The card title follows the same orientation as the artwork: visitor first,
  // "@" between. Only a real two-sided fixture is rewritten — a 24/7 channel or
  // a title we couldn't split keeps whatever the provider called it.
  // Show ESPN's name for a side we resolved, so the same club is spelled the
  // same way on every card — the providers variously write "Florida A and M",
  // "Florida A&M" and "Miami (FL)" for teams we have already identified.
  const sideName = (raw, logo) => prettifyName(teamLogoService.canonicalName(logo) || raw);
  const displayA = isFixture ? sideName(matchup.a, matchup.aLogo) : null;
  const displayB = isFixture ? sideName(matchup.b, matchup.bLogo) : null;
  const displayTitle = isFixture ? `${displayA} @ ${displayB}` : prettifyName(match.title);

  const is247 = match.category === 'networks' || !match.date;
  const prefix = isLive ? (is247 ? '📺 ' : '🔴 LIVE: ') : '⏱️ ';
  const cast = [];
  if (matchup && isFixture) {
    cast.push(displayA, displayB);
  } else {
    if (match.team1 && match.team1.name) cast.push(match.team1.name);
    if (match.team2 && match.team2.name) cast.push(match.team2.name);
  }

  const leagueStr = match.league ? `🏆 League: ${match.league}\n` : '';
  // A local station says where it is and what it is called, which is also
  // what lets a search for the city find it -- and, for a network station,
  // that this is its news stream: the game is on the game's own tile.
  const marketStr = match.market
    ? `📍 ${match.market}${match.station ? ' · ' + match.station : ''}\n`
      + (match.newsStream ? '📡 The station\'s free news stream, not its broadcast. Games are on their own tiles.\n' : '')
    : '';
  // Which television network is carrying the game, which is the one thing about
  // a fixture a viewer cannot work out from anywhere else on the tile. It is a
  // line of information and not an offer: a network station's free stream is
  // its news channel rather than the broadcast, which is what the station tiles
  // above say out loud, so nothing here is something to open.
  const netStr = espn && espn.net.length && !is247 ? `📡 On ${espn.net.join(', ')}\n` : '';
  // A fixture ESPN lists that no provider has posted a link to yet. Saying so is
  // the point of listing it at all — the alternative was a tab that stayed empty
  // until an hour before kickoff.
  const pendingStr = match._scheduleOnly
    ? '⏳ No streams listed yet — they usually appear near kickoff\n'
    : '';
  const statusStr = is247
    ? 'Live channel'
    : (isLive ? '🔴 LIVE NOW' : `Kickoff at ${timeString}${relativeTimeStr}`);
  const desc = `${pendingStr}${marketStr}${leagueStr}${netStr}📅 Category: ${categoryLabel(match.category, match._competition)}\n⏰ Status: ${statusStr}`;

  const metaPreview = {
    id: `nuvio_sport_${match.id}`,
    type: 'tv',
    name: `${prefix}${displayTitle}`,
    genres: [is247 ? channelGenre(match) : categoryLabel(match.category, match._competition)],
    poster: poster,
    posterShape: 'landscape',
    background: background,
    logo: logo,
    // Nothing under a channel's tile: the "24/7" that sat there said the same
    // thing about every one of six hundred channels.
    releaseInfo: isLive ? (is247 ? undefined : 'LIVE') : timeString,
    // Kept for the catalog's repeat-fixture pass below; not part of the
    // Stremio meta contract, and stripped before the response.
    _relative: relativeTimeStr.trim(),
    description: desc,
    cast: cast,
    behaviorHints: {
      defaultVideoId: `nuvio_sport_${match.id}`
    }
  };

  if (releasedIso) {
    metaPreview.released = releasedIso;
  }

  return metaPreview;
}

// ─── ESPN's own schedule ──────────────────────────────────────────────────────

/**
 * The fixtures ESPN lists, read back out of the index HomeAwayService keeps.
 *
 * That index answers which side of a named fixture is at home. The ⭐ tab needs
 * the other question — what is this viewer's team playing next — for games no
 * site has posted a link to yet, and the same index holds that answer: one
 * record per event, and every key naming it says which two teams meet, on which
 * board, on which day.
 *
 * It is read from the file the index is persisted to, since that is the copy
 * reachable from here. A file written under a shape this build does not know
 * yields nothing at all, which costs the tab the fixtures nobody streams and
 * leaves every other thing on it as it was.
 */
const SCHEDULE_FILE = path.join(DATA_DIR, 'homeaway.json');
const SCHEDULE_VERSION = 2;
// As far ahead as a fixture nobody streams is worth a tile. Past a week it stops
// being what a viewer's team is doing next and becomes the rest of the season.
const SCHEDULE_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
// The most such fixtures one request may add. Somebody who named a dozen clubs
// would otherwise push the games that do have a stream off the end of the tab.
const SCHEDULE_MAX = 40;

// Which tab a board's fixtures belong in. ESPN files by sport and competition
// while the catalog files by the tab a card sits in, and the college boards are
// where the two differ: a college game belongs with the college games whichever
// ball it is played with.
const BOARD_CATEGORY = {
  'football/nfl': 'american_football',
  'football/cfl': 'american_football',
  'australian-football/afl': 'american_football',
  'football/college-football': 'college',
  'basketball/nba': 'basketball',
  'basketball/wnba': 'basketball',
  'basketball/mens-college-basketball': 'college',
  'baseball/mlb': 'baseball',
  'baseball/college-baseball': 'college',
  'hockey/nhl': 'hockey',
  'soccer/all': 'football'
};

// ESPN serves every crest from the same 500-pixel path, which is also how the
// bundled table spells them, so the key the index stores rebuilds into a URL the
// rest of the catalog already knows how to name and draw.
function crestUrl(key) {
  const at = String(key || '').indexOf('/');
  if (at < 1) return null;
  return `https://a.espncdn.com/i/teamlogos/${key.slice(0, at)}/500/${key.slice(at + 1)}.png`;
}

// The index is keyed by normalized names — lowercase, punctuation gone — and a
// card has to show a viewer something they recognise. ESPN's own spelling comes
// from the crest wherever there is one; this is what is left for the college
// fixtures, whose crests are in no name table.
function titleCase(name) {
  return String(name || '').replace(/\b[a-z]/g, c => c.toUpperCase());
}

/** UTC calendar day of a ms timestamp, spelled as the index's keys spell it. */
function utcDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

let scheduleCache = { at: 0, size: 0, events: [], reading: false };

function scheduleEvents() {
  // There is no file at all until a refresh has written one, which is a tab
  // without these fixtures rather than a tab that fails.
  let stat;
  try { stat = fs.statSync(SCHEDULE_FILE); } catch (e) { return []; }
  // Parsed once per refresh rather than once per request: this is megabytes of
  // JSON, and every device in the house polls the tab.
  if (stat.mtimeMs === scheduleCache.at && stat.size === scheduleCache.size) return scheduleCache.events;
  // The index is rewritten every twenty minutes, and the card warmer is not
  // asked for this tab, so the request that finds the file changed is always
  // somebody's. Reading it there holds the loop shut for the length of the
  // parse, with every other catalog, stream and image request queued behind it
  // on a two-core host. The copy in hand is one refresh old at worst and
  // describes fixtures days out, so it answers now and the file is read on the
  // next turn of the loop instead. A first read has nothing to answer with and
  // is worth waiting for.
  if (!scheduleCache.events.length) {
    scheduleCache = { at: stat.mtimeMs, size: stat.size, events: readSchedule(), reading: false };
    return scheduleCache.events;
  }
  if (!scheduleCache.reading) {
    scheduleCache.reading = true;
    setImmediate(() => {
      try {
        const fresh = fs.statSync(SCHEDULE_FILE);
        scheduleCache = { at: fresh.mtimeMs, size: fresh.size, events: readSchedule(), reading: false };
      } catch (e) {
        scheduleCache.reading = false;
      }
    });
  }
  return scheduleCache.events;
}

function readSchedule() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); } catch (e) { return []; }
  if (!saved || saved.v !== SCHEDULE_VERSION) return [];
  if (!Array.isArray(saved.events) || !Array.isArray(saved.keys)) return [];

  const byEvent = new Map();
  for (const entry of saved.keys) {
    if (!Array.isArray(entry)) continue;
    const [key, at] = entry;
    const rec = saved.events[at];
    if (!rec || typeof key !== 'string') continue;
    const [kind, board, day, pair] = key.split(':');
    if (!pair) continue;
    let ev = byEvent.get(at);
    // The kickoff is copied out rather than the record kept: the index is
    // already resident in this process, and holding a second reference to every
    // record here would keep the whole parsed copy alive until the next refresh
    // replaces it. A tile needs the hour and the two sides; the networks, the
    // venue and the status all come back through details() at the time a card
    // is drawn.
    if (!ev) {
      byEvent.set(at, ev = {
        board, day, start: Number(rec.start) || 0,
        homeCrest: '', awayCrest: '', home: '', away: '',
        homeNames: new Set(), awayNames: new Set()
      });
    }
    const [left, right] = pair.split('|');
    if (kind === 'L') {
      // A crest pair is sorted, so which of the two is at home is a question
      // only the record answers.
      if (rec.home === left) { ev.homeCrest = left; ev.awayCrest = right; }
      else if (rec.home === right) { ev.homeCrest = right; ev.awayCrest = left; }
    } else if (kind === 'N') {
      // Home first, away second. Every spelling the index was keyed under is
      // kept, because the one a feed writes is rarely the one ESPN leads with —
      // a provider's "Saint Anselm" against the scoreboard's "Saint Anselm
      // Hawks" — and these are what say whether somebody already streams this
      // fixture. Keeping only one of them left that question to the crests,
      // which an event ESPN published no logo for does not have.
      if (left) ev.homeNames.add(left);
      if (right) ev.awayNames.add(right);
      // The longest spelling is the one ESPN calls the club, and the one a card
      // shows: the shorter keys are its nickname, its city and its
      // abbreviation, none of which read as a team.
      if (left && left.length > ev.home.length) ev.home = left;
      if (right && right.length > ev.away.length) ev.away = right;
    }
  }
  // An event with no name key and no kickoff has nothing to match a viewer's
  // spelling against and nothing to put on a tile.
  const out = [];
  for (const ev of byEvent.values()) {
    if (!ev.home || !ev.away || !(ev.start > 0)) continue;
    ev.homeNames = [...ev.homeNames];
    ev.awayNames = [...ev.awayNames];
    out.push(ev);
  }
  return out;
}

// Named so it can never collide with a provider's own id, and so the same
// fixture is the same id on every request.
function scheduleId(ev) {
  const part = s => String(s).replace(/[^a-z0-9]+/gi, '').slice(0, 24);
  return `espn_${part(ev.board)}_${ev.day}_${part(ev.awayCrest || ev.away)}_${part(ev.homeCrest || ev.home)}`;
}

function scheduleFixture(ev) {
  const awayLogo = crestUrl(ev.awayCrest);
  const homeLogo = crestUrl(ev.homeCrest);
  const away = teamLogoService.canonicalName(awayLogo) || titleCase(ev.away);
  const home = teamLogoService.canonicalName(homeLogo) || titleCase(ev.home);
  const fixture = new MatchEntity({
    id: scheduleId(ev),
    title: `${away} @ ${home}`,
    category: BOARD_CATEGORY[ev.board] || 'other',
    date: ev.start,
    // Only fixtures still to come are built, and saying so keeps one that
    // kicks off while a page sits open from being called live by the clock
    // when there is still nothing to watch.
    status: 'upcoming',
    sources: [],
    team1: { name: away, logo: awayLogo || '' },
    team2: { name: home, logo: homeLogo || '' }
  });
  // What the tile says instead of offering a stream, set after construction the
  // way the aggregator sets its own extras.
  fixture._scheduleOnly = true;
  return fixture;
}

/**
 * The fixtures the providers between them already list, as pairs of sides.
 *
 * Both a crest pair and a name pair: the feeds and ESPN rarely spell a club the
 * same way, so the crests are what usually answer, while a fixture nothing could
 * resolve still has its names to be compared by.
 */
function providerPairs(matches, now) {
  const pairs = new Set();
  for (const m of matches) {
    const t = parseInt(m.date, 10) || 0;
    // Only the window the schedule is read for. A season of finished fixtures
    // has nothing here to collide with.
    if (t <= now - 86400000 || t > now + SCHEDULE_AHEAD_MS + 86400000) continue;
    const pair = teamLogoService.resolveMatchup(m);
    if (!pair) continue;
    const day = utcDay(t);
    const na = teamLogoService.normalize(pair.a);
    const nb = teamLogoService.normalize(pair.b);
    if (na && nb && na !== nb) pairs.add(`${day}:${[na, nb].sort().join('|')}`);
    const ca = teamLogoService.crestKey(pair.aLogo);
    const cb = teamLogoService.crestKey(pair.bLogo);
    if (ca && cb && ca !== cb) pairs.add(`${day}:${[ca, cb].sort().join('|')}`);
  }
  return pairs;
}

function coveredByProvider(ev, pairs) {
  // Every spelling ESPN knows this fixture by against the one the provider
  // used, since a feed writing the club's short name is the ordinary case and
  // the full name the exception. A fixture listed twice — once playable, once
  // saying nobody streams it — is the one thing this has to prevent, and the
  // cross product is a few dozen string joins for a viewer's own fixtures.
  const names = [];
  for (const h of ev.homeNames) {
    for (const a of ev.awayNames) {
      if (h !== a) names.push([h, a].sort().join('|'));
    }
  }
  const crests = ev.homeCrest && ev.awayCrest ? [ev.homeCrest, ev.awayCrest].sort().join('|') : null;
  // A provider's clock and ESPN's can straddle midnight, so the neighbouring
  // days count too — the same tolerance the index itself is looked up under.
  for (const off of [0, -1, 1]) {
    const day = utcDay(ev.start + off * 86400000);
    if (crests && pairs.has(`${day}:${crests}`)) return true;
    for (const pair of names) if (pairs.has(`${day}:${pair}`)) return true;
  }
  return false;
}

/**
 * Fixtures ESPN lists for a viewer's own teams that no provider covers, nearest
 * kickoff first.
 */
// Identity for one name the viewer typed, memoised: the filter asks this of
// every fixture in the catalog, and the answer only depends on the name and the
// sport it is being read in.
const favIdentityCache = new Map();
function favouriteIdentity(fav, category) {
  const key = `${fav}|${category || ''}`;
  let id = favIdentityCache.get(key);
  if (!id) {
    // The sport first, since "Cubs" is a baseball club before it is anything
    // else; without one, any league may answer.
    const crest = teamLogoService.lookupTeam(fav, category) || teamLogoService.lookupTeam(fav, null);
    id = {
      norm: teamLogoService.normalize(fav),
      crest: crest ? teamLogoService.crestKey(crest) : null
    };
    favIdentityCache.set(key, id);
  }
  return id;
}

/**
 * Whether a fixture is one the viewer asked for.
 *
 * Asking whether the title contained the name was both too strict and too
 * loose. Too strict: the feeds write "Braves @ Cubs" where the viewer wrote
 * "Chicago Cubs", so the club they actually follow never appeared — their own
 * tab was empty during their own game. Too loose: "Bears" then also matched
 * Mercer and California, who are other people's Bears entirely.
 *
 * Identity settles both. Each side resolves to ESPN's crest, and two clubs are
 * the same club when they wear the same badge — whatever either feed called
 * them. Where no crest resolves, which is the small colleges ESPN publishes no
 * logo for, the side's own name has to match outright rather than merely appear
 * somewhere in the sentence.
 */
function favouriteMatches(m, favoriteTeams) {
  const pair = teamLogoService.resolveMatchup(m);
  if (!pair) return false;
  const sides = [{ name: pair.a, logo: pair.aLogo }, { name: pair.b, logo: pair.bLogo }];
  for (const fav of favoriteTeams) {
    const id = favouriteIdentity(fav, m.category);
    for (const side of sides) {
      const crest = side.logo ? teamLogoService.crestKey(side.logo) : null;
      if (id.crest && crest && id.crest === crest) return true;
      if (teamLogoService.normalize(side.name) === id.norm) return true;
      const canon = side.logo ? teamLogoService.canonicalName(side.logo) : null;
      if (canon && teamLogoService.normalize(canon) === id.norm) return true;
    }
  }
  return false;
}

/**
 * Whether one of a scoreboard fixture's two sides is the club asked for.
 *
 * The crest answers where ESPN published one. Where it did not, the spellings
 * the index was keyed under do — and they have to match a whole name rather
 * than appear inside one. Sixty percent of what the old test matched was of the
 * second kind: "city" is inside "kansas city chiefs", "united" inside "west ham
 * united", "rams" inside "ramsgate".
 *
 * The name arm is not redundant with the crest. ESPN files the same club under
 * more than one crest id across its boards — Manchester City resolve to
 * soccer/382, while their fixtures are keyed soccer/19257 — so a crest-only
 * test loses half a correctly named club's games.
 */
function matchesScheduleSide(ev, want) {
  if (want.crest) {
    if (want.crest === ev.homeCrest || want.crest === ev.awayCrest) return true;
    // A board that publishes no crests still names two clubs, and those names
    // answer the same question. Without this, a viewer who writes the nickname
    // loses a fixture the index only ever keyed under the full name -- the
    // substring test got that one right by accident, and the accident is not
    // worth keeping when the identity is available for the asking.
    if (!ev.homeCrest && !ev.awayCrest) {
      for (const side of [ev.home, ev.away]) {
        const crest = teamLogoService.lookupTeam(side, null);
        if (crest && teamLogoService.crestKey(crest) === want.crest) return true;
      }
    }
  }
  return ev.homeNames.includes(want.norm) || ev.awayNames.includes(want.norm);
}

function scheduleOnlyFixtures(favoriteTeams, matches, now) {
  const wanted = favoriteTeams.map(t => favouriteIdentity(t, null)).filter(w => w.norm.length >= 2);
  if (!wanted.length) return [];
  const events = scheduleEvents();
  if (!events.length) return [];

  const pairs = providerPairs(matches, now);
  const picked = [];
  for (const ev of events) {
    if (ev.start <= now || ev.start > now + SCHEDULE_AHEAD_MS) continue;
    // The tab's own rule for whether a fixture is the viewer's, asked of the
    // names the index was keyed under, so a club answers to any of the
    // spellings ESPN knows it by rather than only to the one on a card.
    if (!wanted.some(w => matchesScheduleSide(ev, w))) continue;
    if (coveredByProvider(ev, pairs)) continue;
    picked.push(ev);
  }
  // Nearest first and then the cap: somebody who named a dozen clubs should
  // lose next weekend's fixtures rather than tonight's.
  picked.sort((a, b) => a.start - b.start);
  return picked.slice(0, SCHEDULE_MAX).map(scheduleFixture);
}

/** One of those fixtures by the id its tile carries, for the page behind it. */
function scheduleFixtureById(id) {
  if (!String(id || '').startsWith('espn_')) return null;
  for (const ev of scheduleEvents()) {
    if (scheduleId(ev) === id) return scheduleFixture(ev);
  }
  return null;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleCatalog(type, id, extra, config, opts = {}) {
  // Warm the home/away index before mapping. Blocks only on a cold start; once
  // an index exists a stale one is served while the refresh runs behind it, so
  // a slow or dead ESPN costs orientation rather than the catalog.
  await homeAway.ensureFresh().catch(() => {});
  if (type !== 'tv' || !id.startsWith('nuvio_sports_')) {
    return { metas: [] };
  }

  // Fire-and-forget stale-while-revalidate: return the cached list now and let
  // CronService refresh it in the background once it passes the revalidate window.
  // The card warmer reads every tab and passes revalidate: false -- a re-sync it
  // started would ask for another warm pass, and that pass for another re-sync.
  if (opts.revalidate !== false) container.resolve('cronService').ensureFresh();
  
  const conf = config || (extra && extra.config) || {};

  // The search twin of a tab that is off the home board is a separate id in the
  // manifest but the same category here, so the suffix comes off first.
  const categoryMatch = id.replace('nuvio_sports_', '').replace(SEARCH_TWIN_SUFFIX_RE, '');
  
  // Use CacheService instead of hitting APIs on demand
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  
  let filteredMatches = matches;

  if (categoryMatch === 'live') {
    // A channel with no kickoff counts as live by definition, which put all
    // nine of them at the top of Live above the games actually being played.
    // Channels have their own tab; Live is for what is on right now.
    filteredMatches = matches.filter(m => isMatchLive(m) && !isChannel(m));
  } else if (categoryMatch === 'upcoming') {
    const now = Date.now();
    filteredMatches = matches.filter(m => !isChannel(m) && !isMatchLive(m) && (parseInt(m.date) || 0) > now);
  } else if (categoryMatch === 'teams') {
    if (typeof conf.teams === 'string' && conf.teams.trim()) {
      const favoriteTeams = conf.teams.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
      // Fixtures only. A club's own 24/7 channel is not a game it is playing,
      // and it sat at the top of this tab every day of the year whether the
      // club was playing or not — the one tile guaranteed never to be what
      // somebody opening ⭐ Your Teams came for.
      filteredMatches = matches.filter(m => !isChannel(m) && favouriteMatches(m, favoriteTeams));
      // A viewer's team vanished from their own tab until some site posted a
      // link, which is usually an hour before kickoff — so the tab was empty
      // exactly when somebody was planning their week, and ESPN had known about
      // the game for days. Appended here and nowhere else: no other tab is
      // asked about a viewer's teams, and the list these join is the copy
      // getMatches() handed out, which nothing writes back.
      filteredMatches = filteredMatches.concat(scheduleOnlyFixtures(favoriteTeams, matches, Date.now()));
    } else {
      filteredMatches = []; // If no config, return empty
    }
  } else if (categoryMatch === 'american_football') {
    // The NFL tab. Everything gridiron and Australian arrives filed as
    // american_football, so the competition the crests named is what separates
    // them -- there is no category to do it with.
    filteredMatches = matches.filter(m => m.category === 'american_football' && !isChannel(m) && m._competition === 'nfl');
  } else if (categoryMatch === 'other_football') {
    // Everything else under that heading: the CFL, the AFL, and any fixture
    // whose competition could not be named.
    filteredMatches = matches.filter(m => m.category === 'american_football' && !isChannel(m) && m._competition !== 'nfl');
  } else if (categoryMatch === 'channels') {
    // Always-on channels, gathered in one place. A channel has no kickoff, which
    // is what separates it from a fixture.
    // Team channels and the listings in channelExclusions are not channels for
    // this tab; everything else is listed, and the health check below decides
    // what plays.
    const allChannels = matches.filter(m => isChannel(m) && !isTeamChannel(m) && !exclusionReason(m));
    // Check, in the background, which channels actually open to a stream. The
    // viewer's own source choices are left out: whether a channel is dead is a
    // fact about the channel, and one viewer turning a source off should not
    // hide it for everyone else.
    channelHealth.sweep(allChannels, (m) => countChannelStreams(m.id));
    // A channel the last check found with no streams at all stays out of the
    // tab until a later check finds it playing. Unchecked channels are shown.
    filteredMatches = allChannels.filter(m => !channelHealth.isDead(m.id));
    // The genre picker. "All" is what a player sends when the genre is required
    // only to keep the tab off the home board, so it means no filter.
    const wantedGenre = extra && typeof extra.genre === 'string' && extra.genre !== 'All' ? extra.genre : null;
    if (wantedGenre) filteredMatches = filteredMatches.filter(m => channelGenre(m) === wantedGenre);
  } else if (categoryMatch === 'local') {
    // The viewer's own cities, from the "markets" setting: their stations'
    // tiles, and any channel whose name says the city -- CBS News Chicago,
    // Chicago Sports Network. Empty until a city is named.
    const markets = parseMarkets(marketsSetting(conf));
    filteredMatches = markets.length
      ? matches.filter(m => isChannel(m) && !isTeamChannel(m) && !exclusionReason(m)
        && !channelHealth.isDead(m.id) && isLocalTo(m, markets))
      : [];
  } else if (categoryMatch === 'other') {
    filteredMatches = matches.filter(m => !TOP_LEVEL_CATEGORIES.includes(m.category) && !isChannel(m));
  } else if (categoryMatch !== 'catalog') {
    // Fixtures only. The always-on channels that used to be mixed in here now
    // live in the Channels tab, so a sport tab is a schedule rather than a
    // schedule with a few permanent entries pinned among it.
    filteredMatches = matches.filter(m => m.category === categoryMatch && !isChannel(m));
  }

  if (typeof conf.sports === 'string' && conf.sports !== 'all') {
    const allowedSports = conf.sports.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    // "other" is not a category any fixture carries -- it is the tab for
    // everything that is not one of the named sports. Comparing it literally
    // meant that unticking a single sport emptied the Other tab, because a
    // fixture in there has a category like "esports" that appears in no list.
    const otherAllowed = allowedSports.includes('other');
    // Don't filter out networks (24/7 TV) since they aren't tied to a specific sport
    filteredMatches = filteredMatches.filter(m =>
      m.category === 'networks'
      || allowedSports.includes(m.category)
      || (otherAllowed && !TOP_LEVEL_CATEGORIES.includes(m.category)));
  }

  filteredMatches = [...filteredMatches].sort((a, b) => {
    const aIsLive = isMatchLive(a) ? 1 : 0;
    const bIsLive = isMatchLive(b) ? 1 : 0;
    if (aIsLive !== bIsLive) return bIsLive - aIsLive; // Live matches first
    
    // Within live matches: Actual live event fixtures (UFC, F1, Football, etc.) take priority over 24/7 TV channels
    const aIsEvent = a.category !== 'networks' ? 1 : 0;
    const bIsEvent = b.category !== 'networks' ? 1 : 0;
    if (aIsEvent !== bIsEvent) return bIsEvent - aIsEvent;

    // Featured / Popular matches first
    const aPop = a.popular === '1' ? 1 : 0;
    const bPop = b.popular === '1' ? 1 : 0;
    if (aPop !== bPop) return bPop - aPop;
    
    const dateA = a.date ? parseInt(a.date) : 0;
    const dateB = b.date ? parseInt(b.date) : 0;
    
    // Sort upcoming by closest kickoff first
    if (dateA > 0 && dateB > 0) return dateA - dateB;
    return 0;
  });

  // Several hundred channels read as a wall in the order the sources sent them.
  // A to Z, with numbers read as numbers so Stan Sport 2 comes before Stan
  // Sport 10. Grouping by genre made "All" jump from sports to news partway
  // down; the genre picker is how to see one group. Before the per-tab shuffle
  // and reverse below, which still have the last word.
  if (categoryMatch === 'channels' || categoryMatch === 'local') {
    filteredMatches.sort((a, b) =>
      String(a.title).localeCompare(String(b.title), 'en', { sensitivity: 'base', numeric: true }));
  }

  // Fire-and-forget, before the mapping work, so the warming has the longest
  // possible head start on the click it is meant to cover. Not for the card
  // warmer's own reads (revalidate: false): nobody is about to click, and the
  // tokens minted would expire before anyone did. Measured on a restart, that
  // was 33 matches minted, 52 decrypts each in a spawned process and 250 dead
  // streams verified -- three minutes at most of both cores, for nothing.
  if (opts.revalidate !== false) prewarmTopMatches(filteredMatches, conf);

  // Per-tab ordering, applied after the sort above so it is the last word.
  const catOpts = (conf.catalogOptions && conf.catalogOptions[id]) || {};
  if (catOpts.shuffle) {
    filteredMatches = shuffleStable(filteredMatches, Number(catOpts.shufflePersistHours) || 0);
  } else if (catOpts.reverse) {
    filteredMatches = [...filteredMatches].reverse();
  }

  let metas = filteredMatches.map(m => mapMatchToMetaPreview(m, conf));

  // Two legs of a series carry the same name — "Pittsburgh Pirates @ Chicago
  // Cubs" today and again tomorrow. They are different games and must not be
  // merged, but side by side they read as a mistake, so when a name repeats in
  // a tab each copy says when it is.
  const nameCounts = new Map();
  for (const m of metas) nameCounts.set(m.name, (nameCounts.get(m.name) || 0) + 1);
  for (const m of metas) {
    if (nameCounts.get(m.name) > 1 && m._relative) m.name = `${m.name} ${m._relative}`;
    delete m._relative;
  }

  if (extra && extra.search) {
    const q = extra.search.toLowerCase();
    metas = metas.filter(m => 
      m.name.toLowerCase().includes(q) || 
      (m.description && m.description.toLowerCase().includes(q)) ||
      (m.cast && m.cast.some(c => c.toLowerCase().includes(q)))
    );
  }

  return { metas };
}

async function handleMeta(type, id, config) {
  await homeAway.ensureFresh().catch(() => {});
  if (type !== 'tv' || !id.startsWith('nuvio_sport_')) {
    return { meta: null };
  }

  // Fire-and-forget stale-while-revalidate, same as handleCatalog.
  container.resolve('cronService').ensureFresh();

  const matchId = id.replace('nuvio_sport_', '');
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  // A fixture only the schedule knows about is in no catalog by design, and
  // opening its tile should still show the fixture rather than an error.
  const match = matches.find(m => m.id === matchId) || scheduleFixtureById(matchId);

  if (!match) {
    return { meta: null };
  }

  // Prewarm: mint tokens for this match's top sources while the user is still
  // on the detail page, so the eventual click is near-instant. Fire-and-forget.
  // One nobody streams yet has no source to warm.
  if (!match._scheduleOnly) {
    try { prewarmMatch(match, config || {}).catch(() => {}); } catch (_) {}
  }

  return { meta: mapMatchToMetaPreview(match, config || {}) };
}

module.exports = {
  handleCatalog,
  handleMeta,
  isMatchLive,
  _eventDurationMs: eventDurationMs,
  _LIVE_STATUS_GRACE_MS: LIVE_STATUS_GRACE_MS,
  _mapMatchToMetaPreview: mapMatchToMetaPreview,
  _scheduleOnlyFixtures: scheduleOnlyFixtures
};
