#!/usr/bin/env node
/**
 * Regenerates src/services/data/espn-teams.json from ESPN's public team lists.
 *
 *   node scripts/build-espn-teams.js
 *
 * Run this when schools rebrand, teams relocate, or a league is added. It is a
 * build step rather than a boot-time fetch on purpose: site.api.espn.com 403s
 * from some egress IPs, and catalog artwork must not depend on that.
 *
 * Output shape:  { "<league>": { "<normalized key>": "<logo url>" } }
 * Keys prefixed with "~" are de-spaced variants ("~ottawaredblacks"), which
 * absorb spelling splits between the scrape providers and ESPN.
 *
 * Keys that would resolve to more than one team inside the same league are
 * dropped — an ambiguous key is exactly the kind that produces a confidently
 * wrong crest.
 */

const fs = require('fs');
const path = require('path');

// site.web.api is used rather than site.api: the latter is Akamai-gated and
// returns 403 to non-browser clients from many networks.
const HOST = 'https://site.web.api.espn.com/apis/site/v2/sports';

const LEAGUES = {
  'nfl': 'football/nfl',
  'cfl': 'football/cfl',
  'college-football': 'football/college-football',
  'nba': 'basketball/nba',
  'wnba': 'basketball/wnba',
  'mens-college-basketball': 'basketball/mens-college-basketball',
  'mlb': 'baseball/mlb',
  'nhl': 'hockey/nhl',
  'mens-college-hockey': 'hockey/mens-college-hockey',
  'womens-college-hockey': 'hockey/womens-college-hockey',
  'afl': 'australian-football/afl'
};

// Soccer is fetched per competition but collapsed into ONE bucket. A club that
// plays in both its domestic league and a continental cup returns the same logo
// URL from each, so the ambiguity check does not drop it - and a single map
// keeps lookups O(1) instead of scanning 70 league tables.
const SOCCER = [
  'eng.1','eng.2','eng.3','eng.4','esp.1','esp.2','ita.1','ita.2','ger.1','ger.2',
  'fra.1','fra.2','ned.1','por.1','sco.1','bel.1','tur.1','gre.1','rus.1','ukr.1',
  'aut.1','sui.1','den.1','swe.1','nor.1','pol.1','cze.1','rou.1','cro.1','srb.1',
  'usa.1','usa.2','mex.1','bra.1','bra.2','arg.1','chi.1','col.1','uru.1','per.1',
  'ecu.1','par.1','ven.1','bol.1','crc.1','jpn.1','kor.1','chn.1','aus.1','ksa.1',
  'uae.1','qat.1','ind.1','rsa.1','egy.1','mar.1',
  'uefa.champions','uefa.europa','uefa.europa.conf','uefa.super_cup',
  'conmebol.libertadores','conmebol.sudamericana','concacaf.champions',
  'afc.champions','caf.champions','club.friendly',
  'fifa.world','fifa.friendly','fifa.worldq.uefa','fifa.worldq.conmebol',
  'fifa.worldq.afc','fifa.worldq.concacaf','fifa.worldq.caf',
  'uefa.euro','uefa.euroq','uefa.nations','conmebol.america','concacaf.gold',
  'afc.asian','caf.nations','uefa.euro_u21','fifa.world.u20','fifa.world.u17'
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.espn.com/'
};

function normalize(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function fetchLeague(slug, apiPath) {
  const url = `${HOST}/${apiPath}/teams?limit=1000`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`);
  const json = await res.json();
  const teams = json?.sports?.[0]?.leagues?.[0]?.teams;
  if (!Array.isArray(teams)) throw new Error(`${slug}: unexpected response shape`);
  return teams.map(t => t.team).filter(Boolean);
}

function logoFor(team, slug) {
  if (Array.isArray(team.logos) && team.logos.length) {
    const light = team.logos.find(l => !(l.rel || []).includes('dark')) || team.logos[0];
    if (light && light.href) return light.href.replace(/^http:/, 'https:');
  }
  if (team.id) return `https://a.espncdn.com/i/teamlogos/${slug}/500/${team.id}.png`;
  return null;
}

// Club-type affixes carry no identity: "Seattle Sounders FC" and "Seattle
// Sounders" are the same club, as are "FC Cincinnati" and "Cincinnati".
// Kept in sync with stripAffix() in src/services/TeamLogoService.js.
const AFFIX = /^(fc|sc|cf|afc|ac|as|sv|cd|ud|fk|sk|nk|bk|if)\s+|\s+(fc|sc|cf|afc|ac|as|sv|cd|ud|fk|sk|nk|bk|if|ii)$/;

function stripAffix(k) {
  let prev;
  let cur = k;
  while (cur !== prev) { prev = cur; cur = cur.replace(AFFIX, '').trim(); }
  return cur;
}

function keysFor(team) {
  const keys = new Set();
  for (const field of [team.displayName, team.shortDisplayName, team.name, team.nickname, team.location, team.abbreviation]) {
    const k = normalize(field);
    if (k.length >= 2) keys.add(k);
  }
  // "Location Nickname" recombination covers "penn state nittany lions" when
  // ESPN only stores the halves separately.
  const loc = normalize(team.location);
  const nick = normalize(team.name);
  if (loc && nick && loc !== nick) keys.add(`${loc} ${nick}`);

  for (const k of [...keys]) {
    const stripped = stripAffix(k);
    if (stripped && stripped !== k && stripped.length >= 4) keys.add(stripped);
  }
  for (const k of [...keys]) {
    const squashed = k.replace(/ /g, '');
    if (squashed !== k && squashed.length >= 6) keys.add('~' + squashed);
  }
  return keys;
}

/**
 * Accumulate teams into `candidates` (key -> { ids, logo }).
 *
 * Ambiguity is judged by ESPN team id, NOT by logo URL. The same club listed
 * under its domestic league and a continental cup can return its logos array in
 * a different order, and comparing URLs would call that a name collision and
 * drop a perfectly good key.
 */
function addTeams(candidates, teams, slug) {
  for (const team of teams) {
    const logo = logoFor(team, slug);
    if (!logo) continue;
    const id = String(team.id);
    const canonical = normalize(team.displayName);
    for (const k of keysFor(team)) {
      if (!candidates.has(k)) {
        candidates.set(k, { ids: new Set(), logos: new Set(), logo, primaries: new Set(), primaryLogo: null });
      }
      const entry = candidates.get(k);
      entry.ids.add(id);
      entry.logos.add(logo);
      // A key that IS this team's canonical display name outranks the same key
      // reached via someone else's location. Without this, "South Korea U17"
      // (location "South Korea") makes the senior side's key ambiguous.
      if (k === canonical) {
        entry.primaries.add(id);
        if (!entry.primaryLogo) entry.primaryLogo = logo;
      }
    }
  }
}

/** Collapse to key -> url, dropping any key that two different teams answer to. */
function finish(candidates) {
  const map = {};
  let dropped = 0;
  for (const k of [...candidates.keys()].sort()) {
    const entry = candidates.get(k);
    // Keep the key when every candidate is the same team, or when they all
    // render the same crest anyway (ESPN duplicates some clubs across
    // competitions under different ids). Either way the outcome is unambiguous.
    if (entry.ids.size === 1 || entry.logos.size === 1) map[k] = entry.logo;
    else if (entry.primaries.size === 1) map[k] = entry.primaryLogo;
    else dropped++;
  }
  return { map, dropped };
}

async function main() {
  const out = {};
  let grandTotal = 0;

  for (const [slug, apiPath] of Object.entries(LEAGUES)) {
    process.stdout.write(`fetching ${slug} ... `);
    const teams = await fetchLeague(slug, apiPath);
    const candidates = new Map();
    addTeams(candidates, teams, slug);
    const { map, dropped } = finish(candidates);
    out[slug] = map;
    grandTotal += Object.keys(map).length;
    console.log(`${teams.length} teams, ${Object.keys(map).length} keys, ${dropped} ambiguous dropped`);
  }

  console.log(`\nfetching soccer (${SOCCER.length} competitions)...`);
  const soccer = new Map();
  const skipped = [];
  let ok = 0;
  for (const comp of SOCCER) {
    try {
      const teams = await fetchLeague(comp, `soccer/${comp}`);
      if (!teams.length) { skipped.push(comp); continue; }
      addTeams(soccer, teams, 'soccer');
      ok++;
      console.log(`  ${comp.padEnd(26)} ${teams.length}`);
    } catch {
      // Competitions come and go (and some slugs are seasonal). A missing one
      // costs coverage, never correctness, so keep going.
      skipped.push(comp);
    }
  }
  const s = finish(soccer);
  out.soccer = s.map;
  grandTotal += Object.keys(s.map).length;
  console.log(`\n  soccer: ${ok} competitions ok, ${Object.keys(s.map).length} keys, ${s.dropped} ambiguous dropped`);
  if (skipped.length) console.log(`  skipped: ${skipped.join(', ')}`);

  const dest = path.join(__dirname, '..', 'src', 'services', 'data', 'espn-teams.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`\nwrote ${path.relative(process.cwd(), dest)} — ${grandTotal} keys, ${(fs.statSync(dest).size / 1024).toFixed(0)} KB`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
