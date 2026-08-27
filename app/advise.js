// "What should he work on next?" — answered from the motivational ladder.
//
// WHY RULES AND NOT PROSE. This app has no backend and no model behind it, so
// the opinion here is a small set of deterministic rules over the swimmer's
// own times. That is a feature, not a limitation: every line it prints carries
// the numbers it came from, so a coach can disagree with it on the evidence
// rather than argue with an oracle. Same input, same output, offline, instantly.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not report a power-point total, an
// IMX/IMR score, or a national rank. Power points are computed server-side by
// USA Swimming — the official calculator carries no formula — and every ranking
// endpoint is closed to anonymous callers. Inventing a lookalike score would be
// worse than omitting it, because it would be believed. See docs/API.md.
//
// EVERY RULE READS REAL SWIMS ONLY. A converted estimate is not a personal best
// and cannot achieve a standard, so it can never drive advice either.

import { mapDistance } from "./convert.js";
import { STROKES, cutsFor, eventsFor, levelFor, nextCut, rung } from "./standards.js";
import { LEVELS } from "./standards.js";
import { formatDelta, formatTime } from "./time.js";

/** Fewer events than this and any "weakest stroke" claim is just noise. */
const MIN_EVENTS = 4;

/** Rung gaps big enough to be worth saying out loud. A rung is one standard. */
const STROKE_GAP = 1.0;
const IM_GAP = 0.8;
const RANGE_GAP = 1.0;

const SPRINT_MAX = 100;

/** A mean rung expressed as the standard it sits at, for readable evidence. */
export function rungLabel(r) {
  if (r == null || !Number.isFinite(r)) return "—";
  if (r < 0) return "under B";
  return LEVELS[Math.min(LEVELS.length - 1, Math.floor(r))];
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Every real swim in one course, placed on the ladder.
 * @returns {Array<{stroke,distance,raced,hundredths,rung,level,next}>}
 */
export function profile(groups, std, course) {
  if (!std?.data || !std.gender || !std.ageGroup) return [];
  const out = [];

  for (const { stroke, rows } of groups) {
    for (const row of rows) {
      const actual = row.actual[course];
      if (actual?.hundredths == null) continue; // real swims only

      const cuts = cutsFor(std.data, {
        gender: std.gender,
        ageGroup: std.ageGroup,
        course,
        distance: row.distance,
        stroke,
      });
      if (!cuts) continue;

      out.push({
        stroke,
        distance: row.distance, // yards-canonical, as the board keys its rows
        raced: mapDistance(row.distance, stroke, "SCY", course),
        hundredths: actual.hundredths,
        rung: rung(actual.hundredths, cuts),
        level: levelFor(actual.hundredths, cuts)?.level ?? null,
        next: nextCut(actual.hundredths, cuts),
      });
    }
  }
  return out;
}

const event = (e) => `${e.raced} ${e.stroke}`;

/**
 * The cut that needs the least time taken off, as a PERCENTAGE of the swim.
 * Percentage rather than seconds because four tenths off a 50 is a different
 * task from four tenths off a 500.
 */
function quickestWin(events) {
  const withTarget = events
    .filter((e) => e.next)
    .map((e) => ({ e, pct: (Math.abs(e.next.gap) / e.hundredths) * 100 }))
    .sort((a, b) => a.pct - b.pct);
  if (!withTarget.length) return null;

  const { e, pct } = withTarget[0];
  return {
    kind: "quickest-win",
    weight: 60 + Math.max(0, 5 - pct) * 4,
    headline: `${event(e)} is the closest cut to reach`,
    detail: `${formatTime(e.hundredths)} now — ${e.next.level} is ${formatTime(e.next.cut)}.`,
    evidence: `${formatDelta(e.next.gap)}, ${pct.toFixed(1)}% off`,
  };
}

/** The stroke trailing the others, averaged across its distances. */
function weakestStroke(events) {
  const byStroke = new Map();
  for (const e of events) {
    if (!STROKES.includes(e.stroke)) continue; // IM is a composite, handled below
    if (!byStroke.has(e.stroke)) byStroke.set(e.stroke, []);
    byStroke.get(e.stroke).push(e.rung);
  }
  // With only two strokes on record, "weakest" says more about what he has
  // raced than about what he is weak at.
  if (byStroke.size < 3) return null;

  const means = [...byStroke.entries()]
    .map(([stroke, rungs]) => ({ stroke, mean: mean(rungs), n: rungs.length }))
    .sort((a, b) => a.mean - b.mean);

  const weak = means[0];
  const strong = means[means.length - 1];
  const gap = strong.mean - weak.mean;
  if (gap < STROKE_GAP) return null;

  // "Averages X across 1 event" is a silly thing to say.
  const standing =
    weak.n === 1
      ? `It sits at ${rungLabel(weak.mean)} on its one recorded event`
      : `It averages ${rungLabel(weak.mean)} across ${weak.n} events`;

  return {
    kind: "weakest-stroke",
    weight: 50 + gap * 15,
    headline: `${weak.stroke} is the stroke holding the set back`,
    detail: `${standing}, against ${rungLabel(strong.mean)} in ${strong.stroke}.`,
    evidence: `${gap.toFixed(1)} standards behind`,
  };
}

/**
 * The 200 IM against the four strokes. It is the classic diagnostic: a weak
 * stroke shows up there even when the swimmer avoids racing it on its own.
 */
function imBalance(events) {
  const im = events.find((e) => e.stroke === "Individual Medley" && e.distance === 200);
  const strokeRungs = events.filter((e) => STROKES.includes(e.stroke)).map((e) => e.rung);
  if (!im || strokeRungs.length < 3) return null;

  const strokes = mean(strokeRungs);
  const diff = strokes - im.rung;
  if (Math.abs(diff) < IM_GAP) return null;

  const lags = diff > 0;
  return {
    kind: "im-balance",
    weight: 40 + Math.abs(diff) * 10,
    headline: lags
      ? "The 200 IM trails the individual strokes"
      : "The 200 IM is ahead of the individual strokes",
    detail: lags
      ? `${rungLabel(im.rung)} in the IM against ${rungLabel(strokes)} across the strokes — usually the weakest leg costing more than it does raced alone.`
      : `${rungLabel(im.rung)} in the IM against ${rungLabel(strokes)} across the strokes — a genuine four-stroke base to build on.`,
    evidence: `${Math.abs(diff).toFixed(1)} standards apart`,
  };
}

/** Published events for the group with no real swim on record in this course. */
function neverRaced(events, std, course) {
  const published = eventsFor(std.data, {
    gender: std.gender,
    ageGroup: std.ageGroup,
    course,
  });
  if (!published.length) return null;

  const have = new Set(events.map((e) => `${e.raced} ${e.stroke}`));
  const missing = published.filter((p) => !have.has(`${p.distance} ${p.stroke}`));
  if (!missing.length) return null;

  const named = missing
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((p) => `${p.distance} ${p.stroke}`);

  return {
    kind: "never-raced",
    weight: 35 + Math.min(missing.length, 6) * 2,
    headline: `${missing.length} published event${missing.length === 1 ? "" : "s"} with no time on record`,
    detail: `No swim in ${named.join(", ")}${missing.length > named.length ? ", and others" : ""}. An unraced event is an unknown, not a weakness.`,
    evidence: `${published.length - missing.length} of ${published.length} raced`,
  };
}

/** Sprint-leaning or distance-leaning, if the split is pronounced. */
function rangeProfile(events) {
  const strokes = events.filter((e) => STROKES.includes(e.stroke));
  const sprint = strokes.filter((e) => e.distance <= SPRINT_MAX).map((e) => e.rung);
  const longer = strokes.filter((e) => e.distance > SPRINT_MAX).map((e) => e.rung);
  if (sprint.length < 2 || longer.length < 2) return null;

  const diff = mean(sprint) - mean(longer);
  if (Math.abs(diff) < RANGE_GAP) return null;

  const sprintLeaning = diff > 0;
  return {
    kind: "range",
    weight: 20 + Math.abs(diff) * 5,
    headline: sprintLeaning ? "Sprint-leaning profile" : "Distance-leaning profile",
    detail: sprintLeaning
      ? `${rungLabel(mean(sprint))} at 50-100 against ${rungLabel(mean(longer))} at 200 and up.`
      : `${rungLabel(mean(longer))} at 200 and up against ${rungLabel(mean(sprint))} at 50-100.`,
    evidence: `${Math.abs(diff).toFixed(1)} standards apart`,
  };
}

/**
 * The ranked focus list for one course.
 *
 * @returns {{ready:boolean, reason?:string, have?:number, findings:Array}}
 *   reason "no-standards" means no gender or age group is set; "thin" means the
 *   swimmer has too few measurable swims in this course to say anything honest.
 */
export function advise(groups, std, course, limit = 3) {
  if (!std?.data || !std.gender || !std.ageGroup) {
    return { ready: false, reason: "no-standards", findings: [] };
  }

  const events = profile(groups, std, course);
  if (events.length < MIN_EVENTS) {
    return { ready: false, reason: "thin", have: events.length, findings: [] };
  }

  const findings = [
    quickestWin(events),
    weakestStroke(events),
    imBalance(events),
    neverRaced(events, std, course),
    rangeProfile(events),
  ]
    .filter(Boolean)
    .sort((a, b) => b.weight - a.weight);

  return { ready: true, findings: findings.slice(0, limit), events };
}
