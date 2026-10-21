// Run: node tests/ui.test.mjs
//
// ui.js renders to strings, so the table logic is testable without a browser.
// Uses the same real fixture as the conversion tests.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  DEFAULT_COLS,
  advicePanel,
  bestTimesTable,
  columnToggleBar,
  courseToggle,
  inferGender,
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
const REGIONAL_DATA = {
  meets: [
    { id: "agi", label: "AGI", edition: "test", source: "https://example.com/agi" },
    { id: "champs", label: "Champs", edition: "test", source: "https://example.com/champs" },
  ],
  standards: {
    agi: { girls: { "15O": { SCY: { "50 FR": 2300 } } } },
    champs: { girls: { "17-18": { SCY: { "50 FR": 2200 } } } },
  },
};

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

check("selected real time shows meet qualification and exact gap", () => {
  const html = bestTimesTable(oneEvent, "SCY", { ...STD, regional: REGIONAL_DATA });
  assert.match(html, /qual met[^>]*[^]*AGI[^]*✓/, "22.64 qualifies for the 23.00 AGI cut");
  assert.match(html, /Champs[^]*−0\.64/, "22.64 is 0.64 off the 22.00 Champs cut");
});

check("meet qualification never uses a converted time", () => {
  const html = bestTimesTable(oneEvent, "LCM", { ...STD, regional: REGIONAL_DATA });
  assert.ok(!html.includes('class="quals"'));
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

check("standards bar names meet editions and unpublished Regionals", () => {
  const html = standardsBar({
    gender: "girls",
    ageGroup: "13-14",
    autoGroup: "13-14",
    age: 13,
    edition: "test",
    ready: true,
    regional: {
      meets: [{ label: "AGI", edition: "2026-27", source: "https://example.com/agi" }],
      unavailable: [{ label: "NW Regionals", edition: "2027", reason: "Cuts not published by PNS" }],
    },
  });
  assert.ok(html.includes("AGI 2026-27"));
  assert.ok(html.includes("NW Regionals 2027 — Cuts not published by PNS"));
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

check("the password and paste fields are masked", () => {
  const html = sessionBar({ signedIn: false, needsSession: true });
  assert.match(html, /id="login-user"[^>]*type="text"/);
  assert.match(html, /id="login-pass"[^>]*type="password"/);
  assert.match(html, /id="session-paste"[^>]*type="password"/);
  assert.match(html, /autocomplete="off"/);
});

check("it explains how credentials are used and keeps cURL fallback", () => {
  const html = sessionBar({ signedIn: false, needsSession: true });
  assert.ok(html.includes("never stored"));
  assert.ok(html.includes("Copy as cURL"), "should keep the devtools cURL fallback");
});

check("busy state disables inputs while signing in", () => {
  const html = sessionBar({ signedIn: false, needsSession: true, busy: true });
  assert.ok(html.includes("Signing in…"));
  assert.match(html, /id="login-pass"[^>]*disabled/);
});

check("a parse failure is shown and escaped", () => {
  const html = sessionBar({ signedIn: false, error: "<script>bad()</script> nope" });
  assert.ok(html.includes("signin-err"));
  assert.ok(!html.includes("<script>"));
});

// --- enriched consolidated table & column toggles --------------------------

const enrichedGroups = groupBestTimes(
  [{ strokeName: "Freestyle", distance: 50, courseCode: "SCY", swimTime: "22.64", swimDate: "2026-09-27T00:00:00" }],
  [
    {
      eventCode: "50 FR SCY",
      courseCode: "SCY",
      swimTime: "22.64",
      swimDate: "2026-09-27T00:00:00",
      swimmerAge: 17,
      powerPoints: 612,
      timeStandard: "AA",
      meetName: "2026 PN IST Sockeye Sprints",
    },
    {
      eventCode: "50 FR SCY",
      courseCode: "SCY",
      swimTime: "23.14",
      swimDate: "2026-03-29T00:00:00",
      swimmerAge: 17,
      powerPoints: 580,
      timeStandard: "A",
      meetName: "2026 PN Spring Showdown",
    },
  ],
);

check("a yards swim that the best-times feed has not listed yet is still shown", () => {
  const groups = groupBestTimes(
    [{ strokeName: "Individual Medley", distance: 200, courseCode: "LCM", swimTime: "3:39.07", swimDate: "2026-06-13T00:00:00" }],
    [
      {
        eventCode: "200 IM LCM",
        courseCode: "LCM",
        swimTime: "3:39.07",
        swimDate: "2026-06-13T00:00:00",
        swimmerAge: 9,
        meetName: "2026 PN IST June Invitational",
      },
      {
        eventCode: "200 IM SCY",
        courseCode: "SCY",
        swimTime: "3:11.60",
        swimDate: "2026-10-17T00:00:00",
        swimmerAge: 9,
        meetName: "2026 PN IST Fall Open",
      },
      {
        eventCode: "500 FR SCY",
        courseCode: "SCY",
        swimTime: "7:46.22",
        swimDate: "2026-10-17T00:00:00",
        swimmerAge: 9,
        meetName: "2026 PN IST Fall Open",
      },
    ],
  );
  const im = groups.find((g) => g.stroke === "Individual Medley").rows.find((r) => r.distance === 200);
  assert.equal(im.actual.SCY.raw, "3:11.60");
  assert.equal(im.actual.SCY.age, 9);
  assert.equal(im.actual.LCM.raw, "3:39.07");
  const free = groups.find((g) => g.stroke === "Freestyle").rows.find((r) => r.distance === 500);
  assert.equal(free.actual.SCY.raw, "7:46.22");
});

check("a faster swim in the history replaces a lagging best-times record", () => {
  const groups = groupBestTimes(
    [{ strokeName: "Butterfly", distance: 100, courseCode: "SCY", swimTime: "1:35.53", swimDate: "2026-01-24T00:00:00" }],
    [
      {
        eventCode: "100 FL SCY",
        courseCode: "SCY",
        swimTime: "1:35.53",
        swimDate: "2026-01-24T00:00:00",
        swimmerAge: 8,
        powerPoints: 300,
        meetName: "2026 PN IST January Invitational",
      },
      {
        eventCode: "100 FL SCY",
        courseCode: "SCY",
        swimTime: "1:32.06",
        swimDate: "2026-10-18T00:00:00",
        swimmerAge: 9,
        powerPoints: 353,
        meetName: "2026 PN IST Fall Open",
      },
    ],
  );
  const cell = groups[0].rows[0].actual.SCY;
  assert.equal(cell.raw, "1:32.06");
  assert.equal(cell.age, 9);
  assert.equal(cell.swimDate, "2026-10-18T00:00:00");
  assert.equal(cell.meetName, "2026 PN IST Fall Open");
  assert.equal(cell.powerPoints, 353);
  assert.equal(cell.swims, 2);
});

check("default columns show Team, LSC, Age, Pts, B–AAAA, and Meet Cuts", () => {
  const html = bestTimesTable(enrichedGroups, "SCY", { ...STD, regional: REGIONAL_DATA }, DEFAULT_COLS);
  assert.ok(!html.includes("26-09-27"), "date is off by default");
  assert.ok(html.includes(">17<"), "expected age at swim");
  assert.ok(html.includes(">612<"), "expected power points");
  assert.ok(html.includes('class="cut-bar"'), "expected motivational & meet cut progress bars");
  assert.ok(!html.includes("Short Meters"), "only active course column is shown");
  assert.ok(!html.includes("IST Sockeye Sprints"), "meet column off by default");
  assert.ok(!html.includes('data-toggle-col="zone"'), "zone rank is off by default");
  assert.ok(!html.includes('data-toggle-col="us"'), "US rank is off by default");
  assert.ok(!html.includes('data-toggle-col="drop"'), "drop column removed");
  assert.ok(!html.includes('data-toggle-col="count"'), "swims count column removed");
  const thead = /<thead>([\s\S]*?)<\/thead>/.exec(html)?.[1] ?? "";
  assert.ok(
    thead.indexOf('data-toggle-col="team"') < thead.indexOf('data-toggle-col="lsc"') &&
      thead.indexOf('data-toggle-col="lsc"') < thead.indexOf('data-toggle-col="age"') &&
      thead.indexOf('data-toggle-col="age"') < thead.indexOf('data-toggle-col="pts"') &&
      thead.indexOf('data-toggle-col="pts"') < thead.indexOf('data-toggle-col="mot"') &&
      thead.indexOf('data-toggle-col="mot"') < thead.indexOf('data-toggle-col="meets"') &&
      !thead.includes('data-toggle-col="date"'),
    "Team and LSC sit before Age, and Date is off",
  );
});

check("Date sits after Meet Cuts and Meet sits after Date when both are on", () => {
  const allOn = { ...DEFAULT_COLS, date: true, meet: true };
  const html = bestTimesTable(enrichedGroups, "SCY", { ...STD, regional: REGIONAL_DATA }, allOn);
  assert.ok(html.includes("26-09-27"), "expected short swim date");
  assert.ok(html.includes("IST Sockeye Sprints"), "expected shortened meet name");
  const thead = /<thead>([\s\S]*?)<\/thead>/.exec(html)?.[1] ?? "";
  assert.ok(
    thead.indexOf("Champs") < thead.indexOf('data-toggle-col="date"') &&
      thead.indexOf('data-toggle-col="date"') < thead.indexOf('data-toggle-col="meet"'),
    "Date must sit right before Meet at the end of the table",
  );
});

check("toggling columns off excludes them from the table", () => {
  const cols = { ...DEFAULT_COLS, mot: false, meets: false };
  const html = bestTimesTable(enrichedGroups, "SCY", { ...STD, regional: REGIONAL_DATA }, cols);
  assert.ok(!html.includes('data-toggle-col="mot"'), "motivational cut columns should be hidden");
  assert.ok(!html.includes('data-toggle-col="meets"'), "meet cut columns should be hidden");
  assert.ok(!html.includes("26-09-27"), "date stays off by default");
});

check("column toggle bar matches table order andstandardsBar includes course toggle", () => {
  const html = columnToggleBar(DEFAULT_COLS);
  const keys = [...html.matchAll(/data-toggle-col="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ["team", "lsc", "zone", "us", "age", "pts", "mot", "meets", "date", "meet"]);
  assert.match(html, /class="col-pill on"[^>]*data-toggle-col="team"/);
  assert.match(html, /class="col-pill on"[^>]*data-toggle-col="lsc"/);
  assert.match(html, /class="col-pill off"[^>]*data-toggle-col="zone"/);
  assert.match(html, /class="col-pill off"[^>]*data-toggle-col="us"/);
  assert.match(html, /class="col-pill off"[^>]*data-toggle-col="date"/);
  assert.match(html, /class="col-pill off"[^>]*data-toggle-col="meet"/);

  const stdHtml = standardsBar({
    course: "LCM",
    gender: "boys",
    ageGroup: "10U",
    autoGroup: "10U",
    age: 9,
    edition: "2024-2028",
    ready: true,
    cols: DEFAULT_COLS,
  });
  assert.match(stdHtml, /class="course-btn on"[^>]*data-course="LCM"/, "course toggle in standardsBar highlights LCM");
});

check("team and LSC ranks sit next to the time and open that event", () => {
  const html = bestTimesTable(
    enrichedGroups,
    "SCY",
    { ...STD, regional: REGIONAL_DATA },
    DEFAULT_COLS,
    null,
    {
      "Freestyle|50": {
        team: { text: "2", title: "IST #2 of 9", scope: "club", kind: "rank" },
        lsc: { text: "16", title: "PN #16", scope: "lsc", kind: "rank" },
      },
    },
  );
  const thead = /<thead>([\s\S]*?)<\/thead>/.exec(html)?.[1] ?? "";
  assert.ok(
    thead.indexOf('data-toggle-col="team"') !== -1 &&
      thead.indexOf('data-toggle-col="team"') < thead.indexOf('data-toggle-col="lsc"') &&
      thead.indexOf('data-toggle-col="lsc"') < thead.indexOf('data-toggle-col="age"'),
    "Team and LSC sit immediately after the time",
  );
  assert.match(html, /data-rank-col="team"[^>]*>2</);
  assert.match(html, /data-rank-col="lsc"[^>]*>16</);
  assert.match(html, /data-rank-cell="Freestyle\|50"/);
  assert.match(html, /data-rank-scope="club"/);
  assert.match(html, /data-rank-scope="lsc"/);
  const hidden = bestTimesTable(enrichedGroups, "SCY", null, {
    ...DEFAULT_COLS,
    team: false,
    lsc: false,
  });
  assert.ok(!hidden.includes("data-rank-open"), "the columns can be turned off");

  const extra = bestTimesTable(enrichedGroups, "SCY", null, { ...DEFAULT_COLS, zone: true, us: true });
  assert.match(extra, /data-toggle-col="zone"/);
  assert.match(extra, /data-toggle-col="us"/);
});

check("inferGender detects gender from official timeStandard labels", () => {
  const stdData = {
    levels: ["B", "BB", "A", "AA", "AAA", "AAAA"],
    standards: {
      girls: { "10U": { SCY: { "50 FR": [3979, 3599, 3209, 3089, 2959, 2829] } } },
      boys: { "10U": { SCY: { "50 FR": [3819, 3459, 3109, 2989, 2869, 2749] } } },
    },
  };
  // 39.33 is B for girls (<= 39.79) but Slower Than B for boys (> 38.19).
  assert.equal(
    inferGender([{ eventCode: "50 FR SCY", courseCode: "SCY", swimTime: "39.33", swimmerAge: 9, timeStandard: "Slower Than B" }], stdData),
    "boys",
  );
  assert.equal(
    inferGender([{ eventCode: "50 FR SCY", courseCode: "SCY", swimTime: "39.33", swimmerAge: 9, timeStandard: "B" }], stdData),
    "girls",
  );
});

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
