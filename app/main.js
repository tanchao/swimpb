// State and wiring. Owns the URL (so a swimmer is linkable/bookmarkable), the
// cache calls, and event handling; delegates all markup to ui.js.

import { advise } from "./advise.js";
import { ApiError, bestTimes, getMember, officialUrl, searchSwimmers } from "./api.js";
import * as cache from "./cache.js";
import { COURSES } from "./convert.js";
import { ageGroupFor, loadStandards } from "./standards.js";
import * as ui from "./ui.js";

const el = (id) => document.getElementById(id);

const state = {
  course: cache.pref("course", "SCY"),
  currentOnly: cache.pref("currentOnly", true),
  swimmer: null,
  groups: [],
  results: null,
  // The motivational standards table, and which slice of it to measure against.
  // Gender can't be derived — the public API has no such field — so it is set
  // per swimmer and remembered.
  standards: null,
  gender: null,
  ageGroupOverride: null,
};

/** The age group in force: an explicit override, else derived from the age. */
function ageGroup() {
  return state.ageGroupOverride ?? ageGroupFor(state.swimmer?.swimmerAge);
}

/** What ui.js needs to draw chips, or null when there's nothing to measure. */
function standardsContext() {
  if (!state.standards) return null;
  return { data: state.standards, gender: state.gender, ageGroup: ageGroup() };
}

// ---------------------------------------------------------------------------
// Rendering

function renderCourse() {
  el("course-toggle").innerHTML = ui.courseToggle(state.course);
}

function renderPinned() {
  el("pinned").innerHTML = ui.pinnedBar(cache.pinned(), state.swimmer?.memberId);
}

function renderResults() {
  el("results").innerHTML = ui.swimmerList(state.results);
}

function renderStandards() {
  el("standards").innerHTML = state.swimmer
    ? ui.standardsBar({
        gender: state.gender,
        ageGroup: ageGroup(),
        autoGroup: ageGroupFor(state.swimmer.swimmerAge),
        age: state.swimmer.swimmerAge ?? null,
        edition: state.standards?.edition ?? null,
        ready: Boolean(state.standards),
      })
    : "";
}

function renderTimes() {
  const std = standardsContext();
  el("times").innerHTML = ui.bestTimesTable(state.groups, state.course, std);
  // The ruler and the advice move together, so they re-render together.
  el("advice").innerHTML = std
    ? ui.advicePanel(advise(state.groups, std, state.course), state.course, state.standards?.edition)
    : "";
}

function renderSwimmer(meta = {}) {
  if (!state.swimmer) {
    el("swimmer").innerHTML = "";
    el("standards").innerHTML = "";
    el("times").innerHTML = "";
    el("advice").innerHTML = "";
    return;
  }
  el("swimmer").innerHTML = ui.swimmerHeader(state.swimmer, {
    pinned: cache.isPinned(state.swimmer.memberId),
    officialUrl: officialUrl(state.swimmer.memberId),
    freshness: meta.freshness ?? "",
  });
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
    if (list.length === 1) selectSwimmer(list[0]);
  } catch (err) {
    status(err instanceof ApiError ? err.message : "Search failed.", "error");
  }
}

async function selectSwimmer(swimmer) {
  state.swimmer = swimmer;
  state.groups = [];
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
    if (state.swimmer) {
      renderStandards();
      renderTimes();
    }
  });

  const url = new URL(location.href);
  url.searchParams.set("m", swimmer.memberId);
  history.replaceState(null, "", url);

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
        renderSwimmer({ freshness: document.querySelector(".freshness")?.textContent ?? "" });
      })
      .catch(() => {});
  }

  try {
    const { data, fromCache, fetchedAt } = await cache.swr(
      `bestTimes:${swimmer.memberId}`,
      () => bestTimes(swimmer.memberId),
      (fresh) => {
        // Background refresh returned something different — swap it in.
        state.groups = ui.groupBestTimes(fresh);
        renderSwimmer({ freshness: "Updated with new times from USA Swimming." });
      },
    );
    state.groups = ui.groupBestTimes(data);
    status("");
    renderSwimmer({ freshness: freshnessLabel(fetchedAt, fromCache) });
  } catch (err) {
    // If we have any cached copy at all, showing it beats showing an error.
    const stale = cache.getEntry(`bestTimes:${swimmer.memberId}`);
    if (stale) {
      state.groups = ui.groupBestTimes(stale.data);
      renderSwimmer({ freshness: "Offline — showing the last saved copy." });
      status("");
    } else {
      status(err instanceof ApiError ? err.message : "Could not load times.", "error");
    }
  }
}

function setCourse(course) {
  if (!COURSES.includes(course) || course === state.course) return;
  state.course = course;
  cache.setPref("course", course);
  renderCourse();
  // Pure re-render — no refetch, because one call already gave us every course.
  if (state.swimmer) renderTimes();
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

el("standards").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (btn) setStandardsSet({ gender: btn.dataset.gender });
});

el("standards").addEventListener("change", (e) => {
  if (e.target.id !== "age-group") return;
  // Empty value means "follow the swimmer's age" rather than a pinned group.
  setStandardsSet({ ageGroupOverride: e.target.value || null });
});

// One delegated handler covers both the search results and the saved bar.
document.addEventListener("click", (e) => {
  const card = e.target.closest(".swimmer");
  if (!card) return;
  const id = card.dataset.member;
  const known =
    state.results?.find((s) => s.memberId === id) ??
    cache.pinned().find((s) => s.memberId === id) ??
    cache.getEntry(`swimmer:${id}`)?.data;
  if (known) selectSwimmer(known);
});

el("swimmer").addEventListener("click", (e) => {
  if (!e.target.closest("#pin-btn") || !state.swimmer) return;
  if (cache.isPinned(state.swimmer.memberId)) cache.unpin(state.swimmer.memberId);
  else cache.pin(state.swimmer);
  renderPinned();
  renderSwimmer({ freshness: document.querySelector(".freshness")?.textContent ?? "" });
});

// Keyboard: 1/2/3 switch course, / focuses search.
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) {
    if (e.key === "Escape") e.target.blur();
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
  renderPinned();

  // Deep link wins; otherwise fall back to the most recently saved swimmer so
  // the common case — checking on your own kid — needs zero interaction.
  const id = new URLSearchParams(location.search).get("m");
  const target = id
    ? (cache.getEntry(`swimmer:${id}`)?.data ??
      cache.pinned().find((s) => s.memberId === id) ?? { memberId: id })
    : cache.pinned()[0];

  if (target) selectSwimmer(target);
  else el("q").focus();
}

boot();
