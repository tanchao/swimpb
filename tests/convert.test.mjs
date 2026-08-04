// Run: node tests/convert.test.mjs
//
// Validates the time parser and the course-conversion model. The interesting
// part is the last section: Katie Ledecky's public best times include 17 events
// she has raced in more than one course, which gives real ground truth to check
// the conversion factors against.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { convert, mapDistance } from "../app/convert.js";
import { formatTime, parseTime } from "../app/time.js";

let pass = 0;
const fails = [];

function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fails.push(`${name}: ${err.message}`);
  }
}

// --- time parsing -----------------------------------------------------------

check("parses seconds-only", () => assert.equal(parseTime("22.64").hundredths, 2264));
check("parses mm:ss", () => assert.equal(parseTime("1:01.61").hundredths, 6161));
check("parses long times", () => assert.equal(parseTime("16:22.05").hundredths, 98205));
check("captures relay flag", () => {
  const t = parseTime("22.64r");
  assert.equal(t.hundredths, 2264);
  assert.equal(t.flag, "r");
});
check("rejects junk", () => assert.equal(parseTime("DQ").hundredths, null));
check("handles non-strings", () => assert.equal(parseTime(null).hundredths, null));

check("formats sub-minute", () => assert.equal(formatTime(2264), "22.64"));
check("formats over a minute", () => assert.equal(formatTime(6161), "1:01.61"));
check("pads seconds", () => assert.equal(formatTime(6005), "1:00.05"));
check("formats distance times", () => assert.equal(formatTime(98205), "16:22.05"));
check("formats null", () => assert.equal(formatTime(null), "—"));

check("round-trips every fixture time", () => {
  for (const h of [2264, 6161, 98205, 3000, 5999, 100]) {
    assert.equal(parseTime(formatTime(h)).hundredths, h);
  }
});

// --- documented factor values ----------------------------------------------
// Straight from the published Colorado Swimming set.

check("SCY→SCM is the pool-length factor only", () =>
  assert.equal(convert(10000, 100, "Freestyle", "SCY", "SCM"), Math.round(100 * 1.11 * 100)));

check("100 free SCY→LCM adds 1.6 s of turns", () =>
  assert.equal(convert(10000, 100, "Freestyle", "SCY", "LCM"), Math.round((100 * 1.11 + 1.6) * 100)));

check("200 breast SCY→LCM adds 4.0 s", () =>
  assert.equal(convert(10000, 200, "Breaststroke", "SCY", "LCM"), Math.round((100 * 1.11 + 4.0) * 100)));

check("200 fly turn increment is the consistent 2.8, not the source table's 2.6", () =>
  assert.equal(convert(10000, 200, "Butterfly", "SCM", "LCM"), Math.round((100 + 2.8) * 100)));

check("400 IM adds 6.4 s", () =>
  assert.equal(convert(30000, 400, "Individual Medley", "SCM", "LCM"), Math.round((300 + 6.4) * 100)));

check("500 free SCY→LCM uses the distance ratio, not length+turns", () =>
  assert.equal(convert(30000, 500, "Freestyle", "SCY", "LCM"), Math.round(300 * 0.8925 * 100)));

check("1650 free SCY→LCM uses its own ratio", () =>
  assert.equal(convert(100000, 1650, "Freestyle", "SCY", "LCM"), Math.round(1000 * 1.02 * 100)));

check("identity conversion is exact", () =>
  assert.equal(convert(5432, 100, "Freestyle", "SCY", "SCY"), 5432));

check("nonsense course returns null", () =>
  assert.equal(convert(5432, 100, "Freestyle", "SCY", "XXX"), null));

check("unknown stroke returns null where turns matter", () =>
  assert.equal(convert(5432, 100, "Sidestroke", "SCM", "LCM"), null));

check("never returns a negative time", () =>
  assert.equal(convert(50, 200, "Breaststroke", "LCM", "SCM"), null));

// --- invertibility ----------------------------------------------------------

check("every conversion round-trips within a hundredth", () => {
  const courses = ["SCY", "SCM", "LCM"];
  const cases = [
    [100, "Freestyle"], [200, "Freestyle"], [50, "Backstroke"], [200, "Backstroke"],
    [100, "Breaststroke"], [200, "Butterfly"], [200, "Individual Medley"],
    [400, "Individual Medley"],
  ];
  for (const [dist, stroke] of cases) {
    for (const a of courses) {
      for (const b of courses) {
        const start = 15000;
        const there = convert(start, dist, stroke, a, b);
        if (there === null) continue;
        const backDist = mapDistance(dist, stroke, a, b);
        const back = convert(there, backDist, stroke, b, a);
        assert.ok(
          back !== null && Math.abs(back - start) <= 1,
          `${dist} ${stroke} ${a}→${b}→${a} drifted: ${start} → ${there} → ${back}`,
        );
      }
    }
  }
});

// --- distance mapping -------------------------------------------------------

check("500 yd free maps to 400 m", () =>
  assert.equal(mapDistance(500, "Freestyle", "SCY", "LCM"), 400));
check("1650 yd free maps to 1500 m", () =>
  assert.equal(mapDistance(1650, "Freestyle", "SCY", "LCM"), 1500));
check("400 m free maps back to 500 yd", () =>
  assert.equal(mapDistance(400, "Freestyle", "LCM", "SCY"), 500));
check("100 back keeps its distance", () =>
  assert.equal(mapDistance(100, "Backstroke", "SCY", "LCM"), 100));
check("SCM↔LCM never remaps distance", () =>
  assert.equal(mapDistance(400, "Freestyle", "SCM", "LCM"), 400));

// --- accuracy against real multi-course swims -------------------------------
// Informational, with a loose guard. Course conversion is an approximation and
// an athlete is genuinely stronger in one course than another, so we assert only
// that the model is in the right ballpark — a large error here means a bug in
// the formula, not a slow swim.

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/ledecky-best-times.json", import.meta.url)),
);

const byEvent = new Map();
for (const r of fixture) {
  const key = `${r.strokeName}|${r.distance}`;
  if (!byEvent.has(key)) byEvent.set(key, {});
  byEvent.get(key)[r.courseCode] = parseTime(r.swimTime).hundredths;
}

const errors = [];
for (const [key, courses] of byEvent) {
  const [stroke, distStr] = key.split("|");
  const distance = Number(distStr);
  for (const from of Object.keys(courses)) {
    for (const to of Object.keys(courses)) {
      if (from === to) continue;
      const predicted = convert(courses[from], distance, stroke, from, to);
      if (predicted === null) continue;
      const actual = courses[to];
      errors.push({
        event: `${distance} ${stroke} ${from}→${to}`,
        pct: ((predicted - actual) / actual) * 100,
      });
    }
  }
}

const absPcts = errors.map((e) => Math.abs(e.pct)).sort((a, b) => a - b);
const median = absPcts[Math.floor(absPcts.length / 2)];
const worst = errors.reduce((a, b) => (Math.abs(b.pct) > Math.abs(a.pct) ? b : a));

check(`median conversion error is small (got ${median.toFixed(2)}%)`, () =>
  assert.ok(median < 4, `median error ${median.toFixed(2)}% suggests a formula bug`));

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);

console.log(`\nConversion accuracy vs ${errors.length} real multi-course swims (Ledecky):`);
console.log(`  median |error|  ${median.toFixed(2)}%`);
console.log(`  worst           ${worst.event}  ${worst.pct > 0 ? "+" : ""}${worst.pct.toFixed(2)}%`);
console.log("  (positive = model predicts slower than she actually swam)\n");

process.exit(fails.length ? 1 : 0);
