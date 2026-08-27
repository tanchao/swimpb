// Run: node tests/standards.test.mjs
//
// Two halves. The first exercises the lookup logic against synthetic cuts, so
// it is meaningful before any real data is transcribed. The second validates
// the real table in app/standards/motivational.json — the checks that catch
// transcription errors — and is skipped with a loud notice until that file
// exists.
//
// loadStandards() is not covered here: it is a thin fetch wrapper and node's
// fetch cannot read file: URLs. It is exercised in the browser instead.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { convert, mapDistance } from "../app/convert.js";
import {
  AGE_GROUPS,
  LEVELS,
  ageGroupFor,
  cutsFor,
  levelFor,
  nextCut,
} from "../app/standards.js";

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    fails.push(`${name}: ${e.message}`);
  }
};

// --- age groups -------------------------------------------------------------

check("age groups cover the published set", () =>
  assert.deepEqual(AGE_GROUPS, ["10U", "11-12", "13-14", "15-16", "17-18"]));

check("ages map to their group", () => {
  assert.equal(ageGroupFor(6), "10U");
  assert.equal(ageGroupFor(10), "10U");
  assert.equal(ageGroupFor(11), "11-12");
  assert.equal(ageGroupFor(12), "11-12");
  assert.equal(ageGroupFor(13), "13-14");
  assert.equal(ageGroupFor(14), "13-14");
  assert.equal(ageGroupFor(15), "15-16");
  assert.equal(ageGroupFor(17), "17-18");
  assert.equal(ageGroupFor(18), "17-18");
});

check("19 and over has no age-group standard", () => {
  // Motivational standards stop at 18; past that it is a different system.
  assert.equal(ageGroupFor(19), null);
  assert.equal(ageGroupFor(29), null);
});

check("unknown age is null, not a guess", () => {
  assert.equal(ageGroupFor(undefined), null);
  assert.equal(ageGroupFor(null), null);
  assert.equal(ageGroupFor(NaN), null);
});

// --- the ladder -------------------------------------------------------------
// Synthetic 50 free: B 27.99 down to AAAA 23.19, strictly decreasing.

const CUTS = [2799, 2639, 2499, 2472, 2389, 2319];

check("levels are ordered slowest to fastest", () =>
  assert.deepEqual(LEVELS, ["B", "BB", "A", "AA", "AAA", "AAAA"]));

check("slower than B has no level", () => assert.equal(levelFor(2900, CUTS), null));

check("exactly on a cut achieves it", () => {
  // A cut is a time you must beat *or equal*.
  assert.equal(levelFor(2799, CUTS).level, "B");
  assert.equal(levelFor(2472, CUTS).level, "AA");
  assert.equal(levelFor(2319, CUTS).level, "AAAA");
});

check("reports the highest level reached, not the first", () => {
  assert.equal(levelFor(2400, CUTS).level, "AA");
  assert.equal(levelFor(2380, CUTS).level, "AAA");
});

check("faster than AAAA still reads AAAA", () =>
  assert.equal(levelFor(2100, CUTS).level, "AAAA"));

check("next cut is the slowest one not yet met", () => {
  assert.equal(nextCut(2900, CUTS).level, "B");
  assert.equal(nextCut(2700, CUTS).level, "BB");
  assert.equal(nextCut(2480, CUTS).level, "AA");
});

check("gap is negative — the time has to come down", () => {
  const n = nextCut(2513, CUTS);
  assert.equal(n.level, "A");
  assert.equal(n.gap, 2499 - 2513);
  assert.ok(n.gap < 0);
});

check("no next cut once AAAA is met", () => {
  assert.equal(nextCut(2319, CUTS), null);
  assert.equal(nextCut(2100, CUTS), null);
});

check("level and next cut are adjacent rungs", () => {
  // Whatever the time, the achieved level and the next target must sit next to
  // each other on the ladder — otherwise a rung is being skipped.
  for (const t of [2900, 2799, 2700, 2500, 2472, 2400, 2320]) {
    const got = levelFor(t, CUTS);
    const next = nextCut(t, CUTS);
    if (next === null) continue;
    const gotIdx = got === null ? -1 : got.index;
    assert.equal(LEVELS.indexOf(next.level), gotIdx + 1, `at ${t}`);
  }
});

check("missing inputs are null, never a thrown error", () => {
  assert.equal(levelFor(null, CUTS), null);
  assert.equal(levelFor(2400, null), null);
  assert.equal(nextCut(null, CUTS), null);
  assert.equal(nextCut(2400, null), null);
});

// --- event lookup -----------------------------------------------------------

const DATA = {
  edition: "test",
  levels: LEVELS,
  standards: {
    girls: {
      "13-14": {
        SCY: { "50 FR": CUTS, "500 FR": [180000, 175000, 170000, 168000, 165000, 160000] },
        LCM: { "400 FR": [190000, 185000, 180000, 178000, 175000, 170000] },
      },
    },
  },
};

check("finds an event in the swimmer's own course", () =>
  assert.deepEqual(
    cutsFor(DATA, { gender: "girls", ageGroup: "13-14", course: "SCY", distance: 50, stroke: "Freestyle" }),
    CUTS,
  ));

check("distance free maps to the metric race", () => {
  // ui.js keys that row on 500 (yards-canonical); the LCM cut is filed under
  // 400, because they are the same event in different pools.
  const cuts = cutsFor(DATA, {
    gender: "girls", ageGroup: "13-14", course: "LCM", distance: 500, stroke: "Freestyle",
  });
  assert.deepEqual(cuts, DATA.standards.girls["13-14"].LCM["400 FR"]);
});

check("an event absent from the published set is null", () =>
  assert.equal(
    cutsFor(DATA, { gender: "girls", ageGroup: "13-14", course: "SCY", distance: 400, stroke: "Individual Medley" }),
    null,
  ));

check("unknown stroke is null", () =>
  assert.equal(
    cutsFor(DATA, { gender: "girls", ageGroup: "13-14", course: "SCY", distance: 50, stroke: "Sidestroke" }),
    null,
  ));

check("no gender means no lookup — it is never guessed", () =>
  assert.equal(
    cutsFor(DATA, { gender: null, ageGroup: "13-14", course: "SCY", distance: 50, stroke: "Freestyle" }),
    null,
  ));

check("missing data is null, not a throw", () =>
  assert.equal(
    cutsFor(null, { gender: "girls", ageGroup: "13-14", course: "SCY", distance: 50, stroke: "Freestyle" }),
    null,
  ));

// --- the real table ---------------------------------------------------------

let real = null;
try {
  real = JSON.parse(readFileSync(new URL("../app/standards/motivational.json", import.meta.url)));
} catch {
  real = null;
}

if (real === null) {
  console.log("\n  NOTE  app/standards/motivational.json not present — data checks skipped.");
} else {
  check("declares an edition and a source", () => {
    assert.ok(real.edition, "edition missing");
    assert.ok(/^https?:\/\//.test(real.source ?? ""), "source must be a URL");
  });

  check("uses the same ladder as the code", () => assert.deepEqual(real.levels, LEVELS));

  check("every cut array is strictly decreasing B → AAAA", () => {
    // The single most valuable check: a transposed pair or a mistyped digit
    // almost always breaks monotonicity.
    for (const [gender, groups] of Object.entries(real.standards)) {
      for (const [group, courses] of Object.entries(groups)) {
        for (const [course, events] of Object.entries(courses)) {
          for (const [event, cuts] of Object.entries(events)) {
            const where = `${gender} ${group} ${course} ${event}`;
            assert.equal(cuts.length, LEVELS.length, `${where}: expected ${LEVELS.length} cuts`);
            for (const c of cuts) {
              assert.ok(Number.isInteger(c) && c > 0, `${where}: ${c} is not a positive integer`);
            }
            for (let i = 1; i < cuts.length; i++) {
              assert.ok(cuts[i] < cuts[i - 1], `${where}: ${LEVELS[i]} ${cuts[i]} not faster than ${LEVELS[i - 1]} ${cuts[i - 1]}`);
            }
          }
        }
      }
    }
  });

  check("every declared age group is a known one", () => {
    for (const groups of Object.values(real.standards)) {
      for (const group of Object.keys(groups)) {
        assert.ok(AGE_GROUPS.includes(group), `unknown age group "${group}"`);
      }
    }
  });

  check("both genders cover every age group and course", () => {
    for (const gender of ["girls", "boys"]) {
      const groups = real.standards[gender];
      assert.ok(groups, `${gender} missing`);
      assert.deepEqual(Object.keys(groups).sort(), [...AGE_GROUPS].sort(), gender);
      for (const [group, courses] of Object.entries(groups)) {
        assert.deepEqual(Object.keys(courses).sort(), ["LCM", "SCM", "SCY"], `${gender} ${group}`);
        for (const [course, events] of Object.entries(courses)) {
          assert.ok(Object.keys(events).length >= 10, `${gender} ${group} ${course} looks thin`);
        }
      }
    }
  });

  check("no relay events leaked in", () => {
    // The published table lists relays alongside individual events; a relay is
    // not a personal best and must not be measurable here.
    for (const groups of Object.values(real.standards)) {
      for (const courses of Object.values(groups)) {
        for (const events of Object.values(courses)) {
          for (const event of Object.keys(events)) {
            assert.ok(/^\d+ (FR|BK|BR|FL|IM)$/.test(event), `unexpected event "${event}"`);
          }
        }
      }
    }
  });

  check("spot checks against the published document", () => {
    // Read by hand off page 1 of the source PDF: 10 & under, 50 FR SCY.
    assert.deepEqual(real.standards.girls["10U"].SCY["50 FR"], [3979, 3599, 3209, 3089, 2959, 2829]);
    // The boys' column is printed mirrored (AAAA first); it must come out B-first.
    assert.deepEqual(real.standards.boys["10U"].SCY["50 FR"], [3819, 3459, 3109, 2989, 2869, 2749]);
    // A time over a minute, to check the mm:ss parse: girls 10&U 100 FR B is 1:30.79.
    assert.equal(real.standards.girls["10U"].SCY["100 FR"][0], 9079);
  });

  check("SCY and LCM cuts agree through the conversion model", () => {
    // The strongest structural check available. Every event published in both
    // courses is converted SCY→LCM with the model in convert.js — which is
    // independently accuracy-tested — and compared to the published LCM cut.
    // Real data lands within 5.5% (backstroke is the model's weakest stroke, as
    // convert.test.mjs also shows). A transposed row, a shifted column or a
    // gender mix-up produces errors far larger than the 8% allowed here.
    const STROKE = { FR: "Freestyle", BK: "Backstroke", BR: "Breaststroke", FL: "Butterfly", IM: "Individual Medley" };
    let compared = 0;
    let worst = { pct: 0, where: "" };

    for (const [gender, groups] of Object.entries(real.standards)) {
      for (const [group, courses] of Object.entries(groups)) {
        for (const [event, cuts] of Object.entries(courses.SCY ?? {})) {
          const [distText, abbrev] = event.split(" ");
          const distance = Number(distText);
          const stroke = STROKE[abbrev];
          const lcmEvent = `${mapDistance(distance, stroke, "SCY", "LCM")} ${abbrev}`;
          const lcmCuts = courses.LCM?.[lcmEvent];
          if (!lcmCuts) continue;

          for (let i = 0; i < cuts.length; i++) {
            const predicted = convert(cuts[i], distance, stroke, "SCY", "LCM");
            if (predicted === null) continue;
            const pct = Math.abs((predicted - lcmCuts[i]) / lcmCuts[i]) * 100;
            compared++;
            if (pct > worst.pct) worst = { pct, where: `${gender} ${group} ${event} ${LEVELS[i]}` };
          }
        }
      }
    }

    assert.ok(compared > 800, `expected to compare most events, got ${compared}`);
    assert.ok(worst.pct < 8, `${worst.where} is off by ${worst.pct.toFixed(2)}%`);
  });
}

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
