// USA Swimming National Age Group Motivational Standards — the B / BB / A / AA
// AAA / AAAA ladder.
//
// WHY THIS IS A FILE AND NOT AN API CALL. There is no public endpoint for cut
// times. `GetAllTimeStandards` only ever returned the standard *names*, and as
// of 2026-08-25 it returns 403 outright, as does `GetSwimmerTimeStandards`.
// See docs/API.md. So the numbers ship with the app.
//
// The data lives in standards/motivational.json — one stable filename, with the
// edition recorded inside it. USA Swimming publishes a new set per quadrennium,
// not yearly, so an update is a content change to that one file rather than a
// new path to wire up.
//
// Times are hundredths integers throughout, the same representation parseTime
// produces, so a cut and a swim are directly comparable with `<=`.

import { mapDistance } from "./convert.js";
import { getEntry, setEntry } from "./cache.js";

/**
 * Slowest to fastest. That ordering is load-bearing: it makes every cut array
 * strictly decreasing, which lets the tests catch transcription errors by
 * checking monotonicity, and lets the lookups below be simple scans.
 */
export const LEVELS = ["B", "BB", "A", "AA", "AAA", "AAAA"];

export const AGE_GROUPS = ["10U", "11-12", "13-14", "15-16", "17-18"];

export const AGE_GROUP_LABEL = {
  "10U": "10 & Under",
  "11-12": "11-12",
  "13-14": "13-14",
  "15-16": "15-16",
  "17-18": "17-18",
};

export const GENDERS = ["girls", "boys"];
export const GENDER_LABEL = { girls: "Girls", boys: "Boys" };

// The JSON keys events by the API's own stroke abbreviation. ui.js has its own
// STROKE_KEY, but that one is a lowercase CSS hook — deliberately not reused,
// because the data format shouldn't be coupled to a styling detail.
const STROKE_ABBREV = {
  Freestyle: "FR",
  Backstroke: "BK",
  Breaststroke: "BR",
  Butterfly: "FL",
  "Individual Medley": "IM",
};

const STROKE_NAME = Object.fromEntries(
  Object.entries(STROKE_ABBREV).map(([name, ab]) => [ab, name]),
);

/** The four strokes, in the order the board shows them. IM is a composite. */
export const STROKES = ["Freestyle", "Backstroke", "Breaststroke", "Butterfly"];

const URL_PATH = "standards/motivational.json";
const CACHE_KEY = "standards";

let inFlight = null;
let loaded = null;

/**
 * The standards table. Memoised for the page, and mirrored into localStorage so
 * a reload works offline. An edition is stable for years, so the cached copy is
 * used whenever present regardless of age — `getEntry` reports staleness but
 * there is nothing useful to revalidate against.
 *
 * @returns {Promise<object|null>} null when unavailable; callers render without
 *   chips rather than failing, the same way a missing profile photo is dropped.
 */
export function loadStandards() {
  if (loaded) return Promise.resolve(loaded);
  if (inFlight) return inFlight;

  const cached = getEntry(CACHE_KEY);
  if (cached?.data) {
    loaded = cached.data;
    return Promise.resolve(loaded);
  }

  inFlight = fetch(new URL(URL_PATH, import.meta.url))
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data) {
        loaded = data;
        setEntry(CACHE_KEY, data);
      }
      return loaded;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * The age group a swimmer competes in. Motivational standards stop at 18 —
 * past that the ladder is Futures / Junior Nationals / Trials, which is a
 * different system and out of scope.
 * @returns {string|null} null for 19 and over, or an unknown age
 */
export function ageGroupFor(age) {
  if (!Number.isFinite(age)) return null;
  if (age <= 10) return "10U";
  if (age <= 12) return "11-12";
  if (age <= 14) return "13-14";
  if (age <= 16) return "15-16";
  if (age <= 18) return "17-18";
  return null;
}

/**
 * The six cuts for one event, or null when the event isn't in the published set
 * for that group (10 & Under has no 400 IM; a 25 has no metric counterpart).
 *
 * `distance` is the row's yards-canonical distance, as ui.js keys its rows —
 * this maps it to the distance actually raced in `course`, so a 500 free row
 * finds "500 FR" under SCY and "400 FR" under LCM.
 */
export function cutsFor(data, { gender, ageGroup, course, distance, stroke }) {
  if (!data || !gender || !ageGroup) return null;
  const abbrev = STROKE_ABBREV[stroke];
  if (!abbrev) return null;

  const raced = mapDistance(distance, stroke, "SCY", course);
  const cuts = data.standards?.[gender]?.[ageGroup]?.[course]?.[`${raced} ${abbrev}`];
  return Array.isArray(cuts) && cuts.length === LEVELS.length ? cuts : null;
}

/**
 * Every event USA Swimming publishes standards for in one group and course.
 * Distances are as raced in that course, so LCM yields 400 FR where SCY yields
 * 500 FR. Keeps the JSON's key format from leaking into callers.
 *
 * @returns {Array<{key:string, distance:number, stroke:string, cuts:number[]}>}
 */
export function eventsFor(data, { gender, ageGroup, course }) {
  const events = data?.standards?.[gender]?.[ageGroup]?.[course];
  if (!events) return [];
  return Object.entries(events)
    .map(([key, cuts]) => {
      const [distance, abbrev] = key.split(" ");
      return { key, distance: Number(distance), stroke: STROKE_NAME[abbrev], cuts };
    })
    .filter((e) => e.stroke && Number.isFinite(e.distance));
}

/**
 * Where a time sits on the ladder as a continuous number: 0 is exactly B, 1 is
 * BB, 5 is AAAA. Below B goes negative, past AAAA goes above 5.
 *
 * Levels alone can't be compared across events — "AA in both" hides that one is
 * a tenth off AAA and the other barely scraped in. Interpolating between the
 * two bracketing cuts gives a single number that ranks events against each
 * other, which is what any "what should I work on" judgement needs.
 */
export function rung(hundredths, cuts) {
  if (!cuts || hundredths == null || !Number.isFinite(hundredths)) return null;

  const span = (i) => cuts[i] - cuts[i + 1];

  if (hundredths > cuts[0]) {
    // Slower than B: extrapolate at the B→BB spacing so the scale stays linear.
    const s = span(0);
    return s > 0 ? -(hundredths - cuts[0]) / s : -1;
  }
  for (let i = 0; i < cuts.length - 1; i++) {
    if (hundredths >= cuts[i + 1]) {
      const s = span(i);
      return s > 0 ? i + (cuts[i] - hundredths) / s : i;
    }
  }
  const s = span(cuts.length - 2);
  return s > 0 ? cuts.length - 1 + (cuts[cuts.length - 1] - hundredths) / s : cuts.length - 1;
}

/**
 * The highest standard a time has reached.
 * @returns {{level:string, index:number}|null} null when slower than B
 */
export function levelFor(hundredths, cuts) {
  if (!cuts || hundredths == null || !Number.isFinite(hundredths)) return null;
  let index = -1;
  for (let i = 0; i < cuts.length; i++) {
    if (hundredths <= cuts[i]) index = i;
  }
  return index === -1 ? null : { level: LEVELS[index], index };
}

/**
 * The next cut to chase.
 *
 * `gap` is signed the way the swimmer experiences it — negative, because the
 * time has to come down — so formatDelta renders it as "−0.41" with no extra
 * formatting code.
 *
 * @returns {{level:string, cut:number, gap:number}|null} null once AAAA is met
 */
export function nextCut(hundredths, cuts) {
  if (!cuts || hundredths == null || !Number.isFinite(hundredths)) return null;
  for (let i = 0; i < cuts.length; i++) {
    if (hundredths > cuts[i]) {
      return { level: LEVELS[i], cut: cuts[i], gap: cuts[i] - hundredths };
    }
  }
  return null;
}
