// Run: node tests/history.test.mjs
//
// The age-best matrix and the meets table are two reshapes of one swim history.

import assert from "node:assert/strict";
import { ageBest, meetsByDate } from "../app/history.js";
import { groupBestTimes } from "../app/ui.js";
import { ageBestTable, meetsTable, viewTabs } from "../app/views.js";

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

// 100 FR at 11-12 and 13-14. Synthetic cuts, as in the other tests.
const CUTS = (g) => ({ "100 FR": [7000, 6600, 6200, 5800, 5400, 5000], ...g });
const DATA = {
  edition: "test",
  levels: ["B", "BB", "A", "AA", "AAA", "AAAA"],
  standards: { girls: { "11-12": { SCY: CUTS({}) }, "13-14": { SCY: CUTS({ "100 FR": [6600, 6200, 5800, 5400, 5000, 4600] }) } } },
};
const STD = { data: DATA, gender: "girls", ageGroup: "13-14" };

let nextId = 1;
const s = (event, swimTime, swimDate, swimmerAge, meetName = "Meet", meetId = null, course = "SCY") => ({
  swimTimeId: nextId++,
  meetId,
  eventCode: `${event} ${course}`,
  courseCode: course,
  swimTime,
  swimDate,
  swimmerAge,
  meetName,
});

const ABBR = { FR: "Freestyle", BK: "Backstroke" };
function build(history) {
  const best = new Map();
  for (const h of history) {
    const [dist, ab] = h.eventCode.split(" ");
    const key = `${dist}|${ab}|${h.courseCode}`;
    const t = Number(h.swimTime.split(":").reduce((a, b) => a * 60 + Number(b), 0));
    if (!best.has(key) || t < best.get(key).t) {
      best.set(key, { t, rec: { strokeName: ABBR[ab], distance: Number(dist), courseCode: h.courseCode, swimTime: h.swimTime } });
    }
  }
  return groupBestTimes([...best.values()].map((b) => b.rec), history);
}

const HISTORY = [
  s("100 FR", "1:08.00", "2023-02-01", 11, "A Meet", "m1"),
  s("100 FR", "1:06.50", "2023-03-01", 11, "B Meet", "m2"),
  s("100 FR", "1:03.00", "2024-02-01", 12, "C Meet", "m3"),
  s("100 FR", "58.00", "2026-02-01", 14, "D Meet", "m4"),
  s("100 BK", "1:12.00", "2026-02-01", 14, "D Meet", "m4"),
];
const groups = build(HISTORY);

// --- age-best ----------------------------------------------------------------

check("the fastest swim at each age is the one shown", () => {
  const { rows } = ageBest(groups, "SCY");
  const fr = rows.find((r) => r.distance === 100 && r.stroke === "Freestyle");
  assert.equal(fr.cells.get(11).hundredths, 6650);
  assert.equal(fr.cells.get(12).hundredths, 6300);
});

check("ages run newest first, with no-race years left as gaps", () => {
  assert.deepEqual(ageBest(groups, "SCY").ages, [14, 13, 12, 11]);
});

check("drop is against the previous age raced, and says how far back", () => {
  const fr = ageBest(groups, "SCY").rows.find((r) => r.stroke === "Freestyle");
  assert.equal(fr.cells.get(11).drop, null);
  assert.equal(fr.cells.get(12).drop, 6300 - 6650);
  assert.equal(fr.cells.get(12).gap, 1);
  assert.equal(fr.cells.get(14).drop, 5800 - 6300);
  assert.equal(fr.cells.get(14).gap, 2, "age 13 was skipped, so the comparison spans two years");
});

check("the standard is the one for the age group the swimmer was in then", () => {
  const fr = ageBest(groups, "SCY", STD).rows.find((r) => r.stroke === "Freestyle");
  // 1:06.50 at 11: 11-12 cuts [7000,6600,...] -> BB (6650 is slower than 6600, faster than 7000 => B)
  assert.equal(fr.cells.get(11).level, "B");
  // 58.00 at 14: 13-14 cuts [6600,6200,5800,...] -> A (5800 <= 5800 is A)
  assert.equal(fr.cells.get(14).level, "A");
});

check("no gender, no standard — but the times still show", () => {
  const fr = ageBest(groups, "SCY", { data: DATA, gender: null }).rows.find((r) => r.stroke === "Freestyle");
  assert.equal(fr.cells.get(14).level, null);
  assert.equal(fr.cells.get(14).hundredths, 5800);
});

check("swims with no age are counted, not placed", () => {
  const g = build([s("100 FR", "1:00.00", "2025-01-01", 13), s("100 FR", "1:05.00", "2025-02-01", null)]);
  const a = ageBest(g, "SCY");
  assert.equal(a.unaged, 1);
  assert.deepEqual(a.ages, [13]);
});

check("another course's swims never enter the matrix", () => {
  const g = build([s("100 FR", "1:00.00", "2025-01-01", 13, "M", null, "SCM")]);
  assert.deepEqual(ageBest(g, "SCY"), { ages: [], unaged: 0, rows: [] });
});

check("the matrix renders a row per event that opens the report, and says when there is nothing", () => {
  const html = ageBestTable(ageBest(groups, "SCY", STD), "SCY", { std: STD });
  assert.match(html, /data-stroke="Freestyle" data-distance="100" tabindex="0" aria-expanded="false"/);
  assert.match(html, /Age 14/);
  assert.match(html, /against the swim 2 years earlier/);
  assert.match(ageBestTable({ ages: [], unaged: 0, rows: [] }, "SCY"), /No swims with an age/);
});

// --- meets -------------------------------------------------------------------

check("meets come out oldest first, one per meet id", () => {
  const { meets } = meetsByDate(groups, "SCY");
  assert.deepEqual(meets.map((m) => m.name), ["A Meet", "B Meet", "C Meet", "D Meet"]);
});

check("a meet's swims are filed under their event", () => {
  const d = meetsByDate(groups, "SCY").meets.find((m) => m.name === "D Meet");
  assert.equal(d.swims, 2);
  assert.deepEqual([...d.cells.keys()].sort(), ["Backstroke|100", "Freestyle|100"]);
});

check("drop is against the previous swim of the event, whichever meet", () => {
  const { meets } = meetsByDate(groups, "SCY");
  const fr = (name) => meets.find((m) => m.name === name).cells.get("Freestyle|100")[0];
  assert.equal(fr("A Meet").drop, null);
  assert.equal(fr("B Meet").drop, 6650 - 6800);
  assert.equal(fr("D Meet").drop, 5800 - 6300);
});

check("PB marks the fastest swim to that date, and a slower later swim is not one", () => {
  const g = build([
    s("100 FR", "1:05.00", "2025-01-01", 13, "A", "a"),
    s("100 FR", "1:03.00", "2025-02-01", 13, "B", "b"),
    s("100 FR", "1:04.00", "2025-03-01", 13, "C", "c"),
  ]);
  const flags = meetsByDate(g, "SCY").meets.map((m) => m.cells.get("Freestyle|100")[0].best);
  assert.deepEqual(flags, [true, true, false]);
});

check("prelims and finals at one meet both appear, in order", () => {
  const g = build([
    s("100 FR", "1:02.00", "2025-03-01", 13, "Champs", "c"),
    s("100 FR", "1:01.00", "2025-03-02", 13, "Champs", "c"),
  ]);
  const cell = meetsByDate(g, "SCY").meets[0].cells.get("Freestyle|100");
  assert.deepEqual(cell.map((x) => x.hundredths), [6200, 6100]);
  assert.equal(cell[1].drop, -100);
});

check("undated swims are counted and left out", () => {
  const g = build([s("100 FR", "1:02.00", "2025-03-01", 13, "A", "a"), s("100 FR", "1:03.00", "never", 13, "B", "b")]);
  const d = meetsByDate(g, "SCY");
  assert.equal(d.undated, 1);
  assert.equal(d.meets.length, 1);
});

check("the table puts newest first by default, flips on request, and offers splits per time", () => {
  const d = meetsByDate(groups, "SCY");
  const names = (html) => [...html.matchAll(/class="mt-name">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(names(meetsTable(d, "SCY")), ["D Meet", "C Meet", "B Meet", "A Meet"]);
  assert.deepEqual(names(meetsTable(d, "SCY", { order: "oldest" })), ["A Meet", "B Meet", "C Meet", "D Meet"]);
  assert.equal((meetsTable(d, "SCY").match(/data-splits=/g) ?? []).length, 5);
});

check("an open swim gets a splits row under its meet, and only that one", () => {
  const d = meetsByDate(groups, "SCY");
  const id = d.meets[0].cells.get("Freestyle|100")[0].id;
  const splits = { open: { has: (x) => x === id }, get: () => ({ status: "loading" }) };
  const html = meetsTable(d, "SCY", { splits });
  assert.equal((html.match(/class="sp-row"/g) ?? []).length, 1);
  assert.match(html, /Loading lap splits/);
});

check("a swim without an id shows its time but no splits button", () => {
  const g = groupBestTimes(
    [{ strokeName: "Freestyle", distance: 100, courseCode: "SCY", swimTime: "1:00.00" }],
    [{ eventCode: "100 FR SCY", courseCode: "SCY", swimTime: "1:00.00", swimDate: "2025-01-01", swimmerAge: 13, meetName: "M" }],
  );
  const html = meetsTable(meetsByDate(g, "SCY"), "SCY");
  assert.ok(!html.includes("data-splits"));
  assert.match(html, /mt-t plain/);
});

check("hostile meet names are escaped in both tables", () => {
  const g = build([s("100 FR", "1:00.00", "2025-01-01", 13, '<img src=x onerror=alert(1)>', "x")]);
  assert.ok(!meetsTable(meetsByDate(g, "SCY"), "SCY").includes("<img"));
  assert.ok(!ageBestTable(ageBest(g, "SCY"), "SCY").includes("<img"));
});

check("the view tabs mark exactly one as selected", () => {
  const html = viewTabs("ages");
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.match(html, /data-view="ages"[^>]*aria-selected="true"/);
});

console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
