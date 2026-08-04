// Pure render functions. Each takes data and returns an HTML string; all state
// lives in main.js. Nothing here touches the network.

import {
  COURSES,
  COURSE_LABEL,
  COURSE_LONG,
  canonicalDistance,
  convert,
  explain,
  mapDistance,
} from "./convert.js";
import { flagLabel, formatDelta, formatTime, parseTime } from "./time.js";

const STROKE_ORDER = ["Freestyle", "Backstroke", "Breaststroke", "Butterfly", "Individual Medley"];
const STROKE_KEY = {
  Freestyle: "fr",
  Backstroke: "bk",
  Breaststroke: "br",
  Butterfly: "fl",
  "Individual Medley": "im",
};

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/**
 * Reshape the flat best-times list into stroke → distance → per-course cells.
 * The API returns one record per (stroke, distance, course), so a distance row
 * gathers up to three of them.
 */
export function groupBestTimes(records) {
  const byStroke = new Map();

  for (const r of records) {
    if (!byStroke.has(r.strokeName)) byStroke.set(r.strokeName, new Map());
    const rows = byStroke.get(r.strokeName);
    // Key on the yards-canonical distance so a 500 free (SCY) and a 400 free
    // (SCM/LCM) land on the same row — they are the same event, raced in
    // different pools.
    const key = canonicalDistance(r.distance, r.strokeName);
    if (!rows.has(key)) {
      rows.set(key, { distance: key, stroke: r.strokeName, actual: {} });
    }
    const parsed = parseTime(r.swimTime);
    rows.get(key).actual[r.courseCode] = {
      hundredths: parsed.hundredths,
      flag: parsed.flag,
      raw: r.swimTime,
      distance: r.distance, // as actually raced, needed when converting from it
    };
  }

  return STROKE_ORDER.filter((s) => byStroke.has(s))
    .concat([...byStroke.keys()].filter((s) => !STROKE_ORDER.includes(s)))
    .map((stroke) => ({
      stroke,
      rows: [...byStroke.get(stroke).values()].sort((a, b) => a.distance - b.distance),
    }));
}

/**
 * For one distance row, the value to show in a course column: a real swim when
 * one exists, otherwise a conversion from the swimmer's fastest other course.
 */
function cellFor(row, course) {
  const actual = row.actual[course];
  if (actual?.hundredths != null) {
    return { kind: "actual", hundredths: actual.hundredths, flag: actual.flag };
  }

  // Prefer converting from the closest course: SCM and LCM share pool units, so
  // an SCM source beats a yards source when estimating LCM, and vice versa.
  const preference = {
    SCY: ["SCM", "LCM"],
    SCM: ["SCY", "LCM"],
    LCM: ["SCM", "SCY"],
  }[course];

  for (const src of preference) {
    const from = row.actual[src];
    if (from?.hundredths == null) continue;
    // Convert from the distance actually raced in the source course.
    const h = convert(from.hundredths, from.distance ?? row.distance, row.stroke, src, course);
    if (h != null) return { kind: "converted", hundredths: h, from: src };
  }
  return { kind: "none" };
}

function cellHtml(row, course, primary) {
  const cell = cellFor(row, course);
  const cls = `c cell${primary ? " primary" : ""}`;

  if (cell.kind === "none") {
    return `<td class="${cls} empty">·</td>`;
  }

  if (cell.kind === "actual") {
    const flag = cell.flag
      ? `<sup class="flag" title="${esc(flagLabel(cell.flag))}">${esc(cell.flag)}</sup>`
      : "";
    return `<td class="${cls}"><span class="t actual">${formatTime(cell.hundredths)}</span>${flag}</td>`;
  }

  return `<td class="${cls}">
    <span class="t converted" title="${esc(explain(row.distance, row.stroke, cell.from, course))}"><span class="tilde">~</span>${formatTime(cell.hundredths)}</span>
  </td>`;
}

const COURSE_LEN = { SCY: "25 yd", SCM: "25 m", LCM: "50 m" };

/**
 * The board: ONE table, with stroke groups as full-width rows inside it.
 *
 * Column order is fixed (Yards, Short Meters, Long Meters) and the selected
 * course is highlighted rather than moved. Reordering columns on every toggle
 * meant the number you were reading jumped sideways; a fixed grid with a strong
 * band keeps the comparison legible and still answers "what is this in meters?"
 * at a glance.
 */
export function bestTimesTable(groups, primaryCourse) {
  if (!groups.length) {
    return `<p class="empty-state">No times on record for this swimmer.</p>`;
  }

  const head = COURSES.map(
    (c) =>
      `<th class="c${c === primaryCourse ? " primary" : ""}" data-course="${c}" title="${esc(COURSE_LONG[c])}">
        ${COURSE_LABEL[c]}<span class="len">${COURSE_LEN[c]}</span>
      </th>`,
  ).join("");

  let i = 0;
  const body = groups
    .map(({ stroke, rows }) => {
      const group = `<tr class="grp" data-stroke="${STROKE_KEY[stroke] ?? "other"}" style="--i:${i++}">
        <th colspan="${COURSES.length + 1}" scope="colgroup">${esc(stroke)}</th>
      </tr>`;

      const evRows = rows
        .map((row) => {
          // State the metric distance once, in the label, instead of repeating
          // it under every meters cell.
          const metric = mapDistance(row.distance, row.stroke, "SCY", "LCM");
          const alt = metric !== row.distance ? `<span class="alt">/ ${metric} m</span>` : "";
          return `<tr class="ev-row" style="--i:${i++}">
            <th scope="row" class="ev">${row.distance}${alt}</th>
            ${COURSES.map((c) => cellHtml(row, c, c === primaryCourse)).join("")}
          </tr>`;
        })
        .join("");

      return group + evRows;
    })
    .join("");

  return `<div class="pb-wrap">
    <table class="pb">
      <colgroup>
        <col class="ev-col" />
        ${COURSES.map(() => '<col class="c-col" />').join("")}
      </colgroup>
      <thead><tr><th class="ev">Event</th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

export function swimmerCard(s, { pinned = false, active = false } = {}) {
  const meta = [s.clubName, s.lscCode, s.swimmerAge != null ? `age ${s.swimmerAge}` : null]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  return `<button class="swimmer${active ? " active" : ""}" data-member="${esc(s.memberId)}">
    <span class="sw-name">${esc(s.fullName || s.shortName)}</span>
    <span class="sw-meta">${meta}</span>
    ${pinned ? '<span class="pin-badge" title="Pinned">★</span>' : ""}
  </button>`;
}

export function swimmerList(list) {
  if (!list) return "";
  if (!list.length) {
    return `<p class="empty-state">No swimmers matched. Try a last name only, or turn off “current members only”.</p>`;
  }
  return `<div class="swimmer-list">${list.map((s) => swimmerCard(s)).join("")}</div>`;
}

export function pinnedBar(list, activeId) {
  if (!list.length) return "";
  return `<div class="pinned-bar">
    <span class="pinned-label">Saved</span>
    ${list.map((s) => swimmerCard(s, { pinned: true, active: s.memberId === activeId })).join("")}
  </div>`;
}

export function courseToggle(primary) {
  return COURSES.map(
    (c, i) =>
      `<button class="course-btn${c === primary ? " on" : ""}" data-course="${c}" title="${esc(COURSE_LONG[c])}">${COURSE_LABEL[c]}<kbd>${i + 1}</kbd></button>`,
  ).join("");
}

export function swimmerHeader(s, meta) {
  const bits = [s.clubName, s.lscCode, s.swimmerAge != null ? `age ${s.swimmerAge}` : null]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  // The photo is optional and third-party; if it fails, drop it rather than
  // leaving a broken-image box in the header.
  const avatar = s.profilePicUrl
    ? `<img class="sw-avatar" src="${esc(s.profilePicUrl)}" alt="" onerror="this.remove()">`
    : "";
  return `<div class="sw-header">
    ${avatar}
    <div>
      <h2>${esc(s.fullName || s.shortName || "Swimmer")}</h2>
      <p class="sw-sub">${bits || "&nbsp;"}</p>
    </div>
    <div class="sw-actions">
      <button id="pin-btn" class="ghost${meta.pinned ? " on" : ""}">${meta.pinned ? "★ Saved" : "☆ Save"}</button>
      <a class="ghost" href="${esc(meta.officialUrl)}" target="_blank" rel="noopener">Official ↗</a>
    </div>
  </div>
  <p class="freshness">${esc(meta.freshness)}</p>`;
}

export { formatDelta };
