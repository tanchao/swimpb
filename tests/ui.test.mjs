// Run: node tests/ui.test.mjs
//
// ui.js renders to strings, so the table logic is testable without a browser.
// Uses the same real fixture as the conversion tests.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  bestTimesTable,
  courseToggle,
  groupBestTimes,
  pinnedBar,
  swimmerList,
} from "../app/ui.js";

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

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/ledecky-best-times.json", import.meta.url)),
);
const groups = groupBestTimes(fixture);

check("groups into the five strokes", () => assert.equal(groups.length, 5));

check("freestyle order puts free first", () => assert.equal(groups[0].stroke, "Freestyle"));

check("distance free shares one row across courses", () => {
  const row = groups[0].rows.find((r) => r.distance === 500);
  assert.ok(row, "no 500 free row");
  // 500 yd, 400 SCM and 400 LCM are the same event in three pools.
  assert.deepEqual(Object.keys(row.actual).sort(), ["LCM", "SCM", "SCY"]);
  assert.equal(row.actual.SCY.distance, 500);
  assert.equal(row.actual.LCM.distance, 400);
});

check("no duplicate 400/500 rows", () => {
  const dists = groups[0].rows.map((r) => r.distance);
  assert.deepEqual(dists, [50, 100, 200, 500, 1000, 1650]);
});

check("renders every real time as actual", () => {
  const html = bestTimesTable(groups, "SCY");
  assert.equal((html.match(/class="t actual"/g) ?? []).length, fixture.length);
});

check("fills gaps with labelled estimates", () => {
  const html = bestTimesTable(groups, "SCY");
  const conv = html.match(/class="t converted"/g) ?? [];
  assert.ok(conv.length > 0, "expected some conversions");
  assert.ok(html.includes("~"), "converted times must be marked with ~");
  assert.ok(html.includes("Not an official time"), "must disclaim converted times");
});

check("column order is stable regardless of selection", () => {
  // Reordering columns on toggle made the number you were reading jump
  // sideways; the selected course is highlighted in place instead.
  for (const course of ["SCY", "SCM", "LCM"]) {
    const heads = [
      ...bestTimesTable(groups, course).matchAll(/(Yards|Short Meters|Long Meters)<span/g),
    ].map((m) => m[1]);
    assert.deepEqual(heads, ["Yards", "Short Meters", "Long Meters"]);
  }
});

check("exactly one column is marked primary, and it is the selected one", () => {
  for (const course of ["SCY", "SCM", "LCM"]) {
    const html = bestTimesTable(groups, course);
    const heads = [...html.matchAll(/<th class="c( primary)?" data-course="(\w+)"/g)];
    const primary = heads.filter((m) => m[1]);
    assert.equal(primary.length, 1, `${course}: expected one primary header`);
    assert.equal(primary[0][2], course);
    // Every body row must mark the same column, so the band is continuous.
    const rows = html.match(/<tr class="ev-row"/g) ?? [];
    assert.equal((html.match(/class="c cell primary"/g) ?? []).length, rows.length);
  }
});

check("renders as a single table, not one per stroke", () => {
  const html = bestTimesTable(groups, "SCY");
  assert.equal((html.match(/<table/g) ?? []).length, 1);
  assert.equal((html.match(/<thead/g) ?? []).length, 1);
  assert.equal((html.match(/<tr class="grp"/g) ?? []).length, 5, "5 stroke group rows");
});

check("never clips — the table lives in a scrollable wrapper", () => {
  assert.ok(bestTimesTable(groups, "SCY").includes('class="pb-wrap"'));
});

check("cross-course distance is stated once in the event label", () => {
  const html = bestTimesTable(groups, "SCY");
  assert.ok(html.includes("/ 400 m"), "500 free should note its 400 m counterpart");
  // Once per row, not once per meters cell.
  assert.equal((html.match(/\/ 400 m/g) ?? []).length, 1);
});

check("relay lead-off flag survives to the markup", () => {
  // The fixture's 50 free SCY is "22.64r".
  assert.ok(bestTimesTable(groups, "SCY").includes('<sup class="flag"'));
});

check("escapes hostile strings", () => {
  const html = swimmerList([
    {
      memberId: "x",
      fullName: '<img src=x onerror=alert(1)>',
      clubName: '"><script>bad()</script>',
      lscCode: "IL",
      swimmerAge: 12,
    },
  ]);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
});

check("empty states", () => {
  assert.ok(bestTimesTable([], "SCY").includes("No times on record"));
  assert.ok(swimmerList([]).includes("No swimmers matched"));
  assert.equal(swimmerList(null), "");
  assert.equal(pinnedBar([], null), "");
});

check("course toggle marks exactly one active", () => {
  assert.equal((courseToggle("SCM").match(/course-btn on/g) ?? []).length, 1);
});

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
