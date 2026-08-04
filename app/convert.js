// Course conversion: SCY ↔ SCM ↔ LCM.
//
// SOURCE. These are the conversion factors published by Colorado Swimming, the
// set in common use for USA Swimming age-group times. Cross-checked against the
// implementation at https://github.com/Stanback/php-swim-time-conversion
// (swimconvert.class.php, factor set "CO"). Only the numbers are reused here —
// the implementation below is independent, because that repo is GPL.
//
// THE MODEL. Two effects, applied separately:
//
//   1. Pool length. A yard is 0.9144 m, so a meter pool is ~9.4% longer and
//      meter times are correspondingly slower: the factor is 1.11 (and 1/1.11
//      the other way). This alone converts SCY ↔ SCM, which race over the same
//      *number* of lengths.
//
//   2. Turns. A short-course race has twice the turns of a long-course race
//      over the same distance, and a turn is faster than swimming. Converting
//      SCM → LCM therefore ADDS time: a fixed increment per 50 of race
//      distance, whose size depends on the stroke (breaststroke gains most from
//      a turn, backstroke least).
//
// The published table is exactly `unit × (number of 50s)`, e.g. freestyle's
// unit is 0.8 s, so 200 free is 0.8 × 4 = 3.2 s and 500 free is 0.8 × 8 = 6.4 s.
// Expressing it as a formula rather than transcribing ~90 cells removes the
// class of bug the source table actually contains (it lists 200 fly as +2.6 in
// one direction and +2.8 in the other; 0.7 × 4 = 2.8 is the consistent value).
//
// DISTANCE FREESTYLE is the exception, because the races aren't the same
// distance: 500 yd vs 400 m, 1000 yd vs 800 m, 1650 yd vs 1500 m. Those get a
// direct empirical ratio instead of length-plus-turns.

export const COURSES = ["SCY", "SCM", "LCM"];

export const COURSE_LABEL = { SCY: "Yards", SCM: "Short Meters", LCM: "Long Meters" };
export const COURSE_LONG = {
  SCY: "Short course yards (25 yd pool)",
  SCM: "Short course meters (25 m pool)",
  LCM: "Long course meters (50 m pool)",
};

const LENGTH_FACTOR = 1.11; // SCY → SCM

// Seconds gained per 50 of race distance when removing half the turns.
const TURN_UNIT = {
  Freestyle: 0.8,
  Backstroke: 0.6,
  Breaststroke: 1.0,
  Butterfly: 0.7,
  "Individual Medley": 0.8,
};

// Distance freestyle: the yards and meters races cover different distances, so
// SCY ↔ LCM uses a direct ratio. Keyed by the yards distance.
const DISTANCE_FREE = {
  500: { lcm: 400, scyToLcm: 0.8925 },
  1000: { lcm: 800, scyToLcm: 0.8925 },
  1650: { lcm: 1500, scyToLcm: 1.02 },
};

// Number of 50s, used to scale the turn increment. Keyed by metric distance.
const FIFTIES = { 50: 1, 100: 2, 200: 4, 400: 8, 800: 16, 1500: 30 };

/**
 * The equivalent distance for an event in another course. Most events keep
 * their number (100 back is 100 back everywhere); distance freestyle does not.
 * @returns {number|null} null when the event has no counterpart in that course
 */
export function mapDistance(distance, stroke, from, to) {
  const yardsSide = (c) => c === "SCY";
  if (yardsSide(from) === yardsSide(to)) return distance; // SCM ↔ LCM, or same

  if (stroke === "Freestyle") {
    if (yardsSide(from)) {
      return DISTANCE_FREE[distance]?.lcm ?? distance;
    }
    const entry = Object.entries(DISTANCE_FREE).find(([, v]) => v.lcm === distance);
    if (entry) return Number(entry[0]);
    // 400 m free has no yards counterpart other than the 500, handled above;
    // a 400 yd free is a relay, not an individual event.
    return distance;
  }
  return distance;
}

function turnIncrement(distance, stroke) {
  const unit = TURN_UNIT[stroke];
  if (unit === undefined) return null;
  // Scale by metric distance so 500 yd free and 400 m free agree on 8 fifties.
  const metric = stroke === "Freestyle" ? (DISTANCE_FREE[distance]?.lcm ?? distance) : distance;
  const fifties = FIFTIES[metric];
  if (fifties === undefined) return null;
  return unit * fifties;
}

/**
 * Convert a time between courses.
 *
 * @param {number} hundredths time in the `from` course
 * @param {number} distance   as raced in the `from` course
 * @param {string} stroke     full stroke name, e.g. "Breaststroke"
 * @param {string} from       SCY | SCM | LCM
 * @param {string} to         SCY | SCM | LCM
 * @returns {number|null} converted hundredths, or null if not convertible
 */
export function convert(hundredths, distance, stroke, from, to) {
  if (hundredths === null || !Number.isFinite(hundredths)) return null;
  if (from === to) return hundredths;
  if (!COURSES.includes(from) || !COURSES.includes(to)) return null;

  const s = hundredths / 100;
  const inc = turnIncrement(distance, stroke);
  const isDistanceFree = stroke === "Freestyle" && DISTANCE_FREE[distance] !== undefined;
  const lcmDistanceFree =
    stroke === "Freestyle" && Object.values(DISTANCE_FREE).some((v) => v.lcm === distance);

  let out;
  switch (`${from}_${to}`) {
    // Pool length only — same number of lengths, same number of turns.
    case "SCY_SCM":
      out = s * LENGTH_FACTOR;
      break;
    case "SCM_SCY":
      out = s / LENGTH_FACTOR;
      break;

    // Turns only — same pool units, half the turns.
    case "SCM_LCM":
      if (inc === null) return null;
      out = s + inc;
      break;
    case "LCM_SCM":
      if (inc === null) return null;
      out = s - inc;
      break;

    // Both effects.
    case "SCY_LCM":
      if (isDistanceFree) {
        out = s * DISTANCE_FREE[distance].scyToLcm;
      } else {
        if (inc === null) return null;
        out = s * LENGTH_FACTOR + inc;
      }
      break;
    case "LCM_SCY": {
      if (lcmDistanceFree) {
        const e = Object.values(DISTANCE_FREE).find((v) => v.lcm === distance);
        out = s / e.scyToLcm;
      } else {
        if (inc === null) return null;
        out = (s - inc) / LENGTH_FACTOR;
      }
      break;
    }
    default:
      return null;
  }

  return out > 0 ? Math.round(out * 100) : null;
}

/**
 * The canonical row a distance belongs to, expressed in yards terms. Distance
 * freestyle races over different distances per course (500 yd vs 400 m), so
 * without this the 500 and the 400 would render as two unrelated rows instead
 * of one event shown in two courses.
 */
export function canonicalDistance(distance, stroke) {
  if (stroke !== "Freestyle") return distance;
  const entry = Object.entries(DISTANCE_FREE).find(([, v]) => v.lcm === distance);
  return entry ? Number(entry[0]) : distance;
}

/** Human-readable explanation of a conversion, for a tooltip. */
export function explain(distance, stroke, from, to) {
  const mapped = mapDistance(distance, stroke, from, to);
  const same = mapped === distance;
  const event = same ? `${distance}` : `${distance} ${from} → ${mapped} ${to}`;
  return `Estimated from a ${from} time (${event} ${stroke}) using Colorado Swimming conversion factors. Not an official time.`;
}
