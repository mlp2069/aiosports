/**
 * TeamLogoService.js
 *
 * Resolves the two sides of a fixture title to ESPN team logo URLs, so catalog
 * cards can show real artwork instead of a generated placeholder.
 *
 * Backed by a bundled table (data/espn-teams.json) generated from ESPN's public
 * team endpoints by scripts/build-espn-teams.js. It is a static file on purpose:
 * ESPN's site.api host 403s from some egress IPs, and a boot-time fetch would
 * make catalog artwork depend on that. Regenerate it when schools/teams change.
 *
 * Matching is deliberately conservative. A wrong logo is worse than no logo —
 * a card that confidently shows Oklahoma State for a Northwestern Oklahoma State
 * game is more misleading than one that shows the team names as text. Every rule
 * below exists to make a near-miss decline instead of guess:
 *
 *   1. exact normalized match      "los angeles rams"
 *   2. exact de-spaced match       "ottawaredblacks" -> ESPN's "Ottawa Red Blacks"
 *   3. whole-word run, >=2 words, covering >=75% of the side's words
 *
 * Bare single-word nicknames ("bombers", "argonauts", "tigers") are never used
 * as a fallback key: they collide across leagues and divisions.
 */

const TEAMS = require('./data/espn-teams.json');

// crest key -> the name ESPN calls that team. Providers spell the same club
// several ways ("Florida A and M", "Florida A&M", "Miami (FL)"); a card shows
// this instead, so one club reads one way across the whole catalog.
let TEAM_NAMES = {};
try {
  TEAM_NAMES = require('./data/espn-team-names.json');
} catch {
  TEAM_NAMES = {};        // absent table costs tidy names, nothing else
}

function crestKey(url) {
  // Rugby crests carry an extra "teams" segment: teamlogos/rugby/teams/500/<id>.png.
  const m = /\/teamlogos\/([^/]+)\/(?:teams\/)?\d+(?:\/scoreboard)?\/([^/?#]+?)\.(?:png|svg|jpg)/i.exec(String(url || ''));
  return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}` : '';
}

/** ESPN's name for whatever team a crest belongs to, or null. */
function canonicalName(logoUrl) {
  const k = crestKey(logoUrl);
  return (k && TEAM_NAMES[k]) || null;
}

// Which ESPN leagues to consult for a given addon category, in priority order.
// Ordering matters: "kansas city chiefs" must hit the NFL before the
// college-football table gets a chance at "kansas".
// Crests for clubs ESPN has no table for, and for the ones it spells
// differently, gathered by scripts/build-extra-crests.js. Consulted only after
// ESPN has failed, so it adds coverage without changing any existing answer.
let EXTRA_CRESTS = {};
try {
  EXTRA_CRESTS = require('./data/extra-crests.json');
} catch {
  // Optional: the addon runs without it, just with more name plates.
}

const CATEGORY_LEAGUES = {
  // AFL last: the providers file Australian rules under american_football, but
  // a bare "richmond" in that feed is the Spiders far more often than the
  // Tigers. resolveMatchup() still finds the Tigers when the opponent is AFL.
  american_football: ['nfl', 'cfl', 'college-football', 'afl'],
  basketball: ['nba', 'wnba', 'mens-college-basketball'],
  baseball: ['mlb'],
  hockey: ['nhl', 'mens-college-hockey', 'womens-college-hockey'],
  football: ['soccer'],
  college: ['college-football', 'mens-college-basketball', 'mens-college-hockey'],
  // Club competitions before the international ones: a bare "Newcastle" in a
  // rugby feed is the Falcons, not a country.
  rugby: ['rugby-prem', 'rugby-urc', 'rugby-top14', 'rugby-super', 'rugby-league',
    'rugby-champions', 'rugby-challenge', 'rugby-mlr', 'rugby-currie', 'rugby-npc',
    'rugby-super-aotearoa', 'rugby-super-au', 'rugby-super-tt', 'rugby-anglo-welsh',
    'rugby-urba', 'rugby-urba-14',
    'rugby-six-nations', 'rugby-championship', 'rugby-international', 'rugby-test',
    'rugby-nations', 'rugby-lions', 'rugby-tri-nations', 'rugby-wwc']
};

// Youth and reserve sides carry the senior badge, so "England U21" resolves
// through "england". Applies to clubs too ("Chelsea U21" -> Chelsea's crest).
const AGE_GROUP = /\s+u\s?(1[5-9]|2[0-3])$/;

// Club-type affixes carry no identity: the providers say "Seattle Sounders"
// where ESPN says "Seattle Sounders FC". The builder indexes stripped variants
// too; this is the query-side half. Kept in sync with scripts/build-espn-teams.js.
// Spelled-out club suffixes as well as the abbreviated ones: the providers
// write "Adelaide Football Club" where ESPN has "Adelaide Crows", and stripping
// only "fc"/"sc" left that side resolving nothing.
const AFFIX = /^(fc|sc|cf|afc|ac|as|sv|cd|ud|fk|sk|nk|bk|if)\s+|\s+(fc|sc|cf|afc|ac|as|sv|cd|ud|fk|sk|nk|bk|if|ii)$|\s+(football|futbol|soccer)\s+club$|\s+club$|\s+rugby$/;

function stripAffix(k) {
  let prev;
  let cur = k;
  while (cur !== prev) { prev = cur; cur = cur.replace(AFFIX, '').trim(); }
  return cur;
}

// National sides where the scrape providers and ESPN simply use different
// names for the same country. Only unambiguous, well-known equivalences.
const ALIASES = {
  // Rugby league: ESPN stores NRL clubs under the bare nickname ("Cowboys"),
  // while every feed writes the full club name. A bare nickname is exactly the
  // kind of key this matcher refuses to guess with, so the full names are
  // mapped explicitly instead of loosening the rules for everyone.
  'brisbane broncos': 'broncos',
  'canterbury bulldogs': 'bulldogs',
  'canterbury bankstown bulldogs': 'bulldogs',
  'north queensland cowboys': 'cowboys',
  'redcliffe dolphins': 'dolphins',
  'st george illawarra dragons': 'dragons',
  'parramatta eels': 'eels',
  'newcastle knights': 'knights',
  'penrith panthers': 'panthers',
  'south sydney rabbitohs': 'rabbitohs',
  'canberra raiders': 'raiders',
  'sydney roosters': 'roosters',
  'manly sea eagles': 'sea eagles',
  'manly warringah sea eagles': 'sea eagles',
  'cronulla sharks': 'sharks',
  'cronulla sutherland sharks': 'sharks',
  'melbourne storm': 'storm',
  'gold coast titans': 'titans',
  'new zealand warriors': 'warriors',
  // Renamed in 2024; ESPN still lists the old name.
  'newcastle red bulls': 'newcastle falcons',
  // Australian rules: ESPN's AFL feed names these two in ways no provider uses.
  // "Adelaide" is only ever stored as "Adelaide Crows", and ESPN ships a second,
  // wrong record for "Sydney Swans" (carrying Gold Coast's abbreviation), which
  // makes every spelling of the Swans ambiguous and drops them from the table —
  // so the club's own abbreviation is the only key left to point at.
  'adelaide': 'adelaide crows',
  'adelaide football club': 'adelaide crows',
  'sydney swans': 'syd',
  'sydney': 'syd',
  'swans': 'syd',
  'czech republic': 'czechia',
  'ireland': 'republic of ireland',
  'turkey': 'turkiye',
  'bosnia': 'bosnia herzegovina',
  'bosnia and herzegovina': 'bosnia herzegovina',
  'usa': 'united states',
  'united states of america': 'united states',
  'uae': 'united arab emirates',
  'ivory coast': 'cote divoire',
  'holland': 'netherlands',
  'china pr': 'china',
  'iran': 'ir iran',
  // Clubs ESPN files under a sponsor/brand name.
  'los angeles fc': 'lafc',
  'new york red bulls': 'red bull new york',
  'operario ferroviario': 'operario pr'
};

const ALL_LEAGUES = Object.keys(TEAMS);

// " vs ", " at ", " - " and friends, longest/most specific first so " vs. "
// is not consumed by the bare " v " rule.
const SEPARATORS = [' vs. ', ' vs ', ' v. ', ' v ', ' at ', ' @ ', ' - ', '—', '–'];

// Leading decoration the providers and the catalog layer add to titles.
const TITLE_PREFIX = /^(?:\s|[^\p{L}\p{N}]|live:|live|24\/7)+/iu;

const MIN_COVERAGE = 0.75;

const cache = new Map();
// Big enough to hold a whole catalog render. At 2000 a large build filled it
// and then threw it away mid-render, repeatedly, so the memo stopped memoising
// exactly when it was needed most. Each entry is a short key and a URL string.
const CACHE_MAX = 20000;

// normalize() as it behaved before it folded the undecomposable letters: they
// were simply deleted by the [^a-z0-9] collapse. The bundled ESPN table was
// generated that way, so this is what some of its keys still look like.
function normalizeLegacy(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalize(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip accents
    // Letters no normal form decomposes: NFD leaves these whole and the
    // [^a-z0-9] collapse below then deletes them outright, so "Bodo/Glimt"
    // typed by a viewer never met "Bodø/Glimt" from the feed -- it had become
    // "bod glimt". Mapped to the spelling people actually type.
    .replace(/ø/g, 'o').replace(/đ/g, 'd').replace(/ð/g, 'd')
    .replace(/ł/g, 'l').replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ı/g, 'i').replace(/þ/g, 'th')
    .replace(/&/g, ' and ')
    .replace(/[‘’']/g, '')   // possessives: "ragin' cajuns" -> "ragin cajuns"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Split "A vs B" / "A at B" into its two sides. Returns null if there is no fixture split. */
function splitSides(title) {
  if (!title || typeof title !== 'string') return null;
  const t = title.replace(TITLE_PREFIX, '');
  for (const sep of SEPARATORS) {
    const i = t.toLowerCase().indexOf(sep);
    if (i > 0) {
      const a = t.slice(0, i).trim();
      const b = t.slice(i + sep.length).trim();
      if (a && b) return [a, b];
    }
  }
  return null;
}

function leaguesFor(category) {
  const named = CATEGORY_LEAGUES[category];
  if (named) return named;
  return ALL_LEAGUES;
}

/**
 * Resolve one side of a fixture to a logo URL, or null.
 * Returns null rather than guessing whenever confidence is low.
 */
function lookupTeam(side, category, leaguesOverride = null) {
  const key = normalize(side);
  if (!key || key.length < 2) return null;

  const leagues = leaguesOverride || leaguesFor(category);
  const cacheKey = `${leagues.join(',')}|${key}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  // Each retry loosens one specific, identity-preserving difference. None of
  // them widen what counts as a match, so a near-miss still declines.
  let result = resolve(key, leagues);
  if (!result && ALIASES[key]) result = resolve(ALIASES[key], leagues);
  // The bundled table predates normalize() folding the letters no normal form
  // decomposes, and it is not consistent about them: ESPN's own spelling gives
  // "bodo glimt" for Bodo/Glimt but "brndby" for Brondby, the slashed o simply
  // deleted. Both are this club under the current folding, so a miss is tried
  // again with the older spelling instead of rebuilding the table.
  if (!result) {
    const legacy = normalizeLegacy(side);
    if (legacy && legacy !== key && legacy.length >= 2) {
      result = resolve(legacy, leagues)
            || (ALIASES[legacy] ? resolve(ALIASES[legacy], leagues) : null);
    }
  }
  if (!result) {
    const bare = stripAffix(key);
    if (bare && bare !== key && bare.length >= 4) result = resolve(bare, leagues);
  }
  // Parenthetical disambiguators: the college feeds write "Miami (FL)" to tell
  // it apart from Miami (OH), and normalize() turns that into "miami fl", which
  // is nobody's key. Retry without the qualifier.
  if (!result && /\(/.test(String(side))) {
    const unqualified = normalize(String(side).replace(/\([^)]*\)/g, ' '));
    if (unqualified && unqualified !== key && unqualified.length >= 3) {
      result = resolve(unqualified, leagues)
            || (ALIASES[unqualified] ? resolve(ALIASES[unqualified], leagues) : null);
    }
  }
  // "Saint" and "St." are the same word, and neither side is consistent about
  // which it writes: ESPN itself stores "St. Lawrence" beside "Saint Anselm",
  // and the feeds are no better. Swapping one for the other preserves identity
  // exactly -- no other name differs only by that word -- so it is safe to try
  // both ways round.
  if (!result && /\b(?:saint|st)\b/.test(key)) {
    const swapped = /\bsaint\b/.test(key)
      ? key.replace(/\bsaint\b/g, 'st')
      : key.replace(/\bst\b/g, 'saint');
    if (swapped !== key) {
      result = resolve(swapped, leagues)
            || (ALIASES[swapped] ? resolve(ALIASES[swapped], leagues) : null)
            || resolve(stripAffix(swapped), leagues);
    }
  }
  if (!result && AGE_GROUP.test(key)) {
    const senior = key.replace(AGE_GROUP, '');
    result = resolve(senior, leagues)
          || (ALIASES[senior] ? resolve(ALIASES[senior], leagues) : null)
          || resolve(stripAffix(senior), leagues);
  }
  // Last: the clubs ESPN has no table for. Keyed by category rather than by
  // league, because the whole reason a side is in here is that no league table
  // of ESPN's contained it.
  if (!result && category) {
    const extra = EXTRA_CRESTS[category];
    if (extra) result = extra[key] || extra[stripAffix(key)] || null;
  }

  // Drop the oldest one rather than all of them: clearing the map threw away
  // every answer to make room for one.
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, result);
  return result;
}

/**
 * Leagues in which `side` resolves at all. Used to resolve a fixture jointly:
 * "NC State vs Richmond" has one league in common (college-football), so
 * Richmond is the Spiders there — while "Richmond vs Collingwood" shares only
 * the AFL and gets the Tigers.
 *
 * This runs the full ladder per league rather than checking for an exact key,
 * because a side may resolve in one league only through an alias or a stripped
 * affix. An exact-key
 * test left those fixtures with no common league, which fell back to category
 * order and handed Richmond the wrong crest. lookupTeam() memoises per
 * (leagues, key), so the repeated calls cost one pass each per catalog build.
 */
function resolvingLeagues(side, leagues) {
  const out = [];
  for (const lg of leagues) {
    if (lookupTeam(side, null, [lg])) out.push(lg);
  }
  return out;
}

function resolve(key, leagues) {
  // 1. exact
  for (const lg of leagues) {
    const map = TEAMS[lg];
    if (map && Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  }

  // 2. de-spaced (the builder stores these under a "~" prefix)
  const squashed = '~' + key.replace(/ /g, '');
  if (squashed.length >= 7) {
    for (const lg of leagues) {
      const map = TEAMS[lg];
      if (map && Object.prototype.hasOwnProperty.call(map, squashed)) return map[squashed];
    }
  }

  // 3. multi-word whole-word run covering most of the side
  const sideWords = key.split(' ').length;
  const padded = ` ${key} `;
  for (const lg of leagues) {
    const map = TEAMS[lg];
    if (!map) continue;
    let best = null;
    let bestWords = 0;
    for (const k in map) {
      if (k.charCodeAt(0) === 126) continue;          // skip "~" de-spaced entries
      const w = k.split(' ').length;
      if (w < 2 || w <= bestWords) continue;
      if (w / sideWords < MIN_COVERAGE) continue;
      if (padded.indexOf(` ${k} `) !== -1) { best = map[k]; bestWords = w; }
    }
    if (best) return best;
  }

  return null;
}

function providedLogo(team) {
  if (!team || !team.logo || typeof team.logo !== 'string') return null;
  const u = team.logo.trim();
  if (!u) return null;
  if (u.startsWith('//')) return 'https:' + u;
  return /^https?:\/\//i.test(u) ? u : null;
}

/**
 * Resolve both sides of a match.
 *
 * Prefers the structured team names the provider supplied and falls back to
 * splitting the title, which is all most providers give us.
 *
 * Each side gets an ordered list of candidate crest URLs rather than a single
 * guess, because a URL's existence can only be known by fetching it and that
 * happens later, in /img/matchup. The bundled ESPN table comes first: its URLs
 * are stable CDN paths. A provider's own logo URL comes second — one feed
 * hands out image-proxy links that have all gone dead, and treating those as
 * authoritative is what produced crest cards with no crests on them.
 *
 * The two sides are resolved jointly. When both are outright hits in a common
 * league, both are looked up in that league only, so a name that exists in two
 * leagues of the same category ("richmond": NCAA Spiders, AFL Tigers) follows
 * its opponent.
 *
 * Returns { a, b, aLogos, bLogos, aLogo, bLogo } where a/b are display names
 * (always present when the title splits), aLogos/bLogos are the candidate
 * lists (possibly empty) and aLogo/bLogo are their first entries or null.
 */
function resolveMatchup(match) {
  if (!match) return null;

  let a = match.team1 && match.team1.name ? String(match.team1.name).trim() : null;
  let b = match.team2 && match.team2.name ? String(match.team2.name).trim() : null;

  if (!a || !b) {
    const sides = splitSides(match.title);
    if (!sides) return null;
    a = a || sides[0];
    b = b || sides[1];
  }

  const leagues = leaguesFor(match.category);
  const inA = resolvingLeagues(a, leagues);
  const inB = resolvingLeagues(b, leagues);
  const common = leagues.filter(lg => inA.includes(lg) && inB.includes(lg));
  const scope = common.length ? common : null;

  // A name that answers in more than one league of the same category is a
  // genuine collision — "richmond" is the NCAA Spiders and the AFL Tigers, and
  // the providers file both under american_football. With a common league the
  // opponent settles it. Without one there is no evidence, and league order
  // would just be a coin flip dressed up as an answer, so the table declines
  // and the provider's own URL (which knows which club it meant) gets its turn.
  // Several leagues answering is only a collision when they disagree. Exeter
  // Chiefs appear in the Premiership, the Champions Cup and the Challenge Cup
  // and are the same club with the same crest in all three; Richmond is the
  // NCAA Spiders in one table and the AFL Tigers in another. Comparing the
  // crests tells those apart, where counting the leagues cannot -- and counting
  // meant a side lost its crest whenever its opponent had none to share.
  const undecidable = (side, inSide) => {
    if (common.length || inSide.length <= 1) return false;
    const crests = new Set();
    for (const lg of inSide) {
      const crest = lookupTeam(side, match.category, [lg]);
      if (crest) crests.add(crest);
    }
    return crests.size > 1;
  };
  const fromTable = (side, ambiguous) =>
    ambiguous ? null : lookupTeam(side, match.category, scope);

  // One crest, one candidate. ESPN serves the same crest again under
  // /scoreboard/ (the Raiders' copy is a 4096-pixel, 572 KB file), and as a
  // "second choice" it only doubled the fetches each card queued on one host.
  const dedupe = list => {
    const seen = new Set();
    return list.filter(u => {
      if (!u) return false;
      const k = crestKey(u) || u;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const aLogos = dedupe([fromTable(a, undecidable(a, inA)), providedLogo(match.team1)]);
  const bLogos = dedupe([fromTable(b, undecidable(b, inB)), providedLogo(match.team2)]);

  return {
    a,
    b,
    aLogos,
    bLogos,
    aLogo: aLogos[0] || null,
    bLogo: bLogos[0] || null
  };
}

/** Forget every name-to-crest answer, for "Clear everything". */
function clearMemo() {
  cache.clear();
}

module.exports = {
  resolveMatchup,
  canonicalName,
  crestKey,
  clearMemo,
  resolvingLeagues,
  lookupTeam,
  splitSides,
  normalize,
  _normalizeLegacy: normalizeLegacy,
  CATEGORY_LEAGUES
};
