// Run: node tests/advise.test.mjs
//
// The advice engine is deterministic, so it is fully testable: same times in,
// same ranked findings out. Synthetic cuts keep the assertions independent of
// whichever edition of the real table is checked in.

import assert from "node:assert/strict";
import { advise, profile, rungLabel } from "../app/advise.js";
import { rung } from "../app/standards.js";
import { groupBestTimes } from "../app/ui.js";

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

const SCY = {
  "50 FR": [3000, 2900, 2800, 2700, 2600, 2500],
  "100 FR": [6600, 6400, 6200, 6000, 5800, 5600],
  "500 FR": [36000, 35000, 34000, 33000, 32000, 31000],
  "100 BK": [7600, 7400, 7200, 7000, 6800, 6600],
  "100 BR": [8600, 8400, 8200, 8000, 7800, 7600],
  "100 FL": [7800, 7600, 7400, 7200, 7000, 6800],
  "200 IM": [16000, 15600, 15200, 14800, 14400, 14000],
};
const DATA = { edition: "test", levels: ["B", "BB", "A", "AA", "AAA", "AAAA"], standards: { girls: { "13-14": { SCY } } } };
const STD = { data: DATA, gender: "girls", ageGroup: "13-14" };

const swim = (distance, stroke, swimTime, courseCode = "SCY") => ({
  strokeName: stroke,
  distance,
  courseCode,
  swimTime,
});

// --- the continuous ladder ---------------------------------------------------

check("a rung anchors exactly on each published cut", () => {
  const cuts = SCY["50 FR"];
  assert.equal(rung(cuts[0], cuts), 0); // exactly B
  assert.equal(rung(cuts[3], cuts), 3); // exactly AA
  assert.equal(rung(cuts[5], cuts), 5); // exactly AAAA
});

check("a rung interpolates between cuts", () => {
  const cuts = SCY["50 FR"];
  assert.equal(rung(2850, cuts), 1.5); // halfway BB → A
});

check("slower than B is negative, faster than AAAA is past 5", () => {
  const cuts = SCY["50 FR"];
  assert.ok(rung(3100, cuts) < 0);
  assert.ok(rung(2400, cuts) > 5);
});

check("a rung rises as the time falls", () => {
  const cuts = SCY["100 BK"];
  let prev = -Infinity;
  for (const t of [7800, 7600, 7300, 7000, 6700, 6600, 6400]) {
    const r = rung(t, cuts);
    assert.ok(r > prev, `rung did not rise at ${t}`);
    prev = r;
  }
});

check("rung labels read as standards", () => {
  assert.equal(rungLabel(0), "B");
  assert.equal(rungLabel(1.9), "BB");
  assert.equal(rungLabel(3.2), "AA");
  assert.equal(rungLabel(-0.4), "under B");
  assert.equal(rungLabel(null), "—");
});

// --- what counts as evidence -------------------------------------------------

check("only real swims enter the profile", () => {
  // One yards swim and one meters swim. Asked about SCY, the meters swim would
  // only appear as a conversion — and a conversion can never drive advice.
  const groups = groupBestTimes([swim(50, "Freestyle", "27.50"), swim(100, "Backstroke", "1:12.00", "SCM")]);
  const p = profile(groups, STD, "SCY");
  assert.equal(p.length, 1);
  assert.equal(p[0].stroke, "Freestyle");
});

check("events with no published standard are skipped", () => {
  const groups = groupBestTimes([swim(1650, "Freestyle", "20:00.00")]);
  assert.equal(profile(groups, STD, "SCY").length, 0);
});

// --- readiness ---------------------------------------------------------------

const FULL = [
  swim(50, "Freestyle", "27.50"),
  swim(100, "Freestyle", "1:00.50"),
  swim(500, "Freestyle", "5:30.60"),
  swim(100, "Backstroke", "1:10.00"),
  swim(100, "Breaststroke", "1:27.00"),
  swim(100, "Butterfly", "1:12.00"),
  swim(200, "Individual Medley", "2:28.00"),
];
const fullGroups = groupBestTimes(FULL);

check("no gender means no advice, and it says so", () => {
  const r = advise(fullGroups, { data: DATA, gender: null, ageGroup: "13-14" }, "SCY");
  assert.equal(r.ready, false);
  assert.equal(r.reason, "no-standards");
  assert.deepEqual(r.findings, []);
});

check("too few measurable swims means no advice", () => {
  const r = advise(groupBestTimes([swim(50, "Freestyle", "27.50")]), STD, "SCY");
  assert.equal(r.ready, false);
  assert.equal(r.reason, "thin");
  assert.equal(r.have, 1);
});

check("a full set produces ranked findings", () => {
  const r = advise(fullGroups, STD, "SCY");
  assert.equal(r.ready, true);
  assert.ok(r.findings.length > 0);
  assert.ok(r.findings.length <= 3, "default limit is three");
});

check("findings are ordered by weight, descending", () => {
  const { findings } = advise(fullGroups, STD, "SCY", 9);
  for (let i = 1; i < findings.length; i++) {
    assert.ok(findings[i - 1].weight >= findings[i].weight, "findings out of order");
  }
});

check("every finding carries its evidence", () => {
  for (const f of advise(fullGroups, STD, "SCY", 9).findings) {
    for (const key of ["kind", "headline", "detail", "evidence", "weight"]) {
      assert.ok(f[key] !== undefined && f[key] !== "", `${f.kind} missing ${key}`);
    }
  }
});

// --- the individual rules ----------------------------------------------------

check("quickest win ranks by percentage, not by seconds", () => {
  // 50 FR needs 0.50 s to reach AA; the 500 needs 0.60 s. In seconds the 50
  // looks closer, but 0.60 off a 5:30 is a far smaller ask than 0.50 off a 27.5.
  const groups = groupBestTimes([
    swim(50, "Freestyle", "27.50"), // AA cut 27.00 → 0.50 s, 1.8%
    swim(500, "Freestyle", "5:30.60"), // AA cut 5:30.00 → 0.60 s, 0.18%
    swim(100, "Backstroke", "1:10.00"),
    swim(100, "Butterfly", "1:12.00"),
  ]);
  const win = advise(groups, STD, "SCY", 9).findings.find((f) => f.kind === "quickest-win");
  assert.ok(win, "expected a quickest-win finding");
  assert.match(win.headline, /500 Freestyle/);
});

check("the weakest stroke is named with both averages", () => {
  const f = advise(fullGroups, STD, "SCY", 9).findings.find((k) => k.kind === "weakest-stroke");
  assert.ok(f, "expected a weakest-stroke finding");
  // 1:27.00 is slower than the 1:26.00 B cut, so breaststroke is under B.
  assert.match(f.headline, /Breaststroke/);
  assert.match(f.detail, /under B/);
  // One recorded event must not be described as an average.
  assert.match(f.detail, /sits at .* on its one recorded event/);
  assert.doesNotMatch(f.detail, /averages/);
});

check("weakest stroke stays quiet with only two strokes on record", () => {
  const groups = groupBestTimes([
    swim(50, "Freestyle", "27.50"),
    swim(100, "Freestyle", "1:00.50"),
    swim(100, "Backstroke", "1:10.00"),
    swim(500, "Freestyle", "5:30.60"),
  ]);
  const f = advise(groups, STD, "SCY", 9).findings.find((k) => k.kind === "weakest-stroke");
  assert.equal(f, undefined, "two strokes says what he raced, not what he is weak at");
});

check("weakest stroke stays quiet when the strokes are level", () => {
  // All four at roughly the same rung.
  const groups = groupBestTimes([
    swim(100, "Freestyle", "1:00.00"),
    swim(100, "Backstroke", "1:10.00"),
    swim(100, "Breaststroke", "1:20.00"),
    swim(100, "Butterfly", "1:12.00"),
  ]);
  const f = advise(groups, STD, "SCY", 9).findings.find((k) => k.kind === "weakest-stroke");
  assert.equal(f, undefined);
});

check("never-raced counts against the published set", () => {
  // Five of the seven published SCY events raced: no 500 FR, no 200 IM.
  const groups = groupBestTimes([
    swim(50, "Freestyle", "27.50"),
    swim(100, "Freestyle", "1:00.50"),
    swim(100, "Backstroke", "1:10.00"),
    swim(100, "Breaststroke", "1:27.00"),
    swim(100, "Butterfly", "1:12.00"),
  ]);
  const f = advise(groups, STD, "SCY", 9).findings.find((k) => k.kind === "never-raced");
  assert.ok(f, "expected a never-raced finding");
  assert.equal(f.evidence, "5 of 7 raced");
  assert.match(f.headline, /^2 published events/);
});

check("never-raced is absent once every published event is raced", () => {
  const every = groupBestTimes([
    swim(50, "Freestyle", "27.50"),
    swim(100, "Freestyle", "1:00.50"),
    swim(500, "Freestyle", "5:30.60"),
    swim(100, "Backstroke", "1:10.00"),
    swim(100, "Breaststroke", "1:27.00"),
    swim(100, "Butterfly", "1:12.00"),
    swim(200, "Individual Medley", "2:28.00"),
  ]);
  const f = advise(every, STD, "SCY", 9).findings.find((k) => k.kind === "never-raced");
  assert.equal(f, undefined);
});

check("an unraced event is framed as unknown, not as a weakness", () => {
  const groups = groupBestTimes([
    swim(50, "Freestyle", "27.50"),
    swim(100, "Freestyle", "1:00.50"),
    swim(100, "Backstroke", "1:10.00"),
    swim(100, "Breaststroke", "1:27.00"),
    swim(100, "Butterfly", "1:12.00"),
  ]);
  const f = advise(groups, STD, "SCY", 9).findings.find((k) => k.kind === "never-raced");
  assert.ok(f);
  assert.match(f.detail, /unknown, not a weakness/);
});

check("the IM is compared against the four strokes", () => {
  // Strokes around AA, IM deliberately slower than its B cut.
  const groups = groupBestTimes([
    swim(100, "Freestyle", "1:00.00"),
    swim(100, "Backstroke", "1:10.00"),
    swim(100, "Breaststroke", "1:20.00"),
    swim(100, "Butterfly", "1:12.00"),
    swim(200, "Individual Medley", "2:41.00"),
  ]);
  const f = advise(groups, STD, "SCY", 9).findings.find((k) => k.kind === "im-balance");
  assert.ok(f, "expected an im-balance finding");
  assert.match(f.headline, /trails the individual strokes/);
});

check("a strong IM is reported as a strength, not a problem", () => {
  const groups = groupBestTimes([
    swim(100, "Freestyle", "1:05.00"),
    swim(100, "Backstroke", "1:15.00"),
    swim(100, "Breaststroke", "1:25.00"),
    swim(100, "Butterfly", "1:17.00"),
    swim(200, "Individual Medley", "2:20.00"),
  ]);
  const f = advise(groups, STD, "SCY", 9).findings.find((k) => k.kind === "im-balance");
  assert.ok(f);
  assert.match(f.headline, /ahead of the individual strokes/);
  assert.match(f.detail, /base to build on/);
});

check("range profile needs two events on each side of 100", () => {
  const groups = groupBestTimes([
    swim(50, "Freestyle", "27.50"),
    swim(100, "Freestyle", "1:00.50"),
    swim(100, "Backstroke", "1:10.00"),
    swim(100, "Butterfly", "1:12.00"),
  ]);
  const f = advise(groups, STD, "SCY", 9).findings.find((k) => k.kind === "range");
  assert.equal(f, undefined, "no 200+ events, so no range claim");
});

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
