// Progress report for ONE event in ONE course, and the focus that follows from it.
//
// Two layers, both pure and deterministic like advise.js:
//
//   progress()    reads the swimmer's recorded swims in the event (the history that
//                 GetAllTimesForFilters returns) and says what happened over time.
//   adviseEvent() turns that history, plus where the event sits on the
//                 motivational ladder next to the swimmer's other events, into a
//                 short ranked list of things to work on — each with its evidence
//                 and a training suggestion.
//
// SAME EVIDENCE RULE AS advise.js. Real swims only; a converted estimate never
// appears here. Lap splits enter through one rule only (fade), and only when the
// caller supplies a verified front-half / back-half pair from splits.js.
//
// WHAT "COMPARED TO OTHERS" MEANS. Always the swimmer's own other events, placed
// on the same continuous ladder (0 = B, 5 = AAAA). Never other swimmers: no
// ranking endpoint is open to us, so a peer comparison would be invented.

import { STROKES } from "./standards.js";
import { FADE_PCT } from "./splits.js";
import { profile, rungLabel } from "./advise.js";
import { formatDelta, formatTime } from "./time.js";

const DAY = 86_400_000;
const MONTH = 30.4375 * DAY;

/** No new best for this long, while still racing the event, is a stall. */
const STALL_MONTHS = 12;
const STALL_SWIMS = 3;
/** A typical recent swim this far off the best means the best is not repeatable. */
const OFF_PB_PCT = 2.0;
const OFF_PB_SWIMS = 4;
/** Rung gaps (one rung = one standard) worth saying out loud. */
const CLASS_GAP = 1.0;
const IM_GAP = 0.8;
const STANDING_GAP = 1.0;
const STANDING_MIN_OTHERS = 4;
/** "Close" for the reachable-cut rule, as a percentage of the swim. */
const CLOSE_PCT = 1.5;
const SPRINT_MAX = 100;

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * A calendar day as UTC milliseconds, or null.
 * Accepts the two shapes USA Swimming is documented to use: ISO ("2019-01-19…")
 * and long form ("Jan 19, 2019"). Anything else is dropped from time-based
 * analysis rather than guessed at.
 */
export function parseDay(s) {
  if (typeof s !== "string" || !s.trim()) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A season runs 1 September to 31 August, labelled "2025-26". */
export function seasonOf(ms) {
  const d = new Date(ms);
  const start = d.getUTCMonth() >= 8 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/**
 * What the swimmer's recorded swims in one event say about progress.
 *
 * @param row     a groupBestTimes() row
 * @param course  "SCY" | "SCM" | "LCM"
 * @returns {{ready:false, reason:"no-swim"|"no-history", pb?:number}
 *          | {ready:true, ...}}
 */
export function progress(row, course, { now = Date.now() } = {}) {
  const actual = row.actual?.[course];
  if (actual?.hundredths == null) return { ready: false, reason: "no-swim" };
  const pb = actual.hundredths;

  const raw = row.history?.[course] ?? [];
  // Same-day prelim and final: slower first, so a faster final counts as the best.
  const dated = raw
    .map((s) => ({ ...s, ms: parseDay(s.swimDate) }))
    .filter((s) => s.ms != null)
    .sort((a, b) => a.ms - b.ms || b.hundredths - a.hundredths);
  if (!dated.length) return { ready: false, reason: "no-history", pb };

  let best = Infinity;
  let previous = null;
  for (const s of dated) {
    // Change from the swim before it, whatever that was. Negative is faster.
    s.delta = previous != null ? s.hundredths - previous : null;
    previous = s.hundredths;
    // How far this swim was from the best the swimmer had already done. An
    // improving swimmer is never "off", so only a stuck one scores high here.
    s.offPct = best !== Infinity ? ((s.hundredths - best) / best) * 100 : null;
    s.isBest = s.hundredths < best;
    s.drop = s.isBest && best !== Infinity ? best - s.hundredths : null;
    if (s.isBest) best = s.hundredths;
  }

  const first = dated[0];
  const bests = dated.filter((s) => s.isBest);
  const lastBest = bests[bests.length - 1];
  const last = dated[dated.length - 1];

  const before12 = dated.filter((s) => s.ms <= now - 12 * MONTH);
  const yearAgo = before12.length ? Math.min(...before12.map((s) => s.hundredths)) : null;

  const drops = bests.map((s) => s.drop).filter((d) => d != null);
  const recentOff = dated
    .map((s) => s.offPct)
    .filter((o) => o != null)
    .slice(-OFF_PB_SWIMS);

  const bySeason = new Map();
  for (const s of dated) {
    const label = seasonOf(s.ms);
    const cur = bySeason.get(label) ?? { label, swims: 0, best: Infinity };
    cur.swims++;
    cur.best = Math.min(cur.best, s.hundredths);
    bySeason.set(label, cur);
  }
  const seasons = [...bySeason.values()].sort((a, b) => a.label.localeCompare(b.label));
  seasons.forEach((s, i) => {
    s.change = i === 0 ? null : s.best - seasons[i - 1].best;
  });

  return {
    ready: true,
    pb,
    swims: dated,
    undated: raw.length - dated.length,
    first,
    lastBest,
    totalDrop: first.hundredths - lastBest.hundredths,
    bestCount: bests.length,
    monthsSinceBest: (now - lastBest.ms) / MONTH,
    monthsSinceSwim: (now - last.ms) / MONTH,
    swimsSinceBest: dated.filter((s) => s.ms > lastBest.ms).length,
    dropLastYear: yearAgo != null ? Math.max(0, yearAgo - lastBest.hundredths) : null,
    typicalDrop: drops.length ? median(drops.slice(-3)) : null,
    typicalDropN: Math.min(3, drops.length),
    // Null until there are enough swims for "typical" to mean anything.
    recentOffPct: recentOff.length >= OFF_PB_SWIMS ? median(recentOff) : null,
    seasons,
  };
}

// ---------------------------------------------------------------------------
// Focus for one event

const label = (e) => `${e.raced} ${e.stroke}`;
const isSprint = (e) => e.distance <= SPRINT_MAX;

/** Stroke events trail, or lead, the same stroke at the other end of the range. */
function rangeGap(me, events) {
  if (me.stroke === "Individual Medley") return imGap(me, events);

  const others = events.filter((e) => e !== me && isSprint(e) !== isSprint(me));
  const sameStroke = others.filter((e) => e.stroke === me.stroke);
  // Without the same stroke at the other end, fall back to the other strokes.
  const pool = sameStroke.length ? sameStroke : others.filter((e) => STROKES.includes(e.stroke));
  if (!pool.length) return null;
  const scope = sameStroke.length ? `in ${me.stroke}` : "in the other strokes";

  const ref = mean(pool.map((e) => e.rung));
  const diff = ref - me.rung;
  if (diff < CLASS_GAP) return null;

  const long = !isSprint(me);
  return {
    kind: long ? "endurance-gap" : "speed-gap",
    weight: 55 + diff * 15,
    headline: long
      ? `${label(me)} trails the sprints`
      : `${label(me)} trails the longer events`,
    detail: long
      ? `${rungLabel(me.rung)} here against ${rungLabel(ref)} at 50-100 ${scope}. The speed is there; holding it over the distance is what trails.`
      : `${rungLabel(me.rung)} here against ${rungLabel(ref)} at 200 and up ${scope}. The endurance is there; the raw speed trails.`,
    evidence: `${diff.toFixed(1)} standards behind`,
    action: long
      ? "Build endurance and race resilience: threshold sets on short rest, descending distance swims, and broken swims at goal pace."
      : "Build speed: short maximum-effort sprints with full rest, fast starts and breakouts, and sharp turns.",
  };
}

/** The IM against the four strokes, naming the stroke that pulls it down. */
function imGap(me, events) {
  const strokes = events.filter((e) => STROKES.includes(e.stroke));
  if (strokes.length < 3) return null;

  const diff = mean(strokes.map((e) => e.rung)) - me.rung;
  if (diff < IM_GAP) return null;

  const byStroke = new Map();
  for (const e of strokes) byStroke.set(e.stroke, [...(byStroke.get(e.stroke) ?? []), e.rung]);
  const weakest = [...byStroke.entries()]
    .map(([stroke, rungs]) => ({ stroke, mean: mean(rungs) }))
    .sort((a, b) => a.mean - b.mean)[0];

  return {
    kind: "im-gap",
    weight: 55 + diff * 15,
    headline: `${label(me)} trails the individual strokes`,
    detail: `${rungLabel(me.rung)} here against ${rungLabel(mean(strokes.map((e) => e.rung)))} across the strokes. ${weakest.stroke} is the weakest leg on record, at ${rungLabel(weakest.mean)}.`,
    evidence: `${diff.toFixed(1)} standards behind`,
    action: `Give ${weakest.stroke} extra technique and set volume; the IM exposes it.`,
  };
}

/** This event against the swimmer's whole programme in the course. */
function standing(me, events) {
  const others = events.filter((e) => e !== me);
  if (others.length < STANDING_MIN_OTHERS) return null;

  const ref = mean(others.map((e) => e.rung));
  const diff = me.rung - ref;
  if (Math.abs(diff) < STANDING_GAP) return null;

  const behind = diff < 0;
  return {
    kind: behind ? "behind-programme" : "ahead-programme",
    weight: 35 + Math.abs(diff) * 8,
    headline: behind
      ? `${label(me)} trails the rest of the programme`
      : `${label(me)} is ahead of the rest of the programme`,
    detail: `${rungLabel(me.rung)} here against ${rungLabel(ref)} on average across ${others.length} other events.`,
    evidence: `${Math.abs(diff).toFixed(1)} standards ${behind ? "behind" : "ahead"}`,
    action: behind
      ? "Give this event more race-pace volume until it stops trailing the rest."
      : "Use it as the anchor: protect it with race-pace work while the weaker events catch up.",
  };
}

function stall(prog) {
  if (
    prog.monthsSinceBest < STALL_MONTHS ||
    prog.swimsSinceBest < STALL_SWIMS ||
    prog.monthsSinceSwim > STALL_MONTHS // no longer racing the event
  ) {
    return null;
  }
  const months = Math.floor(prog.monthsSinceBest);
  return {
    kind: "stall",
    weight: 70,
    headline: "No personal best in over a year",
    detail: `${prog.swimsSinceBest} swims since the best of ${formatTime(prog.lastBest.hundredths)}. The event is being raced but not improving.`,
    evidence: `${months} months, ${prog.swimsSinceBest} swims`,
    action:
      "A flat stretch often needs a change of stimulus: race-pace sets, or a different training emphasis. Raise it with the coach.",
  };
}

function consistency(prog) {
  if (prog.recentOffPct == null || prog.recentOffPct < OFF_PB_PCT) return null;
  if (prog.monthsSinceSwim > 18) return null; // history, not current form
  return {
    kind: "consistency",
    weight: 50 + Math.min(prog.recentOffPct, 6) * 2,
    headline: "The best swim is not the usual swim",
    detail: `The typical swim of the last ${OFF_PB_SWIMS} was ${prog.recentOffPct.toFixed(1)}% slower than the best the swimmer had already done. The best is ${formatTime(prog.lastBest.hundredths)}.`,
    evidence: `${prog.recentOffPct.toFixed(1)}% off the best`,
    action:
      "Work on repeatable racing: a fixed pacing plan, turns and finishes, and rehearsing goal pace so the best swim becomes the normal one.",
  };
}

/**
 * The back half of the race against the front half, from the best swim's splits.
 * A slower back half has two honest causes: a front half that was too fast, or
 * endurance that runs out. The suggestion addresses both.
 */
function fade(h) {
  if (!h || h.pct < FADE_PCT) return null;
  return {
    kind: "fade",
    weight: 58 + Math.min(h.pct, 10) * 2,
    headline: "The back half of the best swim is much slower than the front",
    detail: `${formatTime(h.first)} for the front half, ${formatTime(h.second)} for the back. Either the front half is too fast, or the legs and lungs run out before the wall.`,
    evidence: `back half ${h.pct.toFixed(1)}% slower`,
    action:
      "Build resilience and pacing: even-split and negative-split swims, broken swims at goal pace, and threshold sets that hold pace on short rest.",
  };
}

function reachableCut(me, prog) {
  if (!me?.next) return null;
  const gap = Math.abs(me.next.gap);
  const pct = (gap / me.hundredths) * 100;
  if (pct > CLOSE_PCT) return null;

  const typical = prog?.ready ? prog.typicalDrop : null;
  const pace =
    typical > 0
      ? ` The last ${prog.typicalDropN} personal bests dropped ${formatTime(typical)} on average, so about ${Math.ceil(gap / typical)} more at that pace.`
      : "";
  return {
    kind: "reachable-cut",
    weight: 45 + (CLOSE_PCT - pct) * 10,
    headline: `${me.next.level} is ${formatTime(gap)} away`,
    detail: `${formatTime(me.hundredths)} now — ${me.next.level} is ${formatTime(me.next.cut)}.${pace}`,
    evidence: `${formatDelta(me.next.gap)}, ${pct.toFixed(1)}% off`,
    action: "Plan the next taper meet around this cut.",
  };
}

/**
 * The ranked focus list for one event.
 *
 * History rules need only the swims. Ladder rules also need standards: without a
 * gender or age group they are skipped, not guessed.
 *
 * `halves` is optional and comes from splits.js halves(); without it the fade
 * rule is simply absent.
 *
 * @returns {{findings:Array}}
 */
export function adviseEvent(groups, row, std, course, prog, limit = 3, { halves = null } = {}) {
  const findings = [];

  if (prog?.ready) findings.push(stall(prog), consistency(prog));
  findings.push(fade(halves));

  if (std?.data && std.gender && std.ageGroup) {
    const events = profile(groups, std, course);
    const me = events.find((e) => e.stroke === row.stroke && e.distance === row.distance);
    if (me) {
      const range = rangeGap(me, events);
      findings.push(range, range ? null : standing(me, events), reachableCut(me, prog));
    }
  }

  return {
    findings: findings
      .filter(Boolean)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit),
  };
}
