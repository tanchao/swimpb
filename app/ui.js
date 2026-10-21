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
  ageGroupFor,
  cutsFor,
  levelFor,
  nextCut,
} from "./standards.js";
import { meetCutsFor } from "./regional.js";
import { flagLabel, formatDelta, formatTime, parseTime } from "./time.js";

const STROKE_ORDER = ["Freestyle", "Backstroke", "Breaststroke", "Butterfly", "Individual Medley"];
export const STROKE_KEY = {
  Freestyle: "fr",
  Backstroke: "bk",
  Breaststroke: "br",
  Butterfly: "fl",
  "Individual Medley": "im",
};
const ABBR_TO_STROKE = {
  FR: "Freestyle",
  BK: "Backstroke",
  BR: "Breaststroke",
  FL: "Butterfly",
  IM: "Individual Medley",
};

/** Toggleable columns in the consolidated Personal Bests table. */
export const TABLE_COLUMNS = [
  { key: "team", label: "Team", short: "Team", defaultOn: true },
  { key: "lsc", label: "LSC", short: "LSC", defaultOn: true },
  { key: "zone", label: "Zone", short: "Zone", defaultOn: false },
  { key: "us", label: "US", short: "US", defaultOn: false },
  { key: "age", label: "Age", short: "Age", defaultOn: true },
  { key: "pts", label: "Power Pts", short: "Pts", defaultOn: true },
  { key: "mot", label: "B–AAAA Cuts", short: "B–AAAA", defaultOn: true },
  { key: "meets", label: "Meet Cuts", short: "Meet Cuts", defaultOn: true },
  { key: "date", label: "Date", short: "Date", defaultOn: false },
  { key: "meet", label: "Meet", short: "Meet", defaultOn: false },
];

/** Rank columns, in table order. `scope` is the ranking page each cell opens. */
const RANK_COLS = [
  { key: "team", label: "Team", scope: "club", tip: "Team rank this season, at the age of the swim. Click to open the list." },
  { key: "lsc", label: "LSC", scope: "lsc", tip: "LSC rank this season, at the age of the swim. Click to open the list." },
  { key: "zone", label: "Zone", scope: "zone", tip: "Zone rank this season, at the age of the swim. Click to open the list." },
  { key: "us", label: "US", scope: "us", tip: "US rank this season, at the age of the swim. Click to open the list." },
];

export const DEFAULT_COLS = Object.fromEntries(TABLE_COLUMNS.map((c) => [c.key, c.defaultOn]));

export function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

export function formatShortDate(iso) {
  if (!iso || typeof iso !== "string") return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : iso.slice(0, 10);
}

export function shortMeetName(name) {
  if (!name || typeof name !== "string") return "";
  return name.replace(/^\d{4}\s+[A-Z]{2}\s+/, "").trim();
}

/**
 * Infer a swimmer's competition category ("girls" | "boys") from USA Swimming's
 * recorded `timeStandard` labels on their historical swims when available.
 */
export function inferGender(allRecords, standardsData) {
  if (!Array.isArray(allRecords) || !allRecords.length || !standardsData?.standards) return null;
  const scores = { girls: 0, boys: 0 };

  for (const r of allRecords) {
    const std = r.timeStandard;
    const ag = ageGroupFor(r.swimmerAge);
    const parts = (r.eventCode ?? "").trim().split(/\s+/);
    if (!std || !ag || parts.length !== 3) continue;
    const distance = Number(parts[0]);
    const stroke = ABBR_TO_STROKE[parts[1]];
    const course = parts[2];
    const parsed = parseTime(r.swimTime);
    if (!stroke || !distance || parsed.hundredths == null) continue;

    for (const g of GENDERS) {
      const cuts = cutsFor(standardsData, { gender: g, ageGroup: ag, course, distance, stroke });
      if (!cuts) continue;
      const got = levelFor(parsed.hundredths, cuts)?.level ?? "Slower Than B";
      if (got === std) scores[g]++;
    }
  }

  if (scores.girls > scores.boys) return "girls";
  if (scores.boys > scores.girls) return "boys";
  return null;
}

/**
 * Reshape the flat best-times list into stroke → distance → per-course cells,
 * optionally enriched with full swim history from `GetAllTimesForFilters`.
 */
export function groupBestTimes(records, allRecords = []) {
  const byStroke = new Map();

  // Index all historical swims by (stroke, canonicalDistance, courseCode)
  const historyMap = new Map();
  if (Array.isArray(allRecords)) {
    for (const r of allRecords) {
      const parts = (r.eventCode ?? "").trim().split(/\s+/);
      if (parts.length !== 3) continue;
      const dist = Number(parts[0]);
      const stroke = ABBR_TO_STROKE[parts[1]];
      const course = r.courseCode || parts[2];
      const parsed = parseTime(r.swimTime);
      if (!stroke || !dist || !course || parsed.hundredths == null) continue;
      const canon = canonicalDistance(dist, stroke);
      const hKey = `${stroke}|${canon}|${course}`;
      if (!historyMap.has(hKey)) historyMap.set(hKey, []);
      historyMap.get(hKey).push({
        hundredths: parsed.hundredths,
        flag: parsed.flag,
        raw: r.swimTime,
        id: r.swimTimeId ?? null,
        meetId: r.meetId ?? null,
        distance: dist,
        swimDate: r.swimDate ?? null,
        age: r.swimmerAge ?? null,
        meetName: r.meetName ?? null,
        powerPoints: r.powerPoints ?? null,
        timeStandard: r.timeStandard ?? null,
      });
    }
  }

  for (const r of records) {
    if (!byStroke.has(r.strokeName)) byStroke.set(r.strokeName, new Map());
    const rows = byStroke.get(r.strokeName);
    // Key on the yards-canonical distance so a 500 free (SCY) and a 400 free
    // (SCM/LCM) land on the same row — they are the same event, raced in
    // different pools.
    const key = canonicalDistance(r.distance, r.strokeName);
    if (!rows.has(key)) {
      rows.set(key, { distance: key, stroke: r.strokeName, actual: {}, history: {} });
    }
    const parsed = parseTime(r.swimTime);
    const hKey = `${r.strokeName}|${key}|${r.courseCode}`;
    const hist = historyMap.get(hKey) ?? [];
    hist.sort(
      (a, b) =>
        a.hundredths - b.hundredths ||
        String(b.swimDate ?? "").localeCompare(String(a.swimDate ?? "")),
    );
    const bestHist = hist[0] ?? null;
    // GetBestTimes can lag a swim that the full history already has. The faster
    // recorded swim is the personal best, and its age, meet, and date stay with it.
    const ahead =
      bestHist && parsed.hundredths != null && bestHist.hundredths < parsed.hundredths ? bestHist : null;
    const timeH = ahead ? ahead.hundredths : parsed.hundredths;
    const pbDate = ahead ? ahead.swimDate : (r.swimDate ?? bestHist?.swimDate ?? null);
    const meta = ahead ?? bestHist;
    const prevSwim =
      hist.slice(1).find((s) => !pbDate || !s.swimDate || s.swimDate < pbDate) ?? hist[1] ?? null;
    const drop = timeH != null && prevSwim?.hundredths != null ? timeH - prevSwim.hundredths : null;

    // Every recorded swim in this event and course, for the progress report.
    rows.get(key).history[r.courseCode] = hist;
    rows.get(key).actual[r.courseCode] = {
      hundredths: timeH,
      flag: ahead ? ahead.flag : parsed.flag,
      raw: ahead ? ahead.raw : r.swimTime,
      distance: r.distance, // as actually raced, needed when converting from it
      swimDate: pbDate,
      age: meta?.age ?? null,
      meetName: meta?.meetName ?? null,
      powerPoints: meta?.powerPoints ?? null,
      swims: hist.length || null,
      drop,
      prevTime: prevSwim?.hundredths ?? null,
      prevDate: prevSwim?.swimDate ?? null,
    };
  }

  // A course the best-times feed has not listed yet still counts. The full
  // history already has it. The yards 200 IM is that case: the feed only has
  // the long-course best, so the yards cell was a conversion of that.
  for (const [hKey, hist] of historyMap) {
    const [stroke, canonStr, course] = hKey.split("|");
    const canon = Number(canonStr);
    if (!stroke || !canon || !course || !hist.length) continue;
    if (!byStroke.has(stroke)) byStroke.set(stroke, new Map());
    const rows = byStroke.get(stroke);
    if (!rows.has(canon)) {
      rows.set(canon, { distance: canon, stroke, actual: {}, history: {} });
    }
    const row = rows.get(canon);
    if (row.actual[course]?.hundredths != null) continue;
    hist.sort(
      (a, b) =>
        a.hundredths - b.hundredths ||
        String(b.swimDate ?? "").localeCompare(String(a.swimDate ?? "")),
    );
    const best = hist[0];
    const prev =
      hist.slice(1).find((s) => !best.swimDate || !s.swimDate || s.swimDate < best.swimDate) ??
      hist[1] ??
      null;
    row.history[course] = hist;
    row.actual[course] = {
      hundredths: best.hundredths,
      flag: best.flag,
      raw: best.raw,
      distance: best.distance ?? canon,
      swimDate: best.swimDate ?? null,
      age: best.age ?? null,
      meetName: best.meetName ?? null,
      powerPoints: best.powerPoints ?? null,
      swims: hist.length,
      drop: prev?.hundredths != null ? best.hundredths - prev.hundredths : null,
      prevTime: prev?.hundredths ?? null,
      prevDate: prev?.swimDate ?? null,
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
export function cutsForCell(row, course, std) {
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
export function chipHtml(hundredths, cuts, context) {
  const got = levelFor(hundredths, cuts);
  if (!got) return "";
  return `<span class="lvl lvl-${got.level.toLowerCase()}" title="${esc(`${got.level} standard · ${context}`)}">${got.level}</span>`;
}

/**
 * The next rung and how much has to come off. An empty span rather than nothing
 * when there is no cut to chase: it reserves the same line in every primary
 * cell, so switching course doesn't leave the column ragged.
 */
export function gapHtml(hundredths, cuts) {
  const next = cuts === null ? null : nextCut(hundredths, cuts);
  if (!cuts) return `<span class="gap"></span>`;
  if (!next) {
    return `<span class="gap top" title="Fastest rung on the age-group ladder">AAAA ✓</span>`;
  }
  return `<span class="gap"><span class="gap-lvl">${next.level}</span><span class="gap-d">${formatDelta(next.gap)}</span></span>`;
}

function qualificationHtml(hundredths, row, course, std) {
  if (!std?.regional || !std.gender || !std.ageGroup) return "";
  const cuts = meetCutsFor(std.regional, {
    gender: std.gender,
    ageGroup: std.ageGroup,
    course,
    distance: row.distance,
    stroke: row.stroke,
  });
  if (!cuts.length) return "";

  return `<span class="quals">${cuts
    .map((meet) => {
      const qualified = hundredths <= meet.cut;
      const title = `${meet.label} ${meet.edition} cut · ${formatTime(meet.cut)}`;
      return `<span class="qual${qualified ? " met" : ""}" title="${esc(title)}"><span class="qual-meet">${esc(meet.label)}</span> ${
        qualified ? "✓" : `<span class="qual-gap">${formatDelta(meet.cut - hundredths)}</span>`
      }</span>`;
    })
    .join("")}</span>`;
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
    const qualification = primary ? qualificationHtml(cell.hundredths, row, course, std) : "";
    return `<td class="${cls}"><span class="t actual">${formatTime(cell.hundredths)}</span>${flag}${chip}${gap}${qualification}</td>`;
  }

  // A converted time is an estimate and is never a personal best, so it cannot
  // have achieved a standard. No chip, and no target either — chasing a cut
  // with an estimated time would be chasing a number that isn't real.
  return `<td class="${cls}">
    <span class="t converted" title="${esc(explain(row.distance, row.stroke, cell.from, course))}"><span class="tilde">~</span>${formatTime(cell.hundredths)}</span>${slot ? '<span class="gap"></span>' : ""}
  </td>`;
}

function rankCellHtml(row, course, ranks, col) {
  const actual = row.actual[course];
  if (actual?.hundredths == null) return `<td class="m-td rk-td empty">·</td>`;
  const key = `${row.stroke}|${row.distance}`;
  const cell = ranks?.[key]?.[col.key];
  const text = cell?.text ?? "…";
  const kind = cell?.kind ?? "wait";
  const title = cell?.title ?? col.tip;
  const scope = cell?.scope ?? col.scope;
  return `<td class="m-td rk-td"><button type="button" class="rk-link ${esc(kind)}" data-rank-open data-rank-cell="${esc(key)}" data-rank-col="${esc(col.key)}" data-stroke="${esc(row.stroke)}" data-distance="${row.distance}" data-rank-scope="${esc(scope)}" title="${esc(title)}">${esc(text)}</button></td>`;
}

function metaCellHtml(row, primaryCourse, key) {
  const actual = row.actual[primaryCourse];
  switch (key) {
    case "age":
      return actual?.age != null
        ? `<td class="m-td m-age">${actual.age}</td>`
        : `<td class="m-td m-age empty">·</td>`;
    case "pts":
      return actual?.powerPoints != null
        ? `<td class="m-td m-pts" title="${actual.powerPoints} USA Swimming Power Points">${actual.powerPoints}</td>`
        : `<td class="m-td m-pts empty">·</td>`;
    case "date": {
      const short = formatShortDate(actual?.swimDate);
      const full = actual?.swimDate ? actual.swimDate.slice(0, 10) : "";
      return short
        ? `<td class="m-td m-date" title="${esc(full)}">${esc(short)}</td>`
        : `<td class="m-td m-date empty">·</td>`;
    }
    case "meet": {
      const short = shortMeetName(actual?.meetName);
      return short
        ? `<td class="m-td m-meet" title="${esc(actual.meetName)}"><span class="meet-clip">${esc(short)}</span></td>`
        : `<td class="m-td m-meet empty">·</td>`;
    }
    default:
      return "";
  }
}

function motCutCellsHtml(row, primaryCourse, std, levels) {
  const cuts = cutsForCell(row, primaryCourse, std);
  const actual = row.actual[primaryCourse];
  const hundredths = actual?.hundredths ?? null;

  if (!cuts) {
    return levels.map(() => `<td class="cut-td empty">·</td>`).join("");
  }

  return levels
    .map((lvl, idx) => {
      const cut = cuts[idx];
      if (cut == null) return `<td class="cut-td empty">·</td>`;
      if (hundredths == null) {
        return `<td class="cut-td ref" title="${esc(`${lvl} cut · ${formatTime(cut)}`)}"><span class="cut-v">${formatTime(cut)}</span></td>`;
      }
      const diff = hundredths - cut;
      const met = diff <= 0;
      const prev = idx === 0 ? Math.round(cut * 1.15) : cuts[idx - 1];
      const pct = met
        ? 100
        : Math.max(0, Math.min(100, Math.round(((prev - hundredths) / Math.max(1, prev - cut)) * 100)));
      const deltaStr = met ? formatDelta(diff) : `+${formatTime(diff)}`;
      return `<td class="cut-td ${met ? "met" : "need"}" title="${esc(`${lvl} cut · ${formatTime(cut)}`)}"><span class="cut-bar" style="width:${pct}%"></span><span class="cut-v">${formatTime(cut)}</span><span class="cut-d ${met ? "dp" : "ad"}">${deltaStr}</span></td>`;
    })
    .join("");
}

function meetCutCellsHtml(row, primaryCourse, std, regionalMeets) {
  const actual = row.actual[primaryCourse];
  const hundredths = actual?.hundredths ?? null;
  const cuts = meetCutsFor(std.regional, {
    gender: std.gender,
    ageGroup: std.ageGroup,
    course: primaryCourse,
    distance: row.distance,
    stroke: row.stroke,
  });
  const byId = new Map(cuts.map((m) => [m.id, m]));

  return regionalMeets
    .map((meet) => {
      const entry = byId.get(meet.id);
      if (!entry) return `<td class="cut-td mc-td empty">·</td>`;
      const cut = entry.cut;
      const tip = `${meet.label} ${meet.edition} cut · ${formatTime(cut)}`;
      if (hundredths == null) {
        return `<td class="cut-td mc-td ref" title="${esc(tip)}"><span class="cut-v">${formatTime(cut)}</span></td>`;
      }
      const diff = hundredths - cut;
      const met = diff <= 0;
      const prev = Math.round(cut * 1.12);
      const pct = met
        ? 100
        : Math.max(0, Math.min(100, Math.round(((prev - hundredths) / Math.max(1, prev - cut)) * 100)));
      const deltaStr = met ? `${formatDelta(diff)} ✓` : `+${formatTime(diff)}`;
      return `<td class="cut-td mc-td ${met ? "met" : "need"}" title="${esc(tip)}"><span class="cut-bar" style="width:${pct}%"></span><span class="cut-v">${formatTime(cut)}</span><span class="cut-d ${met ? "dp" : "ad"}">${deltaStr}</span></td>`;
    })
    .join("");
}

/**
 * Compact pill bar for toggling table columns on/off.
 */
export function columnToggleBar(cols = DEFAULT_COLS) {
  const merged = { ...DEFAULT_COLS, ...cols };
  const pills = TABLE_COLUMNS.map((c) => {
    const on = Boolean(merged[c.key]);
    return `<button type="button" class="col-pill${on ? " on" : " off"}" data-toggle-col="${c.key}" title="${esc(
      `${on ? "Hide" : "Show"} ${c.label} column`,
    )}">${esc(c.label)}</button>`;
  }).join("");

  return `<div class="col-bar" aria-label="Visible columns">
    <span class="col-bar-label">Columns</span>
    ${pills}
  </div>`;
}

const COURSE_LEN = { SCY: "25 yd", SCM: "25 m", LCM: "50 m" };

/**
 * The board: ONE consolidated table, with stroke groups as full-width rows
 * inside it, plus toggleable metadata, motivational cuts, and meet cuts.
 */
export function bestTimesTable(groups, primaryCourse, std = null, cols = null, open = null, ranks = null) {
  if (!groups.length) {
    return `<p class="empty-state">No times on record for this swimmer.</p>`;
  }

  // When `cols` is omitted (e.g. unit tests calling bestTimesTable(groups, "SCY", std)),
  // render the core 3-course layout; when `cols` is supplied by the app, render the
  // active course followed by Age, Pts, B–AAAA Cuts, Meet Cuts, Date, and Meet.
  const hasColsArg = cols !== null && typeof cols === "object";
  const vis = Object.fromEntries(
    TABLE_COLUMNS.map((c) => [c.key, hasColsArg ? Boolean(cols[c.key] ?? DEFAULT_COLS[c.key]) : false]),
  );
  const rankDefs = RANK_COLS.filter((c) => vis[c.key]);

  const visibleCourses = hasColsArg ? [primaryCourse] : COURSES;
  const activeStd = Boolean(std?.data && std.gender && std.ageGroup);
  const motLevels = activeStd && vis.mot ? (std.data.levels ?? ["B", "BB", "A", "AA", "AAA", "AAAA"]) : [];
  const regionalMeets =
    activeStd && vis.meets && Array.isArray(std?.regional?.meets) ? std.regional.meets : [];

  const leftMetaDefs = [
    vis.age && { key: "age", label: "Age", tip: "Age at swim (click to hide)" },
    vis.pts && { key: "pts", label: "Pts", tip: "USA Swimming Power Points (click to hide)" },
  ].filter(Boolean);

  const rightMetaDefs = [
    vis.date && { key: "date", label: "Date", tip: "Swim date (click to hide)" },
    vis.meet && { key: "meet", label: "Meet", tip: "Meet name (click to hide)" },
  ].filter(Boolean);

  const totalCols =
    1 +
    visibleCourses.length +
    rankDefs.length +
    leftMetaDefs.length +
    motLevels.length +
    regionalMeets.length +
    rightMetaDefs.length;

  const courseTh = (c) =>
    `<th class="c${c === primaryCourse ? " primary" : ""}" data-course="${c}" title="${esc(COURSE_LONG[c])}">
        ${COURSE_LABEL[c]}<span class="len">${COURSE_LEN[c]}</span>
      </th>`;

  const metaTh = (m) =>
    `<th class="m-th m-${m.key}" data-toggle-col="${m.key}" title="${esc(m.tip)}">${esc(m.label)}</th>`;

  const headCourses = visibleCourses.map(courseTh).join("");
  const headRank = rankDefs
    .map(
      (c) =>
        `<th class="m-th m-rank" data-toggle-col="${c.key}" title="${esc(c.tip)}">${esc(c.label)}</th>`,
    )
    .join("");
  const headLeftMeta = leftMetaDefs.map(metaTh).join("");
  const headMot = motLevels
    .map(
      (lvl) =>
        `<th class="cut-th" data-toggle-col="mot" title="${esc(`${lvl} motivational standard (click to hide B–AAAA)`)}">${esc(lvl)}</th>`,
    )
    .join("");
  const headMeets = regionalMeets
    .map(
      (m) =>
        `<th class="cut-th mc-th" data-toggle-col="meets" title="${esc(`${m.label} ${m.edition} cut (click to hide Meet Cuts)`)}">${esc(m.label)}</th>`,
    )
    .join("");
  const headRightMeta = rightMetaDefs.map(metaTh).join("");

  let i = 0;
  const body = groups
    .map(({ stroke, rows }) => {
      const group = `<tr class="grp" data-stroke="${STROKE_KEY[stroke] ?? "other"}" style="--i:${i++}">
        <th colspan="${totalCols}" scope="colgroup">${esc(stroke)}</th>
      </tr>`;

      const evRows = rows
        .map((row) => {
          // State the metric distance once, in the label, instead of repeating
          // it under every meters cell.
          const metric = mapDistance(row.distance, row.stroke, "SCY", "LCM");
          const alt = metric !== row.distance ? `<span class="alt">/ ${metric} m</span>` : "";
          const courseCells = visibleCourses
            .map((c) => cellHtml(row, c, c === primaryCourse, std))
            .join("");
          const rankCell = rankDefs.map((c) => rankCellHtml(row, primaryCourse, ranks, c)).join("");
          const leftMetaCells = leftMetaDefs
            .map((m) => metaCellHtml(row, primaryCourse, m.key))
            .join("");
          const motCells = motLevels.length
            ? motCutCellsHtml(row, primaryCourse, std, motLevels)
            : "";
          const meetCells = regionalMeets.length
            ? meetCutCellsHtml(row, primaryCourse, std, regionalMeets)
            : "";
          const rightMetaCells = rightMetaDefs
            .map((m) => metaCellHtml(row, primaryCourse, m.key))
            .join("");

          // The whole row opens the event's progress report.
          const isOpen = open?.stroke === row.stroke && open?.distance === row.distance;
          return `<tr class="ev-row" data-stroke="${esc(row.stroke)}" data-distance="${row.distance}" tabindex="0" aria-expanded="${isOpen}" title="Progress report" style="--i:${i++}">
            <th scope="row" class="ev">${row.distance}${alt}</th>
            ${courseCells}${rankCell}${leftMetaCells}${motCells}${meetCells}${rightMetaCells}
          </tr>`;
        })
        .join("");

      return group + evRows;
    })
    .join("");

  return `<div class="pb-wrap${hasColsArg ? " dense" : ""}">
    <table class="pb">
      <colgroup>
        <col class="ev-col" />
        ${visibleCourses.map(() => '<col class="c-col" />').join("")}
        ${rankDefs.map(() => '<col class="m-col m-col-rank" />').join("")}
        ${leftMetaDefs.map((m) => `<col class="m-col m-col-${m.key}" />`).join("")}
        ${motLevels.map(() => '<col class="cut-col" />').join("")}
        ${regionalMeets.map(() => '<col class="cut-col mc-col" />').join("")}
        ${rightMetaDefs.map((m) => `<col class="m-col m-col-${m.key}" />`).join("")}
      </colgroup>
      <thead><tr><th class="ev">Event</th>${headCourses}${headRank}${headLeftMeta}${headMot}${headMeets}${headRightMeta}</tr></thead>
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
 */
export function sessionBar({ signedIn, needsSession, busy = false, error }) {
  if (signedIn) {
    return `<div class="signin on">
      <span class="signin-dot" aria-hidden="true"></span>
      <span>Signed in to USA Swimming — search and best times available.</span>
      <button id="session-clear" class="ghost">Sign out</button>
    </div>`;
  }

  return `<details class="signin"${needsSession ? " open" : ""}>
    <summary>Sign in to USA Swimming${needsSession ? " — required" : ""}</summary>
    <p class="signin-why">
      Sign in with your USA Swimming account (<a href="https://data.usaswimming.org" target="_blank" rel="noopener">data.usaswimming.org ↗</a>).
      Your password is used once to obtain a session cookie from <code>login.usaswimming.org</code> and is never stored.
    </p>
    <form class="signin-form" id="login-form">
      <input id="login-user" type="text" autocomplete="username" spellcheck="false"
             placeholder="Username or email" aria-label="USA Swimming username" required ${busy ? "disabled" : ""} />
      <input id="login-pass" type="password" autocomplete="current-password"
             placeholder="Password" aria-label="USA Swimming password" required ${busy ? "disabled" : ""} />
      <button type="submit" ${busy ? "disabled" : ""}>${busy ? "Signing in…" : "Sign in"}</button>
    </form>
    <details class="signin-alt">
      <summary>Or paste a copied cURL / session cookie</summary>
      <ol class="signin-steps">
        <li>Sign in at <a href="https://data.usaswimming.org" target="_blank" rel="noopener">data.usaswimming.org ↗</a></li>
        <li>DevTools → Network → right-click an <code>/api/times/swims</code> request → Copy → Copy as cURL</li>
        <li>Paste it below</li>
      </ol>
      <form class="signin-form" id="session-form">
        <input id="session-paste" type="password" autocomplete="off" spellcheck="false"
               placeholder="Paste the copied cURL or bff_auth_session cookie" aria-label="Pasted session" />
        <button type="submit">Use session</button>
      </form>
    </details>
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
 * against, plus the column visibility pills.
 */
export function standardsBar({
  course = "SCY",
  gender,
  ageGroup,
  autoGroup,
  age,
  edition,
  regional,
  ready,
  cols = null,
}) {
  if (!ready) return "";

  const courseSeg = courseToggle(course);

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

  const meetEditions = (regional?.meets ?? [])
    .map(
      (meet) =>
        `<a href="${esc(meet.source)}" target="_blank" rel="noopener">${esc(`${meet.label} ${meet.edition}`)} ↗</a>`,
    )
    .join(" · ");
  const unavailable = (regional?.unavailable ?? [])
    .map((meet) => `${meet.label} ${meet.edition} — ${meet.reason}`)
    .join(" · ");

  return `<div class="std-bar">
    <span class="std-label">Standards</span>
    <div class="seg" id="std-course-toggle">${courseSeg}</div>
    <div class="seg" id="gender-toggle">${seg}</div>
    <select id="age-group" aria-label="Age group">${opts}</select>
    ${edition ? `<span class="std-edition" title="USA Swimming National Age Group Motivational Standards">${esc(edition)}</span>` : ""}
    ${note ? `<span class="std-note">${esc(note)}</span>` : ""}
    ${meetEditions ? `<span class="meet-editions">${meetEditions}</span>` : ""}
    ${unavailable ? `<span class="std-note">${esc(unavailable)}</span>` : ""}
  </div>${cols ? columnToggleBar(cols) : ""}`;
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
    <div class="sw-ident">
      <h2>${esc(s.fullName || s.shortName || "Swimmer")}</h2>
      <p class="sw-sub">${bits || "&nbsp;"}${meta.freshness ? ` <span class="freshness">· ${esc(meta.freshness)}</span>` : ""}</p>
    </div>
    <div class="sw-actions">
      <button id="pin-btn" class="ghost${meta.pinned ? " on" : ""}">${meta.pinned ? "★ Saved" : "☆ Save"}</button>
      <a class="ghost" href="${esc(meta.officialUrl)}" target="_blank" rel="noopener">Official ↗</a>
    </div>
  </div>`;
}

export { formatDelta };
