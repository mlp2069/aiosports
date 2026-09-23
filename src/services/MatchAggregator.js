// ─── Fuzzy Match Helpers ────────────────────────────────────────────────────

/**
 * Normalizes team/event names by collapsing well-known multi-word clubs and
 * popular abbreviations into single collision-safe compound tokens so that
 * Jaccard / subset matching cannot accidentally merge different teams that share
 * a single word (e.g. "Inter Milan" vs "AC Milan" both contain "milan").
 *
 * ORDER MATTERS: more specific aliases (inter miami, inter turku) must come
 * before the bare-"inter" rule, otherwise "Inter Miami" would compound to
 * "intermilan" and collide with Inter Milan.
 */
/**
 * Plain ASCII, so an accent is a letter rather than a word break.
 *
 * _tokenize keeps only [a-z0-9] and drops anything shorter than three
 * characters, so "Köln" became "k ln" and then nothing at all -- no token
 * survived to be compared, and no alias below could have rescued it however it
 * was written. The same silence hid Atlético, Beşiktaş and Mönchengladbach.
 * The bayern m[uü]nchen rule below is the workaround this replaces.
 */
function _fold(t) {
  return String(t == null ? '' : t)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/œ/gi, 'oe')
    .replace(/ß/g, 'ss').replace(/đ/gi, 'd').replace(/ł/gi, 'l')
    .replace(/ı/gi, 'i');
}

function _compoundify(t) {
  const aliases = [
    // Football (Soccer)
    [/\bman(chester)?\s*utd\b|\bmanchester\s*united\b/g, 'manchesterunited'],
    [/\bman\.?\s+united\b/g, 'manchesterunited'], // "Man United" / "Man. United" (gap found by A/B testing)
    [/\bman(chester)?\s*city\b/g, 'manchestercity'],
    [/\bspurs\b|\btottenham(\s*hotspur)?\b/g, 'tottenham'],
    [/\bwolves\b|\bwolverhampton(\s*wanderers)?\b/g, 'wolverhampton'],
    [/\bpsg\b|\bparis\s*(saint|st)\s*germain\b/g, 'psg'],
    [/\bbayern(\s*m[uü]nchen)?\b|\bbayern\s*munich\b/g, 'bayernmunich'],
    [/\batl(etico)?\s*madrid\b/g, 'atleticomadrid'],
    [/\breal\s*madrid\b|\br\s*madrid\b/g, 'realmadrid'],
    // inter variants must precede the bare-inter rule below
    [/\binter\s*miami\b/g, 'intermiami'],
    [/\binter\s*turku\b/g, 'interturku'],
    [/\binter(\s*milan)?\b|\binternazionale\b/g, 'intermilan'],
    [/\bac\s*milan\b/g, 'acmilan'],
    [/\bborussia\s*dortmund\b|\bbvb\b|\bdortmund\b/g, 'borussiadortmund'],
    [/\brb\s*leipzig\b/g, 'rbleipzig'],
    [/\baston\s*villa\b/g, 'astonvilla'],
    [/\bwest\s*ham(\s*united)?\b/g, 'westham'],
    [/\bcrystal\s*palace\b/g, 'crystalpalace'],
    [/\bnewcastle(\s*united)?\b/g, 'newcastle'],
    [/\bnottingham\s*forest\b|\bnott(?:s|m)\s+forest\b/g, 'nottinghamforest'],
    [/\bleicester(\s*city)?\b/g, 'leicestercity'],
    [/\bsheff(?:ield)?\s*(?:utd|united)\b/g, 'sheffieldunited'],
    [/\bbe(?:in\s*sport|\s*in)\b/g, 'beinsport'],
    // Channels listed under their on-air short names. USA TV Next's FS1 and FS2
    // were separate tiles from TimStreams' Fox Sports 1 and 2 -- one with the
    // streams, one without.
    [/\bfs\s*1\b|\bfox\s*sports?\s*1\b/g, 'foxsports1'],
    [/\bfs\s*2\b|\bfox\s*sports?\s*2\b/g, 'foxsports2'],
    // The same channels spelled with and without a space, or by a short name.
    // Each pair was two tiles, CDNLive's and TimStreams' or USA TV Next's, with
    // the streams split between them.
    [/\bespn\s+2\b/g, 'espn2'],
    [/\bespn\s+u\b/g, 'espnu'],
    [/\bespn\s+news\b/g, 'espnews'],
    [/\btsn\s+(\d)\b/g, 'tsn$1'],
    [/\bsport\s*tv\s*(\d)\b/g, 'sporttv$1'],
    [/\bfx\s*movie\s*channel\b|\bfxm\b/g, 'fxm'],
    [/\bhallmark\s+channel\b/g, 'hallmark'],
    [/\bfox\s*news(?:\s*channel)?\b/g, 'foxnews'],
    [/\bal[\s\-]nassr\b/g, 'alnassr'],
    [/\bal[\s\-]hilal\b/g, 'alhilal'],
    [/\bal[\s\-]ahly\b/g, 'alahly'],
    [/\bboca\s*juniors\b|\bca\s*boca\b/g, 'bocajuniors'],
    // Clubs two feeds genuinely call by different names. Only real dual names
    // belong here -- a spelling that merely differs by an accent or a club
    // suffix is already handled by _fold and _stripNoise, and an entry that
    // maps a name to itself buys nothing while widening the blast radius.
    // Every one below was a listing that appeared twice in the live catalog.
    [/\bkoln\b|\bcologne\b/g, 'cologne'],
    [/\bathletic\s*(?:club|bilbao)\b/g, 'athleticbilbao'],
    [/\bmonchengladbach\b|\bgladbach\b|\bborussia\s*m\b/g, 'gladbach'],
    [/\bsporting\s*(?:cp|lisbon|clube\s*de\s*portugal)\b/g, 'sportingcp'],
    [/\bjuventus\b|\bjuve\b/g, 'juventus'],
    [/\bbarcelona\b|\bbarca\b/g, 'barcelona'],
    [/\batletico\s*madrid\b|\batleti\b/g, 'atleticomadrid'],
    [/\breal\s*betis\b|\bbetis\b/g, 'realbetis'],
    [/\bdynamo\s*(?:kyiv|kiev)\b/g, 'dynamokyiv'],
    [/\bzenit(\s*st\s*petersburg)?\b/g, 'zenit'],
    [/\bpsv(\s*eindhoven)?\b/g, 'psv'],
    [/\bbesiktas\b/g, 'besiktas'],
    // American Football
    [/\bkansas\s*city\s*chiefs\b|\bkc\s*chiefs\b|\bchiefs\b/g, 'kansascitychiefs'],
    [/\bseattle\s*seahawks\b|\bseahawks\b/g, 'seattleseahawks'],
    [/\bsan\s*francisco\s*49ers\b|\bniners\b|\b49ers\b/g, 'sf49ers'],
    [/\bdallas\s*cowboys\b|\bcowboys\b/g, 'dallascowboys'],
    [/\bphiladelphia\s*eagles\b|\beagles\b/g, 'philadelphiaeagles'],
    [/\bgreen\s*bay\s*packers\b|\bpackers\b/g, 'greenbaypacker'],
    [/\bcincinatti\s*bengals\b|\bbengals\b/g, 'cincinnatibengals'],
    [/\bpittsburgh\s*steelers\b|\bsteelers\b/g, 'pittsburghsteelers'],
    // Basketball
    [/\bny\s*knicks\b|\bnew\s*york\s*knicks\b|\bknicks\b/g, 'nyknicks'],
    [/\bboston\s*celtics\b|\bceltics\b/g, 'bostonceltics'],
    [/\bla\s*lakers\b|\blakers\b|\blos\s*angeles\s*lakers\b/g, 'lalakers'],
    [/\bgolden\s*state\s*warriors\b|\bwarriors\b/g, 'gswarriors'],
    [/\bchicago\s*bulls\b|\bbulls\b/g, 'chicagobulls'],
    [/\bmiami\s*heat\b|\bheat\b/g, 'miamiheat'],
    [/\bdenver\s*nuggets\b|\bnuggets\b/g, 'denvernuggets'],
    [/\bmilwaukee\s*bucks\b|\bbucks\b/g, 'milwaukeebucks'],
  ];
  let r = _fold(t).toLowerCase();
  for (const [regex, rep] of aliases) r = r.replace(regex, rep);
  return r;
}

function _stripNoise(t) {
  return t
    .replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(live|stream|streaming|free|hd|fhd|4k|hq|web|online|tv|match|fixture|round|week|day|game|league|cup|tournament|season|fc|cf|sc|cd|ca|afc|fk|sk|bk|rsc|vfb|tsv)\b/gi, ' ');
}

function _tokenize(t) {
  return t.replace(/[^a-z0-9]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2)
    .map(w => (w.length > 3 && w.endsWith('s')) ? w.slice(0, -1) : w); // naive singular: newells->newell, sports->sport
}

/**
 * Determine if two team-name strings refer to the same club.
 * Single compound tokens (e.g. "manchestercity") require exact equality so
 * different compounds cannot accidentally match via substring.
 */
function _teamsSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const at = a.split(' ').filter(w => w.length > 2);
  const bt = b.split(' ').filter(w => w.length > 2);
  if (at.length === 0 || bt.length === 0) return false;
  if (at.length === 1 && bt.length === 1) return at[0] === bt[0];
  const sa = new Set(at), sb = new Set(bt);
  let common = 0;
  for (const w of sa) if (sb.has(w)) common++;
  const minLen = Math.min(sa.size, sb.size);
  return minLen > 0 && (common / minLen) >= 0.7;
}

/**
 * Try to split a match title into [team1, team2] using common separators.
 * Returns null if the title doesn't look like a "team1 vs team2" fixture.
 */
function _tryExtractTeams(title) {
  const clean = _compoundify(_stripNoise(title));
  // "at" as well as "vs"/"@": the feeds write "Florida A&M Rattlers at Miami
  // Hurricanes" for the same fixture another feed calls "Miami vs Florida A&M",
  // and a title that didn't parse into two sides could never be compared as one.
  const parts = clean.split(/\s(?:vs?\.?|at|@|[-–—])\s/i);
  if (parts.length === 2) {
    return [_tokenize(parts[0]).join(' '), _tokenize(parts[1]).join(' ')];
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * The upstream event numbers an event's sources are keyed by.
 *
 * StreamSports99, StreamedPk and cdnlive all quote the same number for the same
 * fixture, so a shared one is proof two listings are the same event — not a
 * resemblance between their titles. Five digits or more, to skip the short
 * ordinals some providers use for channel slots.
 */
function _upstreamIds(e) {
  const out = new Set();
  const push = (v) => {
    const s = String(v || '');
    // A hex-encoded URL is not an event number. TimStreams keys each source by
    // the hex of its stream URL, and hex is all [0-9a-f], so the tail of one
    // reads as a long number: every embed whose URL ends "-usa" encodes to a
    // string ending 757361. Every listing carrying a US channel therefore
    // claimed upstream event 757361 and matched all the others here -- before
    // the category, date and title guards, because this rule is identity
    // rather than similarity. Fifteen college games collapsed into one that
    // way, and the rest of TimStreams' football vanished from the catalog.
    if (s.length >= 16 && /^[0-9a-f]+$/i.test(s)) return;
    const m = /(\d{5,})$/.exec(s);
    if (m) out.add(m[1]);
  };
  push(e && e.id);
  if (e && Array.isArray(e.sources)) for (const s of e.sources) push(s && s.id);
  return out;
}

/**
 * The sport a named league belongs to.
 *
 * A provider's category string and its league field can disagree, and when they
 * do the league is the one telling the truth: the feeds list "San Francisco
 * 49ers vs Los Angeles Rams" with league "NFL" under a category that normalises
 * to `football`, which files an NFL game in the soccer catalog. The category is
 * a bucket the provider chose; the league is what the fixture actually is.
 */
// Two catalog names for one sport. A pair drawn from this set may merge.
const _SAME_SPORT = new Set(['college', 'american_football']);

// Words that only ever join the two sides of a fixture, never name one.
const _FIXTURE_JOINERS = new Set(['vs', 'v', 'at']);

const teamLogos = require('./TeamLogoService');
const eventMarks = require('./EventMarkService');
const { getChannelLogo } = require('./ChannelLogoService');
const leagueBadges = require('./LeagueBadgeService');
const { moreSpecific } = require('../channelGenres');
const { baseKey } = require('../channelRegions');

/**
 * Give a region to the 24/7 channels whose source did not say, before merging.
 *
 * Channels in different regions never merge, but a listing with no region
 * merges with anything -- so a plain "ESPN" would join whichever regional ESPN
 * the merge happened to meet first, and could carry a US feed into ESPN NZ.
 * Every source's channels are seen here together: a name that exists in one
 * region takes it, and a name that exists in several takes US when one of
 * them is, since the feeds that leave the region off are the US ones.
 */
function _assignChannelRegions(batches) {
  const isChannel = (m) => m && (!m.date || m.category === 'networks');
  const keyOf = (m) => baseKey(m.baseTitle || m.title);
  const known = new Map();
  for (const list of batches) {
    for (const m of list || []) {
      if (!isChannel(m) || !m.region) continue;
      const k = keyOf(m);
      if (!known.has(k)) known.set(k, new Set());
      known.get(k).add(m.region);
    }
  }
  for (const list of batches) {
    for (const m of list || []) {
      if (!isChannel(m) || m.region) continue;
      const regions = known.get(keyOf(m));
      if (!regions) continue;
      if (regions.size === 1) m.region = [...regions][0];
      else if (regions.has('US')) m.region = 'US';
    }
  }
}

/**
 * A fixture's identity, independent of how any provider spelled it.
 *
 * Titles are a presentation detail — "Miami vs Florida A&M", "Miami (FL) vs
 * Florida A and M" and "Florida A&M Rattlers at Miami Hurricanes" are one
 * game — and comparing them as strings is why one fixture could be listed
 * three times. What actually identifies a fixture is which two teams are
 * playing, so both sides are resolved to their crest and the pair, unordered,
 * is the key. Everything about the title, including which side was written
 * first, drops out.
 *
 * Null when either side doesn't resolve; the caller then falls back to the
 * title comparison rather than merging on a guess.
 */
function _identity(e) {
  if (!e) return null;
  let m;
  try {
    m = teamLogos.resolveMatchup(e);
  } catch {
    return null;
  }
  if (!m || !m.aLogo || !m.bLogo) return null;
  const key = (url) => {
    const hit = /\/teamlogos\/([^/]+)\/\d+(?:\/scoreboard)?\/([^/?#]+?)\.(?:png|svg|jpg)/i.exec(String(url));
    return hit ? `${hit[1].toLowerCase()}/${hit[2].toLowerCase()}` : String(url);
  };
  const a = key(m.aLogo);
  const b = key(m.bLogo);
  if (!a || !b || a === b) return null;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

const LEAGUE_CATEGORY = {
  // American Football is professional only; anything collegiate goes to the
  // College catalog, whatever the provider called it.
  nfl: 'american_football', cfl: 'american_football', afl: 'american_football',
  ncaaf: 'college', 'college football': 'college', 'ncaa football': 'college',
  'ncaa division 1 football': 'college',
  nba: 'basketball', wnba: 'basketball',
  ncaab: 'college', 'ncaa basketball': 'college',
  mlb: 'baseball', 'ncaa baseball': 'college',
  nhl: 'hockey',
  nrl: 'rugby', 'super rugby': 'rugby', 'six nations': 'rugby', 'gallagher prem': 'rugby',
  'premiership rugby': 'rugby', 'top 14': 'rugby', 'rugby championship': 'rugby',
  'formula 1': 'motorsport', f1: 'motorsport', nascar: 'motorsport', motogp: 'motorsport',
  indycar: 'motorsport', 'moto2': 'motorsport', 'moto3': 'motorsport',
  ufc: 'mma', pfl: 'mma', bellator: 'mma', boxing: 'mma',
  pga: 'golf', 'pga tour': 'golf', lpga: 'golf', 'dp world tour': 'golf',
  atp: 'tennis', wta: 'tennis'
};

/**
 * Correct a match's category when its league contradicts it. Only ever fires on
 * an exact league name we know, so a league we have never seen leaves the
 * provider's own choice alone.
 */
/**
 * Collegiate by the crests themselves.
 *
 * Most providers don't send a league at all, so a college fixture filed as
 * `american_football` had nothing to correct it — App State against East
 * Carolina sat in the professional tab. Both sides resolving to an ESPN NCAA
 * crest is the fixture telling us what it is. Only consulted for the two
 * football tabs, so college basketball and hockey keep their own categories.
 */
const _NCAA_CREST = /\/teamlogos\/ncaa\//i;

/**
 * Is this a college fixture, judged by the crests?
 *
 * One NCAA crest is enough when the other side resolved to nothing. College
 * teams play college teams, and a professional opponent would have resolved to
 * its own league's crest rather than to nothing -- so an unknown opposite a
 * known NCAA side is another college, usually one of the smaller divisions
 * ESPN keeps no table for. Requiring both meant a single unlisted opponent
 * filed the whole fixture alongside the NFL.
 *
 * A crest that resolved to a professional league still says no, which is what
 * keeps a college-named pro side out.
 */
// Where a college fixture can turn up. Wider than _SAME_SPORT, which governs
// which categories may merge with each other and must stay narrow.
const _COLLEGIATE_CATEGORIES = new Set(['college', 'american_football', 'basketball', 'hockey', 'baseball']);

function _collegiateByCrest(match) {
  if (!match || !_COLLEGIATE_CATEGORIES.has(match.category)) return false;
  let m;
  try {
    m = teamLogos.resolveMatchup(match);
  } catch {
    return false;
  }
  if (!m) return false;

  const a = m.aLogo, b = m.bLogo;
  const aNcaa = !!a && _NCAA_CREST.test(a);
  const bNcaa = !!b && _NCAA_CREST.test(b);
  if (aNcaa && bNcaa) return true;
  // One known college, one nobody knows.
  if (aNcaa && !b) return true;
  if (bNcaa && !a) return true;
  return false;
}

/**
 * A 24/7 channel's sport, read off its name.
 *
 * Channels have no date and no league, and providers file them wherever:
 * "NFL Streams Schedule" arrived categorised as basketball and sat in that tab.
 * Only applied to dateless entries, so a fixture is never renamed by a word in
 * its title.
 */
const CHANNEL_SPORT = [
  [/\bnfl\b|red\s?zone|gridiron/i, 'american_football'],
  [/\bnba\b|basketball/i, 'basketball'],
  [/\bmlb\b|baseball/i, 'baseball'],
  [/\bnhl\b|hockey/i, 'hockey'],
  [/\bnrl\b|rugby|fox league|super league/i, 'rugby'],
  [/cricket|willow/i, 'cricket'],
  [/tennis/i, 'tennis'],
  [/golf|\bpga\b/i, 'golf'],
  [/\bf1\b|formula|motor|rally|nascar|speed/i, 'motorsport'],
  [/\bufc\b|\bmma\b|boxing|wrestling/i, 'mma'],
  [/soccer|football club|premier league|\bepl\b|\bmls\b/i, 'football']
];

function _categoryFromChannelName(match) {
  if (!match || match.date) return null;           // fixtures have dates
  const title = String(match.title || '');
  if (!title) return null;
  for (const [re, cat] of CHANNEL_SPORT) if (re.test(title)) return cat;
  return null;
}

function _categoryFromLeague(match) {
  const raw = match && match.league ? String(match.league).toLowerCase().trim() : '';
  if (!raw) return null;
  if (LEAGUE_CATEGORY[raw]) return LEAGUE_CATEGORY[raw];
  // "American Major League Soccer" and friends: a league whose name says the
  // sport outright.
  if (/\bsoccer\b|\bmls\b|premier league|la ?liga|bundesliga|serie a|ligue 1|eredivisie|champions league/.test(raw)) return 'football';
  // Deliberately NOT matching every NCAA football league name here. "NCAA
  // Division 1 Football" would pull 124 college games out of the College
  // catalog and into American Football, which is a different decision than
  // "stop filing NFL games under soccer" and not one to make as a side effect.
  if (/\bncaa\b|college/.test(raw)) return 'college';
  return null;
}

// Every competition the crest table names, as the sport it is played at. The
// soccer ones are the dotted slugs -- eng.1, uefa.europa, conmebol.libertadores
// -- and there are seventy of them against thirty of everything else, so they
// are recognised by their shape rather than listed one by one.
const COMPETITION_CATEGORY = {
  nfl: 'american_football', cfl: 'american_football', afl: 'american_football',
  'college-football': 'college', 'mens-college-basketball': 'college',
  'mens-college-hockey': 'college', 'womens-college-hockey': 'college',
  nba: 'basketball', wnba: 'basketball',
  mlb: 'baseball', nhl: 'hockey'
};

function _categoryOfCompetition(slug) {
  if (!slug) return null;
  if (Object.prototype.hasOwnProperty.call(COMPETITION_CATEGORY, slug)) return COMPETITION_CATEGORY[slug];
  if (slug.startsWith('rugby-')) return 'rugby';
  if (slug.includes('.')) return 'football';
  return null;
}

/**
 * The sport a fixture's own crests put it in, for a listing that never said.
 *
 * Some sites publish nothing but two club names and a kickoff, and a name is
 * not a sport: "Elche vs Real Madrid" and "Yankees vs Twins" read alike. Those
 * fixtures land in Other Sports, which is wrong twice over -- a viewer looking
 * at Soccer does not see them, and the merge guards refuse to join two rows
 * whose categories disagree, so the same game from a source that did name its
 * sport sits beside this one with the streams divided between the two tiles.
 *
 * The crests already answer it. Both sides resolve to ESPN assets, and the
 * bundled table says which competitions each of them plays in; the one they
 * share is this fixture's. The answer is kept on the match because the pass
 * that fills `_competition` in later skips anything that already has it, so
 * asking now costs that pass the work rather than adding any.
 */
function _categoryFromCrests(match) {
  let comp = null;
  try {
    const pair = teamLogos.resolveMatchup(match);
    comp = pair ? leagueBadges.competitionFor(pair.aLogo, pair.bLogo) : null;
  } catch (err) {
    comp = null;
  }
  match._competition = comp;
  return _categoryOfCompetition(comp);
}

/**
 * A fixture whose title is the separator and nothing else.
 *
 * Streamed.pk publishes the occasional "vs" with neither side filled in. It
 * names no event, resolves to no teams and no competition, so it arrives as a
 * blank grey tile in whichever tab its category happens to point at.
 *
 * Deliberately narrow. An event that simply has one name rather than two — a
 * UFC card, a WWE show, a race meeting — is a real event people watch: of the
 * nine fixtures in a sampled catalog that resolved to no matchup at all, eight
 * were exactly that and only this one named nothing. Having no two sides is
 * therefore not the test; having no name is.
 */
const NAMES_NOTHING = /^[^a-z0-9]*(?:vs?\.?|at|@)?[^a-z0-9]*$/i;
function _namesNothing(match) {
  if (!match) return false;
  if (match.team1 || match.team2) return false;
  return NAMES_NOTHING.test(String(match.title || ''));
}

class MatchAggregator {
  constructor({ streamFreeProvider, timStreamsProvider, sportyHunterProvider, watchFootyProvider, cdnLiveProvider, streamSports99Provider, streamicProvider, streamedPkProvider, usaTvProvider, iptvOrgProvider, daddyLiveProvider, cacheService, yamlProviders }) {
    this.providers = [streamFreeProvider, timStreamsProvider, sportyHunterProvider, watchFootyProvider, cdnLiveProvider, streamSports99Provider, streamicProvider, streamedPkProvider, usaTvProvider, iptvOrgProvider, ...(daddyLiveProvider ? [daddyLiveProvider] : []), ...(yamlProviders || [])];
    this.cacheService = cacheService;
  }

  /**
   * Precompute everything isSameEvent needs ONCE per match. The merge loop is
   * O(N^2) in pair comparisons; doing the regex-heavy normalization here instead
   * of inside every comparison removes ~50x of repeated work on large catalogs.
   */
  _precompute(e) {
    // A channel is compared by its name without the region word, so "DAZN 1
    // Germany" and a "DAZN 1" filed as DE are one channel. The region field is
    // what keeps DE apart from ES, so the word adds nothing but a mismatch.
    const byBase = e && (!e.date || e.category === 'networks') && e.region && e.baseTitle;
    const title = byBase ? String(e.baseTitle) : (e && e.title ? String(e.title) : '');
    const id = e && e.id != null ? String(e.id) : '';
    return {
      id,
      category: e && e.category ? String(e.category) : '',
      region: e && e.region ? String(e.region) : '',
      date: Number(e && e.date) || 0,
      teams: _tryExtractTeams(title),
      tokens: new Set(_tokenize(_compoundify(_stripNoise(title)))),
      // Upstream event numbers, from the ids the providers key their own
      // sources by. Several providers quote the same number for the same
      // fixture, which is exact identity rather than a similarity guess.
      up: _upstreamIds(e),
      ident: _identity(e),
      // The channel this listing is, if it is one. A channel's name resolves to
      // a logo; a fixture's does not, which makes this a clean test for the
      // difference as well as an identity for the channel itself.
      chan: getChannelLogo(title) || null,
      norm: _compoundify(_stripNoise(title)).replace(/\s+/g, ' ').trim(),
      // Every word of the normalised title, short ones included, less the words
      // that only ever join two sides of a fixture. Used by the channel rule
      // above, where a two-letter suffix is the whole difference between two
      // regional feeds of one network.
      words: new Set(
        _compoundify(_stripNoise(title))
          .replace(/[^a-z0-9]/g, ' ')
          .split(/\s+/)
          .filter(w => w && !_FIXTURE_JOINERS.has(w))
          // The same naive singular _tokenize applies, so "beIN Sports 1" and
          // "beIN Sport 1" still read as one channel.
          .map(w => (w.length > 3 && w.endsWith('s')) ? w.slice(0, -1) : w)
      ),
      digits: (title.match(/\d+/g) || []).sort().join(',')
    };
  }

  /**
   * Merge decision on precomputed matches. Same decision tree as before, with
   * two fixes found by A/B testing against the real catalog:
   *   - "Man United" style alias gap (same match, two catalog names)
   *   - channel-like titles (no team-vs-team parse) collapsing under a loose
   *     Jaccard rule ("Sky Sports F1" + "Sky Sports Main Event" merged;
   *     "US Open Court 13" + "Court 7" merged)
   */
  _sameEventPre(p1, p2) {
    // Channels in two different regions are two channels, whatever else they
    // share -- ESPN US and ESPN NZ are different feeds with different
    // commentary. First, because nothing below should be allowed to fuse them.
    if (p1.region && p2.region && p1.region !== p2.region) return false;
    // 0. Same upstream event number — checked before every guard, because it is
    //    identity rather than similarity. This is what the category guard below
    //    was blocking: StreamSports99 files NCAA games as `college` while
    //    StreamedPk files the same fixture as `american_football`, so 14 of the
    //    18 duplicate groups never reached the title logic at all.
    if (p1.up && p2.up && p1.up.size && p2.up.size) {
      for (const u of p1.up) if (p2.up.has(u)) return true;
    }
    // 0b. The same channel, however a feed spelled it. streamed.pk lists NFL
    //     RedZone once properly and again the next day as the mangled "NFL vs
    //     RedZone"; both resolve to the one logo. A channel has no legs to
    //     confuse, so this is checked before the date guard that keeps two
    //     nights of the same fixture apart.
    // The logo alone is not enough. It is resolved by name and is deliberately
    // forgiving, so ESPN and ESPN Deportes answer to the same crest, as do NBC
    // Sports Boston, California and Philadelphia, and four separate SportsNet
    // regionals. Nine channels would have collapsed into three. Requiring the
    // token sets to match as well keeps the case this rule exists for -- "NFL
    // RedZone" and the mangled "NFL vs RedZone" both tokenise to {nfl,redzone}
    // -- while a regional's own city keeps it apart from its siblings.
    if (p1.chan && p2.chan && p1.chan === p2.chan) {
      // Compared on `words` rather than `tokens`: tokens drop anything under
      // three characters, which is how "Spectrum SportsNet LA" lost the only
      // thing separating it from "Spectrum SportsNet". The fixture separators
      // are excluded instead, so the mangled "NFL vs RedZone" still matches
      // "NFL RedZone".
      if (p1.words.size === p2.words.size) {
        let shared = 0;
        for (const w of p1.words) if (p2.words.has(w)) shared++;
        if (shared === p1.words.size) return true;
      }
    }

    // 1. Category mismatch guard.
    //
    // `college` and `american_football` are the same sport filed under two
    // names — StreamSports99 calls an NCAA game `college`, StreamedPk calls the
    // same game `american_football`. Treating them as different kept one
    // fixture listed twice, once in each tab, with its streams split between
    // the two. They are compatible here; the merged event remembers both tabs
    // so it still appears in each.
    if (p1.category && p2.category && p1.category !== 'other' && p2.category !== 'other' && p1.category !== p2.category) {
      if (!(_SAME_SPORT.has(p1.category) && _SAME_SPORT.has(p2.category))) return false;
    }
    // 2. Exact ID match
    if (p1.id && p2.id && p1.id === p2.id) return true;
    // 3. Date window guard. 24h was wide enough to fuse two legs of a series
    //    played on consecutive days; measured disagreement between providers
    //    about the same fixture is at most 1.5h, so 2h is generous.
    if (p1.date && p2.date && Math.abs(p1.date - p2.date) > 7200000) return false;

    // 4. Same two teams, same time — the fixture itself, not its wording.
    //    Deliberately placed after the date guard: the two legs of a series
    //    resolve to the same pair of crests and are only told apart by when
    //    they kick off.
    if (p1.ident && p2.ident && p1.ident === p2.ident) return true;

    // 5. Dual-team extraction — if both titles parse as "team1 vs team2", require
    //    BOTH teams to independently fuzzy-match.
    if (p1.teams && p2.teams) {
      const fwd = _teamsSimilar(p1.teams[0], p2.teams[0]) && _teamsSimilar(p1.teams[1], p2.teams[1]);
      const rev = _teamsSimilar(p1.teams[0], p2.teams[1]) && _teamsSimilar(p1.teams[1], p2.teams[0]);
      return fwd || rev;
    }

    // 6. Channel-identity path — at least one title is not a team-vs-team fixture
    //    (24/7 channels, court/track numbered events, "Team Live" listings).
    // Digit signatures must agree: "beIN 1" vs "beIN 2", "Court 13" vs "Court 7"
    // are different channels/events even when the words are identical.
    if (p1.digits !== p2.digits) return false;

    // 6a. One fixture + one channel-like listing: the channel-like tokens must be
    //     a subset of the fixture tokens ("Real Madrid live" ⊂ "Real Madrid vs
    //     Barcelona"). This keeps single-team listings merging with the fixture.
    if (p1.teams || p2.teams) {
      // An empty token set is a subset of every fixture, so a listing with no
      // usable words never joins one here.
      if (p1.tokens.size === 0 || p2.tokens.size === 0) return false;
      const channel = p1.teams ? p2 : p1;
      const fixture = p1.teams ? p1 : p2;
      for (const w of channel.tokens) if (!fixture.tokens.has(w)) return false;
      return true;
    }

    // 6b. Both channel-like: strict identity only. Distinct channels with shared
    //     branding must never merge.
    //
    // Guarded on `words`, not `tokens`. Tokens drop anything under three
    // characters, so "CW" and "FX" had no tokens at all and returned here
    // before being compared -- two listings of CW could never merge, and the
    // tab showed CW three times.
    if (p1.words.size === 0 || p2.words.size === 0) return false;
    if (p1.norm === p2.norm) return true;
    // On `words`, not `tokens`: tokens drop anything under three characters, so
    // "Spectrum SportsNet LA" and "Spectrum SportsNet" came through here as the
    // same two words and merged at a similarity of 1.0. This rule exists to
    // keep distinct channels that share branding apart, and a two-letter
    // regional suffix is exactly the branding difference it was missing.
    let common = 0;
    for (const w of p1.words) if (p2.words.has(w)) common++;
    const union = p1.words.size + p2.words.size - common;
    if (union > 0 && common / union >= 0.75) return true;
    return false;
  }

  /** Public API preserved: decision on raw matches (computes pre on the fly). */
  isSameEvent(e1, e2) {
    return this._sameEventPre(this._precompute(e1), this._precompute(e2));
  }

  async syncMatches() {
    console.log('[MatchAggregator] Fetching from all providers...');
    const finalMatches = [];
    const finalPres = []; // precomputed identity for each accepted match

    const processProviderMatches = (providerMatches) => {
      if (!providerMatches || !Array.isArray(providerMatches)) return;
      providerMatches.forEach(match => {
        if (!match.id || !match.title) return;

        // Put the match in the right catalog before anything else looks at its
        // category — the merge guards compare categories, so a misfiled event
        // would also fail to merge with its correctly-filed duplicate.
        const channelCategory = _categoryFromChannelName(match);
        if (channelCategory && match.category !== channelCategory) match.category = channelCategory;

        const trueCategory = _categoryFromLeague(match);
        if (trueCategory && match.category !== trueCategory) match.category = trueCategory;
        // Only when nothing else could name it. A category a provider stated is
        // its own evidence and is left alone; this is for the listings that
        // publish two club names and a time, and whose fixtures would otherwise
        // spend the evening in Other Sports.
        if (!match.category || match.category === 'other') {
          const byCrest = _categoryFromCrests(match);
          if (byCrest) match.category = byCrest;
        }
        // College games belong in College whatever the sport: a college hockey
        // fixture in the Hockey tab is the same misfiling as a college football
        // one beside the NFL.
        if (match.category !== 'college' && _collegiateByCrest(match)) {
          const FROM = { american_football: 'football', basketball: 'basketball', hockey: 'hockey', baseball: 'baseball' };
          match._collegeSport = FROM[match.category] || null;
          match.category = 'college';
        }
        // Which college sport, for the card's badge.
        if (match.category === 'college' && !match._collegeSport) {
          match._collegeSport = eventMarks.collegeSport(match.league);
        }

        const pre = this._precompute(match);
        let idx = -1;
        for (let i = 0; i < finalMatches.length; i++) {
          if (this._sameEventPre(finalPres[i], pre)) { idx = i; break; }
        }

        if (idx === -1) {
          finalMatches.push(match);
          finalPres.push(pre);
          return;
        }

        const existing = finalMatches[idx];
        // When a merge crosses the college/american_football line, the merged
        // event is collegiate: American Football lists professional fixtures
        // only, so College wins regardless of which provider arrived first.
        if (match.category !== existing.category && _SAME_SPORT.has(match.category) && _SAME_SPORT.has(existing.category)) {
          existing.category = 'college';
        }
        if (match.sources && Array.isArray(match.sources)) {
          match.sources.forEach(src => {
            if (!existing.sources.find(s => s.id === src.id && s.source === src.source)) {
              existing.sources.push(src);
            }
          });
        }
        if (match.popular === '1') existing.popular = '1';
        if (!existing.poster && match.poster) existing.poster = match.poster;
        if (!existing.logo && match.logo) existing.logo = match.logo;
        if (!existing.thumbnail_url && match.thumbnail_url) existing.thumbnail_url = match.thumbnail_url;
        if (!existing.background && match.background) existing.background = match.background;
        if (!existing.league && match.league) existing.league = match.league;
        // Two sources can file one channel differently; keep the more specific group.
        existing.genre = moreSpecific(existing.genre, match.genre) || '';
        // A group takes the region of the first member that knows one, and its
        // stored identity is updated with it, so a later listing from another
        // region is compared against the region rather than against a blank.
        if (!existing.region && match.region) {
          existing.region = match.region;
          finalPres[idx] = { ...finalPres[idx], region: match.region };
        }
        if (!existing.baseTitle && match.baseTitle) existing.baseTitle = match.baseTitle;
        if (!existing.team1 && match.team1) existing.team1 = match.team1;
        else if (existing.team1 && !existing.team1.logo && match.team1 && match.team1.logo) existing.team1.logo = match.team1.logo;
        if (!existing.team2 && match.team2) existing.team2 = match.team2;
        else if (existing.team2 && !existing.team2.logo && match.team2 && match.team2.logo) existing.team2.logo = match.team2.logo;
        if (existing.description === 'No description' && match.description && match.description !== 'No description') {
          existing.description = match.description;
        }

        // Canonical naming: prefer a team-vs-team fixture title over a
        // channel-like listing title, so the merged event keeps the most
        // informative name regardless of which provider arrived first.
        // A channel keeps its own name. "NFL vs RedZone" parses as a fixture
        // and would otherwise win the rule below, renaming the channel after
        // the feed's own mistake.
        const isChannelGroup = !!(pre.chan && finalPres[idx].chan);
        if (isChannelGroup) {
          // A channel is always on, so a provider that stamps a kickoff on one
          // must not give the group something to expire against. StreamFree
          // lists Willow with a June date; merging it with the live listing
          // handed the group that date, and the 24h cull below dropped both.
          if (!match.date) {
            existing.date = '';
            finalPres[idx] = { ...finalPres[idx], date: 0 };
          }

          // The fuller name of the same channel wins: "Willow" gives way to
          // "Willow Cricket", and the feed's mangled "NFL vs RedZone" -- which
          // parses as a fixture -- gives way to "NFL RedZone".
          const groupIsMangled = !!finalPres[idx].teams && !pre.teams;
          let fuller = false;
          if (!pre.teams && pre.tokens.size > finalPres[idx].tokens.size) {
            fuller = true;
            for (const w of finalPres[idx].tokens) if (!pre.tokens.has(w)) { fuller = false; break; }
          }
          if (groupIsMangled || fuller) {
            existing.title = match.title;
            if (match.baseTitle) existing.baseTitle = match.baseTitle;
            finalPres[idx] = { ...finalPres[idx], teams: null, tokens: pre.tokens, norm: pre.norm, digits: pre.digits };
          }
        } else if (!existing._titleIsFixture && pre.teams) {
          existing.title = match.title;
          existing._titleIsFixture = true;
          // Take the better title, but keep the group's own date and identity:
          // replacing the whole precompute moved the group's date onto whichever
          // member merged last, which then pushed the next legitimate duplicate
          // outside the window.
          finalPres[idx] = { ...finalPres[idx], teams: pre.teams, tokens: pre.tokens, norm: pre.norm, digits: pre.digits };
        }
        // A group accumulates its members' upstream ids, so a third listing
        // matches on any alias the group has already absorbed.
        if (pre.up && pre.up.size) {
          for (const u of pre.up) finalPres[idx].up.add(u);
        }
      });
    };

    // Providers swallow their own errors and return []. A non-empty result is the
    // only reliable success signal; it keeps a total upstream outage from wiping the cache.
    let anyProviderSucceeded = false;

    // Every provider's results are gathered before any are merged, so the
    // region pass below can see all of them at once.
    const batches = [];
    if (process.env.LOW_MEMORY_MODE === 'true') {
      // Memory-safe sequential fetching (Alwaysdata)
      for (const p of this.providers) {
        try {
          const providerMatches = await p.getMatches();
          if (Array.isArray(providerMatches) && providerMatches.length > 0) anyProviderSucceeded = true;
          batches.push(providerMatches);
        } catch (err) {
          console.error(`[MatchAggregator] Provider fetch failed:`, err.message);
        }
      }
    } else {
      // Fast parallel fetching (Render / Local)
      const results = await Promise.allSettled(this.providers.map(p => p.getMatches()));
      results.forEach((promiseResult, index) => {
        if (promiseResult.status === 'fulfilled') {
          if (Array.isArray(promiseResult.value) && promiseResult.value.length > 0) anyProviderSucceeded = true;
          batches.push(promiseResult.value);
        } else {
          console.error(`[MatchAggregator] Provider ${index} failed:`, promiseResult.reason);
        }
      });
    }
    _assignChannelRegions(batches);
    for (const b of batches) processProviderMatches(b);

    const now = Date.now();
    // Smart Trending Engine: Boost popular matches globally, but only if they are actually live or starting soon
    const TRENDING_KEYWORDS = ['bein', 'real madrid', 'barcelona', 'manchester', 'arsenal', 'liverpool', 'chelsea', 'bayern', 'psg', 'lakers', 'warriors', 'mcgregor', 'super bowl', 'champions league', 'el clasico', 'f1', 'formula 1', 'grand prix'];

    finalMatches.forEach(match => {
      const titleLower = match.title.toLowerCase();

      // Parse kickoff date (default to 0 if none provided, assume live)
      let kickoff = 0;
      if (match.date) {
        const parsed = Number(match.date);
        kickoff = isNaN(parsed) ? new Date(match.date).getTime() : parsed;
        if (isNaN(kickoff)) kickoff = 0;
      }
      // Allow matches to be flagged as 'Live' from 3 hours before kickoff up to 14 hours after kickoff
      const isWithinTimeWindow = kickoff === 0 || (now >= kickoff - (3 * 3600 * 1000) && now <= kickoff + (14 * 3600 * 1000));

      if (TRENDING_KEYWORDS.some(kw => titleLower.includes(kw))) {
        if (isWithinTimeWindow) {
          match.popular = '1';
        }
      }

      // GLOBAL FIX: Some providers (like Streamed.pk) flag future events as popular/live early.
      // We must override and strip the popular flag if the event is too far in the future.
      if (match.popular === '1' && kickoff > 0 && !isWithinTimeWindow) {
        match.popular = '0';
      }
    });

    // Filter out matches that are already over (kickoff was > 24 hours ago)
    // Which competition each fixture belongs to, worked out once from the
    // crests rather than per request. The tabs need it to tell an NFL game from
    // a CFL one -- both arrive filed as american_football -- and the card needs
    // it for the badge.
    for (const match of finalMatches) {
      if (match._competition !== undefined) continue;
      try {
        const pair = teamLogos.resolveMatchup(match);
        match._competition = pair ? leagueBadges.competitionFor(pair.aLogo, pair.bLogo) : null;
      } catch {
        match._competition = null;
      }
    }

    const activeMatches = finalMatches.filter(match => {
      // Dropped here rather than in the tabs: a tile that names no event is not
      // any one tab's problem.
      if (_namesNothing(match)) return false;
      let kickoff = 0;
      if (match.date) {
        const parsed = Number(match.date);
        kickoff = isNaN(parsed) ? new Date(match.date).getTime() : parsed;
        if (isNaN(kickoff)) kickoff = 0;
      }
      if (kickoff === 0) return true; // Keep if we don't know the time

      // Keep matches up to 24 hours after kickoff, except TimStreams which we keep for 48 hours (VODs)
      const isTimStreams = match.sources && match.sources.some(s => s.source === 'timstreams');
      const expiryWindowMs = isTimStreams ? (48 * 3600 * 1000) : (24 * 3600 * 1000);
      return now <= kickoff + expiryWindowMs;
    });

    // The same channel name in more than one region is labelled with it --
    // "ESPN US", "ESPN NZ" -- and a name found in one region keeps the name it
    // had. Counted after merging, across every source. Providers build fresh
    // entities each sync, so a label is never added to one already labelled.
    const isChannelMatch = (m) => !m.date || m.category === 'networks';
    const regionsByName = new Map();
    for (const m of activeMatches) {
      if (!isChannelMatch(m) || !m.region) continue;
      const k = baseKey(m.baseTitle || m.title);
      if (!regionsByName.has(k)) regionsByName.set(k, new Set());
      regionsByName.get(k).add(m.region);
    }
    let labelled = 0;
    for (const m of activeMatches) {
      if (!isChannelMatch(m) || !m.region) continue;
      const regions = regionsByName.get(baseKey(m.baseTitle || m.title));
      if (regions && regions.size > 1) {
        m.title = `${m.baseTitle || m.title} ${m.region}`;
        labelled++;
      }
    }
    if (labelled) console.log(`[MatchAggregator] ${labelled} channels labelled with their region`);

    console.log(`[MatchAggregator] Sync complete. Merged ${activeMatches.length} active events.`);
    if (anyProviderSucceeded) {
      this.cacheService.setMatches(activeMatches);
      return activeMatches;
    }
    return null;
  }
}

module.exports = MatchAggregator;
module.exports._internal = { _compoundify, _stripNoise, _tokenize, _teamsSimilar, _tryExtractTeams, _categoryOfCompetition, _categoryFromCrests, _namesNothing };
