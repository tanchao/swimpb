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
    swimmer: { memberId: "ME", lscCode: "PN", swimmerAge: 10 },
    gender: "boys",
    ageGroup: "10U",
    course: "SCY",
    groups: [{ stroke: "Freestyle", rows: [{ distance: 100, actual: { SCY: {}, LCM: {} } }] }],
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
    getSession: (k) => store.get(`s:${k}`) ?? null,
    setSession: (k, v) => store.set(`s:${k}`, v),
    pref: (k, d) => (prefs.has(k) ? prefs.get(k) : d),
    setPref: (k, v) => prefs.set(k, v),
  };
  const ctl = createRankings({ api, cache, context: () => context, onError: (e) => errors.push(e), host, now: NOW });
  return { ctl, calls, errors, host, context, store, prefs };
}

await checkAsync("a closed panel makes no request and shows only its header", async () => {
  const { ctl, calls, host } = setup();
  ctl.refresh();
  await flush();
  assert.equal(calls.allEvents + calls.seasons + calls.topTimes.length, 0);
  assert.match(host.innerHTML, /data-rank-toggle/);
  assert.doesNotMatch(host.innerHTML, /data-rank-event/);
});

await checkAsync("opening asks for the event and season lists once, then one list per scope", async () => {
  const { ctl, calls } = setup();
  ctl.act({ type: "toggle" });
  await flush();
  assert.equal(calls.allEvents, 1);
  assert.equal(calls.seasons, 1);
  assert.equal(calls.topTimes.length, 3);
  const [lsc, zone, nation] = calls.topTimes;
  for (const b of calls.topTimes) {
    assert.equal(b.eventId, 2);
    assert.equal(b.competitionGenderTypeId, 1);
    assert.equal(b.minAge, 10);
    assert.equal(b.maxAge, 10);
    assert.equal(b.seasonKey, 1156, "October 2026 is the 2027 season");
    assert.equal(b.bestTimesOnly, 1);
  }
  assert.deepEqual([lsc.lscCode, lsc.zoneCode], ["PN", null]);
  assert.deepEqual([zone.lscCode, zone.zoneCode], [null, "Western"]);
  assert.deepEqual([nation.lscCode, nation.zoneCode], [null, null]);
});

await checkAsync("the open state is remembered", async () => {
  const { ctl, prefs } = setup();
  ctl.act({ type: "toggle" });
  assert.equal(prefs.get("rankOpen"), true);
  ctl.act({ type: "toggle" });
  assert.equal(prefs.get("rankOpen"), false);
});

await checkAsync("cards: LSC rank, zone and nation outside the top 100, club derived", async () => {
  const { ctl, host } = setup();
  ctl.act({ type: "toggle" });
  await flush();
  const m = ctl.model();
  const by = Object.fromEntries(m.cards.map((c) => [c.label, c]));
  assert.equal(by.PN.kind, "ranked");
  assert.equal(by.PN.rank, 4, "the server's eventRank, not the array position");
  assert.equal(by.PN.of, "of 5", "a short list is complete");
  assert.equal(by.Western.kind, "outside");
  assert.equal(by.US.kind, "outside");
  assert.equal(by.BC.kind, "ranked");
  assert.equal(by.BC.rank, 2);
  assert.match(by.BC.of, /of 3/);
  assert.match(host.innerHTML, /#4/);
  assert.match(host.innerHTML, /Not in the top 100/);
});

await checkAsync("a repeated refresh and a repeated selection reuse the lists", async () => {
  const { ctl, calls } = setup();
  ctl.act({ type: "toggle" });
  await flush();
  ctl.refresh();
  ctl.refresh();
  await flush();
  assert.equal(calls.topTimes.length, 3);

  ctl.act({ type: "event", value: "3" });
  await flush();
  assert.equal(calls.topTimes.length, 6, "a new event is three new lists");
  ctl.act({ type: "event", value: "2" });
  await flush();
  assert.equal(calls.topTimes.length, 6, "going back costs nothing");
});

await checkAsync("lists already cached for the tab are shown without a request", async () => {
  // A reload keeps sessionStorage but loses the controller's memory.
  const first = setup();
  first.ctl.act({ type: "toggle" });
  await flush();
  assert.equal(first.calls.topTimes.length, 3);

  const second = setup({ store: first.store });
  second.ctl.act({ type: "toggle" });
  await flush();
  assert.equal(second.calls.topTimes.length, 0, "the cached lists are reused");
  assert.match(second.host.innerHTML, /#4/, "and the panel redraws from them");
  assert.doesNotMatch(second.host.innerHTML, /Loading/);
});

await checkAsync("age and season choices change the request", async () => {
  const { ctl, calls } = setup();
  ctl.act({ type: "toggle" });
  await flush();
  calls.topTimes.length = 0;

  ctl.act({ type: "season", value: "all" });
  await flush();
  assert.equal(calls.topTimes.length, 3);
  assert.equal(calls.topTimes[0].seasonKey, null);

  calls.topTimes.length = 0;
  ctl.act({ type: "age", value: "all" });
  await flush();
  assert.equal(calls.topTimes[0].minAge, null);
  assert.equal(calls.topTimes[0].maxAge, null);

  calls.topTimes.length = 0;
  ctl.act({ type: "age", value: "group" });
  await flush();
  assert.equal(calls.topTimes[0].minAge, 1);
  assert.equal(calls.topTimes[0].maxAge, 10);
});

await checkAsync("switching course keeps the event, mapped to the course raced", async () => {
  const { ctl, calls, context } = setup({
    ctx: { groups: [{ stroke: "Freestyle", rows: [{ distance: 500, actual: { SCY: {}, LCM: {} } }] }] },
  });
  ctl.act({ type: "toggle" });
  await flush();
  assert.equal(calls.topTimes[0].eventId, 4, "500 free in yards");
  calls.topTimes.length = 0;
  context.course = "LCM";
  ctl.refresh();
  await flush();
  assert.equal(calls.topTimes[0].eventId, 58, "the same event is 400 free in long meters");
});

await checkAsync("no gender means a note and no leaderboard request", async () => {
  const { ctl, calls, host } = setup({ ctx: { gender: null } });
  ctl.act({ type: "toggle" });
  await flush();
  assert.equal(calls.topTimes.length, 0);
  assert.match(host.innerHTML, /Pick Boys or Girls/);
});

await checkAsync("browsing the other gender shows the leaderboard but no standings", async () => {
  const { ctl, calls } = setup();
  ctl.act({ type: "toggle" });
  await flush();
  calls.topTimes.length = 0;
  ctl.act({ type: "gender", value: "girls" });
  await flush();
  assert.equal(calls.topTimes[0].competitionGenderTypeId, 2);
  const m = ctl.model();
  assert.equal(m.cards, null, "a boy's standing in the girls' list would be a false 'not in the top 100'");
  assert.ok(m.table.rows.length > 0);
});

await checkAsync("the club tab holds clubmates only, ranked among themselves", async () => {
  const { ctl, host } = setup();
  ctl.act({ type: "toggle" });
  await flush();
  assert.deepEqual(ctl.model().tabs.map((t) => t.key), ["club", "lsc", "zone", "national"]);
  ctl.act({ type: "tab", value: "club" });
  const m = ctl.model();
  assert.equal(m.tab, "club");
  assert.deepEqual(
    m.table.rows.map((r) => [r.memberId, r.eventRank]),
    [["C1", 1], ["ME", 2], ["C2", 3]],
  );
  assert.match(m.tabNote, /BC Swim Club/);
  assert.match(host.innerHTML, /class="me"/);
});

await checkAsync("an unattached swimmer gets no club card standing", async () => {
  const { ctl } = setup({
    topTimes: (b) => (b.lscCode ? [row(1, "ME", "50.00", "UN")] : fullList()),
  });
  ctl.act({ type: "toggle" });
  await flush();
  const club = ctl.model().cards[0];
  assert.equal(club.label, "Club");
  assert.equal(club.kind, "unknown");
  assert.match(club.message, /unattached/i, "the swimmer is listed, so do not ask for another time");
  assert.deepEqual(ctl.model().tabs.map((t) => t.key), ["lsc", "zone", "national"]);
});

await checkAsync("a failed list shows its error, reports it, and a retry fetches again", async () => {
  let fail = true;
  const { ctl, calls, errors } = setup({
    topTimes: (b) => {
      if (fail && b.lscCode) throw new ApiError("USA Swimming returned 500.", 500);
      return b.lscCode ? LSC_LIST : fullList();
    },
  });
  ctl.act({ type: "toggle" });
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(ctl.model().cards.find((c) => c.label === "PN").kind, "error");
  const club = ctl.model().cards.find((c) => c.label === "Club");
  assert.doesNotMatch(club.message, /Needs a time/, "an outage is not the swimmer's missing time");
  assert.match(club.message, /list/i);
  const before = calls.topTimes.length;

  ctl.refresh();
  await flush();
  assert.equal(calls.topTimes.length, before, "an ordinary refresh does not hammer a failing endpoint");

  fail = false;
  ctl.act({ type: "retry" });
  await flush();
  assert.equal(ctl.model().cards.find((c) => c.label === "PN").kind, "ranked");
});

await checkAsync("a sign-in error is passed to the page so it can open the sign-in row", async () => {
  const { ctl, errors } = setup({
    topTimes: () => {
      throw new ApiError("sign in", 401, { needsSession: true });
    },
  });
  ctl.act({ type: "toggle" });
  await flush();
  assert.ok(errors.every((e) => e.needsSession));
  assert.ok(errors.length > 0);
});

await checkAsync("another swimmer starts from the board's defaults", async () => {
  const { ctl, calls, context } = setup();
  ctl.act({ type: "toggle" });
  await flush();
  ctl.act({ type: "age", value: "all" });
  ctl.act({ type: "season", value: "all" });
  await flush();

  context.swimmer = { memberId: "OTHER", lscCode: "FL", swimmerAge: 13 };
  calls.topTimes.length = 0;
  ctl.refresh();
  await flush();
  assert.equal(calls.topTimes[0].minAge, 13);
  assert.equal(calls.topTimes[0].seasonKey, 1156);
  assert.equal(calls.topTimes[1].zoneCode, "Southern");
});

await checkAsync("no swimmer renders an empty panel without a request", async () => {
  const { ctl, calls } = setup({ ctx: { swimmer: null } });
  ctl.act({ type: "toggle" });
  await flush();
  assert.equal(calls.topTimes.length, 0);
});

await checkAsync("a deep link with no LSC yet ranks nationally only", async () => {
  const { ctl, calls } = setup({ ctx: { swimmer: { memberId: "ME", swimmerAge: 10 } } });
  ctl.act({ type: "toggle" });
  await flush();
  assert.equal(calls.topTimes.length, 1);
  assert.deepEqual([calls.topTimes[0].lscCode, calls.topTimes[0].zoneCode], [null, null]);
});

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
