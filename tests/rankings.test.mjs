// Run: node tests/rankings.test.mjs
//
// The Rankings controller against a fake API, cache and host. Checks what the
// panel asks the server for, when, and what it concludes from the answers.
// Every swimmer and club below is synthetic.

import assert from "node:assert/strict";
import { createRankings } from "../app/rankings.js";
import { ApiError } from "../app/api.js";

let pass = 0;
const fails = [];
const checkAsync = async (name, fn) => {
  try {
    await fn();
    pass++;
  } catch (e) {
    fails.push(`${name}: ${e.stack?.split("\n").slice(0, 3).join(" | ") ?? e.message}`);
  }
};

const flush = () => new Promise((r) => setTimeout(r, 0));

const EVENTS = [
  { eventId: 2, eventCode: "100 FR SCY", strokeName: "Freestyle", distance: 100, courseCode: "SCY" },
  { eventId: 3, eventCode: "200 FR SCY", strokeName: "Freestyle", distance: 200, courseCode: "SCY" },
  { eventId: 4, eventCode: "500 FR SCY", strokeName: "Freestyle", distance: 500, courseCode: "SCY" },
  { eventId: 56, eventCode: "100 FR LCM", strokeName: "Freestyle", distance: 100, courseCode: "LCM" },
  { eventId: 58, eventCode: "400 FR LCM", strokeName: "Freestyle", distance: 400, courseCode: "LCM" },
];
const SEASONS = [
  { reportingYearKey: 1156, seasonYear: 2027, season: "2027 (9/1/2026 - 8/31/2027)" },
  { reportingYearKey: 155, seasonYear: 2026, season: "2026 (9/1/2025 - 8/31/2026)" },
];
const NOW = () => new Date(2026, 9, 20);

const row = (rank, id, time, club = "OTH") => ({
  eventRank: rank,
  memberId: id,
  fullName: `Swimmer ${id}`,
  swimTime: time,
  swimTimeId: 5000 + rank,
  meetName: "Synthetic Open",
  swimDate: "2026-10-04T00:00:00",
  swimmerAge: 10,
  lscCode: "PN",
  clubCode: club,
  clubName: `${club} Swim Club`,
});

/** A full 100-row list with the swimmer absent. */
const fullList = () => Array.from({ length: 100 }, (_, i) => row(i + 1, `F${i + 1}`, `${50 + Math.floor(i / 5)}.${String(i).padStart(2, "0")}`));

// LSC list: swimmer is 5th overall and 2nd in club BC.
const LSC_LIST = [
  row(1, "X1", "50.10", "OTH"),
  row(2, "C1", "50.50", "BC"),
  row(3, "X2", "51.00", "OTH"),
  row(4, "ME", "52.00", "BC"),
  row(5, "C2", "53.00", "BC"),
];

function setup({ ctx = {}, topTimes, events = EVENTS, store = new Map() } = {}) {
  const calls = { allEvents: 0, seasons: 0, topTimes: [] };
  const errors = [];
  const prefs = new Map();
  const context = {
    swimmer: { memberId: "ME", lscCode: "PN", swimmerAge: 10, clubName: "BC Swim Club" },
    gender: "boys",
    ageGroup: "10U",
    course: "SCY",
    ranks: { team: true, lsc: true, zone: false, us: false },
    groups: [
      {
        stroke: "Freestyle",
        rows: [{ distance: 100, stroke: "Freestyle", actual: { SCY: { hundredths: 5200 }, LCM: { hundredths: 5800 } } }],
      },
    ],
    ...ctx,
  };
  const host = { innerHTML: "", addEventListener() {} };
  const api = {
    async allEvents() {
      calls.allEvents++;
      return events;
    },
    async seasons() {
      calls.seasons++;
      return SEASONS;
    },
    async topTimes(body) {
      calls.topTimes.push(body);
      if (topTimes) return topTimes(body);
      if (body.lscCode) return LSC_LIST;
      if (body.zoneCode) return fullList();
      return fullList();
    },
  };
  const cache = {
    async swr(key, fetcher) {
      if (store.has(`swr:${key}`)) return { data: store.get(`swr:${key}`) };
      const data = await fetcher();
      store.set(`swr:${key}`, data);
      return { data };
    },
    getEntry: (k) => {
      const v = store.get(`e:${k}`);
      if (!v) return null;
      return { data: v.data, fetchedAt: v.at, stale: Date.now() - v.at > 12 * 60 * 60 * 1000 };
    },
    setEntry: (k, data) => store.set(`e:${k}`, { data, at: Date.now() }),
    pref: (k, d) => (prefs.has(k) ? prefs.get(k) : d),
    setPref: (k, v) => prefs.set(k, v),
  };
  const ctl = createRankings({ api, cache, context: () => context, onError: (e) => errors.push(e), host, now: NOW });
  return { ctl, calls, errors, host, context, store, prefs };
}

await checkAsync("a hidden column and a closed page make no request", async () => {
  const { ctl, calls, host } = setup({
    ctx: { ranks: { team: false, lsc: false, zone: false, us: false } },
  });
  ctl.refresh();
  await flush();
  assert.equal(calls.allEvents + calls.seasons + calls.topTimes.length, 0);
  assert.equal(host.innerHTML, "");
});

await checkAsync("the board asks for each event's LSC list only", async () => {
  const { ctl, calls } = setup();
  ctl.refresh();
  await flush();
  assert.equal(calls.allEvents, 1);
  assert.equal(calls.seasons, 1);
  assert.equal(calls.topTimes.length, 1);
  const body = calls.topTimes[0];
  assert.equal(body.eventId, 2);
  assert.equal(body.competitionGenderTypeId, 1);
  assert.equal(body.minAge, 10);
  assert.equal(body.maxAge, 10);
  assert.equal(body.seasonKey, 1156, "October 2026 is the 2027 season");
  assert.equal(body.bestTimesOnly, 1);
  assert.deepEqual([body.lscCode, body.zoneCode], ["PN", null]);
  assert.ok(calls.topTimes.every((b) => b.zoneCode == null && b.lscCode));
  const cell = ctl.boardCells()["Freestyle|100"];
  assert.equal(cell.team.text, "2", "team rank, counted from clubmates");
  assert.equal(cell.team.scope, "club");
  assert.equal(cell.team.kind, "rank");
  assert.equal(cell.lsc.text, "4", "LSC place is the list's eventRank");
  assert.equal(cell.lsc.scope, "lsc");
  assert.equal(cell.zone, undefined, "zone stays off until its column is on");
  assert.equal(cell.us, undefined);
});

await checkAsync("a second event is one more LSC list, and a repeat is free", async () => {
  const { ctl, calls, context } = setup();
  ctl.refresh();
  await flush();
  context.groups = [
    {
      stroke: "Freestyle",
      rows: [
        { distance: 100, stroke: "Freestyle", actual: { SCY: { hundredths: 1 } } },
        { distance: 200, stroke: "Freestyle", actual: { SCY: { hundredths: 1 } } },
      ],
    },
  ];
  ctl.refresh();
  await flush();
  assert.equal(calls.topTimes.length, 2);
  assert.deepEqual(
    calls.topTimes.map((b) => b.eventId).sort(),
    [2, 3],
  );
  ctl.refresh();
  await flush();
  assert.equal(calls.topTimes.length, 2);
});

await checkAsync("lists already in browser storage are shown without a request", async () => {
  const first = setup();
  first.ctl.refresh();
  await flush();
  assert.equal(first.calls.topTimes.length, 1);

  const second = setup({ store: first.store });
  second.ctl.refresh();
  await flush();
  assert.equal(second.calls.topTimes.length, 0, "the cached lists are reused");
  assert.equal(second.ctl.boardCells()["Freestyle|100"].team.text, "2");
});

await checkAsync("a list older than a day and a half is shown, then fetched again", async () => {
  const first = setup();
  first.ctl.refresh();
  await flush();
  const key = [...first.store.keys()].find((k) => String(k).startsWith("e:rank:"));
  first.store.get(key).at = Date.now() - 40 * 60 * 60 * 1000;

  const second = setup({
    store: first.store,
    topTimes: () => [row(1, "ME", "49.00", "BC")],
  });
  second.ctl.refresh();
  await flush();
  assert.equal(second.calls.topTimes.length, 1, "the old copy is checked again");
  assert.equal(second.ctl.boardCells()["Freestyle|100"].team.text, "1");
  assert.equal(second.ctl.boardCells()["Freestyle|100"].lsc.text, "1");
});

await checkAsync("the page is the team list, and age on the page does not move the board rank", async () => {
  const { ctl, calls, host } = setup();
  ctl.refresh();
  await flush();
  ctl.act({ type: "open", stroke: "Freestyle", distance: 100, scope: "club" });
  await flush();
  assert.equal(calls.topTimes.length, 1, "the page reuses the board's LSC list");
  const m = ctl.model();
  assert.equal(m.open, true);
  assert.equal(m.scope, "club");
  assert.equal(m.eventLabel, "100 Freestyle");
  assert.deepEqual(
    m.tabs.map((t) => t.key),
    ["club", "lsc", "zone", "us"],
  );
  assert.equal(m.tabs[0].label, "BC");
  assert.deepEqual(
    m.table.rows.map((r) => [r.memberId, r.eventRank]),
    [
      ["C1", 1],
      ["ME", 2],
      ["C2", 3],
    ],
  );
  assert.match(host.innerHTML, /data-rank-back/);
  assert.match(host.innerHTML, /class="me"/);
  assert.doesNotMatch(host.innerHTML, /data-rank-event/);
  assert.doesNotMatch(host.innerHTML, /USA Swimming returns only/);

  calls.topTimes.length = 0;
  ctl.act({ type: "age", value: "all" });
  await flush();
  assert.equal(calls.topTimes.length, 1);
  assert.equal(calls.topTimes[0].minAge, null);
  assert.equal(ctl.boardCells()["Freestyle|100"].team.text, "2", "the column stays on the swimmer's age");

  calls.topTimes.length = 0;
  ctl.act({ type: "season", value: "all" });
  await flush();
  assert.equal(calls.topTimes[0].seasonKey, null);
});

await checkAsync("LSC and zone are the other groups, and zone is its own list", async () => {
  const { ctl, calls } = setup();
  ctl.act({ type: "open", stroke: "Freestyle", distance: 100, scope: "lsc" });
  await flush();
  const lsc = ctl.model();
  assert.equal(lsc.scope, "lsc");
  assert.equal(lsc.table.rows.length, 5, "the LSC page is the whole list, not clubmates only");
  assert.equal(calls.topTimes.filter((b) => b.zoneCode).length, 0);

  ctl.act({ type: "scope", value: "zone" });
  await flush();
  assert.equal(calls.topTimes.filter((b) => b.zoneCode === "Western").length, 1);
  assert.equal(ctl.model().scope, "zone");
  assert.match(ctl.model().scopeNote, /top 100/);

  ctl.act({ type: "scope", value: "us" });
  await flush();
  const national = calls.topTimes.filter((b) => b.lscCode == null && b.zoneCode == null);
  assert.equal(national.length, 1);
  assert.equal(ctl.model().scope, "us");
  assert.match(ctl.model().scopeNote, /top 100/);
});

await checkAsync("turning on Zone and US fetches those lists and fills the cells", async () => {
  const { ctl, calls, context } = setup({
    topTimes: (b) => {
      if (b.lscCode) return LSC_LIST;
      if (b.zoneCode) return [row(9, "ME", "52.00", "BC"), ...fullList().slice(0, 99)];
      return [row(40, "ME", "52.00", "BC"), ...fullList().slice(0, 99)];
    },
  });
  ctl.refresh();
  await flush();
  assert.equal(calls.topTimes.length, 1);

  context.ranks = { team: true, lsc: true, zone: true, us: true };
  ctl.refresh();
  await flush();
  assert.equal(calls.topTimes.filter((b) => b.zoneCode === "Western").length, 1);
  assert.equal(calls.topTimes.filter((b) => b.lscCode == null && b.zoneCode == null).length, 1);
  const cell = ctl.boardCells()["Freestyle|100"];
  assert.equal(cell.team.text, "2");
  assert.equal(cell.lsc.text, "4");
  assert.equal(cell.zone.text, "9");
  assert.equal(cell.us.text, "40");
});

await checkAsync("switching course asks for the same event in that course", async () => {
  const { ctl, calls, context } = setup({
    ctx: {
      groups: [
        {
          stroke: "Freestyle",
          rows: [{ distance: 500, stroke: "Freestyle", actual: { SCY: { hundredths: 1 }, LCM: { hundredths: 1 } } }],
        },
      ],
    },
  });
  ctl.refresh();
  await flush();
  assert.equal(calls.topTimes[0].eventId, 4, "500 free in yards");
  context.course = "LCM";
  ctl.refresh();
  await flush();
  assert.equal(calls.topTimes.at(-1).eventId, 58, "the same event is 400 free in long meters");
});

await checkAsync("no gender means a note and no leaderboard request", async () => {
  const { ctl, calls, host } = setup({ ctx: { gender: null } });
  ctl.act({ type: "open", stroke: "Freestyle", distance: 100, scope: "club" });
  await flush();
  assert.equal(calls.topTimes.length, 0);
  assert.match(host.innerHTML, /Pick Boys or Girls/);
  assert.equal(ctl.boardCells()["Freestyle|100"].team.text, "…");
});

await checkAsync("an unattached swimmer has no team tab and the cell shows the LSC rank", async () => {
  const { ctl } = setup({
    ctx: { swimmer: { memberId: "ME", lscCode: "PN", swimmerAge: 10, clubName: "Unattached" } },
    topTimes: () => [row(1, "ME", "50.00", "UN")],
  });
  ctl.refresh();
  await flush();
  const cell = ctl.boardCells()["Freestyle|100"];
  assert.equal(cell.team.text, "—");
  assert.equal(cell.team.kind, "miss");
  assert.equal(cell.lsc.text, "1");
  assert.equal(cell.lsc.scope, "lsc");
  ctl.act({ type: "open", stroke: "Freestyle", distance: 100, scope: "club" });
  await flush();
  assert.deepEqual(
    ctl.model().tabs.map((t) => t.key),
    ["lsc", "zone", "us"],
  );
  assert.equal(ctl.model().scope, "lsc");
});

await checkAsync("a failed list shows on the cell, and a retry fetches again", async () => {
  let fail = true;
  const { ctl, calls, errors } = setup({
    topTimes: (b) => {
      if (fail && b.lscCode) throw new ApiError("USA Swimming returned 500.", 500);
      return b.lscCode ? LSC_LIST : fullList();
    },
  });
  ctl.refresh();
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(ctl.boardCells()["Freestyle|100"].team.kind, "error");
  const before = calls.topTimes.length;

  ctl.refresh();
  await flush();
  assert.equal(calls.topTimes.length, before, "an ordinary refresh does not hammer a failing endpoint");

  fail = false;
  ctl.act({ type: "retry" });
  await flush();
  assert.equal(ctl.boardCells()["Freestyle|100"].team.text, "2");
});

await checkAsync("a sign-in error is passed to the page so it can open the sign-in row", async () => {
  const { ctl, errors } = setup({
    topTimes: () => {
      throw new ApiError("sign in", 401, { needsSession: true });
    },
  });
  ctl.refresh();
  await flush();
  assert.ok(errors.every((e) => e.needsSession));
  assert.ok(errors.length > 0);
});

await checkAsync("outside the top 100 the cell is a dash and the page says so", async () => {
  const { ctl, host } = setup({ topTimes: () => fullList() });
  ctl.act({ type: "open", stroke: "Freestyle", distance: 100, scope: "club" });
  await flush();
  assert.equal(ctl.boardCells()["Freestyle|100"].team.text, "—");
  assert.equal(ctl.boardCells()["Freestyle|100"].lsc.text, "—");
  assert.match(host.innerHTML, /Not in the PN top 100/);
  assert.match(host.innerHTML, /100th time/);
});

await checkAsync("another swimmer uses that swimmer's age and LSC", async () => {
  const { ctl, calls, context } = setup();
  ctl.act({ type: "open", stroke: "Freestyle", distance: 100, scope: "club" });
  await flush();
  ctl.act({ type: "age", value: "all" });
  ctl.act({ type: "season", value: "all" });
  await flush();

  context.swimmer = { memberId: "OTHER", lscCode: "FL", swimmerAge: 13, clubName: "FL Swim Club" };
  calls.topTimes.length = 0;
  ctl.refresh();
  await flush();
  assert.equal(calls.topTimes[0].minAge, 13, "the board goes back to the new swimmer's age");
  assert.equal(calls.topTimes[0].lscCode, "FL");
  assert.equal(calls.topTimes[0].seasonKey, 1156);
  assert.equal(ctl.model().ageValue, "age");
});

await checkAsync("no swimmer renders nothing and makes no request", async () => {
  const { ctl, calls, host } = setup({ ctx: { swimmer: null } });
  ctl.act({ type: "open", stroke: "Freestyle", distance: 100, scope: "club" });
  await flush();
  assert.equal(calls.topTimes.length, 0);
  assert.equal(host.innerHTML, "");
});

await checkAsync("a swimmer with no LSC yet makes no list request", async () => {
  const { ctl, calls, host } = setup({
    ctx: { swimmer: { memberId: "ME", swimmerAge: 10, clubName: "BC Swim Club" } },
  });
  ctl.act({ type: "open", stroke: "Freestyle", distance: 100, scope: "club" });
  await flush();
  assert.equal(calls.topTimes.length, 0);
  assert.match(host.innerHTML, /No LSC/);
  assert.equal(ctl.boardCells()["Freestyle|100"].team.text, "—");
  assert.equal(ctl.boardCells()["Freestyle|100"].lsc.text, "—");
});

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
