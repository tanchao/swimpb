// Run: node tests/regional.test.mjs

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { meetCutsFor } from "../app/regional.js";

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (error) {
    fails.push(`${name}: ${error.message}`);
  }
};

const data = JSON.parse(
  readFileSync(new URL("../app/standards/pns.json", import.meta.url)),
);

const lookup = (overrides = {}) =>
  meetCutsFor(data, {
    gender: "girls",
    ageGroup: "13-14",
    course: "SCY",
    distance: 50,
    stroke: "Freestyle",
    ...overrides,
  });

check("declares official sources and editions", () => {
  assert.equal(data.meets.length, 2);
  for (const meet of data.meets) {
    assert.ok(meet.edition);
    assert.match(meet.source, /^https:\/\/www\.pns\.org\//);
  }
});

check("finds AGI and Champs cuts for one event", () => {
  const cuts = lookup();
  assert.deepEqual(cuts.map((cut) => cut.id), ["agi", "champs"]);
  assert.deepEqual(cuts.map((cut) => cut.cut), [3019, 2599]);
});

check("maps distance freestyle to the metric event", () => {
  const cuts = lookup({ course: "LCM", distance: 500 });
  assert.deepEqual(cuts.map((cut) => cut.cut), [33539, 29839]);
});

check("maps older motivational groups to the AGI 15-and-over group", () => {
  for (const ageGroup of ["15-16", "17-18"]) {
    const cuts = lookup({ ageGroup });
    assert.deepEqual(cuts.map((cut) => cut.id), ["agi"]);
    assert.equal(cuts[0].cut, 2749);
  }
});

check("14-and-under Champs does not claim older swimmers", () => {
  assert.deepEqual(lookup({ ageGroup: "17-18" }).map((cut) => cut.id), ["agi"]);
});

check("missing inputs and unpublished events return no cuts", () => {
  assert.deepEqual(lookup({ gender: null }), []);
  assert.deepEqual(lookup({ stroke: "Sidestroke" }), []);
});

check("every stored cut is a positive integer", () => {
  for (const meets of Object.values(data.standards)) {
    for (const genders of Object.values(meets)) {
      for (const groups of Object.values(genders)) {
        for (const courses of Object.values(groups)) {
          for (const cut of Object.values(courses)) {
            assert.ok(Number.isInteger(cut) && cut > 0);
          }
        }
      }
    }
  }
});

check("2027 Regionals is explicit rather than using expired cuts", () => {
  const regionals = data.unavailable.find((meet) => meet.id === "regionals");
  assert.equal(regionals.edition, "2027");
  assert.match(regionals.reason, /not published/i);
  assert.equal(data.standards.regionals, undefined);
});

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const failure of fails) console.log(`  FAIL  ${failure}`);
process.exit(fails.length ? 1 : 0);
