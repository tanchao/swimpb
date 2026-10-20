// Client for USA Swimming's Data Hub BFF API (/api/times/swims).
//
// In October 2026 USA Swimming moved the frontend off direct calls to
// times-api.usaswimming.org and behind a same-origin BFF at
// https://data.usaswimming.org/api/times/swims authenticated by an HttpOnly
// `bff_auth_session` cookie. Because data.usaswimming.org rejects cross-origin
// requests with HTTP 400 and browsers forbid setting a `Cookie` header on fetch,
// requests go through `/api/times/swims`. Locally that is `serve.py`. On
// Cloudflare Pages it is `functions/`, which stores no session of its own.

const BASE = "/api/times/swims";
const TIMEOUT_MS = 20_000;

// The server rejects arbitrary values with 400 "Invalid Device-Id format in
// request headers." It wants the shape the official SPA produces: a base64
// blob with its first 5 chars re-inserted at offset 15. Reproduced here so our
// requests are accepted; persisted so we look like one stable client instead of
// a new device on every page load.
function makeDeviceId() {
  const b64 = btoa(`platform - vendor - unknown - ${Date.now()}`);
  return b64.slice(0, 15) + b64.slice(0, 5) + b64.slice(15);
}

function deviceId() {
  let id = localStorage.getItem("swimpb:deviceId");
  if (!id) {
    id = makeDeviceId();
    localStorage.setItem("swimpb:deviceId", id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Session
//
// Every Data Hub endpoint now requires a signed-in `bff_auth_session` cookie
// (anonymous calls return 401). The user copies any `/api/times/swims` request
// as cURL from DevTools on data.usaswimming.org and pastes it in; we extract
// `bff_auth_session` and pass it to the local `serve.py` proxy in `X-Bff-Session`,
// which forwards it upstream as a Cookie header.
//
// Kept in sessionStorage, never localStorage: a session cookie grants access
// to the account's view of the data, so it dies with the tab rather than
// sitting on disk.

const SESSION_KEY = "swimpb:session";

/** @returns {{bffSession:string}|null} */
export function session() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return typeof s?.bffSession === "string" && s.bffSession ? { bffSession: s.bffSession } : null;
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing to do — an unwritable store just means no session.
  }
  if (typeof fetch === "function") {
    fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  }
}

/**
 * Sign in with USA Swimming credentials via the local `serve.py` OIDC proxy.
 * Credentials are exchanged for a `bff_auth_session` cookie and never stored.
 */
export async function loginWithCredentials(username, password) {
  let res;
  try {
    res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.trim(), password }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(
      err.name === "TimeoutError"
        ? "USA Swimming did not respond in time."
        : "Could not reach the local server.",
      0,
      { needsSession: true },
    );
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON response (e.g. 501 from python3 -m http.server)
  }

  if (res.status === 501 || res.status === 405) {
    throw new ApiError(
      "Local API proxy is not running. Start the server with: python3 serve.py",
      res.status,
      { needsSession: true },
    );
  }

  if (!res.ok || !data?.ok || !data?.bffSession) {
    throw new ApiError(
      data?.error || `Sign-in failed (${res.status}).`,
      res.status,
      { needsSession: true },
    );
  }

  setSession(data.bffSession);
  return data.bffSession;
}

/**
 * Pull a `bff_auth_session` cookie value out of whatever the user pasted.
 *
 * Accepts DevTools "Copy as cURL" (`-b 'bff_auth_session=...'`, `--cookie`, or
 * `-H 'Cookie: ...'`), a `bff_auth_session=<value>` pair, or a bare ASP.NET Core
 * Data Protection cookie value (`CfDJ8...`) copied from Application → Cookies.
 *
 * @returns {{bffSession:string}|null}
 */
export function parseSession(text) {
  if (typeof text !== "string" || !text.trim()) return null;

  const named = text.match(/(?:^|[\s;'"=])bff_auth_session=([A-Za-z0-9_\-~.%+=/]{20,})/);
  if (named) return { bffSession: named[1] };

  const trimmed = text.trim();
  if (/^CfDJ8[A-Za-z0-9_\-~.%+=/]{20,}$/.test(trimmed)) {
    return { bffSession: trimmed };
  }

  return null;
}

/** Store a pasted session. @returns {boolean} whether it parsed */
export function setSession(text) {
  const parsed = parseSession(text);
  if (!parsed) return false;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(parsed));
  } catch {
    return false;
  }
  return true;
}

export class ApiError extends Error {
  constructor(message, status, { needsSession = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    // The UI prompts for a paste instead of showing a bare status code.
    this.needsSession = needsSession;
  }
}

async function request(path, body) {
  const active = session();
  const headers = {
    "Device-Id": deviceId(),
    "X-CSRF": "1",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (active) {
    headers["X-Bff-Session"] = active.bffSession;
  }

  let res;
  try {
    res = await fetch(BASE + path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(
      err.name === "TimeoutError"
        ? "USA Swimming did not respond in time."
        : "Could not reach USA Swimming. Check your connection.",
      0,
    );
  }

  // Detect `python3 -m http.server` (returns 501 on POST and text/html 404 on GET).
  if (
    res.status === 501 ||
    (res.status === 404 && (res.headers.get("content-type") ?? "").includes("text/html"))
  ) {
    throw new ApiError(
      "Local API proxy is not running. Start the server with: python3 serve.py",
      res.status,
    );
  }

  if (res.status === 404) return null; // "no records" — a normal empty result

  // 401/403 means "sign in", not "something went wrong".
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(
      active
        ? "That USA Swimming session is no longer valid. Sign in again and paste a fresh one."
        : "USA Swimming now requires a sign-in for this. Paste a session to continue.",
      res.status,
      { needsSession: true },
    );
  }

  if (!res.ok) {
    throw new ApiError(`USA Swimming returned ${res.status}.`, res.status);
  }
  // The hosted proxy returns a replacement cookie only to this browser.
  const rotated = res.headers.get("X-Bff-Session");
  if (rotated) setSession(`bff_auth_session=${rotated}`);
  return res.json();
}

/**
 * Free-text swimmer search. `name` matches against full/preferred name.
 * @param {string} name
 * @param {{lscCode?: string|null, currentOnly?: boolean}} [opts]
 *   lscCode narrows to one LSC (e.g. "IL"); currentOnly=false includes
 *   swimmers without a current registration.
 * @returns {Promise<Array<{memberId,fullName,shortName,clubName,lscCode,swimmerAge,isNcaa}>>}
 */
export async function searchSwimmers(name, opts = {}) {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const res = await request("/TimesSearch/GetMembersForFilters", {
    name: trimmed,
    orgCode: null,
    lscCode: opts.lscCode ?? null,
    // Numeric, not boolean — a JSON `true` here is rejected with a parse error.
    isCurrent: opts.currentOnly === false ? 0 : 1,
  });
  return res ?? [];
}

/**
 * Every personal best for a swimmer, across all three courses in one call.
 * @returns {Promise<Array<{swimTimeRecognitionId,strokeName,strokeAbbreviation,distance,courseCode,swimTime,swimDate}>>}
 */
export async function bestTimes(memberId) {
  const res = await request(`/TimesSearch/GetBestTimesForMember/${memberId}`);
  return res ?? [];
}

/**
 * Every recorded individual swim for a swimmer across all meets and courses.
 * Carries meetName, swimDate, swimmerAge, powerPoints, and timeStandard.
 * @returns {Promise<Array<{swimTimeId,meetId,meetName,eventId,eventCode,courseCode,swimDate,swimmerAge,powerPoints,swimTime,timeStandard,clubName}>>}
 */
export async function allTimes(memberId) {
  const res = await request("/TimesSearch/GetAllTimesForFilters", { memberId });
  return res ?? [];
}

/**
 * One recorded swim, with its lap `splits`. The id is `swimTimeId` from
 * GetAllTimesForFilters — not `swimTimeRecognitionId` from the best times, which
 * is a different id space and returns another swimmer's swim.
 * The payload shape of `splits` is not verified; see splits.js.
 */
export async function swimDetail(swimTimeId) {
  return request(`/TimesSearch/AllTimes/SwimTime/${encodeURIComponent(swimTimeId)}`);
}

/** Full profile for one swimmer, incl. profilePicUrl. Public. */
export async function getMember(memberId) {
  return request(`/TimesSearch/GetMember/${memberId}`);
}

/** LSC list, for the search filter dropdown. */
export async function lscs() {
  const res = await request("/SearchFilter/GetLscs");
  return res ?? [];
}

/** Every event the site ranks, with its id: individual and relay, all courses. */
export async function allEvents() {
  const res = await request("/SearchFilter/GetAllEvents");
  return res ?? [];
}

/** Seasons (9/1 to 8/31) with the `reportingYearKey` the leaderboard filters on. */
export async function seasons() {
  const res = await request("/SearchFilter/GetSeasons");
  return res ?? [];
}

/**
 * The fastest swimmers for one event and filter set. At most 100 rows, sorted by
 * time, one row per swimmer. See app/rank.js for the body.
 */
export async function topTimes(body) {
  const res = await request("/TimesSearch/GetTopTimesLeaderBoard", body);
  return res ?? [];
}

/** Deep link to this swimmer on the official site, for cross-checking. */
export function officialUrl(memberId) {
  return `https://data.usaswimming.org/search/athlete/${memberId}/best-times`;
}
