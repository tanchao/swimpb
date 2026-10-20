// Lap splits for one swim, from AllTimes/SwimTime/{swimTimeId}.
//
// WHAT IS NOT VERIFIED. docs/API.md shows `"splits": null` in the one sample on
// record, and no populated payload has been captured: the session used for
// verification expired before one could be. So this module assumes nothing about
// the shape. It accepts a few plausible shapes, and then PROVES what the numbers
// mean against the swim's own final time before using them:
//
//   cumulative   non-decreasing, and the last value equals the final time
//   lap          the values add up to the final time
//   cumulative, final lap missing   non-decreasing, the last value is below the
//                final time, and one more lap divides the distance evenly
//
// Anything else is reported as "unverified" and shown as received, with no
// analysis. A wrong reading of a split would produce confident, wrong coaching.

import { mapDistance } from "./convert.js";
import { parseTime } from "./time.js";

/** Rounding slack between a time and the sum of its rounded parts, in hundredths. */
const TOLERANCE = 15;
/** The back half this much slower than the front half is worth saying. */
export const FADE_PCT = 4;
const TIME_KEYS = ["splitTime", "time", "swimTime", "cumulativeTime", "lapTime", "value"];

function toHundredths(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
  if (typeof v === "string") return parseTime(v).hundredths;
  if (v && typeof v === "object") {
    for (const k of TIME_KEYS) {
      if (v[k] != null) {
        const h = toHundredths(v[k]);
        if (h != null) return h;
      }
    }
  }
  return null;
}

function toList(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON: fall through to a delimited list such as "28.10, 58.30".
  }
  return raw.split(/[\s,;|]+/).filter(Boolean);
}

/**
 * @param raw             the `splits` field exactly as received
 * @param finalHundredths the swim's final time
 * @param swim            {distance, stroke, course} — distance as stored on the board row
 * @returns {{status:"none"}
 *          |{status:"unrecognised"}
 *          |{status:"unverified", values:number[]}
 *          |{status:"ok", mode:"cumulative"|"lap", appended:boolean, laps:Array<{n,distance,lap,cumulative}>}}
 */
export function normalizeSplits(raw, finalHundredths, swim) {
  if (raw == null || (Array.isArray(raw) && raw.length === 0) || raw === "") return { status: "none" };

  const list = toList(raw);
  if (!list) return { status: "unrecognised" };
  const values = list.map(toHundredths);
  if (!values.length || values.some((v) => v == null)) return { status: "unrecognised" };
  if (finalHundredths == null) return { status: "unverified", values };

  const n = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  const rising = values.every((v, i) => i === 0 || v >= values[i - 1]);
  const raced = mapDistance(swim.distance, swim.stroke, "SCY", swim.course);

  let cumulative = null;
  let mode = null;
  let appended = false;

  if (n > 1 && rising && Math.abs(values[n - 1] - finalHundredths) <= TOLERANCE) {
    cumulative = values;
    mode = "cumulative";
  } else if (Math.abs(sum - finalHundredths) <= TOLERANCE + n) {
    let run = 0;
    cumulative = values.map((v) => (run += v));
    mode = "lap";
  } else if (rising && values[n - 1] < finalHundredths && raced % (n + 1) === 0) {
    // The last lap was not listed; the final time is its running total.
    cumulative = [...values, finalHundredths];
    mode = "cumulative";
    appended = true;
  }
  if (!cumulative) return { status: "unverified", values };

  const per = raced % cumulative.length === 0 ? raced / cumulative.length : null;
  const laps = cumulative.map((c, i) => ({
    n: i + 1,
    distance: per == null ? null : per * (i + 1),
    lap: c - (i ? cumulative[i - 1] : 0),
    cumulative: c,
  }));
  return { status: "ok", mode, appended, laps };
}

/**
 * Front half against back half. Null when halves are not meaningful: an IM
 * changes stroke every leg, and an odd number of laps has no middle.
 *
 * @returns {{first:number, second:number, pct:number}|null}
 */
export function halves(normalized, stroke) {
  if (normalized?.status !== "ok" || stroke === "Individual Medley") return null;
  const { laps } = normalized;
  if (laps.length < 4 || laps.length % 2) return null;

  const mid = laps.length / 2;
  const first = laps[mid - 1].cumulative;
  const second = laps[laps.length - 1].cumulative - first;
  return { first, second, pct: ((second - first) / first) * 100 };
}
