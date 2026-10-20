// The Rankings panel: state, fetching, and the view model. Owns no markup
// (rankviews.js) and no ranking maths (rank.js).
//
// Nothing is fetched until the panel is open. Opening it costs three leaderboard
// calls (LSC, zone, nation) plus two small reference lists. Club standing and
// the club leaderboard come from the LSC list, so they cost no call.
//
// The API client and storage are passed in, so tests run with fakes.

import { AGE_GROUP_LABEL } from "./standards.js";
import {
  LIST_CAP,
  ageRange,
  clubRows,
  clubStanding,
  currentSeasonKey,
  defaultSelection,
  eventIdFor,
  individualEvents,
  leaderboardBody,
  pastSeasons,
  scopesFor,
  selectionFor,
  slimRows,
  standing,
} from "./rank.js";
import { rankingsPanel } from "./rankviews.js";

// Leaderboards change when meets are swum. A tab left open for a day should not
// keep showing yesterday's list.
const LIST_TTL_MS = 30 * 60 * 1000;

/**
 * @param {object} deps
 * @param {{allEvents:Function, seasons:Function, topTimes:Function}} deps.api
 * @param {object} deps.cache  swr, getSession, setSession, pref, setPref
 * @param {() => {swimmer:object|null, gender:string|null, ageGroup:string|null,
 *                course:string, groups:Array}} deps.context
 * @param {(err:Error) => void} deps.onError
 * @param {{innerHTML:string, addEventListener?:Function}} deps.host
 * @param {() => Date} [deps.now]
 */
export function createRankings({ api, cache, context, onError, host, now = () => new Date() }) {
  const state = {
    open: cache.pref("rankOpen", false),
    sel: null, // {stroke, distance} in yards terms; null follows the board
    ageChoice: "age",
    seasonKey: undefined, // undefined follows the current season; null is all time
    genderOverride: null,
    tab: null,
    events: null,
    seasons: null,
    refStatus: "idle",
    refError: "",
    lists: new Map(), // request key → {status, rows, message}
  };
  let seenSwimmer = null;
  let seenGender = null;

  const messageOf = (err, fallback) => (err?.message ? String(err.message) : fallback);

  // -------------------------------------------------------------------------
  // Reference lists

  async function loadReference() {
    if (state.refStatus === "loading" || state.refStatus === "ready") return;
    state.refStatus = "loading";
    render();
    try {
      const [events, seasons] = await Promise.all([
        cache.swr("rank:events", () => api.allEvents()),
        cache.swr("rank:seasons", () => api.seasons()),
      ]);
      state.events = events.data ?? [];
      state.seasons = seasons.data ?? [];
      state.refStatus = "ready";
    } catch (err) {
      state.refStatus = "error";
      state.refError = messageOf(err, "Could not load the event list.");
      onError(err);
    }
    render();
    fetchLists();
  }

  // -------------------------------------------------------------------------
  // What is being asked for

  function selection() {
    const ctx = context();
    const swimmer = ctx.swimmer;
    const gender = state.genderOverride ?? ctx.gender;
    const sel = state.sel ?? defaultSelection(ctx.groups, ctx.course);
    const eventId = state.events ? eventIdFor(state.events, sel, ctx.course) : null;

    const ageChoices = [];
    if (Number.isFinite(swimmer?.swimmerAge)) {
      ageChoices.push({ value: "age", label: `Age ${swimmer.swimmerAge}` });
    }
    if (AGE_GROUP_LABEL[ctx.ageGroup]) {
      ageChoices.push({ value: "group", label: AGE_GROUP_LABEL[ctx.ageGroup] });
    }
    ageChoices.push({ value: "all", label: "All ages" });
    const ageValue = ageChoices.some((c) => c.value === state.ageChoice) ? state.ageChoice : "all";
    const age = ageRange(ageValue, { age: swimmer?.swimmerAge, ageGroup: ctx.ageGroup });

    const seasonKey =
      state.seasonKey === undefined ? currentSeasonKey(state.seasons, now()) : state.seasonKey;

    return { ctx, swimmer, gender, eventId, ageChoices, ageValue, age, seasonKey };
  }

  /** One request per scope, or [] while something is missing. */
  function requests(s) {
    if (!s.swimmer || !s.gender || s.eventId == null) return [];
    return scopesFor(s.swimmer).map((scope) => {
      const body = leaderboardBody({
        eventId: s.eventId,
        gender: s.gender,
        age: s.age,
        seasonKey: s.seasonKey,
        ...scope.filter,
      });
      return { scope: scope.key, label: scope.label, body, key: JSON.stringify(body) };
    });
  }

  // -------------------------------------------------------------------------
  // Fetching

  async function fetchList({ key, body }) {
    const hit = cache.getSession(`rank:${key}`);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) {
      state.lists.set(key, { status: "ready", rows: hit.rows });
      return;
    }
    state.lists.set(key, { status: "loading" });
    render();
    try {
      const rows = slimRows(await api.topTimes(body));
      cache.setSession(`rank:${key}`, { at: Date.now(), rows });
      state.lists.set(key, { status: "ready", rows });
    } catch (err) {
      state.lists.set(key, { status: "error", message: messageOf(err, "Could not load the leaderboard.") });
      onError(err);
    }
    render();
  }

  async function fetchLists() {
    if (!state.open || state.refStatus !== "ready") return;
    const todo = requests(selection()).filter((r) => !state.lists.has(r.key));
    if (!todo.length) return;
    await Promise.all(todo.map(fetchList));
    // A list served from the tab cache is stored without a draw of its own.
    render();
  }

  // -------------------------------------------------------------------------
  // The view model

  function cardFor(r, entry, memberId) {
    if (!entry || entry.status === "loading") return { kind: "loading", label: r.label };
    if (entry.status === "error") return { kind: "error", label: r.label, message: entry.message };
    const st = standing(entry.rows, memberId);
    if (st.kind === "ranked") {
      return {
        kind: "ranked",
        label: r.label,
        rank: st.rank,
        time: st.row.swimTime,
        of: st.complete ? `of ${st.of}` : "top 100",
      };
    }
    return { kind: st.kind, label: r.label, cutoff: st.cutoff };
  }

  function model() {
    const s = selection();
    const m = {
      open: state.open,
      course: s.ctx.course,
      refStatus: state.refStatus,
      refError: state.refError,
      eventGroups: individualEvents(state.events, s.ctx.course),
      eventId: s.eventId,
      gender: s.gender,
      ageOptions: s.ageChoices,
      ageValue: s.ageValue,
      seasonOptions: [
        { value: "all", label: "All time" },
        ...pastSeasons(state.seasons, now()).map((x) => ({ value: x.reportingYearKey, label: x.season })),
      ],
      seasonValue: s.seasonKey == null ? "all" : String(s.seasonKey),
      note: null,
      cards: null,
      tabs: [],
      tab: null,
      tabNote: null,
      table: null,
    };
    if (!state.open || state.refStatus !== "ready") return m;

    if (!s.gender) {
      m.note = "Pick Boys or Girls — the public API does not say which.";
      return m;
    }
    if (s.eventId == null) {
      m.note = "Choose an event.";
      return m;
    }

    const reqs = requests(s);
    const entryOf = (r) => state.lists.get(r.key);
    const memberId = s.swimmer.memberId;

    // The narrowest list that holds the swimmer decides the club standing.
    let club = null;
    let clubSource = null;
    for (const r of reqs) {
      const e = entryOf(r);
      if (e?.status !== "ready") continue;
      club = clubStanding(e.rows, memberId);
      if (club) {
        clubSource = { label: r.label, rows: e.rows, complete: e.rows.length < LIST_CAP };
        break;
      }
    }

    // Standings describe this swimmer, so they are only shown in the swimmer's
    // own gender. Browsing the other gender shows the leaderboard alone.
    if (s.ctx.gender && s.gender === s.ctx.gender) {
      const pending = reqs.some((r) => !entryOf(r) || entryOf(r).status === "loading");
      const clubCard = club
        ? {
            kind: "ranked",
            label: club.clubCode,
            rank: club.rank,
            time: club.clubName,
            of: clubSource.complete
              ? `of ${club.count}`
              : `of ${club.count} in the ${clubSource.label} top 100`,
          }
        : pending
          ? { kind: "loading", label: "Club" }
          : {
              kind: "unknown",
              label: "Club",
              message: reqs.some((r) => entryOf(r)?.rows?.some((x) => x.memberId === memberId))
                ? "Swam unattached — no club rank"
                : reqs.some((r) => entryOf(r)?.status === "error")
                  ? "Unknown until every list loads"
                  : "Needs a time in a top-100 list",
            };
      m.cards = [clubCard, ...reqs.map((r) => cardFor(r, entryOf(r), memberId))];
    }

    m.tabs = reqs.map((r) => ({ key: r.scope, label: r.label }));
    if (club && m.cards) m.tabs.unshift({ key: "club", label: club.clubCode });
    m.tab = m.tabs.some((t) => t.key === state.tab) ? state.tab : (m.tabs[0]?.key ?? null);

    if (m.tab === "club") {
      m.tabNote = `Only ${club.clubName} swimmers in the ${clubSource.label} top 100.`;
      m.table = { status: "ready", rows: clubRows(clubSource.rows, club.clubCode), meId: memberId };
    } else {
      const r = reqs.find((x) => x.scope === m.tab);
      const e = r && entryOf(r);
      m.table = e
        ? {
            status: e.status,
            message: e.message,
            rows: e.rows ?? [],
            meId: memberId,
          }
        : { status: "loading", rows: [], meId: memberId };
    }
    return m;
  }

  function render() {
    host.innerHTML = context().swimmer ? rankingsPanel(model()) : "";
  }

  // -------------------------------------------------------------------------
  // Events

  /** Call whenever the swimmer, course, gender, age group or board changes. */
  function refresh() {
    const ctx = context();
    const id = ctx.swimmer?.memberId ?? null;
    if (id !== seenSwimmer) {
      // Another swimmer starts from the board's defaults.
      seenSwimmer = id;
      state.sel = null;
      state.ageChoice = "age";
      state.seasonKey = undefined;
      state.genderOverride = null;
      state.tab = null;
    }
    if (ctx.gender !== seenGender) {
      seenGender = ctx.gender;
      state.genderOverride = null;
    }
    render();
    if (!ctx.swimmer || !state.open) return;
    if (state.refStatus === "idle") loadReference();
    else fetchLists();
  }

  /** Forget failed requests so the next refresh tries them again. */
  function retryErrors() {
    for (const [key, e] of state.lists) if (e.status === "error") state.lists.delete(key);
    if (state.refStatus === "error") state.refStatus = "idle";
  }

  function act({ type, value }) {
    switch (type) {
      case "toggle":
        state.open = !state.open;
        cache.setPref("rankOpen", state.open);
        break;
      case "event":
        state.sel = selectionFor(state.events, Number(value));
        break;
      case "age":
        state.ageChoice = value;
        break;
      case "season":
        state.seasonKey = value === "all" ? null : Number(value);
        break;
      case "gender":
        state.genderOverride = value;
        break;
      case "tab":
        state.tab = value;
        break;
      case "retry":
        retryErrors();
        break;
      default:
        return;
    }
    refresh();
  }

  host.addEventListener?.("click", (e) => {
    const hit = (sel) => e.target.closest?.(sel);
    let b;
    if ((b = hit("[data-rank-toggle]"))) act({ type: "toggle" });
    else if ((b = hit("[data-rank-gender]"))) act({ type: "gender", value: b.dataset.rankGender });
    else if ((b = hit("[data-rank-tab]"))) act({ type: "tab", value: b.dataset.rankTab });
    else if (hit("[data-rank-retry]")) act({ type: "retry" });
  });
  host.addEventListener?.("change", (e) => {
    const t = e.target;
    if (t.matches?.("[data-rank-event]")) act({ type: "event", value: t.value });
    else if (t.matches?.("[data-rank-age]")) act({ type: "age", value: t.value });
    else if (t.matches?.("[data-rank-season]")) act({ type: "season", value: t.value });
  });

  return { refresh, retryErrors, act, model, state };
}
