// Run: node tests/rank.test.mjs
//
// Pure logic for rankings. Every row below is synthetic: the real leaderboard
// lists children by name, and this file is committed.

import assert from "node:assert/strict";
import {
  LIST_CAP,
  ZONE_LSCS,
  ageRange,
  clubRows,
  clubStanding,
  currentSeasonKey,
  defaultSelection,
  eventIdFor,
  individualEvents,
  leaderboardBody,
  pastSeasons,
  scopesFor,
  selectionFor,
  slimRows,
  standing,
  zoneOf,
} from "../app/rank.js";

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

const row = (rank, id, time, club = "AAA", extra = {}) => ({
  eventRank: rank,
  memberId: id,
  fullName: `Swimmer ${id}`,
  swimTime: time,
  swimTimeId: 1000 + rank,
  meetName: "Synthetic Open",
  swimDate: "2026-10-04T00:00:00",
  swimmerAge: 10,
  lscCode: "PN",
  clubCode: club,
  clubName: `${club} Swim Club`,
  ...extra,
});

// --- zones -------------------------------------------------------------------

check("the four zones cover 61 LSCs, each exactly once", () => {
  assert.deepEqual(Object.keys(ZONE_LSCS).sort(), ["Central", "Eastern", "Southern", "Western"]);
  const all = Object.values(ZONE_LSCS).flat();
  assert.equal(all.length, 61);
  assert.equal(new Set(all).size, 61);
});

check("zoneOf maps an LSC and rejects an unknown one", () => {
  assert.equal(zoneOf("PN"), "Western");
  assert.equal(zoneOf("FL"), "Southern");
  assert.equal(zoneOf("NE"), "Eastern");
  assert.equal(zoneOf("IL"), "Central");
  assert.equal(zoneOf("ZZ"), null);
  assert.equal(zoneOf(undefined), null);
});

// --- filters -----------------------------------------------------------------

check("ageRange: exact age, board age group, or none", () => {
  assert.deepEqual(ageRange("age", { age: 10 }), { min: 10, max: 10 });
  assert.deepEqual(ageRange("group", { ageGroup: "11-12" }), { min: 11, max: 12 });
  assert.deepEqual(ageRange("group", { ageGroup: "10U" }), { min: 1, max: 10 });
  assert.equal(ageRange("all", { age: 10 }), null);
  assert.equal(ageRange("age", {}), null, "an unknown age must not become a filter");
  assert.equal(ageRange("group", { ageGroup: null }), null);
});

check("leaderboardBody sends what the official site sends", () => {
  const body = leaderboardBody({
    eventId: 2,
    gender: "boys",
    age: { min: 10, max: 10 },
    seasonKey: 1156,
    lscCode: "PN",
  });
  assert.deepEqual(body, {
    bestTimesOnly: 1,
    eventId: 2,
    competitionGenderTypeId: 1,
    seasonKey: 1156,
    startDate: null,
    endDate: null,
    minAge: 10,
    maxAge: 10,
    lscCode: "PN",
    zoneCode: null,
    timeStandardType: null,
    loggedInUserClubs: false,
    teamUsaEligible: false,
  });
});

check("leaderboardBody: girls are 2, and absent filters are null", () => {
  const body = leaderboardBody({ eventId: 5, gender: "girls", age: null, seasonKey: null });
  assert.equal(body.competitionGenderTypeId, 2);
  assert.equal(body.minAge, null);
  assert.equal(body.maxAge, null);
  assert.equal(body.seasonKey, null);
  assert.equal(body.lscCode, null);
  assert.equal(body.zoneCode, null);
});

check("slimRows keeps display fields only", () => {
  const [r] = slimRows([{ ...row(1, "A", "55.00"), powerPoints: 900, splits: null, timeStandard: "A" }]);
  assert.equal(r.powerPoints, undefined);
  assert.equal(r.splits, undefined);
  assert.equal(r.fullName, "Swimmer A");
  assert.deepEqual(slimRows(null), []);
});

// --- events ------------------------------------------------------------------

const EVENTS = [
  { eventId: 1, eventCode: "50 FR SCY", strokeName: "Freestyle", distance: 50, courseCode: "SCY" },
  { eventId: 2, eventCode: "100 FR SCY", strokeName: "Freestyle", distance: 100, courseCode: "SCY" },
  { eventId: 4, eventCode: "500 FR SCY", strokeName: "Freestyle", distance: 500, courseCode: "SCY" },
  { eventId: 12, eventCode: "100 BK SCY", strokeName: "Backstroke", distance: 100, courseCode: "SCY" },
  { eventId: 21, eventCode: "200 IM SCY", strokeName: "Individual Medley", distance: 200, courseCode: "SCY" },
  { eventId: 23, eventCode: "200 FR-R SCY", strokeName: "Freestyle Relay", distance: 200, courseCode: "SCY" },
  { eventId: 58, eventCode: "400 FR LCM", strokeName: "Freestyle", distance: 400, courseCode: "LCM" },
  { eventId: 56, eventCode: "100 FR LCM", strokeName: "Freestyle", distance: 100, courseCode: "LCM" },
  { eventId: 66, eventCode: "100 BK LCM", strokeName: "Backstroke", distance: 100, courseCode: "LCM" },
];

check("individualEvents drops relays, other courses, and orders by stroke then distance", () => {
  const groups = individualEvents(EVENTS, "SCY");
  assert.deepEqual(
    groups.map((g) => g.stroke),
    ["Freestyle", "Backstroke", "Individual Medley"],
  );
  assert.deepEqual(
    groups[0].events.map((e) => e.distance),
    [50, 100, 500],
  );
  assert.ok(!JSON.stringify(groups).includes("23"), "the relay id must not appear");
});

check("eventIdFor maps the board's yards distance into the course raced", () => {
  assert.equal(eventIdFor(EVENTS, { stroke: "Freestyle", distance: 100 }, "SCY"), 2);
  assert.equal(eventIdFor(EVENTS, { stroke: "Freestyle", distance: 100 }, "LCM"), 56);
  assert.equal(eventIdFor(EVENTS, { stroke: "Freestyle", distance: 500 }, "SCY"), 4);
  assert.equal(eventIdFor(EVENTS, { stroke: "Freestyle", distance: 500 }, "LCM"), 58, "500 yd free is 400 m free");
  assert.equal(eventIdFor(EVENTS, { stroke: "Backstroke", distance: 100 }, "LCM"), 66);
  assert.equal(eventIdFor(EVENTS, { stroke: "Butterfly", distance: 100 }, "SCY"), null);
  assert.equal(eventIdFor(EVENTS, null, "SCY"), null);
});

check("selectionFor is the inverse of eventIdFor", () => {
  assert.deepEqual(selectionFor(EVENTS, 58), { stroke: "Freestyle", distance: 500 });
  assert.deepEqual(selectionFor(EVENTS, 12), { stroke: "Backstroke", distance: 100 });
  assert.equal(selectionFor(EVENTS, 999), null);
});

check("defaultSelection picks the first board event with a real time in the course", () => {
  const groups = [
    { stroke: "Freestyle", rows: [{ distance: 50, actual: { LCM: {} } }, { distance: 100, actual: { SCY: {} } }] },
    { stroke: "Backstroke", rows: [{ distance: 100, actual: { SCY: {} } }] },
  ];
  assert.deepEqual(defaultSelection(groups, "SCY"), { stroke: "Freestyle", distance: 100 });
  assert.deepEqual(defaultSelection(groups, "LCM"), { stroke: "Freestyle", distance: 50 });
  assert.equal(defaultSelection(groups, "SCM"), null);
  assert.equal(defaultSelection([], "SCY"), null);
});

// --- seasons -----------------------------------------------------------------

const SEASONS = [
  { reportingYearKey: 1160, seasonYear: 2028, season: "2028 (9/1/2027 - 8/31/2028)" },
  { reportingYearKey: 1156, seasonYear: 2027, season: "2027 (9/1/2026 - 8/31/2027)" },
  { reportingYearKey: 155, seasonYear: 2026, season: "2026 (9/1/2025 - 8/31/2026)" },
];

check("the season is named for the year it ends in", () => {
  assert.equal(currentSeasonKey(SEASONS, new Date(2026, 9, 20)), 1156, "October 2026 is season 2027");
  assert.equal(currentSeasonKey(SEASONS, new Date(2026, 8, 1)), 1156, "September 1 starts the new season");
  assert.equal(currentSeasonKey(SEASONS, new Date(2026, 7, 31)), 155, "August 31 is the last day of 2026");
  assert.equal(currentSeasonKey(SEASONS, new Date(2031, 0, 1)), null, "unknown season is null, not a guess");
});

check("pastSeasons hides seasons that have not started, newest first", () => {
  const list = pastSeasons(SEASONS, new Date(2026, 9, 20));
  assert.deepEqual(
    list.map((s) => s.seasonYear),
    [2027, 2026],
  );
});

// --- standing ----------------------------------------------------------------

const full = (target) => {
  const rows = [];
  for (let i = 1; i <= LIST_CAP; i++) rows.push(row(i, `M${i}`, `${50 + Math.floor(i / 10)}.${String(i).padStart(2, "0")}`));
  if (target) rows[target.at - 1] = target.row;
  return rows;
};

check("standing: in the list gives the server's rank", () => {
  const s = standing(full({ at: 7, row: row(7, "ME", "56.10") }), "ME");
  assert.equal(s.kind, "ranked");
  assert.equal(s.rank, 7);
  assert.equal(s.complete, false, "a full list says nothing about how many swim this event");
  assert.equal(s.of, LIST_CAP);
});

check("standing: a tie keeps the server's rank, not the position", () => {
  const rows = [row(1, "A", "50.00"), row(2, "B", "51.00"), row(2, "ME", "51.00"), row(4, "D", "52.00")];
  assert.equal(standing(rows, "ME").rank, 2);
});

check("standing: a short list is complete, so absence means no time", () => {
  const rows = [row(1, "A", "50.00"), row(2, "B", "51.00")];
  assert.deepEqual(standing(rows, "ME"), { kind: "none" });
  assert.equal(standing(rows, "B").complete, true);
  assert.equal(standing(rows, "B").of, 2);
  assert.deepEqual(standing([], "ME"), { kind: "none" });
  assert.deepEqual(standing(null, "ME"), { kind: "none" });
});

check("standing: a full list without him is outside the top 100, with the cutoff", () => {
  const rows = full();
  const s = standing(rows, "ME");
  assert.equal(s.kind, "outside");
  assert.equal(s.cutoff, rows[LIST_CAP - 1].swimTime);
});

// --- club standing -----------------------------------------------------------

check("clubStanding counts faster clubmates, ignoring other clubs", () => {
  const rows = [
    row(1, "X1", "50.00", "OTH"),
    row(2, "C1", "51.00", "BC"),
    row(3, "X2", "52.00", "OTH"),
    row(4, "ME", "53.00", "BC"),
    row(5, "C2", "54.00", "BC"),
  ];
  assert.deepEqual(clubStanding(rows, "ME"), {
    clubCode: "BC",
    clubName: "BC Swim Club",
    rank: 2,
    count: 3,
  });
});

check("clubStanding: a tied clubmate is not ahead of him", () => {
  const rows = [row(1, "C1", "51.00", "BC"), row(1, "ME", "51.00", "BC")];
  assert.equal(clubStanding(rows, "ME").rank, 1);
});

check("clubStanding is null when he is absent, unattached, or the time is unreadable", () => {
  assert.equal(clubStanding([row(1, "A", "50.00", "BC")], "ME"), null);
  assert.equal(clubStanding([row(1, "ME", "50.00", "UN")], "ME"), null);
  assert.equal(clubStanding([row(1, "ME", "50.00", null)], "ME"), null);
  assert.equal(clubStanding([row(1, "ME", "n/a", "BC")], "ME"), null);
});

check("clubStanding reads relay lead-off flags", () => {
  const rows = [row(1, "C1", "51.00r", "BC"), row(2, "ME", "52.00", "BC")];
  assert.equal(clubStanding(rows, "ME").rank, 2);
});

check("clubRows re-ranks one club among itself, with ties", () => {
  const rows = [
    row(1, "X1", "50.00", "OTH"),
    row(2, "C1", "51.00", "BC"),
    row(3, "C2", "51.00", "BC"),
    row(9, "C3", "55.00", "BC"),
  ];
  const out = clubRows(rows, "BC");
  assert.deepEqual(
    out.map((r) => [r.memberId, r.eventRank]),
    [
      ["C1", 1],
      ["C2", 1],
      ["C3", 3],
    ],
  );
  assert.deepEqual(clubRows(null, "BC"), []);
});

// --- scopes ------------------------------------------------------------------

check("scopesFor: LSC, then its zone, then the nation", () => {
  const scopes = scopesFor({ lscCode: "PN" });
  assert.deepEqual(
    scopes.map((s) => [s.key, s.label, s.filter]),
    [
      ["lsc", "PN", { lscCode: "PN" }],
      ["zone", "Western", { zoneCode: "Western" }],
      ["national", "US", {}],
    ],
  );
});

check("scopesFor: an unknown LSC falls back to the nation only", () => {
  assert.deepEqual(scopesFor({}).map((s) => s.key), ["national"]);
  assert.deepEqual(scopesFor(null).map((s) => s.key), ["national"]);
  assert.deepEqual(scopesFor({ lscCode: "ZZ" }).map((s) => s.key), ["lsc", "national"]);
});

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
