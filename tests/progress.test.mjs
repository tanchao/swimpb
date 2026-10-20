// Run: node tests/progress.test.mjs
//
// The progress report is deterministic: same swims and the same `now` in, same
// report out. Synthetic cuts keep the assertions independent of whichever
// edition of the real standards table is checked in.

import assert from "node:assert/strict";
import { adviseEvent, isoDay, parseDay, progress, seasonOf } from "../app/progress.js";
import { bestTimesTable, groupBestTimes } from "../app/ui.js";
import { eventReport, progressChart } from "../app/views.js";

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

const NOW = Date.UTC(2026, 9, 20);

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

const ABBR = { Freestyle: "FR", Backstroke: "BK", Breaststroke: "BR", Butterfly: "FL", "Individual Medley": "IM" };
const STROKE_NAME = Object.fromEntries(Object.entries(ABBR).map(([k, v]) => [v, k]));

/** One history swim, e.g. s("100 FR", "1:00.00", "2025-03-14"). */
const s = (event, swimTime, swimDate, meetName = "Test Meet", course = "SCY") => ({
  eventCode: `${event} ${course}`,
  courseCode: course,
  swimTime,
  swimDate,
  swimmerAge: 13,
  meetName,
});

/** Best-times records are derived from the history, as USA Swimming does. */
function build(history) {
  const best = new Map();
  for (const h of history) {
    const [dist, ab] = h.eventCode.split(" ");
    const [m, rest] = h.swimTime.includes(":") ? h.swimTime.split(":") : [0, h.swimTime];
    const t = Number(m) * 6000 + Math.round(Number(rest) * 100);
    const key = `${dist}|${ab}|${h.courseCode}`;
    if (!best.has(key) || t < best.get(key).t) {
      best.set(key, { t, rec: { strokeName: STROKE_NAME[ab], distance: Number(dist), courseCode: h.courseCode, swimTime: h.swimTime } });
    }
  }
  return groupBestTimes([...best.values()].map((b) => b.rec), history);
}

const find = (groups, stroke, distance) => groups.find((g) => g.stroke === stroke).rows.find((r) => r.distance === distance);

// --- dates -------------------------------------------------------------------

check("parses both documented date shapes to the same calendar day", () => {
  assert.equal(parseDay("2019-01-19T00:00:00"), Date.UTC(2019, 0, 19));
  assert.equal(parseDay("2019-01-19"), Date.UTC(2019, 0, 19));
  assert.equal(parseDay("Jan 19, 2019"), Date.UTC(2019, 0, 19));
});

check("an unreadable date is dropped, not guessed", () => {
  assert.equal(parseDay("sometime"), null);
  assert.equal(parseDay(""), null);
  assert.equal(parseDay(null), null);
});

check("seasons turn over on 1 September", () => {
  assert.equal(seasonOf(Date.UTC(2025, 7, 31)), "2024-25");
  assert.equal(seasonOf(Date.UTC(2025, 8, 1)), "2025-26");
  assert.equal(seasonOf(Date.UTC(2099, 11, 31)), "2099-00");
});

// --- progress ----------------------------------------------------------------

const FR100 = [
  s("100 FR", "1:05.00", "2023-02-10"),
  s("100 FR", "1:03.00", "2023-12-02"),
  s("100 FR", "1:03.50", "2024-02-03"),
  s("100 FR", "1:01.00", "2024-12-07"),
  s("100 FR", "1:01.40", "2025-03-01"),
];

check("a conversion is not a swim: no real swim in the course means no report", () => {
  const groups = build([s("100 FR", "1:00.00", "2025-03-01", "M", "SCM")]);
  assert.deepEqual(progress(find(groups, "Freestyle", 100), "SCY", { now: NOW }), { ready: false, reason: "no-swim" });
});

check("best times without history say so rather than inventing a progression", () => {
  const groups = groupBestTimes([{ strokeName: "Freestyle", distance: 100, courseCode: "SCY", swimTime: "1:00.00" }]);
  const p = progress(find(groups, "Freestyle", 100), "SCY", { now: NOW });
  assert.equal(p.ready, false);
  assert.equal(p.reason, "no-history");
  assert.equal(p.pb, 6000);
});

check("marks each new best and the drop it made", () => {
  const p = progress(find(build(FR100), "Freestyle", 100), "SCY", { now: NOW });
  assert.deepEqual(p.swims.map((x) => x.isBest), [true, true, false, true, false]);
  assert.deepEqual(p.swims.map((x) => x.drop), [null, 200, null, 200, null]);
  assert.equal(p.bestCount, 3);
  assert.equal(p.totalDrop, 400);
  assert.equal(p.pb, 6100);
});

check("counts the swims since the last best", () => {
  const p = progress(find(build(FR100), "Freestyle", 100), "SCY", { now: NOW });
  assert.equal(p.swimsSinceBest, 1);
  assert.equal(isoDay(p.lastBest.ms), "2024-12-07");
  assert.ok(Math.abs(p.monthsSinceBest - 22.4) < 0.3);
});

check("groups swims into seasons with the change in best", () => {
  const p = progress(find(build(FR100), "Freestyle", 100), "SCY", { now: NOW });
  assert.deepEqual(p.seasons.map((x) => [x.label, x.swims, x.best, x.change]), [
    ["2022-23", 1, 6500, null],
    ["2023-24", 2, 6300, -200],
    ["2024-25", 2, 6100, -200],
  ]);
});

check("a same-day final faster than the prelim counts as the best", () => {
  const groups = build([s("100 FR", "1:02.00", "2025-03-01"), s("100 FR", "1:01.00", "2025-03-01")]);
  const p = progress(find(groups, "Freestyle", 100), "SCY", { now: NOW });
  assert.equal(p.swims[1].hundredths, 6100);
  assert.equal(p.swims[1].isBest, true);
});

check("an undated swim is counted but kept out of the timeline", () => {
  const groups = build([s("100 FR", "1:02.00", "2025-03-01"), s("100 FR", "1:03.00", "unknown")]);
  const p = progress(find(groups, "Freestyle", 100), "SCY", { now: NOW });
  assert.equal(p.swims.length, 1);
  assert.equal(p.undated, 1);
});

check("the last-12-months drop compares against the best a year ago", () => {
  const groups = build([
    s("100 FR", "1:05.00", "2025-01-10"),
    s("100 FR", "1:02.00", "2026-03-10"),
  ]);
  const p = progress(find(groups, "Freestyle", 100), "SCY", { now: NOW });
  assert.equal(p.dropLastYear, 300);
});

// --- history rules (no standards needed) -------------------------------------

check("a stall needs a year without a best AND swims since", () => {
  const groups = build(FR100);
  const row = find(groups, "Freestyle", 100);
  const p = progress(row, "SCY", { now: NOW });
  assert.ok(!adviseEvent(groups, row, null, "SCY", p).findings.some((f) => f.kind === "stall"), "one swim since is not a stall");

  const stalled = build([...FR100, s("100 FR", "1:01.80", "2025-12-01"), s("100 FR", "1:02.10", "2026-03-01")]);
  const row2 = find(stalled, "Freestyle", 100);
  const p2 = progress(row2, "SCY", { now: NOW });
  const hit = adviseEvent(stalled, row2, null, "SCY", p2).findings.find((f) => f.kind === "stall");
  assert.ok(hit, "expected a stall");
  assert.equal(hit.evidence, "22 months, 3 swims");
});

check("no stall when the swimmer has stopped racing the event", () => {
  const groups = build([
    s("100 FR", "1:00.00", "2023-01-10"),
    s("100 FR", "1:01.00", "2023-02-10"),
    s("100 FR", "1:01.00", "2023-03-10"),
    s("100 FR", "1:01.00", "2023-04-10"),
  ]);
  const row = find(groups, "Freestyle", 100);
  const out = adviseEvent(groups, row, null, "SCY", progress(row, "SCY", { now: NOW }));
  assert.deepEqual(out.findings, []);
});

check("no stall when the best is recent", () => {
  const groups = build([
    s("100 FR", "1:05.00", "2025-12-01"),
    s("100 FR", "1:04.00", "2026-02-01"),
    s("100 FR", "1:03.00", "2026-03-01"),
    s("100 FR", "1:02.00", "2026-04-01"),
  ]);
  const row = find(groups, "Freestyle", 100);
  assert.deepEqual(adviseEvent(groups, row, null, "SCY", progress(row, "SCY", { now: NOW })).findings, []);
});

check("flags a best that the usual swim does not come near", () => {
  const groups = build([
    s("100 FR", "1:00.00", "2026-01-10"),
    s("100 FR", "1:03.00", "2026-02-10"),
    s("100 FR", "1:03.50", "2026-03-10"),
    s("100 FR", "1:04.00", "2026-04-10"),
    s("100 FR", "1:03.00", "2026-05-10"),
  ]);
  const row = find(groups, "Freestyle", 100);
  const p = progress(row, "SCY", { now: NOW });
  const hit = adviseEvent(groups, row, null, "SCY", p).findings.find((f) => f.kind === "consistency");
  assert.ok(hit, "expected a consistency finding");
  assert.ok(p.recentOffPct > 4);
});

// --- ladder rules ------------------------------------------------------------

const kinds = (groups, stroke, distance) => {
  const row = find(groups, stroke, distance);
  return adviseEvent(groups, row, STD, "SCY", progress(row, "SCY", { now: NOW }), 9).findings;
};

check("a distance event far behind the sprints is an endurance gap", () => {
  const g = build([s("50 FR", "25.00", "2026-02-01"), s("100 FR", "56.00", "2026-02-01"), s("500 FR", "6:00.00", "2026-02-01")]);
  const hit = kinds(g, "Freestyle", 500).find((f) => f.kind === "endurance-gap");
  assert.ok(hit, "expected endurance-gap");
  assert.match(hit.action, /endurance/);
  assert.match(hit.headline, /500 Freestyle/);
});

check("a sprint far behind the distance events is a speed gap", () => {
  const g = build([s("50 FR", "30.00", "2026-02-01"), s("100 FR", "1:06.00", "2026-02-01"), s("500 FR", "5:10.00", "2026-02-01")]);
  const hit = kinds(g, "Freestyle", 50).find((f) => f.kind === "speed-gap");
  assert.ok(hit, "expected speed-gap");
  assert.match(hit.action, /speed/);
});

check("a balanced swimmer gets neither range finding", () => {
  const g = build([s("50 FR", "27.00", "2026-02-01"), s("100 FR", "1:00.00", "2026-02-01"), s("500 FR", "5:30.00", "2026-02-01")]);
  const ks = kinds(g, "Freestyle", 500).map((f) => f.kind);
  assert.ok(!ks.includes("endurance-gap") && !ks.includes("speed-gap"), ks.join());
});

check("the IM names the stroke pulling it down", () => {
  const g = build([
    s("100 FR", "56.00", "2026-02-01"),
    s("100 BK", "1:06.00", "2026-02-01"),
    s("100 BR", "1:26.00", "2026-02-01"),
    s("100 FL", "1:08.00", "2026-02-01"),
    s("200 IM", "2:40.00", "2026-02-01"),
  ]);
  const hit = kinds(g, "Individual Medley", 200).find((f) => f.kind === "im-gap");
  assert.ok(hit, "expected im-gap");
  assert.match(hit.detail, /Breaststroke is the weakest leg/);
  assert.match(hit.action, /Breaststroke/);
});

check("an event behind the whole programme, with no range comparison, is called out", () => {
  // Every event is a sprint, so there is no other end of the range to compare to.
  const g = build([
    s("100 FR", "1:06.00", "2026-02-01"),
    s("50 FR", "25.00", "2026-02-01"),
    s("100 BK", "1:06.00", "2026-02-01"),
    s("100 BR", "1:16.00", "2026-02-01"),
    s("100 FL", "1:08.00", "2026-02-01"),
  ]);
  const ks = kinds(g, "Freestyle", 100).map((f) => f.kind);
  assert.ok(ks.includes("behind-programme"), ks.join());
  assert.ok(!ks.includes("speed-gap") && !ks.includes("endurance-gap"));
});

check("a cut within 1.5% is reported with the typical drop", () => {
  const g = build([
    s("100 FR", "1:05.00", "2025-01-10"),
    s("100 FR", "1:02.00", "2025-12-10"),
    s("100 FR", "58.50", "2026-02-10"),
  ]);
  const hit = kinds(g, "Freestyle", 100).find((f) => f.kind === "reachable-cut");
  assert.ok(hit, "expected reachable-cut");
  assert.match(hit.headline, /AAA is 0\.50 away/);
  assert.match(hit.detail, /dropped 3\.25 on average/);
});

check("a back half 4% slower than the front is a fade, from verified splits", () => {
  const g = build([s("500 FR", "5:30.00", "2026-02-01")]);
  const row = find(g, "Freestyle", 500);
  const prog = progress(row, "SCY", { now: NOW });
  const hit = adviseEvent(g, row, null, "SCY", prog, 3, { halves: { first: 16000, second: 17000, pct: 6.25 } }).findings.find((f) => f.kind === "fade");
  assert.ok(hit, "expected fade");
  assert.equal(hit.evidence, "back half 6.3% slower");
  assert.match(hit.action, /negative-split/);
});

check("an even split is not a fade, and no splits means no fade", () => {
  const g = build([s("500 FR", "5:30.00", "2026-02-01")]);
  const row = find(g, "Freestyle", 500);
  const prog = progress(row, "SCY", { now: NOW });
  const ks = (h) => adviseEvent(g, row, null, "SCY", prog, 9, { halves: h }).findings.map((f) => f.kind);
  assert.ok(!ks({ first: 16500, second: 16700, pct: 1.2 }).includes("fade"));
  assert.ok(!ks(null).includes("fade"));
});

check("without standards the ladder rules are skipped, not guessed", () => {
  const g = build([s("50 FR", "25.00", "2026-02-01"), s("500 FR", "6:00.00", "2026-02-01")]);
  const row = find(g, "Freestyle", 500);
  const out = adviseEvent(g, row, { data: DATA, gender: null, ageGroup: "13-14" }, "SCY", progress(row, "SCY", { now: NOW }));
  assert.deepEqual(out.findings, []);
});

check("every finding carries evidence and a suggestion, in weight order", () => {
  const g = build([s("50 FR", "25.00", "2026-02-01"), s("100 FR", "56.00", "2026-02-01"), s("500 FR", "6:00.00", "2026-02-01")]);
  const fs = kinds(g, "Freestyle", 500);
  assert.ok(fs.length > 0);
  for (const f of fs) for (const k of ["kind", "headline", "detail", "evidence", "action"]) assert.ok(f[k], `${f.kind} missing ${k}`);
  for (let i = 1; i < fs.length; i++) assert.ok(fs[i - 1].weight >= fs[i].weight);
});

// --- rendering ---------------------------------------------------------------

check("each board row carries what the click handler needs", () => {
  const groups = build(FR100);
  const html = bestTimesTable(groups, "SCY");
  assert.match(html, /<tr class="ev-row" data-stroke="Freestyle" data-distance="100" tabindex="0" aria-expanded="false"/);
});

check("the open row is marked expanded, and only that one", () => {
  const groups = build([...FR100, s("200 FR", "2:10.00", "2025-03-01")]);
  const html = bestTimesTable(groups, "SCY", null, null, { stroke: "Freestyle", distance: 100 });
  assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 1);
  assert.match(html, /data-distance="100" tabindex="0" aria-expanded="true"/);
});

const report = (groups, stroke, distance, std = STD, splits = undefined) => {
  const row = find(groups, stroke, distance);
  const prog = progress(row, "SCY", { now: NOW });
  return eventReport({ row, course: "SCY", prog, advice: adviseEvent(groups, row, std, "SCY", prog), std, edition: "test", splits });
};

check("the report shows the best, the chart, the seasons and the focus", () => {
  const html = report(build(FR100), "Freestyle", 100);
  assert.match(html, /100 Freestyle/);
  assert.match(html, /1:01\.00/);
  assert.match(html, /<svg class="rp-chart"/);
  assert.match(html, /2024-25/);
  assert.match(html, /Focus for this event/);
  assert.match(html, /id="report-close"/);
});

check("the report lists every swim with its drop from the swim before", () => {
  const html = report(build(FR100), "Freestyle", 100);
  const rows = html.match(/<tr><th scope="row">\d{4}-\d\d-\d\d<\/th>/g) ?? [];
  assert.equal(rows.length, FR100.length, "one row per swim, not just the latest few");
  // 1:03.50 after 1:03.00 is a 0.50 slower swim; 1:01.00 after 1:03.50 is 2.50 faster.
  assert.match(html, /\+0\.50/);
  assert.match(html, /−2\.50/);
});

check("the stats are four figures and the swim list comes before the seasons", () => {
  const html = report(build(FR100), "Freestyle", 100);
  assert.equal((html.match(/class="rp-stat"/g) ?? []).length, 4);
  assert.ok(!html.includes("Since last best"));
  assert.ok(html.indexOf("Every swim") < html.indexOf("By season"), "every swim first");
});

check("a swim with an id offers splits, and opens them inline when asked", () => {
  const history = FR100.map((h, i) => ({ ...h, swimTimeId: 100 + i }));
  const groups = build(history);
  const closed = report(groups, "Freestyle", 100);
  assert.equal((closed.match(/data-splits=/g) ?? []).length, FR100.length);
  assert.ok(!closed.includes("splits-box"));

  const splits = { open: { has: (id) => id === 103 }, get: () => ({ status: "ready", detail: { splits: null } }) };
  const open = report(groups, "Freestyle", 100, STD, splits);
  assert.equal((open.match(/class="splits-box"/g) ?? []).length, 1);
  assert.match(open, /No lap splits are on record/);
});

check("the report says plainly when there is no real swim in the course", () => {
  const groups = build([s("100 FR", "1:00.00", "2025-03-01", "M", "SCM")]);
  const html = report(groups, "Freestyle", 100);
  assert.match(html, /No real swim on record/);
  assert.ok(!html.includes("<svg"));
});

check("the report says plainly when the history has not loaded", () => {
  const groups = groupBestTimes([{ strokeName: "Freestyle", distance: 100, courseCode: "SCY", swimTime: "1:00.00" }]);
  assert.match(report(groups, "Freestyle", 100), /history is not loaded/);
});

check("hostile meet names are escaped", () => {
  const groups = build([s("100 FR", "1:00.00", "2026-02-01", '<img src=x onerror=alert(1)>')]);
  const html = report(groups, "Freestyle", 100);
  assert.ok(!html.includes("<img"));
});

const cys = (svg) => [...svg.matchAll(/<circle class="rp-dot[^"]*" cx="[\d.]+" cy="([\d.]+)"/g)].map((m) => Number(m[1]));
const FRPROG = () => progress(find(build(FR100), "Freestyle", 100), "SCY", { now: NOW });

check("a chart needs at least two dated swims", () => {
  const one = progress(find(build([s("100 FR", "1:00.00", "2026-02-01")]), "Freestyle", 100), "SCY", { now: NOW });
  assert.equal(progressChart(one, []), "");
  assert.equal((progressChart(FRPROG(), []).match(/<circle/g) ?? []).length, 5);
});

check("the line falls as the swimmer gets faster", () => {
  // SVG y grows downward: the slowest swim (first) must sit above the fastest (last best).
  const [first, , , best] = cys(progressChart(FRPROG(), []));
  assert.ok(first < best, `first swim y=${first} should be above the best y=${best}`);
  const ys = cys(progressChart(FRPROG(), []));
  const times = FRPROG().swims.map((x) => x.hundredths);
  assert.equal(ys.indexOf(Math.min(...ys)), times.indexOf(Math.max(...times)), "slowest swim is the highest point");
  assert.equal(ys.indexOf(Math.max(...ys)), times.indexOf(Math.min(...times)), "fastest swim is the lowest point");
});

check("dates are marked every half year, on 1 January and 1 July", () => {
  const svg = progressChart(FRPROG(), []);
  const labels = [...svg.matchAll(/text-anchor="middle">([A-Z][a-z]{2} \d{4})</g)].map((m) => m[1]);
  assert.deepEqual(labels, ["Jul 2023", "Jan 2024", "Jul 2024", "Jan 2025"]);
  assert.equal((svg.match(/class="rp-tick"/g) ?? []).length, 4);
});

check("a history shorter than half a year names its two ends instead", () => {
  const g = build([s("100 FR", "1:05.00", "2025-02-01"), s("100 FR", "1:04.00", "2025-04-01")]);
  const svg = progressChart(progress(find(g, "Freestyle", 100), "SCY", { now: NOW }), []);
  assert.ok(!svg.includes("rp-tick"));
  assert.match(svg, />Feb 2025</);
  assert.match(svg, />Apr 2025</);
});

check("a long history labels only the Januaries", () => {
  const g = build(
    Array.from({ length: 12 }, (_, i) => s("100 FR", `1:${String(20 - i).padStart(2, "0")}.00`, `${2016 + i}-02-01`)),
  );
  const svg = progressChart(progress(find(g, "Freestyle", 100), "SCY", { now: NOW }), []);
  const labels = [...svg.matchAll(/text-anchor="middle">([A-Z][a-z]{2}) \d{4}</g)].map((m) => m[1]);
  assert.ok(labels.length > 0 && labels.every((m) => m === "Jan"), labels.join());
});

check("both the next standard and a meet cut are drawn and named at the left edge", () => {
  const goals = [
    { kind: "level", label: "AAA", cut: 5950 },
    { kind: "meet", label: "AGI", cut: 6050 },
  ];
  const svg = progressChart(FRPROG(), goals);
  assert.match(svg, /class="rp-cut level"/);
  assert.match(svg, /class="rp-cut meet"/);
  assert.match(svg, />AAA 59\.50</);
  assert.match(svg, />AGI 1:00\.50</);
  assert.ok(!svg.includes("rp-legend"), "no footer: the names sit beside the times");
});

check("a goal far off the scale draws no line but keeps its name, with an arrow", () => {
  const svg = progressChart(FRPROG(), [{ kind: "level", label: "AAAA", cut: 4000 }]);
  assert.ok(!svg.includes('class="rp-cut'), "must not squash the history");
  assert.match(svg, />AAAA 40\.00 ↓</);
});

check("the fastest-time label is not repeated when a goal sits at the bottom", () => {
  const svg = progressChart(FRPROG(), [{ kind: "level", label: "AAA", cut: 5950 }]);
  assert.equal((svg.match(/59\.50/g) ?? []).length, 1);
  const none = progressChart(FRPROG(), []);
  assert.match(none, />1:01\.00</, "with no goal the fastest swim labels the bottom");
});

check("two goals a second apart keep readable, separate labels", () => {
  const svg = progressChart(FRPROG(), [
    { kind: "level", label: "AAA", cut: 5950 },
    { kind: "meet", label: "AGI", cut: 5900 },
  ]);
  const ys = [...svg.matchAll(/<text class="rp-axis rp-goal \w+" x="[\d.]+" y="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(ys.length >= 3);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 10.9, `labels at ${ys.join(", ")} overlap`);
  const lines = [...svg.matchAll(/<line class="rp-cut \w+" x1="[\d.]+" x2="[\d.]+" y1="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(new Set(lines).size, 2, "both lines are drawn, at distinct heights");
});

check("the report draws the next standard AND the meets not yet met", () => {
  const regional = {
    meets: [
      { id: "agi", label: "AGI", edition: "2026-27", source: "" },
      { id: "champs", label: "Champs", edition: "2026", source: "" },
    ],
    standards: {
      agi: { girls: { "13-14": { SCY: { "100 FR": 5950 } } } },
      champs: { girls: { "13-14": { SCY: { "100 FR": 6300 } } } }, // already met: 1:01.00 is faster
    },
  };
  const html = report(build(FR100), "Freestyle", 100, { ...STD, regional });
  assert.match(html, /class="rp-cut level"/);
  assert.match(html, /class="rp-cut meet"/);
  assert.match(html, />AGI 59\.50</);
  assert.ok(!html.includes("Champs"), "a met meet cut is not a goal");
});

console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
