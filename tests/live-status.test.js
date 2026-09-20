// When a card stops being LIVE.
//
// The owner's report, and the measurement behind it: an Austria GP session was
// still marked LIVE 6.2 hours after it started, while every football match on
// the same board had aged out correctly. Six providers stamp status 'live' and
// none of them ever takes it back, so that branch of isMatchLive returned true
// forever -- the per-sport duration table sat twenty lines below it, reachable
// only by fixtures whose status was never set.
//
//   node tests/live-status.test.js
const { isMatchLive, _eventDurationMs, _LIVE_STATUS_GRACE_MS } = require('../src/catalog');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};
const MIN = 60 * 1000, HOUR = 60 * MIN;
const ago = (ms) => String(Date.now() - ms);
const ahead = (ms) => String(Date.now() + ms);

// ─── The bug: a provider's "live" outlives the event ────────────────────────
t(false, isMatchLive({ category: 'motorsport', status: 'live', date: ago(6.2 * HOUR) }),
  'the Austria GP case: motorsport still flagged live 6.2h in');
t(false, isMatchLive({ category: 'football', status: 'live', date: ago(4 * HOUR) }),
  'a football match flagged live four hours in');
t(false, isMatchLive({ category: 'football', status: 'in_progress', date: ago(5 * HOUR) }),
  'in_progress ages out the same way');
t(false, isMatchLive({ category: 'basketball', status: 'in', date: ago(6 * HOUR) }),
  "and so does 'in'");

// ─── What must not change: matches that really are on ───────────────────────
t(true, isMatchLive({ category: 'football', status: 'live', date: ago(30 * MIN) }),
  'a football match half an hour in is live');
t(true, isMatchLive({ category: 'football', status: 'live', date: ago(2 * HOUR) }),
  'and still live at two hours, stoppage and all');
t(true, isMatchLive({ category: 'cricket', status: 'live', date: ago(7 * HOUR) }),
  'cricket runs long and is still live at seven hours');
t(true, isMatchLive({ category: 'motorsport', status: 'live', date: ago(3 * HOUR) }),
  'a race meeting is still live at three hours');
t(true, isMatchLive({ category: 'mma', status: 'live', date: ago(5 * HOUR) }),
  'a fight card is still live at five hours');

// ─── The grace window covers the awkward cases ──────────────────────────────
{
  // Football's table entry is 2.5h. Extra time and penalties from a kickoff
  // the provider recorded as the scheduled time can push past that.
  const edge = _eventDurationMs('football') + _LIVE_STATUS_GRACE_MS;
  t(true, isMatchLive({ category: 'football', status: 'live', date: ago(edge - 5 * MIN) }),
    'five minutes inside the grace window is still live');
  t(false, isMatchLive({ category: 'football', status: 'live', date: ago(edge + 5 * MIN) }),
    'five minutes past it is not');
  t(true, _LIVE_STATUS_GRACE_MS >= 30 * MIN,
    'the grace window is at least half an hour, for extra time and delayed starts');
}

// ─── Nothing else about the function changes ────────────────────────────────
t(true, isMatchLive({ category: 'networks', status: 'live', date: ago(50 * HOUR) }),
  'a 24/7 network is always live, whatever its date says');
t(true, isMatchLive({ category: 'football', status: 'live', date: '' }),
  'with no kickoff there is nothing to hold the status against, so it stands');
t(false, isMatchLive({ category: 'football', status: 'finished', date: ago(10 * MIN) }),
  'finished is never live');
t(false, isMatchLive({ category: 'football', status: 'cancelled', date: ago(10 * MIN) }),
  'cancelled is never live');
t(false, isMatchLive({ category: 'football', status: 'upcoming', date: ahead(2 * HOUR) }),
  'upcoming is not live');
t(false, isMatchLive(null), 'no match is not live');

// ─── The time-based branch still behaves ────────────────────────────────────
t(true, isMatchLive({ category: 'football', date: ago(10 * MIN) }),
  'no status, kicked off ten minutes ago: live');
t(true, isMatchLive({ category: 'football', date: ahead(10 * MIN) }),
  'no status, kicking off in ten minutes: live (the 15-minute pre-roll)');
t(false, isMatchLive({ category: 'football', date: ahead(2 * HOUR) }),
  'no status, kicking off in two hours: not live');
t(false, isMatchLive({ category: 'football', date: ago(4 * HOUR) }),
  'no status, four hours ago: not live');

// ─── The duration table is shared by both branches ──────────────────────────
t(_eventDurationMs('football'), 2.5 * HOUR, 'football duration unchanged by the refactor');
t(_eventDurationMs('cricket'), 8 * HOUR, 'cricket duration unchanged');
t(_eventDurationMs('nonsense-sport'), 3 * HOUR, 'an unknown sport falls back to three hours');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
