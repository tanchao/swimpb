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
import {
  AGE_GROUPS,
  AGE_GROUP_LABEL,
  GENDERS,
  GENDER_LABEL,
  cutsFor,
  levelFor,
  nextCut,
} from "./standards.js";
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

/**
 * The six motivational cuts for one cell, or null when there is no standard to
 * measure against — no gender chosen, an age past 18, or an event not in the
 * published set.
 */
function cutsForCell(row, course, std) {
  if (!std?.data || !std.gender || !std.ageGroup) return null;
  return cutsFor(std.data, {
    gender: std.gender,
    ageGroup: std.ageGroup,
    course,
    distance: row.distance,
    stroke: row.stroke,
  });
}

/**
 * The achieved-standard chip. Deliberately absent in two cases, which the gap
 * line in the highlighted column disambiguates:
 *   - no published standard for the event → nothing to say
 *   - slower than B → say it as a target ("B −1.20"), not as a failing mark
 */
function chipHtml(hundredths, cuts, context) {
  const got = levelFor(hundredths, cuts);
  if (!got) return "";
  return `<span class="lvl lvl-${got.level.toLowerCase()}" title="${esc(`${got.level} standard · ${context}`)}">${got.level}</span>`;
}

/**
 * The next rung and how much has to come off. An empty span rather than nothing
 * when there is no cut to chase: it reserves the same line in every primary
 * cell, so switching course doesn't leave the column ragged.
 */
function gapHtml(hundredths, cuts) {
  const next = cuts === null ? null : nextCut(hundredths, cuts);
  if (!cuts) return `<span class="gap"></span>`;
  if (!next) {
    return `<span class="gap top" title="Fastest rung on the age-group ladder">AAAA ✓</span>`;
  }
  return `<span class="gap"><span class="gap-lvl">${next.level}</span><span class="gap-d">${formatDelta(next.gap)}</span></span>`;
}

function cellHtml(row, course, primary, std) {
  const cell = cellFor(row, course);
  const cls = `c cell${primary ? " primary" : ""}`;
  const active = Boolean(std?.data && std.gender && std.ageGroup);
  const cuts = active ? cutsForCell(row, course, std) : null;

  // Reserve the gap line in every primary cell once standards are on, whatever
  // the cell holds, so all rows keep the same height.
  const slot = primary && active;

  if (cell.kind === "none") {
    return `<td class="${cls} empty">·${slot ? '<span class="gap"></span>' : ""}</td>`;
  }

  if (cell.kind === "actual") {
    const flag = cell.flag
      ? `<sup class="flag" title="${esc(flagLabel(cell.flag))}">${esc(cell.flag)}</sup>`
      : "";
    // Only a real swim can achieve a standard, so chips are computed here and
    // nowhere else.
    const context = `${GENDER_LABEL[std?.gender] ?? ""} ${std?.ageGroup ?? ""} · ${row.distance} ${row.stroke} ${course}`;
    const chip = chipHtml(cell.hundredths, cuts, context.replace(/\s+/g, " ").trim());
    const gap = slot ? gapHtml(cell.hundredths, cuts) : "";
    return `<td class="${cls}"><span class="t actual">${formatTime(cell.hundredths)}</span>${flag}${chip}${gap}</td>`;
  }

  // A converted time is an estimate and is never a personal best, so it cannot
  // have achieved a standard. No chip, and no target either — chasing a cut
  // with an estimated time would be chasing a number that isn't real.
  return `<td class="${cls}">
    <span class="t converted" title="${esc(explain(row.distance, row.stroke, cell.from, course))}"><span class="tilde">~</span>${formatTime(cell.hundredths)}</span>${slot ? '<span class="gap"></span>' : ""}
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
export function bestTimesTable(groups, primaryCourse, std = null) {
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
            ${COURSES.map((c) => cellHtml(row, c, c === primaryCourse, std)).join("")}
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

/**
 * The ranked focus list. Takes the result of advise() — this stays a pure
 * renderer, so the rules live in advise.js and the state in main.js.
 *
 * Each item shows its own evidence on purpose: the point is a coach or parent
 * can check the reasoning and disagree with it, rather than take it on faith.
 */
export function advicePanel(result, course, edition) {
  if (!result || result.reason === "no-standards") return "";

  if (!result.ready) {
    return `<section class="focus">
      <h3 class="focus-title">Focus</h3>
      <p class="focus-thin">Not enough swims in ${esc(COURSE_LABEL[course] ?? course)} to say anything useful yet${
        result.have ? ` — ${result.have} measurable so far` : ""
      }. Switch course, or come back after another meet.</p>
    </section>`;
  }

  const items = result.findings
    .map(
      (f, i) => `<li class="focus-item" data-kind="${esc(f.kind)}">
        <span class="focus-rank">${i + 1}</span>
        <div class="focus-body">
          <p class="focus-head">${esc(f.headline)}</p>
          <p class="focus-detail">${esc(f.detail)}</p>
        </div>
        <span class="focus-evi">${esc(f.evidence)}</span>
      </li>`,
    )
    .join("");

  return `<section class="focus">
    <h3 class="focus-title">Focus <span class="focus-course">${esc(COURSE_LABEL[course] ?? course)}</span></h3>
    <ol class="focus-list">${items}</ol>
    <p class="focus-note">
      Worked out from this swimmer’s own recorded swims against the
      ${esc(edition ?? "")} age-group standards — real times only, never converted
      estimates. This is <strong>not</strong> a power-point total, an IMX/IMR score
      or a national rank: USA Swimming computes those on its own servers and does
      not expose them here.
    </p>
  </section>`;
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

/**
 * Sign-in row.
 *
 * USA Swimming closed anonymous search and best-times on 2026-08-28, and a
 * browser-only app can't complete the login flow itself — the session is an
 * HttpOnly cookie on their domain and the login endpoints refuse a
 * cross-origin preflight. But times-api accepts the session as headers from any
 * origin, so the user pastes their own in.
 *
 * Collapsed by default so it stays out of the way, and opened automatically the
 * moment a request comes back needing it.
 */
export function sessionBar({ signedIn, needsSession, error }) {
  if (signedIn) {
    return `<div class="signin on">
      <span class="signin-dot" aria-hidden="true"></span>
      <span>Signed in to USA Swimming — search and best times available for this tab.</span>
      <button id="session-clear" class="ghost">Sign out</button>
    </div>`;
  }

  return `<details class="signin"${needsSession ? " open" : ""}>
    <summary>Sign in to USA Swimming${needsSession ? " — required" : ""}</summary>
    <p class="signin-why">
      Searching and loading best times now need a signed-in session. This page can’t
      log in for you: the session is a cookie on <code>usaswimming.org</code> and their
      login endpoints refuse cross-origin requests. Paste your own instead — it is kept
      in this tab only, never written to disk, and is gone when the tab closes.
    </p>
    <ol class="signin-steps">
      <li>Sign in at <a href="https://data.usaswimming.org" target="_blank" rel="noopener">data.usaswimming.org ↗</a></li>
      <li>Open any swimmer’s best-times page</li>
      <li>DevTools → Network → right-click a <code>times-api</code> request → Copy → Copy as cURL</li>
      <li>Paste it below</li>
    </ol>
    <form class="signin-form" id="session-form">
      <input id="session-paste" type="password" autocomplete="off" spellcheck="false"
             placeholder="Paste the copied cURL here" aria-label="Pasted session" />
      <button type="submit">Use session</button>
    </form>
    ${error ? `<p class="signin-err">${esc(error)}</p>` : ""}
  </details>`;
}

export function courseToggle(primary) {
  return COURSES.map(
    (c, i) =>
      `<button class="course-btn${c === primary ? " on" : ""}" data-course="${c}" title="${esc(COURSE_LONG[c])}">${COURSE_LABEL[c]}<kbd>${i + 1}</kbd></button>`,
  ).join("");
}

/**
 * The control row above the board: which standards set the chips are measured
 * against.
 *
 * It exists because the public API has no gender field — only `swimmerAge` — so
 * the set cannot be fully derived. Gender is chosen once and remembered; the age
 * group is derived from the age but stays overridable, which doubles as a way to
 * see what the next age group up demands.
 *
 * @param {{gender:string|null, ageGroup:string|null, autoGroup:string|null,
 *          age:number|null, edition:string|null, ready:boolean}} o
 */
export function standardsBar({ gender, ageGroup, autoGroup, age, edition, ready }) {
  if (!ready) return "";

  const seg = GENDERS.map(
    (g) =>
      `<button class="seg-btn${g === gender ? " on" : ""}" data-gender="${g}">${GENDER_LABEL[g]}</button>`,
  ).join("");

  const opts = [
    `<option value=""${ageGroup === autoGroup ? " selected" : ""}>${
      autoGroup ? `Auto — ${AGE_GROUP_LABEL[autoGroup]}` : "Choose age group"
    }</option>`,
    ...AGE_GROUPS.map(
      (g) =>
        `<option value="${g}"${g === ageGroup && ageGroup !== autoGroup ? " selected" : ""}>${AGE_GROUP_LABEL[g]}</option>`,
    ),
  ].join("");

  // Say why the board has no chips, rather than leaving it looking broken.
  let note = "";
  if (!gender) {
    note = "Pick Girls or Boys to show standards — the public API doesn’t say.";
  } else if (!ageGroup) {
    note =
      age != null && age >= 19
        ? `Motivational standards stop at 18, and this swimmer is ${age}. Choose an age group to compare anyway.`
        : "Choose an age group to show standards.";
  }

  return `<div class="std-bar">
    <span class="std-label">Standards</span>
    <div class="seg" id="gender-toggle">${seg}</div>
    <select id="age-group" aria-label="Age group">${opts}</select>
    ${edition ? `<span class="std-edition" title="USA Swimming National Age Group Motivational Standards">${esc(edition)}</span>` : ""}
    ${note ? `<span class="std-note">${esc(note)}</span>` : ""}
  </div>`;
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
