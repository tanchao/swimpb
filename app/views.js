// Renderers for the views that read the swim history: the event progress report,
// the age-best matrix, the meets table, and the lap-splits box they share. Pure
// like ui.js — data in, an HTML string out — and kept apart from it so the
// splits renderer can be used by both the report and the meets table without a
// circular import.

import { COURSE_LABEL, COURSE_LONG } from "./convert.js";
import { meetCutsFor } from "./regional.js";
import { GENDER_LABEL, nextCut } from "./standards.js";
import { halves, normalizeSplits } from "./splits.js";
import { isoDay } from "./progress.js";
import { flagLabel, formatDelta, formatTime } from "./time.js";
import {
  STROKE_KEY,
  chipHtml,
  cutsForCell,
  esc,
  formatShortDate,
  gapHtml,
  shortMeetName,
} from "./ui.js?v=13";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthYear = (ms) => {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** Vertical room one left-edge label needs, in chart units. */
const LABEL_GAP = 11;

/** Jan 1 and Jul 1 inside [from, to], as UTC milliseconds. */
function halfYearTicks(from, to) {
  const ticks = [];
  const start = new Date(from);
  let year = start.getUTCFullYear();
  for (let i = 0; i < 80; i++) {
    for (const month of [0, 6]) {
      const t = Date.UTC(year, month, 1);
      if (t >= from && t <= to) ticks.push(t);
    }
    year++;
    if (Date.UTC(year, 0, 1) > to) break;
  }
  return ticks;
}

/**
 * Time against date. Slower is higher, so the line FALLS as the swimmer gets
 * faster. Every swim is a dot and the best-so-far is a step line. Dates are
 * marked every half year.
 *
 * Goals are the cuts still to reach: the next motivational standard (kind
 * "level") and each meet qualifying time not yet met (kind "meet"). A goal joins
 * the scale only when it is within one full range of the swims, so a far-off cut
 * cannot squash the history; it keeps its name at the bottom edge, marked with an arrow.
 *
 * @param goals Array<{kind:"level"|"meet", label:string, cut:number}>
 */
export function progressChart(prog, goals = []) {
  const swims = prog?.swims ?? [];
  if (swims.length < 2) return "";

  const W = 680;
  const H = 180;
  const L = 128;
  const R = 12;
  const T = 12;
  const B = 24;

  const times = swims.map((s) => s.hundredths);
  let lo = Math.min(...times);
  let hi = Math.max(...times);
  const span = Math.max(hi - lo, 1);

  const shown = goals.filter((g) => g.cut >= lo - span);
  for (const g of shown) lo = Math.min(lo, g.cut);
  const pad = Math.max((hi - lo) * 0.08, 1);
  lo -= pad;
  hi += pad;

  const x0 = swims[0].ms;
  const x1 = swims[swims.length - 1].ms;
  const xs = Math.max(x1 - x0, 1);
  const px = (ms) => (L + ((ms - x0) / xs) * (W - L - R)).toFixed(1);
  // Slow at the top, fast at the bottom.
  const py = (h) => (T + ((hi - h) / (hi - lo)) * (H - T - B)).toFixed(1);

  let step = "";
  let best = null;
  for (const s of swims) {
    if (!s.isBest) continue;
    step += best === null ? `M${px(s.ms)} ${py(s.hundredths)}` : `H${px(s.ms)}V${py(s.hundredths)}`;
    best = s.hundredths;
  }
  step += `H${px(x1)}`;

  const dots = swims
    .map(
      (s) =>
        `<circle class="rp-dot${s.isBest ? " best" : ""}" cx="${px(s.ms)}" cy="${py(s.hundredths)}" r="${s.isBest ? 3.4 : 2.4}"><title>${esc(`${formatTime(s.hundredths)} · ${isoDay(s.ms)}`)}</title></circle>`,
    )
    .join("");

  const goalLines = shown
    .map((g) => `<line class="rp-cut ${g.kind}" x1="${L}" x2="${W - R}" y1="${py(g.cut)}" y2="${py(g.cut)}"/>`)
    .join("");

  // Every time on the left edge is one label: the slowest swim, each goal, and the
  // fastest swim unless a goal already sits there. They live outside the plot, so
  // two cuts a second apart can be pushed apart without hiding either line.
  // A goal too far off the scale has no line; it is pinned to the bottom with an arrow.
  const floor = H - B + 4;
  const labels = [{ y: T + 4, text: formatTime(Math.round(hi - pad)), kind: "axis" }];
  if (!shown.length || Math.min(...shown.map((g) => g.cut)) > lo + pad + 0.5) {
    labels.push({ y: floor, text: formatTime(Math.round(lo + pad)), kind: "axis" });
  }
  for (const g of shown) labels.push({ y: Number(py(g.cut)) + 3, text: `${g.label} ${formatTime(g.cut)}`, kind: g.kind });
  for (const g of goals.filter((x) => !shown.includes(x))) {
    labels.push({ y: floor, text: `${g.label} ${formatTime(g.cut)} ↓`, kind: g.kind, off: true });
  }
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + LABEL_GAP);
  labels[labels.length - 1].y = Math.min(labels[labels.length - 1].y, floor);
  for (let i = labels.length - 2; i >= 0; i--) labels[i].y = Math.min(labels[i].y, labels[i + 1].y - LABEL_GAP);
  const axisLabels = labels
    .map(
      (l) =>
        `<text class="rp-axis rp-goal ${l.kind}" x="${L - 6}" y="${l.y.toFixed(1)}" text-anchor="end">${esc(l.text)}${
          l.off ? "<title>Below the chart: faster than the scale shows</title>" : ""
        }</text>`,
    )
    .join("");

  // A tick every half year; a long history labels only the Januaries.
  const ticks = halfYearTicks(x0, x1);
  const labelAll = ticks.length <= 9;
  const tickMarks = ticks
    .map((t) => {
      const jan = new Date(t).getUTCMonth() === 0;
      const label = labelAll || jan ? `<text class="rp-axis" x="${px(t)}" y="${H - 6}" text-anchor="middle">${esc(monthYear(t))}</text>` : "";
      return `<line class="rp-tick" x1="${px(t)}" x2="${px(t)}" y1="${T}" y2="${H - B}"/>${label}`;
    })
    .join("");
  // A history shorter than half a year has no tick to label, so name its ends.
  const ends = ticks.length
    ? ""
    : `<text class="rp-axis" x="${L}" y="${H - 6}">${esc(monthYear(x0))}</text><text class="rp-axis" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(monthYear(x1))}</text>`;

  return `<figure class="rp-fig"><svg class="rp-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
    `${swims.length} swims from ${monthYear(x0)} to ${monthYear(x1)}, best ${formatTime(best)}`,
  )}">
    <line class="rp-grid" x1="${L}" x2="${W - R}" y1="${T}" y2="${T}"/>
    <line class="rp-grid" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
    ${tickMarks}${ends}
    ${axisLabels}
    ${goalLines}
    <path class="rp-step" d="${step}"/>
    ${dots}
  </svg></figure>`;
}

function reportStat(label, value, sub = "") {
  return `<div class="rp-stat"><dt>${esc(label)}</dt><dd>${value}${sub ? `<span>${esc(sub)}</span>` : ""}</dd></div>`;
}

/**
 * The progress report for one event, shown in a side drawer.
 *
 * @param {{row, course, prog, advice, std, edition, splits}} r
 *   prog is progress(), advice is adviseEvent() — this stays a pure renderer.
 *   splits is {open:Set<id>, get:(id)=>info} for the inline lap-split rows.
 */
export function eventReport({ row, course, prog, advice, std, edition, splits }) {
  const title = `${row.distance} ${row.stroke}`;
  const head = `<header class="rp-head">
    <div>
      <h3>${esc(title)}</h3>
      <p class="rp-sub">${esc(COURSE_LONG[course] ?? course)}</p>
    </div>
    <button type="button" class="ghost" id="report-close" aria-label="Close progress report">Close ✕</button>
  </header>`;

  if (!prog.ready && prog.reason === "no-swim") {
    return `${head}<p class="rp-empty">No real swim on record in ${esc(COURSE_LABEL[course] ?? course)}. A converted estimate is not a swim, so there is nothing to report. Switch course to see this event where it has been raced.</p>`;
  }

  const cuts = cutsForCell(row, course, std);
  const ctx = `${GENDER_LABEL[std?.gender] ?? ""} ${std?.ageGroup ?? ""} · ${title} ${course}`
    .replace(/\s+/g, " ")
    .trim();
  const pbBlock = `<div class="rp-pb">
    <span class="t actual">${formatTime(prog.pb)}</span>${chipHtml(prog.pb, cuts, ctx)}${cuts ? gapHtml(prog.pb, cuts) : ""}
  </div>`;

  if (!prog.ready) {
    return `${head}${pbBlock}<p class="rp-empty">The swim history is not loaded, so there is no progression to show yet. It arrives with the best times; if it does not, sign in again.</p>`;
  }

  // Both kinds of goal: the next motivational standard, and every meet cut not yet met.
  const next = cuts ? nextCut(prog.pb, cuts) : null;
  const goals = [
    ...(next ? [{ kind: "level", label: next.level, cut: next.cut }] : []),
    ...(std?.regional && std.gender && std.ageGroup
      ? meetCutsFor(std.regional, {
          gender: std.gender,
          ageGroup: std.ageGroup,
          course,
          distance: row.distance,
          stroke: row.stroke,
        })
          .filter((m) => m.cut < prog.pb)
          .map((m) => ({ kind: "meet", label: m.label, cut: m.cut }))
      : []),
  ];
  const stats = [
    reportStat("Swims on record", String(prog.swims.length), prog.undated ? `${prog.undated} undated` : ""),
    reportStat(
      "Personal bests set",
      String(prog.bestCount),
      `first ${formatTime(prog.first.hundredths)} · ${formatShortDate(isoDay(prog.first.ms))}`,
    ),
    reportStat(
      "Total drop",
      prog.totalDrop > 0 ? formatDelta(-prog.totalDrop) : "none yet",
      prog.totalDrop > 0 ? `${((prog.totalDrop / prog.first.hundredths) * 100).toFixed(1)}% of the first swim` : "",
    ),
    reportStat(
      "Last 12 months",
      prog.dropLastYear == null ? "—" : prog.dropLastYear > 0 ? formatDelta(-prog.dropLastYear) : "no drop",
      prog.dropLastYear == null ? "no swim older than a year" : "",
    ),
  ].join("");

  const seasons = [...prog.seasons]
    .reverse()
    .slice(0, 6)
    .map(
      (s) =>
        `<tr><th scope="row">${esc(s.label)}</th><td>${s.swims}</td><td class="t">${formatTime(s.best)}</td><td class="${
          s.change == null ? "" : s.change < 0 ? "dp" : s.change > 0 ? "ad" : ""
        }">${s.change == null ? "" : s.change === 0 ? "=" : formatDelta(s.change)}</td></tr>`,
    )
    .join("");

  // Every swim, newest first. Drop is against the swim before it, so a run of
  // small drops and one bad meet are both visible.
  const swimRows = [...prog.swims]
    .reverse()
    .map((s) => {
      const flag = s.flag ? `<sup class="flag" title="${esc(flagLabel(s.flag))}">${esc(s.flag)}</sup>` : "";
      const mark = s.isBest ? `<b class="mt-pb" title="Fastest the swimmer had swum up to that day">PB</b>` : "";
      const drop =
        s.delta == null ? "" : s.delta === 0 ? "=" : formatDelta(s.delta);
      const meta = { hundredths: s.hundredths, stroke: row.stroke, distance: row.distance, course };
      const open = s.id != null && splits?.open?.has(s.id);
      const btn =
        s.id != null
          ? `<button type="button" class="sp-btn" data-splits="${esc(s.id)}" aria-expanded="${Boolean(open)}">Splits</button>`
          : "";
      const detail = open
        ? `<tr class="sp-row"><td colspan="6">${splitsBox(splits.get(s.id), meta)}</td></tr>`
        : "";
      return `<tr><th scope="row">${esc(formatShortDate(isoDay(s.ms)))}</th><td>${s.age ?? ""}</td><td class="t">${formatTime(s.hundredths)}${flag}${mark}</td><td class="${
        s.delta == null ? "" : s.delta < 0 ? "dp" : s.delta > 0 ? "ad" : ""
      }">${drop}</td><td class="rp-meet" title="${esc(s.meetName ?? "")}">${esc(shortMeetName(s.meetName))}</td><td>${btn}</td></tr>${detail}`;
    })
    .join("");

  const items = advice.findings.length
    ? advice.findings
        .map(
          (f, i) => `<li class="focus-item" data-kind="${esc(f.kind)}">
        <span class="focus-rank">${i + 1}</span>
        <div class="focus-body">
          <p class="focus-head">${esc(f.headline)}</p>
          <p class="focus-detail">${esc(f.detail)}</p>
          <p class="rp-action"><strong>Try:</strong> ${esc(f.action)}</p>
        </div>
        <span class="focus-evi">${esc(f.evidence)}</span>
      </li>`,
        )
        .join("")
    : `<li class="focus-thin">Nothing stands out for this event: no stall, no gap to the rest of the programme, and recent swims sit close to the best. ${
        std?.data && std.gender && std.ageGroup ? "" : "Choose a gender and age group to compare against the standards."
      }</li>`;

  return `${head}
    ${pbBlock}
    <dl class="rp-stats">${stats}</dl>
    ${progressChart(prog, goals)}
    <div class="rp-tables">
      <div class="rp-scroll"><table class="rp-table"><caption>Every swim, newest first · drop is against the swim before</caption><thead><tr><th>Date</th><th>Age</th><th>Time</th><th>Drop</th><th>Meet</th><th></th></tr></thead><tbody>${swimRows}</tbody></table></div>
      <table class="rp-table"><caption>By season</caption><thead><tr><th>Season</th><th>Swims</th><th>Best</th><th>Change</th></tr></thead><tbody>${seasons}</tbody></table>
    </div>
    <section class="focus rp-focus">
      <h3 class="focus-title">Focus for this event <span class="focus-course">${esc(COURSE_LABEL[course] ?? course)}</span></h3>
      <ol class="focus-list">${items}</ol>
      <p class="focus-note">
        Worked out from this event’s recorded swims, and from how it sits against
        this swimmer’s other events on the ${esc(edition ?? "")} age-group standards.
        Real times only. “Compared to others” means the swimmer’s own other events,
        not other swimmers. The suggestions are starting points for a conversation
        with the coach, not a training plan.
      </p>
    </section>`;
}


// ---------------------------------------------------------------------------
// Lap splits

/**
 * The lap splits of one swim, from whatever state their fetch is in.
 *
 * @param info  undefined | {status:"loading"} | {status:"error", message}
 *              | {status:"ready", detail}   — detail is the AllTimes/SwimTime body
 * @param meta  {hundredths, stroke, distance, course}
 */
export function splitsBox(info, meta) {
  const box = (inner) => `<div class="splits-box">${inner}</div>`;
  if (!info || info.status === "loading") return box(`<p class="sp-note">Loading lap splits…</p>`);
  if (info.status === "error") return box(`<p class="sp-note err">${esc(info.message)}</p>`);

  const n = normalizeSplits(info.detail?.splits, meta.hundredths, meta);
  if (n.status === "none") {
    return box(`<p class="sp-note">No lap splits are on record for this swim.</p>`);
  }
  if (n.status === "unrecognised") {
    return box(
      `<p class="sp-note">USA Swimming returned splits in a shape this app does not recognise, so none are shown.</p>`,
    );
  }
  if (n.status === "unverified") {
    return box(`<p class="sp-note">These splits do not add up to the final time of ${esc(formatTime(meta.hundredths))}, so they are shown as received, with no analysis.</p>
      <p class="sp-raw">${n.values.map((v) => esc(formatTime(v))).join(" · ")}</p>`);
  }

  const rows = n.laps
    .map(
      (l) =>
        `<tr><th scope="row">${l.distance ?? `#${l.n}`}</th><td class="t">${formatTime(l.lap)}</td><td class="t">${formatTime(l.cumulative)}</td></tr>`,
    )
    .join("");
  const h = halves(n, meta.stroke);
  const halfLine = h
    ? `<p class="sp-half">Front half <strong>${formatTime(h.first)}</strong> · back half <strong>${formatTime(h.second)}</strong> · <span class="${
        h.pct > 0 ? "ad" : "dp"
      }">${h.pct > 0 ? "+" : "−"}${Math.abs(h.pct).toFixed(1)}%</span></p>`
    : "";
  const how = n.appended
    ? "Running totals, with the final lap taken from the final time."
    : n.mode === "lap"
      ? "Lap times, added up to match the final time."
      : "Running totals, matched to the final time.";
  return box(`<table class="sp-table"><thead><tr><th>Distance</th><th>Lap</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
    ${halfLine}<p class="sp-note">${how}</p>`);
}

// ---------------------------------------------------------------------------
// View tabs

export const VIEWS = [
  { key: "best", label: "Best times" },
  { key: "ages", label: "By age" },
  { key: "meets", label: "Meets" },
];

export function viewTabs(view) {
  return `<div class="view-tabs" role="tablist" aria-label="View">${VIEWS.map(
    (v) =>
      `<button type="button" role="tab" class="view-tab${v.key === view ? " on" : ""}" data-view="${v.key}" aria-selected="${v.key === view}">${esc(v.label)}</button>`,
  ).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Age-best matrix

const evRowOpen = (open, stroke, distance) => open?.stroke === stroke && open?.distance === distance;

/**
 * One row per event, one column per age, newest age first. Each cell is the
 * fastest swim at that age, the standard it earned for the age group the
 * swimmer was in then, and the drop from the previous age raced.
 *
 * Rows open the event progress report, like the board.
 */
export function ageBestTable(data, course, { open = null, std = null } = {}) {
  if (!data.rows.length) {
    return `<p class="empty-state">No swims with an age on record in ${esc(COURSE_LABEL[course] ?? course)}. Switch course, or wait for the swim history to load.</p>`;
  }

  const byStroke = new Map();
  for (const r of data.rows) byStroke.set(r.stroke, [...(byStroke.get(r.stroke) ?? []), r]);
  const totalCols = 1 + data.ages.length;

  const body = [...byStroke.entries()]
    .map(([stroke, rows]) => {
      const group = `<tr class="grp" data-stroke="${STROKE_KEY[stroke] ?? "other"}"><th colspan="${totalCols}" scope="colgroup">${esc(stroke)}</th></tr>`;
      const evRows = rows
        .map((r) => {
          const cells = data.ages
            .map((age) => {
              const c = r.cells.get(age);
              if (!c) return `<td class="ab-cell empty">·</td>`;
              const flag = c.flag ? `<sup class="flag" title="${esc(flagLabel(c.flag))}">${esc(c.flag)}</sup>` : "";
              const chip = c.level
                ? `<span class="lvl lvl-${c.level.toLowerCase()}" title="${esc(`${c.level} standard for age ${age}`)}">${c.level}</span>`
                : "";
              const drop =
                c.drop == null
                  ? ""
                  : `<span class="ab-drop ${c.drop < 0 ? "dp" : c.drop > 0 ? "ad" : ""}"${
                      c.gap > 1 ? ` title="${esc(`against the swim ${c.gap} years earlier`)}"` : ""
                    }>${c.drop === 0 ? "=" : formatDelta(c.drop)}${c.gap > 1 ? `<sup>${c.gap}y</sup>` : ""}</span>`;
              const tip = [c.meetName, c.swimDate ? String(c.swimDate).slice(0, 10) : ""].filter(Boolean).join(" · ");
              return `<td class="ab-cell"${tip ? ` title="${esc(tip)}"` : ""}><span class="t actual">${formatTime(c.hundredths)}</span>${flag}${chip}${drop}</td>`;
            })
            .join("");
          return `<tr class="ev-row" data-stroke="${esc(r.stroke)}" data-distance="${r.distance}" tabindex="0" aria-expanded="${evRowOpen(open, r.stroke, r.distance)}" title="Progress report"><th scope="row" class="ev">${r.distance}</th>${cells}</tr>`;
        })
        .join("");
      return group + evRows;
    })
    .join("");

  const head = data.ages.map((a) => `<th class="ab-th">Age ${a}</th>`).join("");
  const note = [
    data.unaged ? `${data.unaged} swim${data.unaged === 1 ? "" : "s"} with no age on record are left out.` : "",
    !std?.gender ? "Pick Girls or Boys above to show the standard each time reached." : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<div class="pb-wrap dense">
    <table class="pb ab"><thead><tr><th class="ev">Event</th>${head}</tr></thead><tbody>${body}</tbody></table>
  </div>
  <p class="view-note">Fastest recorded swim at each age in ${esc(COURSE_LONG[course] ?? course)}. The standard is for the age group the swimmer was in at that age. Drop is against the previous age raced.${note ? ` ${esc(note)}` : ""}</p>`;
}

// ---------------------------------------------------------------------------
// Meets table

/**
 * One row per meet, one column per event. Each swim shows its time, the drop
 * against the swimmer's previous swim of the event, and a PB marker when it was
 * the fastest to that date. A time opens its lap splits in a row below the meet.
 *
 * @param data   meetsByDate()
 * @param opts   {order:"newest"|"oldest", splits:{open:Set, get:fn}, course, stroke events open}
 */
export function meetsTable(data, course, { order = "newest", splits = null } = {}) {
  if (!data.meets.length) {
    return `<p class="empty-state">No dated swims in ${esc(COURSE_LABEL[course] ?? course)}. Switch course, or wait for the swim history to load.</p>`;
  }

  // Columns grouped by stroke, in the order the events arrived.
  const groups = [];
  for (const e of data.events) {
    const last = groups[groups.length - 1];
    if (last?.stroke === e.stroke) last.events.push(e);
    else groups.push({ stroke: e.stroke, events: [e] });
  }
  const totalCols = 1 + data.events.length;

  const groupHead = groups
    .map(
      (g) =>
        `<th class="mt-grp" colspan="${g.events.length}" data-stroke="${STROKE_KEY[g.stroke] ?? "other"}">${esc(g.stroke)}</th>`,
    )
    .join("");
  const eventHead = data.events.map((e) => `<th class="mt-ev">${e.distance}</th>`).join("");

  const meets = order === "oldest" ? data.meets : [...data.meets].reverse();
  const body = meets
    .map((m) => {
      const span =
        m.start === m.end
          ? formatShortDate(isoDay(m.start))
          : `${formatShortDate(isoDay(m.start))} → ${formatShortDate(isoDay(m.end))}`;
      const opened = [];
      const cells = data.events
        .map((e) => {
          const swims = m.cells.get(`${e.stroke}|${e.distance}`);
          if (!swims) return `<td class="mt-cell empty"></td>`;
          const inner = swims
            .map((s) => {
              const flag = s.flag ? `<sup class="flag" title="${esc(flagLabel(s.flag))}">${esc(s.flag)}</sup>` : "";
              const open = s.id != null && splits?.open?.has(s.id);
              if (open) opened.push({ s, e });
              const time =
                s.id != null
                  ? `<button type="button" class="mt-t" data-splits="${esc(s.id)}" aria-expanded="${Boolean(open)}" title="Lap splits">${formatTime(s.hundredths)}</button>`
                  : `<span class="mt-t plain">${formatTime(s.hundredths)}</span>`;
              const drop =
                s.drop == null
                  ? ""
                  : `<span class="mt-d ${s.drop < 0 ? "dp" : s.drop > 0 ? "ad" : ""}">${s.drop === 0 ? "=" : formatDelta(s.drop)}</span>`;
              const pb = s.best ? `<b class="mt-pb" title="Fastest the swimmer had swum up to that day">PB</b>` : "";
              return `<div class="mt-swim">${time}${flag}${pb}${drop}</div>`;
            })
            .join("");
          return `<td class="mt-cell">${inner}</td>`;
        })
        .join("");

      const details = opened
        .map(({ s, e }) => {
          const meta = { hundredths: s.hundredths, stroke: e.stroke, distance: e.distance, course };
          return `<tr class="sp-row"><td colspan="${totalCols}"><div class="sp-sticky"><p class="sp-title">${esc(`${e.distance} ${e.stroke}`)} · ${esc(formatTime(s.hundredths))} · ${esc(m.name)}</p>${splitsBox(splits.get(s.id), meta)}</div></td></tr>`;
        })
        .join("");

      return `<tr class="mt-row"><th scope="row" class="mt-meet" title="${esc(m.name)}"><span class="mt-name">${esc(shortMeetName(m.name) || m.name)}</span><span class="mt-when">${esc(span)} · ${m.swims} swim${m.swims === 1 ? "" : "s"}</span></th>${cells}</tr>${details}`;
    })
    .join("");

  const flip = order === "oldest" ? "Showing oldest first" : "Showing newest first";
  return `<div class="view-bar"><button type="button" class="ghost" data-meet-order>${flip} · flip</button>
    <span class="view-note">${meets.length} meet${meets.length === 1 ? "" : "s"} in ${esc(COURSE_LONG[course] ?? course)}${
      data.undated ? ` · ${data.undated} swim${data.undated === 1 ? "" : "s"} with no readable date left out` : ""
    }</span></div>
  <div class="pb-wrap dense">
    <table class="pb mt"><thead><tr><th class="ev" rowspan="2">Meet</th>${groupHead}</tr><tr>${eventHead}</tr></thead><tbody>${body}</tbody></table>
  </div>
  <p class="view-note">Click a time to load its lap splits. Drop is against the previous swim of the same event, whichever meet it was at. PB marks the fastest swim to that date.</p>`;
}
