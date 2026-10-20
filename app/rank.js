// Where a swimmer's time ranks, from USA Swimming's top-times leaderboard.
//
// WHAT THE API GIVES US. `POST /TimesSearch/GetTopTimesLeaderBoard` returns the
// fastest swimmers for one event, filtered by gender, age range, season, LSC
// and zone. It returns **at most 100 rows**, sorted by time, one row per
// swimmer, each carrying `eventRank`. There is no paging, no club filter, and
// no "rank of this swim" call. Verified 2026-10-20; see docs/API.md.
//
// WHAT THAT MEANS FOR A RANK. A rank is exact when the swimmer is in the
// returned list. When the list is full (100 rows) and he is not in it, all we
// can say is "not in the top 100". When the list is short, it is complete, so
// his absence means he has no time in that slice. We never guess a rank.
//
// CLUB RANK is derived, not fetched. Every swimmer faster than him in his club
// is also faster than him in the LSC, the zone and the nation, so they are in
// any list that contains him. The count of faster clubmates in that list is
// therefore exact.

import { canonicalDistance, mapDistance } from "./convert.js";
import { parseTime } from "./time.js";

/** The server never returns more than this many rows. */
export const LIST_CAP = 100;

/** `GetCompetitionGenders`: 1 Male, 2 Female, 3 Mixed (relays only). */
export const GENDER_ID = { boys: 1, girls: 2 };

/**
 * USA Swimming zone for each LSC code.
 *
 * The API has no LSC → zone call (`GetLscs` carries no zone). This table was
 * built on 2026-10-20 from the server itself: for each zone, the LSC codes on
 * `zoneCode`-filtered leaderboards (96 queries across events, genders and
 * ages). All 61 LSCs from `GetLscs` appeared under exactly one zone.
 * tests/rank.test.mjs checks that shape.
 */
export const ZONE_LSCS = {
  Central: ["AR", "IA", "IL", "IN", "LE", "MI", "MN", "MV", "MW", "ND", "OH", "OHO", "OK", "OZ", "SD", "WI"],
  Eastern: ["AD", "AM", "CT", "MA", "MD", "ME", "MR", "NE", "NI", "NJ", "PV", "VA"],
  Southern: ["BD", "FG", "FL", "GA", "GU", "KY", "LA", "MS", "NC", "NT", "SC", "SE", "ST", "WT", "WV"],
  Western: ["AK", "AZ", "CA", "CC", "CO", "HI", "IE", "MT", "NM", "OR", "PC", "PN", "SI", "SN", "SR", "US", "UT", "WY"],
};

const ZONE_OF_LSC = Object.fromEntries(
  Object.entries(ZONE_LSCS).flatMap(([zone, codes]) => codes.map((code) => [code, zone])),
);

/** @returns {string|null} the zone code, e.g. "Western" for "PN" */
export function zoneOf(lscCode) {
  return ZONE_OF_LSC[lscCode] ?? null;
}

// ---------------------------------------------------------------------------
// Filters

/** Age ranges the board's own age groups cover. Keys match standards.js. */
const GROUP_RANGE = {
  "10U": { min: 1, max: 10 },
  "11-12": { min: 11, max: 12 },
  "13-14": { min: 13, max: 14 },
  "15-16": { min: 15, max: 16 },
  "17-18": { min: 17, max: 18 },
};

/**
 * The age filter for a choice. The leaderboard filters on the age the swimmer
 * was *at the swim*, so "age" means swims done at that exact age.
 *
 * @param {"age"|"group"|"all"} choice
 * @returns {{min:number, max:number}|null} null means no age filter
 */
export function ageRange(choice, { age, ageGroup } = {}) {
  if (choice === "age") return Number.isFinite(age) ? { min: age, max: age } : null;
  if (choice === "group") return GROUP_RANGE[ageGroup] ?? null;
  return null;
}

/**
 * The request body, exactly as the official site sends it.
 * @param {{eventId:number, gender:"boys"|"girls", age:{min,max}|null,
 *          seasonKey:number|null, lscCode?:string|null, zoneCode?:string|null}} f
 */
export function leaderboardBody(f) {
  return {
    bestTimesOnly: 1,
    eventId: f.eventId,
    competitionGenderTypeId: GENDER_ID[f.gender],
    seasonKey: f.seasonKey ?? null,
    startDate: null,
    endDate: null,
    minAge: f.age?.min ?? null,
    maxAge: f.age?.max ?? null,
    lscCode: f.lscCode ?? null,
    zoneCode: f.zoneCode ?? null,
    timeStandardType: null,
    loggedInUserClubs: false,
    teamUsaEligible: false,
  };
}

/** Keep only what the page shows, so a list is small enough to cache. */
export function slimRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    eventRank: r.eventRank,
    memberId: r.memberId,
    fullName: r.fullName,
    swimTime: r.swimTime,
    swimTimeId: r.swimTimeId,
    meetName: r.meetName,
    swimDate: r.swimDate,
    swimmerAge: r.swimmerAge,
    lscCode: r.lscCode,
    clubCode: r.clubCode,
    clubName: r.clubName,
  }));
}

// ---------------------------------------------------------------------------
// Events and seasons

const STROKE_ORDER = ["Freestyle", "Backstroke", "Breaststroke", "Butterfly", "Individual Medley"];

/**
 * Individual events in one course, grouped by stroke for a <select>.
 * Relays are left out: a relay has no single swimmer to rank.
 *
 * @returns {Array<{stroke:string, events:Array<{eventId:number, distance:number}>}>}
 */
export function individualEvents(events, course) {
  const byStroke = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (e.courseCode !== course || String(e.strokeName).includes("Relay")) continue;
    if (!byStroke.has(e.strokeName)) byStroke.set(e.strokeName, []);
    byStroke.get(e.strokeName).push({ eventId: e.eventId, distance: e.distance });
  }
  return STROKE_ORDER.filter((s) => byStroke.has(s)).map((stroke) => ({
    stroke,
    events: byStroke.get(stroke).sort((a, b) => a.distance - b.distance),
  }));
}

/**
 * The API's event id for a board row in a course. Board rows are keyed by the
 * yards distance, so 500 free in yards is 400 free in long meters.
 *
 * @param {{stroke:string, distance:number}} sel distance in yards terms
 * @returns {number|null}
 */
export function eventIdFor(events, sel, course) {
  if (!sel) return null;
  const raced = mapDistance(sel.distance, sel.stroke, "SCY", course);
  const hit = (Array.isArray(events) ? events : []).find(
    (e) => e.courseCode === course && e.strokeName === sel.stroke && e.distance === raced,
  );
  return hit?.eventId ?? null;
}

/** The selection (yards terms) that an event id stands for. */
export function selectionFor(events, eventId) {
  const e = (Array.isArray(events) ? events : []).find((x) => x.eventId === eventId);
  return e ? { stroke: e.strokeName, distance: canonicalDistance(e.distance, e.strokeName) } : null;
}

/** First board event with a real time in this course, or null. */
export function defaultSelection(groups, course) {
  for (const g of groups ?? []) {
    const row = g.rows.find((r) => r.actual?.[course]);
    if (row) return { stroke: g.stroke, distance: row.distance };
  }
  return null;
}

/**
 * Seasons run 9/1 to 8/31 and are named for the year they end in.
 * @returns {number|null} the `reportingYearKey` of the season containing `now`
 */
export function currentSeasonKey(seasons, now = new Date()) {
  const year = now.getMonth() >= 8 ? now.getFullYear() + 1 : now.getFullYear();
  return (Array.isArray(seasons) ? seasons : []).find((s) => s.seasonYear === year)?.reportingYearKey ?? null;
}

/** Seasons that have started, newest first. */
export function pastSeasons(seasons, now = new Date()) {
  const year = now.getMonth() >= 8 ? now.getFullYear() + 1 : now.getFullYear();
  return (Array.isArray(seasons) ? seasons : [])
    .filter((s) => s.seasonYear <= year)
    .sort((a, b) => b.seasonYear - a.seasonYear);
}

// ---------------------------------------------------------------------------
// Standings

/**
 * Where a swimmer stands in one list.
 *
 *   ranked   in the list; `rank` is the server's `eventRank`
 *   outside  the list is full and he is not in it
 *   none     the list is short, so it is complete and he has no time in it
 */
export function standing(rows, memberId) {
  const list = Array.isArray(rows) ? rows : [];
  const complete = list.length < LIST_CAP;
  const row = list.find((r) => r.memberId === memberId);
  if (row) return { kind: "ranked", rank: row.eventRank, of: list.length, complete, row };
  if (!complete) return { kind: "outside", cutoff: list[list.length - 1].swimTime };
  return { kind: "none" };
}

/**
 * His rank among swimmers of his own club, counted inside a list that contains
 * him. Exact, because every faster clubmate is in any list he is in.
 *
 * @returns {{clubCode:string, clubName:string, rank:number, count:number}|null}
 *   null when he is not in the list or swims unattached
 */
export function clubStanding(rows, memberId) {
  const list = Array.isArray(rows) ? rows : [];
  const me = list.find((r) => r.memberId === memberId);
  if (!me || !me.clubCode || me.clubCode === "UN") return null;
  const mine = parseTime(me.swimTime).hundredths;
  if (mine == null) return null;
  const club = list.filter((r) => r.clubCode === me.clubCode);
  const faster = club.filter((r) => {
    const t = parseTime(r.swimTime).hundredths;
    return t != null && t < mine;
  }).length;
  return { clubCode: me.clubCode, clubName: me.clubName, rank: faster + 1, count: club.length };
}

/**
 * One club's rows from a list, ranked among themselves (ties share a rank).
 * Partial by nature: it holds only the clubmates who made the list.
 */
export function clubRows(rows, clubCode) {
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => r.clubCode === clubCode);
  const times = mine.map((r) => parseTime(r.swimTime).hundredths);
  return mine.map((r, i) => ({
    ...r,
    eventRank: 1 + times.filter((t) => t != null && times[i] != null && t < times[i]).length,
  }));
}

/**
 * The scopes a swimmer is ranked in, widest last. A scope is missing when we
 * do not know the LSC (a deep link before the profile loads).
 */
export function scopesFor(swimmer) {
  const lsc = swimmer?.lscCode;
  if (!lsc) return [{ key: "national", label: "US", filter: {} }];
  const zone = zoneOf(lsc);
  return [
    { key: "lsc", label: lsc, filter: { lscCode: lsc } },
    ...(zone ? [{ key: "zone", label: zone, filter: { zoneCode: zone } }] : []),
    { key: "national", label: "US", filter: {} },
  ];
}
