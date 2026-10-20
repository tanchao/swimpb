// Two reshapes of the same swim history, both for one course:
//
//   ageBest()   one row per event, one column per age, fastest time at each age
//   meetsByDate() one row per meet, one column per event, every swim at that meet
//
// Pure, like the rest. Real swims only: both read row.history, which is built from
// recorded swims, never from conversions.

import { cutsFor, ageGroupFor, levelFor } from "./standards.js";
import { parseDay } from "./progress.js";

/**
 * Fastest swim at each age, per event.
 *
 * Drop is against the nearest younger age that has a time, which is the previous
 * year when the swimmer raced the event that year. `gap` says how many years
 * that comparison spans, so the view can say so when it is more than one.
 *
 * Swims with no age on record cannot be placed in a column; they are counted in
 * `unaged` so the view can say so.
 *
 * @returns {{ages:number[], unaged:number, rows:Array}}
 *   ages are descending (newest first); each row is
 *   {stroke, distance, cells: Map<age, {hundredths, flag, swimDate, meetName, id, drop, gap, level}>}
 */
export function ageBest(groups, course, std = null) {
  const rows = [];
  const seen = new Set();
  let unaged = 0;

  for (const { stroke, rows: evRows } of groups) {
    for (const row of evRows) {
      const best = new Map();
      for (const s of row.history?.[course] ?? []) {
        if (s.age == null) {
          unaged++;
          continue;
        }
        const cur = best.get(s.age);
        if (!cur || s.hundredths < cur.hundredths) best.set(s.age, s);
      }
      if (!best.size) continue;

      const ages = [...best.keys()].sort((a, b) => a - b);
      const cells = new Map();
      ages.forEach((age, i) => {
        const s = best.get(age);
        const prevAge = i ? ages[i - 1] : null;
        const group = ageGroupFor(age);
        const cuts =
          std?.data && std.gender && group
            ? cutsFor(std.data, {
                gender: std.gender,
                ageGroup: group,
                course,
                distance: row.distance,
                stroke,
              })
            : null;
        cells.set(age, {
          hundredths: s.hundredths,
          flag: s.flag ?? null,
          swimDate: s.swimDate ?? null,
          meetName: s.meetName ?? null,
          id: s.id ?? null,
          drop: prevAge != null ? s.hundredths - best.get(prevAge).hundredths : null,
          gap: prevAge != null ? age - prevAge : null,
          // The standard for the age group the swimmer was in THEN, not now.
          level: cuts ? (levelFor(s.hundredths, cuts)?.level ?? null) : null,
        });
        seen.add(age);
      });
      rows.push({ stroke, distance: row.distance, cells });
    }
  }

  if (!seen.size) return { ages: [], unaged, rows: [] };

  // Contiguous, so a year with no races shows as a gap instead of vanishing.
  const lo = Math.min(...seen);
  const hi = Math.max(...seen);
  const ages = [];
  for (let a = hi; a >= lo; a--) ages.push(a);
  return { ages, unaged, rows };
}

/**
 * Every meet swum in a course, with every swim at it.
 *
 * Drop is against the previous swim of the same event, in date order, whichever
 * meet that was. `best` marks a swim that was the fastest the swimmer had done to
 * that point. Swims without a readable date cannot be put in order, so they are
 * counted in `undated` and left out.
 *
 * @returns {{events:Array<{stroke,distance}>, meets:Array, undated:number}}
 *   meets are oldest first; each is
 *   {key, name, start, end, swims:number, cells: Map<"stroke|distance", Swim[]>}
 *   Swim = {id, hundredths, flag, ms, age, drop, best}
 */
export function meetsByDate(groups, course) {
  const events = [];
  const meets = new Map();
  let undated = 0;

  for (const { stroke, rows } of groups) {
    for (const row of rows) {
      const raw = row.history?.[course] ?? [];
      const dated = raw
        .map((s) => ({ ...s, ms: parseDay(s.swimDate) }))
        .filter((s) => s.ms != null)
        .sort((a, b) => a.ms - b.ms || b.hundredths - a.hundredths);
      undated += raw.length - dated.length;
      if (!dated.length) continue;

      events.push({ stroke, distance: row.distance });
      const evKey = `${stroke}|${row.distance}`;

      let best = Infinity;
      let previous = null;
      for (const s of dated) {
        const swim = {
          id: s.id ?? null,
          hundredths: s.hundredths,
          flag: s.flag ?? null,
          ms: s.ms,
          age: s.age ?? null,
          drop: previous != null ? s.hundredths - previous : null,
          best: s.hundredths < best,
        };
        previous = s.hundredths;
        best = Math.min(best, s.hundredths);

        // The id is the reliable key; a name alone can repeat across years.
        const key = s.meetId != null ? `id:${s.meetId}` : `name:${s.meetName ?? "Unnamed meet"}:${new Date(s.ms).getUTCFullYear()}`;
        let meet = meets.get(key);
        if (!meet) {
          meet = { key, name: s.meetName ?? "Unnamed meet", start: s.ms, end: s.ms, swims: 0, cells: new Map() };
          meets.set(key, meet);
        }
        meet.start = Math.min(meet.start, s.ms);
        meet.end = Math.max(meet.end, s.ms);
        meet.swims++;
        meet.cells.set(evKey, [...(meet.cells.get(evKey) ?? []), swim]);
      }
    }
  }

  return {
    events,
    meets: [...meets.values()].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name)),
    undated,
  };
}
