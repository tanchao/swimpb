// Markup for the Rankings panel. Pure: data in, HTML string out. All state and
// all network calls live in rankings.js.

import { COURSE_LABEL } from "./convert.js";

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

const GENDER_LABEL = { boys: "Boys", girls: "Girls" };

function shortDate(iso) {
  const m = typeof iso === "string" ? iso.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  return m ? `${m[1].slice(2)}-${m[2]}-${m[3]}` : "";
}

function options(list, selected) {
  return list
    .map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(selected) ? " selected" : ""}>${esc(o.label)}</option>`)
    .join("");
}

function eventSelect(groups, eventId) {
  const placeholder =
    eventId == null ? `<option value="" selected disabled>Choose an event</option>` : "";
  const body = groups
    .map(
      (g) =>
        `<optgroup label="${esc(g.stroke)}">${g.events
          .map(
            (e) =>
              `<option value="${e.eventId}"${e.eventId === eventId ? " selected" : ""}>${e.distance} ${esc(g.stroke)}</option>`,
          )
          .join("")}</optgroup>`,
    )
    .join("");
  return `<select data-rank-event aria-label="Event">${placeholder}${body}</select>`;
}

function genderSeg(gender) {
  return `<div class="seg" role="group" aria-label="Gender">${["boys", "girls"]
    .map(
      (g) =>
        `<button class="seg-btn${g === gender ? " on" : ""}" data-rank-gender="${g}" aria-pressed="${g === gender}">${GENDER_LABEL[g]}</button>`,
    )
    .join("")}</div>`;
}

/** One standing card. `c.kind` says which fact is true; nothing here is a guess. */
function card(c) {
  let num = "—";
  let sub = "";
  let cls = c.kind;
  switch (c.kind) {
    case "loading":
      num = "…";
      sub = "Loading";
      break;
    case "error":
      sub = esc(c.message || "Could not load");
      break;
    case "ranked":
      num = `#${esc(c.rank)}`;
      sub = `${esc(c.time)}${c.of ? ` · ${esc(c.of)}` : ""}`;
      break;
    case "outside":
      sub = `Not in the top 100 · 100th is ${esc(c.cutoff)}`;
      break;
    case "none":
      sub = "No time in this list";
      break;
    case "unknown":
      sub = esc(c.message || "Not in a top-100 list");
      break;
    default:
      break;
  }
  return `<div class="rank-card ${cls}">
    <span class="rank-scope">${esc(c.label)}</span>
    <span class="rank-num">${num}</span>
    <span class="rank-sub">${sub}</span>
  </div>`;
}

function leaderboard(table) {
  if (!table) return "";
  if (table.status === "loading") return `<p class="rank-note">Loading the leaderboard…</p>`;
  if (table.status === "error") {
    return `<p class="rank-note error">${esc(table.message || "Could not load the leaderboard.")}
      <button class="ghost" data-rank-retry>Retry</button></p>`;
  }
  if (!table.rows.length) return `<p class="rank-note">No swims match these filters.</p>`;
  const body = table.rows
    .map((r, i) => {
      const me = r.memberId === table.meId;
      return `<tr class="${me ? "me" : ""}" style="--i:${Math.min(i, 24)}"${me ? ' aria-current="true"' : ""}>
        <td class="rk">${esc(r.eventRank)}</td>
        <td class="who"><span class="who-name">${esc(r.fullName)}</span><span class="who-club">${esc(r.clubName)}${r.lscCode ? ` · ${esc(r.lscCode)}` : ""}</span></td>
        <td class="ag">${esc(r.swimmerAge ?? "")}</td>
        <td class="tm">${esc(r.swimTime)}</td>
        <td class="mt">${esc(r.meetName)}</td>
        <td class="dt">${esc(shortDate(r.swimDate))}</td>
      </tr>`;
    })
    .join("");
  return `<div class="rank-wrap"><table class="rank-table">
    <thead><tr><th class="rk">#</th><th>Swimmer</th><th class="ag">Age</th><th class="tm">Time</th><th class="mt">Meet</th><th class="dt">Date</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

/**
 * @param {object} m
 * @param {boolean} m.open
 * @param {string} m.course
 * @param {"idle"|"loading"|"ready"|"error"} m.refStatus  events and seasons
 * @param {string} [m.refError]
 * @param {Array} m.eventGroups  from individualEvents()
 * @param {number|null} m.eventId
 * @param {"boys"|"girls"|null} m.gender
 * @param {Array<{value,label}>} m.ageOptions
 * @param {string} m.ageValue
 * @param {Array<{value,label}>} m.seasonOptions
 * @param {string} m.seasonValue
 * @param {string|null} m.note        why there is nothing to show yet
 * @param {Array|null} m.cards
 * @param {Array<{key,label}>} m.tabs
 * @param {string} m.tab
 * @param {string|null} m.tabNote     caveat for the selected tab
 * @param {object|null} m.table
 */
export function rankingsPanel(m) {
  const head = `<div class="rank-head">
    <h2 class="rank-title">Rankings <span class="rank-course">${esc(COURSE_LABEL[m.course] ?? m.course)}</span></h2>
    <button class="ghost" data-rank-toggle aria-expanded="${m.open}">${m.open ? "Hide" : "Show"}</button>
  </div>`;
  if (!m.open) return `<section class="rank" aria-label="Rankings">${head}</section>`;

  if (m.refStatus === "loading" || m.refStatus === "idle") {
    return `<section class="rank" aria-label="Rankings">${head}<p class="rank-note">Loading events…</p></section>`;
  }
  if (m.refStatus === "error") {
    return `<section class="rank" aria-label="Rankings">${head}
      <p class="rank-note error">${esc(m.refError || "Could not load the event list.")}
      <button class="ghost" data-rank-retry>Retry</button></p></section>`;
  }

  const controls = `<div class="rank-controls">
    ${eventSelect(m.eventGroups, m.eventId)}
    ${genderSeg(m.gender)}
    <select data-rank-age aria-label="Age">${options(m.ageOptions, m.ageValue)}</select>
    <select data-rank-season aria-label="Season">${options(m.seasonOptions, m.seasonValue)}</select>
  </div>`;

  const cards = m.cards ? `<div class="rank-cards">${m.cards.map(card).join("")}</div>` : "";
  const tabs = m.tabs.length
    ? `<div class="seg rank-tabs" role="group" aria-label="Leaderboard">${m.tabs
        .map(
          (t) =>
            `<button class="seg-btn${t.key === m.tab ? " on" : ""}" data-rank-tab="${esc(t.key)}" aria-pressed="${t.key === m.tab}">${esc(t.label)}</button>`,
        )
        .join("")}</div>`
    : "";

  return `<section class="rank" aria-label="Rankings">${head}${controls}
    ${
      m.note
        ? `<p class="rank-note">${esc(m.note)}</p>`
        : `${cards}${tabs}${m.tabNote ? `<p class="rank-note">${esc(m.tabNote)}</p>` : ""}${leaderboard(m.table)}`
    }
    <p class="rank-foot">
      USA Swimming returns only the fastest 100 swimmers per list, so a rank is shown
      only when the swimmer is in it. The time shown is the swimmer’s best in the
      chosen age and season, which can be slower than the personal best. Club
      standing counts clubmates who made the list.
    </p>
  </section>`;
}
