// Spelling a club the way a viewer would type it.
//
// Your Teams matches on crest identity and on keyed names, and both run every
// name through normalize(). NFD decomposition handles the accents people leave
// off -- Atletico for Atlético, Besiktas for Beşiktaş -- because the accent is
// a separate combining mark once decomposed.
//
// It does nothing for the letters that are not an ASCII letter plus a mark.
// No normal form decomposes ø, ł, ß, đ or æ, so the [^a-z0-9] collapse that
// follows deleted them outright: "Bodø/Glimt" became "bod glimt", which a
// viewer typing "Bodo Glimt" could never match.
//
//   node tests/name-folding.test.js
const { normalize } = require('../src/services/TeamLogoService');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};
const same = (a, b, label) => t(true, normalize(a) === normalize(b) && normalize(a) !== '', `${label}: "${a}" == "${b}"`);

// ─── The letters that do not decompose ──────────────────────────────────────
same('Bodo Glimt', 'Bodø/Glimt', 'Norwegian slashed o');
t('bod glimt'.replace('bod', 'bodo'), normalize('Bodø/Glimt'), 'Bodø normalises to bodo, not bod');
same('Lodz', 'Łódź', 'Polish crossed l');
same('Fenerbahce', 'Fenerbahçe', 'Turkish cedilla (decomposes, still works)');
same('Dusseldorf', 'Düsseldorf', 'German umlaut (decomposes, still works)');
same('Bayern Munchen', 'Bayern München', 'another umlaut');
same('Malmo', 'Malmö', 'Swedish o with diaeresis');
same('Preussen', 'Preußen', 'German sharp s becomes ss');
same('Brondby', 'Brøndby', 'Danish slashed o');
same('Aarhus', 'Aarhus', 'a name with nothing to fold is left alone');

// ─── What must not change ───────────────────────────────────────────────────
t('arsenal', normalize('Arsenal'), 'a plain name is untouched');
t('manchester united', normalize('Manchester United'), 'spacing is untouched');
t('ragin cajuns', normalize("Ragin' Cajuns"), 'apostrophes still drop');
t('a and b', normalize('A & B'), 'ampersand still becomes and');
t('', normalize(''), 'empty stays empty');
t('', normalize(null), 'null is empty');
t('atletico madrid', normalize('Atlético Madrid'), 'accents still strip the old way');

// ─── Folding must not collide two different clubs ───────────────────────────
t(false, normalize('Bodø/Glimt') === normalize('Brøndby'), 'two Nordic clubs stay distinct');
t(false, normalize('Łódź') === normalize('Lazio'), 'folding does not blur unrelated names');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
