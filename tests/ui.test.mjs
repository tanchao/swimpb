// Run: node tests/ui.test.mjs
//
// ui.js renders to strings, so the table logic is testable without a browser.
// Uses the same real fixture as the conversion tests.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  advicePanel,
  bestTimesTable,
  courseToggle,
  sessionBar,
  groupBestTimes,
  pinnedBar,
  standardsBar,
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

// --- motivational standards -------------------------------------------------
// A synthetic ladder, so the assertions don't depend on which edition of the
// real table happens to be checked in.

const CUTS_50 = [2600, 2500, 2400, 2300, 2200, 2100]; // fixture's 50 FR SCY is 22.64r
const STD_DATA = {
  edition: "test",
  levels: ["B", "BB", "A", "AA", "AAA", "AAAA"],
  standards: {
    girls: { "17-18": { SCY: { "50 FR": CUTS_50 }, LCM: { "50 FR": CUTS_50 } } },
  },
};
const STD = { data: STD_DATA, gender: "girls", ageGroup: "17-18" };

// One event, raced in yards only, so the meters columns must be conversions.
const oneEvent = groupBestTimes([
  { strokeName: "Freestyle", distance: 50, courseCode: "SCY", swimTime: "22.64" },
]);

check("no chips until a gender is chosen", () => {
  // The public API has no gender field, so guessing would be both unreliable
  // and wrong to do — the board simply shows no standards.
  const html = bestTimesTable(oneEvent, "SCY", { data: STD_DATA, gender: null, ageGroup: "17-18" });
  assert.ok(!html.includes('class="lvl'));
  assert.ok(!html.includes('class="gap'));
});

check("no chips without standards data", () =>
  assert.ok(!bestTimesTable(oneEvent, "SCY", null).includes('class="lvl')));

check("an actual time gets the level it reached", () => {
  const html = bestTimesTable(oneEvent, "SCY", STD);
  // 22.64 beats AA (23.00) but not AAA (22.00).
  assert.ok(html.includes(">AA</span>"), "expected an AA chip");
  assert.equal((html.match(/class="lvl lvl-aa"/g) ?? []).length, 1);
});

check("a converted estimate never gets a chip", () => {
  // Only a real swim can achieve a standard. LCM here is an estimate, and the
  // synthetic table does define an LCM 50 FR cut, so a chip would appear if the
  // rule were not enforced.
  const html = bestTimesTable(oneEvent, "SCY", STD);
  assert.equal((html.match(/class="t converted"/g) ?? []).length, 2, "expected 2 estimates");
  assert.equal((html.match(/class="lvl /g) ?? []).length, 1, "only the real swim is chipped");
});

check("the gap to the next cut appears, in the primary column only", () => {
  const html = bestTimesTable(oneEvent, "SCY", STD);
  assert.ok(html.includes(">AAA</span>"), "next rung should be AAA");
  assert.ok(html.includes("−0.64"), "22.64 is 0.64 off the 22.00 AAA cut");
  // One gap element per row, and it sits in the highlighted column. Matched
  // exactly, so the gap-lvl / gap-d spans inside it don't also count.
  assert.equal((html.match(/class="gap(?:"| )/g) ?? []).length, 1);
  const primaryCell = /<td class="c cell primary">([\s\S]*?)<\/td>/.exec(html);
  assert.ok(primaryCell && primaryCell[1].includes('class="gap'), "gap must be in the primary cell");
});

check("the gap follows the selected course", () => {
  // Selecting a course whose cell is an estimate leaves the slot empty rather
  // than offering a target derived from a time that was never swum.
  const html = bestTimesTable(oneEvent, "LCM", STD);
  assert.ok(!html.includes("−0.64"), "an estimate must not carry a target");
  assert.equal((html.match(/class="gap"><\/span>/g) ?? []).length, 1);
});

check("every primary cell reserves the gap line, so rows stay level", () => {
  const groupsAll = groupBestTimes(fixture);
  const html = bestTimesTable(groupsAll, "SCY", STD);
  const rows = (html.match(/<tr class="ev-row"/g) ?? []).length;
  assert.equal((html.match(/class="gap(?:"| )/g) ?? []).length, rows);
});

check("faster than the top rung reads AAAA with no target", () => {
  const fast = groupBestTimes([
    { strokeName: "Freestyle", distance: 50, courseCode: "SCY", swimTime: "20.00" },
  ]);
  const html = bestTimesTable(fast, "SCY", STD);
  assert.ok(html.includes("lvl-aaaa"));
  assert.ok(html.includes("AAAA ✓"));
});

check("standards bar is silent until the table has loaded", () =>
  assert.equal(standardsBar({ gender: null, ageGroup: null, ready: false }), ""));

check("standards bar asks for a gender and says why", () => {
  const html = standardsBar({ gender: null, ageGroup: "13-14", autoGroup: "13-14", age: 13, edition: "x", ready: true });
  assert.ok(html.includes("Girls") && html.includes("Boys"));
  assert.ok(!html.includes("seg-btn on"), "nothing preselected");
  assert.ok(/doesn.t say/.test(html), "should explain the API has no gender");
});

check("standards bar marks the chosen gender and offers the auto age group", () => {
  const html = standardsBar({ gender: "boys", ageGroup: "13-14", autoGroup: "13-14", age: 14, edition: "2025-2028", ready: true });
  assert.equal((html.match(/seg-btn on/g) ?? []).length, 1);
  assert.ok(html.includes("Auto — 13-14"));
  assert.ok(html.includes("2025-2028"));
});

check("standards bar explains an out-of-range age instead of going blank", () => {
  const html = standardsBar({ gender: "girls", ageGroup: null, autoGroup: null, age: 29, edition: "x", ready: true });
  assert.ok(html.includes("stop at 18"));
  assert.ok(html.includes("29"));
});

check("standards bar escapes the edition string", () => {
  const html = standardsBar({ gender: "girls", ageGroup: "13-14", autoGroup: "13-14", age: 13, edition: '<script>bad()</script>', ready: true });
  assert.ok(!html.includes("<script>"));
});

// --- focus panel ------------------------------------------------------------

check("focus panel is silent when there is no standards set", () => {
  assert.equal(advicePanel({ ready: false, reason: "no-standards", findings: [] }, "SCY", "x"), "");
  assert.equal(advicePanel(null, "SCY", "x"), "");
});

check("focus panel explains thin data instead of showing an empty box", () => {
  const html = advicePanel({ ready: false, reason: "thin", have: 2, findings: [] }, "SCM", "x");
  assert.ok(html.includes("Not enough swims"));
  assert.ok(html.includes("Short Meters"), "should name the course in words");
  assert.ok(html.includes("2 measurable"));
});

check("focus panel ranks findings and shows each one's evidence", () => {
  const html = advicePanel(
    {
      ready: true,
      findings: [
        { kind: "quickest-win", headline: "Closest cut", detail: "d1", evidence: "−0.60, 0.2% off", weight: 9 },
        { kind: "weakest-stroke", headline: "Breaststroke lags", detail: "d2", evidence: "1.4 standards behind", weight: 7 },
      ],
    },
    "SCY",
    "2024-2028",
  );
  assert.equal((html.match(/class="focus-item"/g) ?? []).length, 2);
  assert.ok(/focus-rank">1</.test(html) && /focus-rank">2</.test(html), "items are numbered");
  assert.ok(html.includes("−0.60, 0.2% off") && html.includes("1.4 standards behind"));
  assert.ok(html.includes("2024-2028"), "should name the edition it judged against");
});

check("focus panel disclaims the things it is not", () => {
  // It must never be mistaken for a power-point total, an IMX score or a rank —
  // none of which are obtainable here.
  const html = advicePanel(
    { ready: true, findings: [{ kind: "k", headline: "h", detail: "d", evidence: "e", weight: 1 }] },
    "SCY",
    "2024-2028",
  );
  assert.ok(/not<\/strong> a power-point total/.test(html));
  assert.ok(html.includes("IMX/IMR score"));
  assert.ok(html.includes("rank"));
});

check("focus panel escapes hostile findings", () => {
  const html = advicePanel(
    {
      ready: true,
      findings: [
        { kind: "<img src=x>", headline: "<script>bad()</script>", detail: '"><b>x', evidence: "<i>e", weight: 1 },
      ],
    },
    "SCY",
    "<script>y</script>",
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
});

// --- sign-in row ------------------------------------------------------------

check("signed in collapses to one line with a way out", () => {
  const html = sessionBar({ signedIn: true });
  assert.ok(html.includes("Signed in to USA Swimming"));
  assert.ok(html.includes('id="session-clear"'), "must offer sign-out");
  assert.ok(!html.includes("session-paste"), "no paste field once signed in");
});

check("signed out stays collapsed until something needs it", () => {
  const quiet = sessionBar({ signedIn: false, needsSession: false });
  assert.ok(quiet.startsWith("<details class=\"signin\">"), "should not be open");
  const asked = sessionBar({ signedIn: false, needsSession: true });
  assert.ok(asked.includes("<details class=\"signin\" open>"), "should open on demand");
  assert.ok(asked.includes("required"));
});

check("the paste field is masked, since it holds a credential", () => {
  const html = sessionBar({ signedIn: false, needsSession: true });
  assert.match(html, /id="session-paste"[^>]*type="password"/);
  assert.match(html, /autocomplete="off"/);
});

check("it explains why the page cannot log in for you", () => {
  const html = sessionBar({ signedIn: false, needsSession: true });
  assert.ok(/can’t\s+log in for you/.test(html));
  assert.ok(html.includes("never written to disk"));
  assert.ok(html.includes("Copy as cURL"), "should name the exact devtools action");
});

check("a parse failure is shown and escaped", () => {
  const html = sessionBar({ signedIn: false, error: "<script>bad()</script> nope" });
  assert.ok(html.includes("signin-err"));
  assert.ok(!html.includes("<script>"));
});

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
