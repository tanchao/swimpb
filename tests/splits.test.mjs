// Run: node tests/splits.test.mjs
//
// The splits payload shape is not verified against a live response, so these
// tests pin the part that IS under our control: nothing is interpreted unless
// it adds up to the swim's own final time.

import assert from "node:assert/strict";
import { halves, normalizeSplits } from "../app/splits.js";
import { splitsBox } from "../app/views.js";

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

// A 200 free in yards: 4 x 50, final 1:52.00 = 11200.
const FINAL = 11200;
const SWIM = { distance: 200, stroke: "Freestyle", course: "SCY" };
const CUM = ["26.00", "54.50", "1:23.40", "1:52.00"];
const LAP = ["26.00", "28.50", "28.90", "28.60"];

check("null, empty and blank splits mean none, not an error", () => {
  for (const raw of [null, undefined, [], ""]) assert.equal(normalizeSplits(raw, FINAL, SWIM).status, "none");
});

check("cumulative splits are recognised by matching the final time", () => {
  const n = normalizeSplits(CUM, FINAL, SWIM);
  assert.equal(n.status, "ok");
  assert.equal(n.mode, "cumulative");
  assert.deepEqual(n.laps.map((l) => l.lap), [2600, 2850, 2890, 2860]);
  assert.deepEqual(n.laps.map((l) => l.distance), [50, 100, 150, 200]);
});

check("lap splits are recognised by adding up to the final time", () => {
  const n = normalizeSplits(LAP, FINAL, SWIM);
  assert.equal(n.status, "ok");
  assert.equal(n.mode, "lap");
  assert.equal(n.laps[3].cumulative, FINAL);
});

check("a missing final lap is appended only when the distance divides evenly", () => {
  const n = normalizeSplits(CUM.slice(0, 3), FINAL, SWIM);
  assert.equal(n.status, "ok");
  assert.equal(n.appended, true);
  assert.equal(n.laps.length, 4);
  assert.equal(n.laps[3].lap, FINAL - 8340);
  // 3 splits + final = 4 laps divides 200; 2 splits + final = 3 laps does not.
  assert.equal(normalizeSplits(CUM.slice(0, 2), FINAL, SWIM).status, "unverified");
});

check("numbers, objects, JSON text and delimited text are all read", () => {
  assert.equal(normalizeSplits([26, 54.5, 83.4, 112], FINAL, SWIM).status, "ok");
  assert.equal(normalizeSplits(CUM.map((t) => ({ splitTime: t })), FINAL, SWIM).status, "ok");
  assert.equal(normalizeSplits(JSON.stringify(CUM), FINAL, SWIM).status, "ok");
  assert.equal(normalizeSplits(CUM.join(", "), FINAL, SWIM).status, "ok");
});

check("splits that fit neither reading are shown as received, never analysed", () => {
  const n = normalizeSplits(["26.00", "54.50", "1:23.40", "2:30.00"], FINAL, SWIM);
  assert.equal(n.status, "unverified");
  assert.equal(halves(n, "Freestyle"), null);
});

check("an unreadable shape is reported as such", () => {
  assert.equal(normalizeSplits({ a: 1 }, FINAL, SWIM).status, "unrecognised");
  assert.equal(normalizeSplits([{ nope: 1 }], FINAL, SWIM).status, "unrecognised");
  assert.equal(normalizeSplits(["fast"], FINAL, SWIM).status, "unrecognised");
});

check("halves compare the front half to the back half", () => {
  const h = halves(normalizeSplits(CUM, FINAL, SWIM), "Freestyle");
  assert.equal(h.first, 5450);
  assert.equal(h.second, 5750);
  assert.ok(Math.abs(h.pct - 5.5) < 0.1);
});

check("an IM and an odd number of laps have no halves", () => {
  assert.equal(halves(normalizeSplits(CUM, FINAL, SWIM), "Individual Medley"), null);
  const odd = normalizeSplits(["30.00", "1:00.00", "1:30.00"], 9000, { distance: 150, stroke: "Freestyle", course: "SCY" });
  assert.equal(halves(odd, "Freestyle"), null);
});

check("the metric race distance is used for lap labels", () => {
  // 500 yd free is a 400 m race in metres: 8 laps of 50.
  const cum = [30, 62, 94, 126, 158, 190, 222, 254].map((s) => String(s) );
  const n = normalizeSplits(
    cum.map((s) => `${Math.floor(Number(s) / 60)}:${(Number(s) % 60).toFixed(2).padStart(5, "0")}`),
    25400,
    { distance: 500, stroke: "Freestyle", course: "LCM" },
  );
  assert.equal(n.status, "ok");
  assert.equal(n.laps[0].distance, 50);
  assert.equal(n.laps[7].distance, 400);
});

// --- rendering ---------------------------------------------------------------

const META = { hundredths: FINAL, ...SWIM };

check("the box says what state it is in", () => {
  assert.match(splitsBox(undefined, META), /Loading lap splits/);
  assert.match(splitsBox({ status: "loading" }, META), /Loading lap splits/);
  assert.match(splitsBox({ status: "error", message: "No access." }, META), /No access\./);
  assert.match(splitsBox({ status: "ready", detail: null }, META), /No lap splits are on record/);
  assert.match(splitsBox({ status: "ready", detail: { splits: { a: 1 } } }, META), /does not recognise/);
});

check("verified splits render as a table with the half summary", () => {
  const html = splitsBox({ status: "ready", detail: { splits: CUM } }, META);
  assert.equal((html.match(/<tr><th scope="row">/g) ?? []).length, 4);
  assert.match(html, /Front half/);
  assert.match(html, /\+5\.5%/);
});

check("unverified splits are listed raw with the reason", () => {
  const html = splitsBox({ status: "ready", detail: { splits: ["26.00", "54.50", "1:23.40", "2:30.00"] } }, META);
  assert.match(html, /do not add up to the final time of 1:52\.00/);
  assert.ok(!html.includes("Front half"));
});

check("a hostile error message is escaped", () => {
  assert.ok(!splitsBox({ status: "error", message: "<script>x()</script>" }, META).includes("<script>"));
});

console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
