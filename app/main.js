// State and wiring. Owns the URL (so a swimmer is linkable/bookmarkable), the
// cache calls, and event handling; delegates all markup to ui.js.

import { advise } from "./advise.js";
import {
  ApiError,
  allEvents,
  allTimes,
  bestTimes,
  clearSession,
  getMember,
  loginWithCredentials,
  officialUrl,
  searchSwimmers,
  seasons,
  session,
  setSession,
  swimDetail,
  topTimes,
} from "./api.js?v=6";
import * as cache from "./cache.js";
import { COURSES } from "./convert.js";
import { ageBest, meetsByDate } from "./history.js";
import { adviseEvent, progress } from "./progress.js";
import { createRankings } from "./rankings.js";
import { halves, normalizeSplits } from "./splits.js";
import { loadRegionalStandards } from "./regional.js";
import { ageGroupFor, loadStandards } from "./standards.js";
import * as ui from "./ui.js?v=13";
import * as views from "./views.js?v=9";

const el = (id) => document.getElementById(id);

const state = {
  course: cache.pref("course", "SCY"),
  currentOnly: cache.pref("currentOnly", true),
  cols: { ...ui.DEFAULT_COLS, ...cache.pref("cols:v4", {}) },
  swimmer: null,
  bestRecords: [],
  allRecords: [],
  groups: [],
  // Which table fills the main area: "best" | "ages" | "meets".
  view: cache.pref("view", "best"),
  meetOrder: cache.pref("meetOrder", "newest"),
  // The event whose progress report is open: {stroke, distance}, or null.
  open: null,
  // The ranking page, or null while the board is showing.
  // {stroke, distance, scope:"club"|"lsc"|"zone"}
  rank: null,
  // Lap splits, fetched on demand, one entry per swim id:
  // {status:"loading"} | {status:"ready", detail} | {status:"error", message}.
  splits: new Map(),
  openSwims: new Set(),
  results: null,
  // The motivational standards table, and which slice of it to measure against.
  standards: null,
  regionalStandards: null,
  gender: null,
  ageGroupOverride: null,
  // Set when a request comes back 401/403, so the sign-in row opens itself.
  needsSession: false,
  sessionBusy: false,
  sessionError: "",
  serverSession: false,
};

/** The age group in force: an explicit override, else derived from the age. */
function ageGroup() {
  return state.ageGroupOverride ?? ageGroupFor(state.swimmer?.swimmerAge);
}

/** What ui.js needs to draw chips, or null when there's nothing to measure. */
function standardsContext() {
  if (!state.standards) return null;
  return {
    data: state.standards,
    regional: state.regionalStandards,
    gender: state.gender,
    ageGroup: ageGroup(),
  };
}

function maybeAutoDetectGender() {
  if (state.gender || !state.swimmer || !state.standards || !state.allRecords.length) return;
  const detected = ui.inferGender(state.allRecords, state.standards);
  if (detected) {
    state.gender = detected;
    cache.setPref(`gender:${state.swimmer.memberId}`, detected);
  }
}

// ---------------------------------------------------------------------------
// Rendering

function renderCourse() {
  el("course-toggle").innerHTML = ui.courseToggle(state.course);
}

function renderSession() {
  el("session").innerHTML = ui.sessionBar({
    signedIn: Boolean(session()) || state.serverSession,
    needsSession: state.needsSession,
    busy: state.sessionBusy,
    error: state.sessionError,
  });
}

/** A 401/403 is an instruction, not a failure: open the sign-in row and say why. */
function noteApiError(err, fallback) {
  const needs = err instanceof ApiError && err.needsSession;
  if (needs) {
    state.serverSession = false;
    state.needsSession = true;
    renderSession();
  }
  status(err instanceof ApiError ? err.message : fallback, "error");
}

const rankings = createRankings({
  api: { allEvents, seasons, topTimes },
  cache,
  host: el("rankings"),
  context: () => ({
    swimmer: state.swimmer,
    gender: state.gender,
    ageGroup: ageGroup(),
    course: state.course,
    groups: state.groups,
    ranks: {
      team: state.view === "best" && Boolean(state.cols.team),
      lsc: state.view === "best" && Boolean(state.cols.lsc),
      zone: state.view === "best" && Boolean(state.cols.zone),
      us: state.view === "best" && Boolean(state.cols.us),
    },
  }),
  onBoard: paintRankCells,
  onNavigate: (action) => {
    if (action.type === "close") closeRank({ alreadyClosed: true });
    else if (action.type === "scope") rememberRankScope(action.scope);
    else if (action.type === "swimmer") {
      if (state.swimmer?.memberId === action.swimmer.memberId) {
        closeRank();
      } else {
        if (state.rank) {
          state.rank = null;
          applyRankChrome();
          rankings.act({ type: "close" });
        }
        selectSwimmer(action.swimmer, { historyMode: "push" });
      }
    }
  },
  onError: (err) => noteApiError(err, "Could not load rankings."),
});

function paintRankCells(cells) {
  if (!cells) return;
  for (const btn of el("times").querySelectorAll("[data-rank-cell]")) {
    const c = cells[btn.dataset.rankCell]?.[btn.dataset.rankCol];
    if (!c) continue;
    if (btn.textContent !== c.text) btn.textContent = c.text;
    btn.title = c.title;
    btn.dataset.rankScope = c.scope;
    for (const kind of ["rank", "miss", "wait", "error"]) btn.classList.toggle(kind, c.kind === kind);
  }
}

/** Hide the board while the ranking page is up, and bring it back after. */
function applyRankChrome() {
  const on = Boolean(state.rank);
  for (const id of ["views", "times", "advice"]) el(id).hidden = on;
}

function renderPinned() {
  el("pinned").innerHTML = ui.pinnedBar(cache.pinned(), state.swimmer?.memberId);
}

function renderResults() {
  el("results").innerHTML = ui.swimmerList(state.results);
}

function renderRegionalNotes() {
  const target = el("legend-regional");
  if (target && state.regionalStandards) {
    target.innerHTML = ui.regionalNotes(state.regionalStandards);
  }
}

function renderStandards() {
  el("standards").innerHTML = state.swimmer
    ? ui.standardsBar({
        gender: state.gender,
        ageGroup: ageGroup(),
        autoGroup: ageGroupFor(state.swimmer.swimmerAge),
        age: state.swimmer.swimmerAge ?? null,
        ready: Boolean(state.standards),
        cols: state.view === "best" ? state.cols : null,
      })
    : "";
}

function renderViews() {
  el("views").innerHTML = state.swimmer ? views.viewTabs(state.view) : "";
}

/** The board row for the open report, or null when it no longer exists. */
function openRow() {
  if (!state.open) return null;
  for (const g of state.groups) {
    if (g.stroke !== state.open.stroke) continue;
    return g.rows.find((r) => r.distance === state.open.distance) ?? null;
  }
  return null;
}

/** What the splits views need: which swims are open, and what each one has. */
const splitsView = () => ({
  open: { has: (id) => state.openSwims.has(String(id)) },
  get: (id) => state.splits.get(String(id)),
});

/**
 * Fetch one swim's detail, once. Both an explicit click and the fade rule go
 * through here, so a swim is never requested twice.
 */
function ensureSplits(rawId) {
  // Ids come from the DOM as strings and from the API as numbers.
  if (rawId == null) return;
  const id = String(rawId);
  if (state.splits.has(id)) return;
  state.splits.set(id, { status: "loading" });
  cache
    .swr(`swim:${id}`, () => swimDetail(id))
    .then(({ data }) => state.splits.set(id, { status: "ready", detail: data }))
    .catch((err) =>
      state.splits.set(id, {
        status: "error",
        message: err instanceof ApiError ? err.message : "Could not load the lap splits.",
      }),
    )
    .finally(rerenderSplits);
}

/**
 * Splits change only the meets table and the report drawer. Rebuilding the
 * board for them would replay its row reveal on every click.
 */
function rerenderSplits() {
  if (!state.swimmer) return;
  if (state.view === "meets") renderTimes();
  else renderReport();
}

function toggleSwim(id) {
  if (state.openSwims.has(id)) state.openSwims.delete(id);
  else {
    state.openSwims.add(id);
    // A failed fetch is retried by the next explicit click, never automatically.
    if (state.splits.get(id)?.status === "error") state.splits.delete(id);
    ensureSplits(id);
  }
  rerenderSplits();
}

/**
 * Front half against back half of the best swim, for events where that means
 * something. Fetching is automatic here (one cached request) because the fade
 * rule is worthless without it; an IM and a sprint have no meaningful halves.
 */
function bestSwimHalves(row, prog) {
  if (!prog.ready || row.stroke === "Individual Medley" || row.distance < 200) return null;
  const id = prog.lastBest.id;
  if (id == null) return null;
  ensureSplits(id);
  const info = state.splits.get(String(id));
  if (info?.status !== "ready") return null;
  return halves(
    normalizeSplits(info.detail?.splits, prog.lastBest.hundredths, {
      distance: row.distance,
      stroke: row.stroke,
      course: state.course,
    }),
    row.stroke,
  );
}

function renderReport() {
  const host = el("report");
  const row = openRow();
  if (!row) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  const std = standardsContext();
  const prog = progress(row, state.course);
  const keep = host.scrollTop;
  host.innerHTML = views.eventReport({
    row,
    course: state.course,
    prog,
    advice: adviseEvent(state.groups, row, std, state.course, prog, 3, {
      halves: bestSwimHalves(row, prog),
    }),
    std,
    edition: state.standards?.edition,
    splits: splitsView(),
  });
  host.hidden = false;
  host.scrollTop = keep;
}

/**
 * Mark the open row in place. Opening a report must not rebuild the board: that
 * would replay the row reveal animation on every click.
 */
function markOpenRow() {
  for (const tr of el("times").querySelectorAll("tr.ev-row")) {
    const open =
      state.open?.stroke === tr.dataset.stroke && state.open?.distance === Number(tr.dataset.distance);
    tr.setAttribute("aria-expanded", String(open));
  }
  renderReport();
}

/** Re-fetch a swimmer's times at most this often when an event is opened. */
const EVENT_REFRESH_MS = 30 * 60 * 1000;
let eventRefresh = null;

/**
 * Opening an event checks USA Swimming again when the saved times are older
 * than half an hour. A click sooner than that reuses what is already on screen.
 */
function refreshTimesIfOld() {
  const id = state.swimmer?.memberId;
  if (!id || (!session() && !state.serverSession) || eventRefresh) return;
  const times = cache.getEntry(`allTimes:${id}`);
  const best = cache.getEntry(`bestTimes:${id}`);
  const oldest = Math.min(times?.fetchedAt ?? 0, best?.fetchedAt ?? 0);
  if (oldest && Date.now() - oldest < EVENT_REFRESH_MS) return;
  eventRefresh = Promise.all([allTimes(id), bestTimes(id)])
    .then(([all, freshBest]) => {
      if (state.swimmer?.memberId !== id) return;
      const allSame = JSON.stringify(all ?? []) === JSON.stringify(state.allRecords);
      const bestSame = JSON.stringify(freshBest ?? []) === JSON.stringify(state.bestRecords);
      cache.setEntry(`allTimes:${id}`, all ?? []);
      cache.setEntry(`bestTimes:${id}`, freshBest ?? []);
      if (allSame && bestSame) return;
      state.allRecords = all ?? [];
      state.bestRecords = freshBest ?? [];
      maybeAutoDetectGender();
      rebuildGroups();
      renderStandards();
      renderTimes();
      renderSwimmer({ freshness: "Updated with new times from USA Swimming." });
    })
    .catch(() => {})
    .finally(() => {
      eventRefresh = null;
    });
}

/** Open the report for a row, or close it when that row is already open. */
function toggleReport(stroke, distance, { focus = false } = {}) {
  const same = state.open?.stroke === stroke && state.open?.distance === distance;
  state.open = same ? null : { stroke, distance };
  markOpenRow();
  if (state.open) refreshTimesIfOld();
  if (focus && state.open) el("report-close")?.focus();
}

function closeReport() {
  if (!state.open) return;
  state.open = null;
  markOpenRow();
}

let renderedView = null;

function renderTimes() {
  const std = standardsContext();
  const host = el("times");
  // A re-render must not throw the reader back to the left edge of a wide table.
  const keep = renderedView === state.view ? (host.querySelector(".pb-wrap")?.scrollLeft ?? 0) : 0;

  if (state.view === "ages") {
    host.innerHTML = views.ageBestTable(ageBest(state.groups, state.course, std), state.course, {
      open: state.open,
      std,
    });
  } else if (state.view === "meets") {
    host.innerHTML = views.meetsTable(meetsByDate(state.groups, state.course), state.course, {
      order: state.meetOrder,
      splits: splitsView(),
    });
  } else {
    host.innerHTML = ui.bestTimesTable(
      state.groups,
      state.course,
      std,
      state.cols,
      state.open,
      rankings.boardCells(),
    );
  }
  renderedView = state.view;
  const wrap = host.querySelector(".pb-wrap");
  if (wrap) wrap.scrollLeft = keep;

  renderReport();
  // The ruler and the advice move together, so they re-render together. The
  // advice is about the board, so it only shows with the board.
  el("advice").innerHTML =
    std && state.view === "best"
      ? ui.advicePanel(advise(state.groups, std, state.course), state.course, state.standards?.edition)
      : "";
  // Course, gender, age group and the board all change through here.
  rankings.refresh();
}

function setView(view) {
  if (!views.VIEWS.some((v) => v.key === view) || view === state.view) return;
  state.view = view;
  // Only the board and the matrix have event rows to open a report from.
  state.open = null;
  cache.setPref("view", view);
  renderViews();
  renderStandards();
  renderTimes();
}

function swimmerViewMeta(freshness = "") {
  return {
    pinned: cache.isPinned(state.swimmer.memberId),
    officialUrl: officialUrl(state.swimmer.memberId),
    freshness,
    edition: state.standards?.edition ?? "",
  };
}

function renderSwimmer(meta = {}) {
  if (!state.swimmer) {
    el("swimmer").innerHTML = "";
    el("standards").innerHTML = "";
    el("views").innerHTML = "";
    el("times").innerHTML = "";
    el("advice").innerHTML = "";
    state.open = null;
    renderReport();
    rankings.refresh();
    return;
  }
  el("swimmer").innerHTML = ui.swimmerHeader(state.swimmer, swimmerViewMeta(meta.freshness ?? ""));
  renderViews();
  renderStandards();
  renderTimes();
}

function status(msg, kind = "info") {
  el("status").innerHTML = msg ? `<p class="status ${kind}">${msg}</p>` : "";
}

function freshnessLabel(fetchedAt, fromCache) {
  const mins = Math.round((Date.now() - fetchedAt) / 60000);
  if (!fromCache) return "Fetched just now from USA Swimming.";
  if (mins < 1) return "From cache (just now).";
  if (mins < 60) return `From cache (${mins} min ago). Refreshing in the background.`;
  const hrs = Math.round(mins / 60);
  return `From cache (${hrs} h ago). Refreshing in the background.`;
}

function rebuildGroups() {
  state.groups = ui.groupBestTimes(state.bestRecords, state.allRecords);
}

// ---------------------------------------------------------------------------
// Actions

async function doSearch(name) {
  const query = name.trim();
  if (!query) return;

  const key = `search:${query}:${state.currentOnly ? 1 : 0}`;
  const hit = cache.getSession(key);
  if (hit) {
    state.results = hit;
    renderResults();
    return;
  }

  status("Searching…");
  try {
    const list = await searchSwimmers(query, { currentOnly: state.currentOnly });
    state.results = list;
    cache.setSession(key, list);
    status("");
    renderResults();
    // A single unambiguous match is almost always the one you meant.
    if (list.length === 1) selectSwimmer(list[0], { historyMode: "push" });
  } catch (err) {
    noteApiError(err, "Search failed.");
  }
}

function rankFromUrl() {
  const params = new URLSearchParams(location.search);
  const raw = params.get("rank");
  if (!raw) return null;
  const cut = raw.lastIndexOf(":");
  if (cut <= 0) return null;
  const distance = Number(raw.slice(cut + 1));
  if (!Number.isFinite(distance)) return null;
  const scope = params.get("scope");
  return {
    stroke: raw.slice(0, cut),
    distance,
    scope: scope === "lsc" || scope === "zone" || scope === "us" ? scope : "club",
  };
}

/**
 * @param {"push"|"replace"|"none"} historyMode
 */
function openRank(stroke, distance, scope = "club", { historyMode = "push" } = {}) {
  state.rank = { stroke, distance, scope };
  if (state.open) {
    state.open = null;
    el("report").hidden = true;
  }
  applyRankChrome();
  const url = new URL(location.href);
  url.searchParams.set("rank", `${stroke}:${distance}`);
  url.searchParams.set("scope", scope);
  if (historyMode === "push") history.pushState({ rank: "pushed" }, "", url);
  else if (historyMode === "replace") history.replaceState({ rank: "replaced" }, "", url);
  rankings.act({ type: "open", stroke, distance, scope });
}

function closeRank({ fromPop = false, alreadyClosed = false } = {}) {
  const was = state.rank;
  state.rank = null;
  applyRankChrome();
  if (!alreadyClosed) rankings.act({ type: "close" });
  if (fromPop) return;
  // Only a click from the table pushed an entry. A direct link replaced the
  // current one, so Back must not leave the app.
  if (was && history.state?.rank === "pushed") {
    history.back();
    return;
  }
  const url = new URL(location.href);
  if (url.searchParams.has("rank")) {
    url.searchParams.delete("rank");
    url.searchParams.delete("scope");
    history.replaceState(null, "", url);
  }
}

function rememberRankScope(scope) {
  if (!state.rank) return;
  state.rank = { ...state.rank, scope };
  const url = new URL(location.href);
  url.searchParams.set("scope", scope);
  const mark = history.state?.rank === "pushed" ? "pushed" : "replaced";
  history.replaceState({ rank: mark }, "", url);
}

async function selectSwimmer(swimmer, { historyMode = "replace" } = {}) {
  if (state.rank && state.swimmer && state.swimmer.memberId !== swimmer.memberId) {
    state.rank = null;
    applyRankChrome();
    rankings.act({ type: "close" });
  }
  const switching = state.swimmer && state.swimmer.memberId !== swimmer.memberId;
  state.swimmer = swimmer;
  // Also runs after a sign-in, so a leaderboard that failed with 401 is retried.
  rankings.retryErrors();
  state.bestRecords = [];
  state.allRecords = [];
  state.groups = [];
  state.open = null;
  state.openSwims.clear();
  state.results = null;
  // Both are per swimmer: a family checks more than one, and they don't share a
  // gender or an age group.
  state.gender = cache.pref(`gender:${swimmer.memberId}`, null);
  state.ageGroupOverride = cache.pref(`ageGroup:${swimmer.memberId}`, null);
  renderResults();
  renderPinned();
  cache.setEntry(`swimmer:${swimmer.memberId}`, swimmer);

  // Fire and forget: the board renders without chips and gains them when the
  // table arrives. A failure leaves the board exactly as it is today.
  loadStandards().then((data) => {
    if (!data || state.standards) return;
    state.standards = data;
    maybeAutoDetectGender();
    if (state.swimmer) {
      // The quad is printed next to the age, so the header has to pick it up
      // when the table arrives after the first paint.
      const freshness = document.querySelector("#swimmer .freshness")?.textContent?.replace(/^·\s*/, "") ?? "";
      el("swimmer").innerHTML = ui.swimmerHeader(state.swimmer, swimmerViewMeta(freshness));
      renderStandards();
      renderTimes();
    }
  });
  loadRegionalStandards().then((data) => {
    if (!data || state.regionalStandards) return;
    state.regionalStandards = data;
    renderRegionalNotes();
    if (state.swimmer) {
      renderStandards();
      renderTimes();
    }
  });

  const url = new URL(location.href);
  url.searchParams.set("m", swimmer.memberId);
  if (!state.rank) {
    url.searchParams.delete("rank");
    url.searchParams.delete("scope");
  }
  if (historyMode === "push" && switching) {
    history.pushState({ swimmer: swimmer.memberId }, "", url);
  } else if (historyMode === "replace" || (historyMode === "push" && !switching)) {
    const mark = state.rank ? (history.state?.rank === "pushed" ? "pushed" : "replaced") : null;
    history.replaceState(mark ? { rank: mark } : null, "", url);
  }

  status("Loading personal bests…");
  renderSwimmer({ freshness: "" });

  // A deep link only carries an id, so the profile has to be resolved before we
  // can show a name instead of a placeholder.
  if (!swimmer.fullName) {
    cache
      .swr(`member:${swimmer.memberId}`, () => getMember(swimmer.memberId))
      .then(({ data }) => {
        if (!data || state.swimmer?.memberId !== data.memberId) return;
        state.swimmer = data;
        cache.setEntry(`swimmer:${data.memberId}`, data);
        renderSwimmer({ freshness: document.querySelector(".freshness")?.textContent?.replace(/^·\s*/, "") ?? "" });
      })
      .catch(() => {});
  }

  // Fetch all recorded swims in parallel to enrich PB rows with age, drop,
  // swim count, power points, meet name, and automatic gender detection.
  cache
    .swr(
      `allTimes:${swimmer.memberId}`,
      () => allTimes(swimmer.memberId),
      (fresh) => {
        if (state.swimmer?.memberId !== swimmer.memberId) return;
        state.allRecords = fresh ?? [];
        maybeAutoDetectGender();
        rebuildGroups();
        renderStandards();
        renderTimes();
      },
      { revalidate: true },
    )
    .then(({ data }) => {
      if (state.swimmer?.memberId !== swimmer.memberId) return;
      state.allRecords = data ?? [];
      maybeAutoDetectGender();
      if (state.bestRecords.length) {
        rebuildGroups();
        renderStandards();
        renderTimes();
      }
    })
    .catch(() => {});

  try {
    const { data, fromCache, fetchedAt } = await cache.swr(
      `bestTimes:${swimmer.memberId}`,
      () => bestTimes(swimmer.memberId),
      (fresh) => {
        if (state.swimmer?.memberId !== swimmer.memberId) return;
        state.bestRecords = fresh ?? [];
        rebuildGroups();
        renderSwimmer({ freshness: "Updated with new times from USA Swimming." });
      },
      {
        revalidate: true,
        onUnchanged: () => {
          if (state.swimmer?.memberId !== swimmer.memberId) return;
          const hit = cache.getEntry(`bestTimes:${swimmer.memberId}`);
          if (hit) renderSwimmer({ freshness: freshnessLabel(hit.fetchedAt, true) });
        },
      },
    );
    state.bestRecords = data ?? [];
    if (!session()) state.serverSession = true;
    rebuildGroups();
    status("");
    renderSession();
    renderSwimmer({ freshness: freshnessLabel(fetchedAt, fromCache) });
  } catch (err) {
    // If we have any cached copy at all, showing it beats showing an error.
    const stale = cache.getEntry(`bestTimes:${swimmer.memberId}`);
    if (stale) {
      state.bestRecords = stale.data ?? [];
      rebuildGroups();
      renderSwimmer({ freshness: "Offline — showing the last saved copy." });
      status("");
    } else {
      noteApiError(err, "Could not load times.");
    }
  }
}

function setCourse(course) {
  if (!COURSES.includes(course) || course === state.course) return;
  state.course = course;
  cache.setPref("course", course);
  renderCourse();
  // Pure re-render — no refetch, because one call already gave us every course.
  if (state.swimmer) {
    renderStandards();
    renderTimes();
  }
}

function toggleColumn(colKey) {
  if (!(colKey in state.cols)) return;
  state.cols = { ...state.cols, [colKey]: !state.cols[colKey] };
  cache.setPref("cols:v4", state.cols);
  renderStandards();
  renderTimes();
}

/**
 * Changing the standards set is a re-render too: the times are unchanged, only
 * the ruler moves.
 */
function setStandardsSet({ gender, ageGroupOverride }) {
  if (!state.swimmer) return;
  if (gender !== undefined) {
    state.gender = gender;
    cache.setPref(`gender:${state.swimmer.memberId}`, gender);
  }
  if (ageGroupOverride !== undefined) {
    state.ageGroupOverride = ageGroupOverride;
    cache.setPref(`ageGroup:${state.swimmer.memberId}`, ageGroupOverride);
  }
  renderStandards();
  renderTimes();
}

// ---------------------------------------------------------------------------
// Events

el("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  doSearch(el("q").value);
});

el("current-only").addEventListener("change", (e) => {
  state.currentOnly = e.target.checked;
  cache.setPref("currentOnly", state.currentOnly);
  if (el("q").value.trim()) doSearch(el("q").value);
});

el("course-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".course-btn");
  if (btn) setCourse(btn.dataset.course);
});

el("session").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.target.id === "login-form") {
    const userField = el("login-user");
    const passField = el("login-pass");
    const username = userField?.value ?? "";
    const password = passField?.value ?? "";
    if (!username.trim() || !password) return;

    state.sessionBusy = true;
    state.sessionError = "";
    renderSession();
    try {
      await loginWithCredentials(username, password);
      state.sessionBusy = false;
      state.needsSession = false;
      state.sessionError = "";
      renderSession();
      status("Signed in. Retrying…");
      retryPending();
    } catch (err) {
      state.sessionBusy = false;
      state.sessionError = err instanceof ApiError ? err.message : "Sign-in failed.";
      renderSession();
    }
    return;
  }

  const field = el("session-paste");
  if (!field || !setSession(field.value)) {
    state.sessionError =
      "Couldn’t find a session in that. Copy an /api/times/swims request as cURL while signed in, or paste the bff_auth_session cookie.";
    renderSession();
    return;
  }
  // Never leave the credential sitting in the DOM.
  field.value = "";
  state.needsSession = false;
  state.sessionError = "";
  renderSession();
  status("Signed in. Retrying…");
  retryPending();
});

el("session").addEventListener("click", (e) => {
  if (!e.target.closest("#session-clear")) return;
  clearSession();
  state.serverSession = false;
  state.needsSession = false;
  state.sessionError = "";
  renderSession();
});

/** After signing in, pick up whatever the user was denied. */
function retryPending() {
  if (state.swimmer) {
    selectSwimmer(state.swimmer);
  } else if (el("q").value.trim()) {
    doSearch(el("q").value);
  } else {
    status("");
  }
}

el("standards").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (btn) {
    setStandardsSet({ gender: btn.dataset.gender });
    return;
  }
  const colBtn = e.target.closest("[data-toggle-col]");
  if (colBtn) toggleColumn(colBtn.dataset.toggleCol);
});

el("standards").addEventListener("change", (e) => {
  if (e.target.id !== "age-group") return;
  // Empty value means "follow the swimmer's age" rather than a pinned group.
  setStandardsSet({ ageGroupOverride: e.target.value || null });
});

el("views").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-view]");
  if (tab) setView(tab.dataset.view);
});

el("times").addEventListener("click", (e) => {
  const splitsBtn = e.target.closest("[data-splits]");
  if (splitsBtn) {
    toggleSwim(splitsBtn.dataset.splits);
    return;
  }
  if (e.target.closest("[data-meet-order]")) {
    state.meetOrder = state.meetOrder === "newest" ? "oldest" : "newest";
    cache.setPref("meetOrder", state.meetOrder);
    renderTimes();
    return;
  }
  const colTh = e.target.closest("[data-toggle-col]");
  if (colTh) {
    toggleColumn(colTh.dataset.toggleCol);
    return;
  }
  const courseTh = e.target.closest("th.c[data-course]");
  if (courseTh) {
    setCourse(courseTh.dataset.course);
    return;
  }
  const rankBtn = e.target.closest("[data-rank-open]");
  if (rankBtn) {
    openRank(rankBtn.dataset.stroke, Number(rankBtn.dataset.distance), rankBtn.dataset.rankScope || "club");
    return;
  }
  const evRow = e.target.closest("tr.ev-row");
  if (evRow) toggleReport(evRow.dataset.stroke, Number(evRow.dataset.distance));
});

window.addEventListener("storage", (e) => {
  if (e.key !== "swimpb:session") return;
  renderSession();
  if (e.newValue && state.swimmer && !state.bestRecords.length) selectSwimmer(state.swimmer);
});

el("report").addEventListener("click", (e) => {
  const splitsBtn = e.target.closest("[data-splits]");
  if (splitsBtn) {
    toggleSwim(splitsBtn.dataset.splits);
    return;
  }
  if (e.target.closest("#report-close")) closeReport();
});

// One delegated handler covers both the search results and the saved bar.
document.addEventListener("click", (e) => {
  const card = e.target.closest(".swimmer");
  if (!card) return;
  const id = card.dataset.member;
  const known =
    state.results?.find((s) => s.memberId === id) ??
    cache.pinned().find((s) => s.memberId === id) ??
    cache.getEntry(`swimmer:${id}`)?.data ??
    { memberId: id };
  selectSwimmer(known, { historyMode: "push" });
});

el("swimmer").addEventListener("click", (e) => {
  if (!e.target.closest("#pin-btn") || !state.swimmer) return;
  if (cache.isPinned(state.swimmer.memberId)) cache.unpin(state.swimmer.memberId);
  else cache.pin(state.swimmer);
  renderPinned();
  renderSwimmer({ freshness: document.querySelector(".freshness")?.textContent?.replace(/^·\s*/, "") ?? "" });
});

// Keyboard: 1/2/3 switch course, / focuses search.
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "Escape") {
    if (state.rank) closeRank();
    else closeReport();
    return;
  }
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("tr.ev-row")) {
    e.preventDefault();
    toggleReport(e.target.dataset.stroke, Number(e.target.dataset.distance), { focus: true });
    return;
  }
  if (e.key === "/") {
    e.preventDefault();
    el("q").focus();
  }
  const idx = ["1", "2", "3"].indexOf(e.key);
  if (idx !== -1) setCourse(COURSES[idx]);
});

el("theme-btn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  cache.setPref("theme", next);
});

// ---------------------------------------------------------------------------
// Boot

function boot() {
  document.documentElement.dataset.theme = cache.pref("theme", "dark");
  el("current-only").checked = state.currentOnly;
  renderCourse();
  renderSession();
  renderPinned();
  loadRegionalStandards().then((data) => {
    if (!data || state.regionalStandards) return;
    state.regionalStandards = data;
    renderRegionalNotes();
    if (state.swimmer) {
      renderStandards();
      renderTimes();
    }
  });

  // Deep link wins; otherwise fall back to the most recently saved swimmer so
  // the common case — checking on your own kid — needs zero interaction.
  const id = new URLSearchParams(location.search).get("m");
  const target = id
    ? (cache.getEntry(`swimmer:${id}`)?.data ??
      cache.pinned().find((s) => s.memberId === id) ?? { memberId: id })
    : cache.pinned()[0];

  if (target) {
    const pending = rankFromUrl();
    if (pending) state.rank = pending;
    selectSwimmer(target);
    if (pending) openRank(pending.stroke, pending.distance, pending.scope, { historyMode: "none" });
  } else el("q").focus();
}

window.addEventListener("popstate", () => {
  const currentId = new URLSearchParams(location.search).get("m");
  if (currentId && (!state.swimmer || state.swimmer.memberId !== currentId)) {
    const target =
      cache.getEntry(`swimmer:${currentId}`)?.data ??
      cache.pinned().find((s) => s.memberId === currentId) ?? { memberId: currentId };
    const pending = rankFromUrl();
    if (pending) state.rank = pending;
    selectSwimmer(target, { historyMode: "none" });
    if (pending) openRank(pending.stroke, pending.distance, pending.scope, { historyMode: "none" });
    return;
  }
  if (!state.swimmer) return;
  const pending = rankFromUrl();
  if (pending) openRank(pending.stroke, pending.distance, pending.scope, { historyMode: "none" });
  else if (state.rank) closeRank({ fromPop: true });
});

boot();
