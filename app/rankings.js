// Rankings: Team, LSC, Zone, and US places on the board, and one page that is
// the list for the event and group you clicked.
//
// Team and LSC both come from the LSC list. Zone and US are their own lists,
// and each is fetched only when that column is on or the page is showing it.
// A list is kept in localStorage and shown at once on the next visit, including
// after the tab is closed. It is fetched again when it is older than a day and
// a half. Nothing is fetched while every rank column is hidden and the page is
// closed.

import { AGE_GROUP_LABEL } from "./standards.js";
import {
  LIST_CAP,
  ageRange,
  clubRows,
  clubStanding,
  currentSeasonKey,
  eventIdFor,
  leaderboardBody,
  pastSeasons,
  slimRows,
  standing,
  zoneOf,
} from "./rank.js";
import { rankingPage } from "./rankviews.js";

const RANK_FRESH_MS = 36 * 60 * 60 * 1000;
const POOL = 4;

const RANK_COLS = [
  { key: "team", label: "Team", scope: "club", list: "lsc" },
  { key: "lsc", label: "LSC", scope: "lsc", list: "lsc" },
  { key: "zone", label: "Zone", scope: "zone", list: "zone" },
  { key: "us", label: "US", scope: "us", list: "us" },
];

function unattached(name) {
  return !name || /^unattached\b/i.test(name);
}

/** Team identity from a list: his own row, or a clubmate with the same club name. */
function teamFrom(rows, swimmer) {
  const list = Array.isArray(rows) ? rows : [];
  const mine = clubStanding(list, swimmer?.memberId);
  if (mine) return { ...mine, inList: true };
  if (unattached(swimmer?.clubName)) return null;
  const hit = list.find((r) => r.clubName === swimmer.clubName && r.clubCode && r.clubCode !== "UN");
  if (!hit) return null;
  return {
    clubCode: hit.clubCode,
    clubName: hit.clubName,
    rank: null,
    count: list.filter((r) => r.clubCode === hit.clubCode).length,
    inList: false,
  };
}

function tabsFor(swimmer) {
  const tabs = [];
  if (!unattached(swimmer?.clubName)) {
    tabs.push({ key: "club", label: "Team", title: swimmer.clubName });
  }
  if (swimmer?.lscCode) tabs.push({ key: "lsc", label: swimmer.lscCode, title: swimmer.lscCode });
  const zone = zoneOf(swimmer?.lscCode);
  if (zone) tabs.push({ key: "zone", label: zone, title: `${zone} Zone` });
  tabs.push({ key: "us", label: "US", title: "United States" });
  return tabs;
}

/**
 * @param {object} deps
 * @param {{allEvents:Function, seasons:Function, topTimes:Function}} deps.api
 * @param {object} deps.cache
 * @param {() => {swimmer:object|null, gender:string|null, ageGroup:string|null,
 *                course:string, groups:Array,
 *                ranks:{team:boolean, lsc:boolean, zone:boolean, us:boolean}}} deps.context
 * @param {(err:Error) => void} deps.onError
 * @param {(action:{type:string, scope?:string}) => void} [deps.onNavigate]
 * @param {(cells:object) => void} [deps.onBoard]
 * @param {{innerHTML:string, addEventListener?:Function, querySelector?:Function}} deps.host
 * @param {() => Date} [deps.now]
 */
export function createRankings({ api, cache, context, onError, onNavigate, onBoard, host, now = () => new Date() }) {
  const state = {
    page: null, // {stroke, distance, scope}
    ageChoice: "age",
    seasonKey: undefined, // undefined follows the current season; null is all time
    events: null,
    seasons: null,
    refStatus: "idle",
    refError: "",
    lists: new Map(),
    justOpened: false,
  };
  let seenSwimmer = null;

  const messageOf = (err, fallback) => (err?.message ? String(err.message) : fallback);

  function ageChoices(swimmer, ageGroup) {
    const choices = [];
    if (Number.isFinite(swimmer?.swimmerAge)) choices.push({ value: "age", label: `Age ${swimmer.swimmerAge}` });
    if (AGE_GROUP_LABEL[ageGroup]) choices.push({ value: "group", label: AGE_GROUP_LABEL[ageGroup] });
    choices.push({ value: "all", label: "All ages" });
    return choices;
  }

  /** @param {"page"|"board"} mode */
  function filters(mode) {
    const ctx = context();
    const swimmer = ctx.swimmer;
    const choices = ageChoices(swimmer, ctx.ageGroup);
    let ageChoice = mode === "page" ? state.ageChoice : "age";
    if (!choices.some((c) => c.value === ageChoice)) ageChoice = "all";
    const seasonKey =
      mode === "page" && state.seasonKey !== undefined
        ? state.seasonKey
        : currentSeasonKey(state.seasons, now());
    return {
      ctx,
      swimmer,
      gender: ctx.gender,
      ageChoice,
      ageChoices: choices,
      age: ageRange(ageChoice, { age: swimmer?.swimmerAge, ageGroup: ctx.ageGroup }),
      seasonKey,
    };
  }

  function resolvedScope(swimmer) {
    const tabs = tabsFor(swimmer);
    if (state.page && tabs.some((t) => t.key === state.page.scope)) return state.page.scope;
    return tabs[0]?.key ?? null;
  }

  function requestFor(f, event, scope) {
    if (!f.gender || !f.swimmer || state.refStatus !== "ready") return null;
    const eventId = eventIdFor(state.events, event, f.ctx.course);
    if (eventId == null) return null;
    const zone = zoneOf(f.swimmer.lscCode);
    const base = { eventId, gender: f.gender, age: f.age, seasonKey: f.seasonKey };
    let body;
    if (scope === "us") {
      body = leaderboardBody(base);
    } else if (scope === "zone") {
      if (!zone) return null;
      body = leaderboardBody({ ...base, zoneCode: zone });
    } else {
      if (!f.swimmer.lscCode) return null;
      body = leaderboardBody({ ...base, lscCode: f.swimmer.lscCode });
    }
    return { key: JSON.stringify(body), body };
  }

  /** The page's team view is the LSC list, filtered down to the club. */
  function listScope(scope) {
    if (scope === "zone" || scope === "us") return scope;
    return "lsc";
  }

  function boardEvents(ctx) {
    const out = [];
    for (const g of ctx.groups ?? []) {
      for (const row of g.rows ?? []) {
        if (row.actual?.[ctx.course]?.hundredths == null) continue;
        out.push({ stroke: row.stroke || g.stroke, distance: row.distance });
      }
    }
    return out;
  }

  function pending() {
    const map = new Map();
    const add = (req) => {
      if (!req) return;
      const e = state.lists.get(req.key);
      if (e?.status === "loading" || e?.status === "error") return;
      if (e?.status === "ready" && e.fresh) return;
      map.set(req.key, req);
    };
    if (state.page) {
      const f = filters("page");
      add(requestFor(f, state.page, listScope(resolvedScope(f.swimmer))));
    }
    const ranks = context().ranks ?? {};
    if (ranks.team || ranks.lsc || ranks.zone || ranks.us) {
      const f = filters("board");
      for (const ev of boardEvents(context())) {
        if (ranks.team || ranks.lsc) add(requestFor(f, ev, "lsc"));
        if (ranks.zone) add(requestFor(f, ev, "zone"));
        if (ranks.us) add(requestFor(f, ev, "us"));
      }
    }
    return [...map.values()];
  }

  function pageRequestKey() {
    if (!state.page) return null;
    const f = filters("page");
    return requestFor(f, state.page, listScope(resolvedScope(f.swimmer)))?.key ?? null;
  }

  function placeCell(col, entry, swimmer) {
    if (!entry || entry.status === "loading") {
      return { text: "…", title: `Loading ${col.label} rank`, scope: col.scope, kind: "wait" };
    }
    if (entry.status === "error") {
      return { text: "!", title: entry.message || "Could not load", scope: col.scope, kind: "error" };
    }
    if (col.key === "team") {
      if (unattached(swimmer.clubName)) {
        return { text: "—", title: "No team rank for an unattached swimmer.", scope: "club", kind: "miss" };
      }
      const team = teamFrom(entry.rows, swimmer);
      if (team?.inList) {
        return {
          text: String(team.rank),
          title: `${team.clubCode} #${team.rank} of ${team.count}. Open the team ranking.`,
          scope: "club",
          kind: "rank",
        };
      }
      return { text: "—", title: "No team rank in this list.", scope: "club", kind: "miss" };
    }
    const st = standing(entry.rows, swimmer.memberId);
    const where =
      col.key === "lsc" ? swimmer.lscCode : col.key === "zone" ? zoneOf(swimmer.lscCode) : "the US";
    if (st.kind === "ranked") {
      return {
        text: String(st.rank),
        title: `${where} #${st.rank}. Open the list.`,
        scope: col.scope,
        kind: "rank",
      };
    }
    if (st.kind === "outside") {
      return { text: "—", title: `Not in the top 100. Open the list.`, scope: col.scope, kind: "miss" };
    }
    return { text: "—", title: "No time in this list.", scope: col.scope, kind: "miss" };
  }

  function boardCell(col, f, ev, swimmer) {
    if (!f.gender) {
      return { text: "…", title: "Pick Boys or Girls, then open the ranking.", scope: col.scope, kind: "wait" };
    }
    if (col.list !== "us" && !swimmer.lscCode) {
      return { text: "—", title: "No LSC on this swimmer yet.", scope: col.scope, kind: "miss" };
    }
    if (col.list === "zone" && !zoneOf(swimmer.lscCode)) {
      return { text: "—", title: "No zone for this LSC.", scope: col.scope, kind: "miss" };
    }
    if (state.refStatus === "error") {
      return { text: "!", title: state.refError || "Could not load rankings.", scope: col.scope, kind: "error" };
    }
    const req = requestFor(f, ev, col.list);
    if (!req) return { text: "…", title: `Loading ${col.label} rank`, scope: col.scope, kind: "wait" };
    return placeCell(col, state.lists.get(req.key), swimmer);
  }

  /**
   * Rank text for each visible column of each board row that has a real time.
   * Key is `Stroke|distance`, then `team` / `lsc` / `zone` / `us`.
   */
  function boardCells() {
    const ctx = context();
    const cells = {};
    const swimmer = ctx.swimmer;
    if (!swimmer) return cells;
    const ranks = ctx.ranks ?? {};
    const cols = RANK_COLS.filter((c) => ranks[c.key]);
    const f = filters("board");
    for (const ev of boardEvents(ctx)) {
      const key = `${ev.stroke}|${ev.distance}`;
      const row = {};
      for (const col of cols) row[col.key] = boardCell(col, f, ev, swimmer);
      cells[key] = row;
    }
    return cells;
  }

  function scopeNote(scope, entry, swimmer, team) {
    if (!entry || entry.status !== "ready") return null;
    const full = entry.rows.length >= LIST_CAP;
    const inList = entry.rows.some((r) => r.memberId === swimmer.memberId);
    const lsc = swimmer.lscCode;
    if (scope === "club") {
      if (!team) {
        return full
          ? `Not in the ${lsc} top 100, so there is no team rank. The 100th time is ${entry.rows.at(-1)?.swimTime}.`
          : "No teammates in this list.";
      }
      if (!inList) return `Not in the ${lsc} top 100. These are the ${team.clubName} swimmers who are.`;
      if (full) return `Only ${team.clubName} swimmers in the ${lsc} top 100.`;
      return null;
    }
    if (!inList && full) {
      return `Not in the top 100. The 100th time is ${entry.rows.at(-1)?.swimTime}.`;
    }
    if (full) {
      if (scope === "zone") return `Fastest 100 in the ${zoneOf(lsc)} zone.`;
      if (scope === "us") return "Fastest 100 in the US.";
      return `Fastest 100 in ${lsc}.`;
    }
    return null;
  }

  function model() {
    if (!state.page) return { open: false };
    const f = filters("page");
    const swimmer = f.swimmer;
    const scope = resolvedScope(swimmer);
    const tabs = tabsFor(swimmer).map((t) => ({ ...t }));
    const eventId = state.refStatus === "ready" ? eventIdFor(state.events, state.page, f.ctx.course) : null;
    const m = {
      open: true,
      course: f.ctx.course,
      eventLabel: `${state.page.distance} ${state.page.stroke}`,
      refStatus: state.refStatus,
      refError: state.refError,
      note: null,
      tabs,
      scope,
      ageOptions: f.ageChoices,
      ageValue: f.ageChoice,
      seasonOptions: [
        { value: "all", label: "All time" },
        ...pastSeasons(state.seasons, now()).map((x) => ({ value: x.reportingYearKey, label: x.season })),
      ],
      seasonValue: f.seasonKey == null ? "all" : String(f.seasonKey),
      scopeNote: null,
      table: null,
    };
    if (state.refStatus !== "ready") return m;
    if (!f.gender) {
      m.note = "Pick Boys or Girls above — the public API does not say which.";
      return m;
    }
    if (eventId == null) {
      m.note = "This event has no ranking in this course.";
      return m;
    }
    if (!swimmer.lscCode) {
      m.note = "No LSC on this swimmer yet.";
      return m;
    }
    if (!scope) {
      m.note = "No team, LSC, or zone to rank in.";
      return m;
    }

    const labelEntry =
      state.lists.get(requestFor(filters("board"), state.page, "lsc")?.key) ??
      state.lists.get(requestFor(f, state.page, "lsc")?.key);
    if (labelEntry?.status === "ready") {
      const named = teamFrom(labelEntry.rows, swimmer);
      const tab = tabs.find((t) => t.key === "club");
      if (tab && named?.clubCode) {
        tab.label = named.clubCode;
        tab.title = named.clubName;
      }
    }

    const req = requestFor(f, state.page, listScope(scope));
    const entry = req ? state.lists.get(req.key) : null;
    if (scope === "club" && entry?.status === "ready") {
      const team = teamFrom(entry.rows, swimmer);
      m.scopeNote = scopeNote("club", entry, swimmer, team);
      m.table = {
        status: "ready",
        rows: team ? clubRows(entry.rows, team.clubCode) : [],
        meId: swimmer.memberId,
      };
      return m;
    }
    m.scopeNote = scopeNote(scope, entry, swimmer, null);
    m.table = entry
      ? { status: entry.status, message: entry.message, rows: entry.rows ?? [], meId: swimmer.memberId }
      : { status: "loading", rows: [], meId: swimmer.memberId };
    return m;
  }

  function publish({ page = false } = {}) {
    onBoard?.(boardCells());
    if (!state.page) {
      host.innerHTML = "";
      return;
    }
    if (!page) return;
    const hadMe = Boolean(host.querySelector?.("tr.me"));
    host.innerHTML = rankingPage(model());
    if (!hadMe) host.querySelector?.("tr.me")?.scrollIntoView?.({ block: "nearest" });
    if (state.justOpened) {
      state.justOpened = false;
      host.scrollIntoView?.({ block: "nearest" });
    }
  }

  async function loadReference() {
    if (state.refStatus === "loading" || state.refStatus === "ready") return;
    state.refStatus = "loading";
    publish({ page: true });
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
    publish({ page: true });
    fetchLists();
  }

  function readRank(key) {
    const hit = cache.getEntry?.(`rank:${key}`);
    if (!hit || !Array.isArray(hit.data)) return null;
    return { rows: hit.data, fresh: Date.now() - hit.fetchedAt < RANK_FRESH_MS };
  }

  async function fetchOne(req) {
    const cur = state.lists.get(req.key);
    if (cur?.status === "loading" || (cur?.status === "ready" && cur.fresh)) return;

    let shown = cur?.status === "ready" ? cur.rows : null;
    if (!shown) {
      const hit = readRank(req.key);
      if (hit) {
        shown = hit.rows;
        state.lists.set(req.key, { status: "ready", rows: hit.rows, fresh: hit.fresh });
        publish({ page: req.key === pageRequestKey() });
        if (hit.fresh) return;
      }
    }

    const page = req.key === pageRequestKey();
    if (!shown) {
      state.lists.set(req.key, { status: "loading" });
      publish({ page });
    }
    try {
      const rows = slimRows(await api.topTimes(req.body));
      cache.setEntry?.(`rank:${req.key}`, rows);
      const same = shown && JSON.stringify(shown) === JSON.stringify(rows);
      state.lists.set(req.key, { status: "ready", rows, fresh: true });
      if (!same) publish({ page });
    } catch (err) {
      if (!shown) {
        state.lists.set(req.key, { status: "error", message: messageOf(err, "Could not load the leaderboard.") });
        publish({ page });
      }
      onError(err);
    }
  }

  async function fetchLists() {
    if (state.refStatus !== "ready") return;
    const todo = pending();
    if (!todo.length) {
      publish({ page: true });
      return;
    }
    let cursor = 0;
    async function worker() {
      while (cursor < todo.length) await fetchOne(todo[cursor++]);
    }
    await Promise.all(Array.from({ length: Math.min(POOL, todo.length) }, worker));
    publish({ page: true });
  }

  function refresh() {
    const ctx = context();
    const id = ctx.swimmer?.memberId ?? null;
    if (id !== seenSwimmer) {
      seenSwimmer = id;
      state.ageChoice = "age";
      state.seasonKey = undefined;
    }
    if (!ctx.swimmer) {
      state.page = null;
      publish({ page: true });
      return;
    }
    const ranks = ctx.ranks ?? {};
    const wantBoard = Boolean(ranks.team || ranks.lsc || ranks.zone || ranks.us);
    if (!state.page && !wantBoard) {
      publish({ page: true });
      return;
    }
    if (state.refStatus === "idle") loadReference();
    else if (state.refStatus === "ready") fetchLists();
    else publish({ page: true });
  }

  function retryErrors() {
    for (const [key, e] of state.lists) if (e.status === "error") state.lists.delete(key);
    if (state.refStatus === "error") state.refStatus = "idle";
  }

  function act(action, { fromHost = false } = {}) {
    const { type, value } = action;
    switch (type) {
      case "open":
        state.page = {
          stroke: action.stroke,
          distance: Number(action.distance),
          scope: action.scope || "club",
        };
        state.justOpened = true;
        break;
      case "close":
        state.page = null;
        if (fromHost) onNavigate?.({ type: "close" });
        break;
      case "scope":
        if (state.page) state.page = { ...state.page, scope: value };
        if (fromHost) onNavigate?.({ type: "scope", scope: value });
        break;
      case "age":
        state.ageChoice = value;
        break;
      case "season":
        state.seasonKey = value === "all" ? null : Number(value);
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
    if (hit("[data-rank-back]")) act({ type: "close" }, { fromHost: true });
    else if ((b = hit("[data-rank-scope]"))) act({ type: "scope", value: b.dataset.rankScope }, { fromHost: true });
    else if (hit("[data-rank-retry]")) act({ type: "retry" }, { fromHost: true });
  });
  host.addEventListener?.("change", (e) => {
    const t = e.target;
    if (t.matches?.("[data-rank-age]")) act({ type: "age", value: t.value });
    else if (t.matches?.("[data-rank-season]")) act({ type: "season", value: t.value });
  });

  return { refresh, retryErrors, act, model, boardCells, state };
}
