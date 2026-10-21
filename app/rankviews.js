// Markup for the ranking page. Pure: data in, HTML string out. All state and
// all network calls live in rankings.js.
//
// The page is one event and one group (team, LSC, zone, or US). It is not a panel
// of standing cards.

import { COURSE_LABEL } from "./convert.js";

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function shortDate(iso) {
  const m = typeof iso === "string" ? iso.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  return m ? `${m[1].slice(2)}-${m[2]}-${m[3]}` : "";
}

function shortMeet(name) {
  if (!name || typeof name !== "string") return "";
  return name.replace(/^\d{4}\s+[A-Z]{2}\s+/, "").trim();
}

function options(list, selected) {
  return list
    .map(
      (o) =>
        `<option value="${esc(o.value)}"${String(o.value) === String(selected) ? " selected" : ""}>${esc(o.label)}</option>`,
    )
    .join("");
}

function leaderboard(table, scope) {
  if (!table) return "";
  if (table.status === "loading") return `<p class="rank-note">Loading…</p>`;
  if (table.status === "error") {
    return `<p class="rank-note error">${esc(table.message || "Could not load this list.")}
      <button type="button" class="ghost" data-rank-retry>Retry</button></p>`;
  }
  if (!table.rows.length) return "";
  const body = table.rows
    .map((r, i) => {
      const me = r.memberId === table.meId;
      const club =
        scope === "club"
          ? ""
          : `<span class="who-club">${esc(r.clubName)}${r.lscCode ? ` · ${esc(r.lscCode)}` : ""}</span>`;
      const name = r.memberId
        ? `<a class="who-name" href="?m=${esc(r.memberId)}" data-member="${esc(r.memberId)}">${esc(r.fullName || "Swimmer")}</a>`
        : `<span class="who-name">${esc(r.fullName || "Swimmer")}</span>`;
      return `<tr class="${me ? "me" : ""}"${me ? ' aria-current="true"' : ""}>
        <td class="rk">${esc(r.eventRank)}</td>
        <td class="who">${name}${club}</td>
        <td class="ag">${esc(r.swimmerAge ?? "")}</td>
        <td class="tm">${esc(r.swimTime)}</td>
        <td class="mt" title="${esc(r.meetName)}">${esc(shortMeet(r.meetName))}</td>
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
 * The ranking page for one event.
 * @param {object} m
 * @param {string} m.course
 * @param {string} m.eventLabel
 * @param {"idle"|"loading"|"ready"|"error"} m.refStatus
 * @param {string} [m.refError]
 * @param {string|null} m.note
 * @param {Array<{key,label,title}>} m.tabs
 * @param {string|null} m.scope
 * @param {Array<{value,label}>} m.ageOptions
 * @param {string} m.ageValue
 * @param {Array<{value,label}>} m.seasonOptions
 * @param {string} m.seasonValue
 * @param {string|null} m.scopeNote
 * @param {object|null} m.table
 */
export function rankingPage(m) {
  const head = `<button type="button" class="ghost rank-back" data-rank-back>← Times</button>
    <h2 class="rank-title">${esc(m.eventLabel)} <span class="rank-course">${esc(COURSE_LABEL[m.course] ?? m.course)}</span></h2>`;

  if (m.refStatus === "loading" || m.refStatus === "idle") {
    return `<section class="rank-page" aria-label="Ranking">${head}<p class="rank-note">Loading…</p></section>`;
  }
  if (m.refStatus === "error") {
    return `<section class="rank-page" aria-label="Ranking">${head}
      <p class="rank-note error">${esc(m.refError || "Could not load the event list.")}
      <button type="button" class="ghost" data-rank-retry>Retry</button></p></section>`;
  }

  const tabs = m.tabs.length
    ? `<div class="seg" role="group" aria-label="Group">${m.tabs
        .map(
          (t) =>
            `<button type="button" class="seg-btn${t.key === m.scope ? " on" : ""}" data-rank-scope="${esc(t.key)}" title="${esc(t.title)}" aria-pressed="${t.key === m.scope}">${esc(t.label)}</button>`,
        )
        .join("")}</div>`
    : "";

  const controls = `<div class="rank-bar">
      ${tabs}
      <select data-rank-age aria-label="Age">${options(m.ageOptions, m.ageValue)}</select>
      <select data-rank-season aria-label="Season">${options(m.seasonOptions, m.seasonValue)}</select>
    </div>`;

  const list =
    m.table?.status === "ready" && !m.table.rows.length && !m.scopeNote
      ? `<p class="rank-note">No swims in this list.</p>`
      : leaderboard(m.table, m.scope);
  const body = m.note
    ? `<p class="rank-note">${esc(m.note)}</p>`
    : `${m.scopeNote ? `<p class="rank-note">${esc(m.scopeNote)}</p>` : ""}${list}`;

  return `<section class="rank-page" aria-label="Ranking">${head}${controls}${body}</section>`;
}
