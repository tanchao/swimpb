// Client for USA Swimming's public Data Hub API (times-api.usaswimming.org).
//
// This is the same API the official SPA at data.usaswimming.org calls. It sends
// `access-control-allow-origin: *` and echoes back any requested headers on the
// preflight, so a browser-only app can call it directly — no backend, no proxy,
// no token. Verified 2026-08-03.
//
// Not every endpoint is public: GetSwimmerCourses / GetSwimmerEvents /
// GetSwimmerMeets / GetAllTimesForFilters / GetSwimmerTimeStandards all return
// 403 without a logged-in session. Only the calls below are reachable
// anonymously, which is why this app derives everything from best-times.

const BASE = "https://times-api.usaswimming.org/swims";
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
// On 2026-08-28 USA Swimming closed the two endpoints this app is built on —
// GetMembersForFilters and GetBestTimesForMember both return 403 to anonymous
// callers, having worked on 2026-08-03. GetMember and GetLscs still answer, so
// it is per-endpoint authorization, not a block: verified with back-to-back
// requests that returned 403 and 200 respectively, both x-cache MISS.
//
// A browser-only app CANNOT sign in by itself. The session is an HttpOnly
// cookie on .usaswimming.org, read by the official app with
// fetch("…/bff/userinfo", {credentials:"include"}), and both that endpoint and
// security-api reject a cross-origin preflight outright (400, no CORS headers).
// No client-side code gets past that.
//
// What does work: times-api takes the session in HEADERS, not a cookie, and
// allows them from any origin —
//   access-control-allow-origin:  *
//   access-control-allow-headers: appname,device-id,rate-key,usas-session-id,usas-sub-id
// So the user pastes their own session in and we send it as headers. Verified
// 403 → 200 on both closed endpoints with no cookie, no Origin and no Sec-*.
//
// It is kept in sessionStorage, never localStorage: a session id grants access
// to the account's view of the data, so it dies with the tab rather than
// sitting on disk.

const SESSION_KEY = "swimpb:session";

/** @returns {{sessionId:string, subId:string}|null} */
export function session() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s?.sessionId && s?.subId ? s : null;
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
}

/**
 * Pull a session out of whatever the user pasted.
 *
 * The expected input is DevTools "Copy as cURL" for any times-api request,
 * because that is one copy action and carries both values. Two bare tokens work
 * too: the session id is 32 hex characters and the sub id is a UUID, so they
 * are told apart by shape rather than by order.
 *
 * @returns {{sessionId:string, subId:string}|null}
 */
export function parseSession(text) {
  if (typeof text !== "string" || !text.trim()) return null;

  const headers = {};
  for (const m of text.matchAll(/-H\s+(['"])([^:'"]+):\s*([\s\S]*?)\1/g)) {
    headers[m[2].trim().toLowerCase()] = m[3].trim();
  }
  let sessionId = headers["usas-session-id"];
  let subId = headers["usas-sub-id"];

  // Fall back to shape: a plain paste of the two values, in either order.
  if (!sessionId) sessionId = text.match(/\b[0-9A-Fa-f]{32}\b/)?.[0];
  if (!subId) {
    subId = text.match(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/)?.[0];
  }

  if (!sessionId || !subId || subId.toLowerCase() === "anonymous") return null;
  return { sessionId, subId };
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

/**
 * The `rate-key` header the official app sends alongside a session.
 *
 * A faithful port of its derivation: HMAC-SHA256 of a 10-second time bucket,
 * keyed by the session id, prefixed with that bucket divided by the seconds
 * elapsed since UTC midnight. Requires a secure context for crypto.subtle;
 * http://localhost counts as one.
 *
 * Whether the server actually validates this is unknown — a request carrying a
 * freshly derived key is accepted, which does not prove a wrong one is refused.
 * Sending the correct value is right either way.
 */
export async function rateKey(sessionId) {
  const bucket = Math.floor(Date.now() / 10_000).toString();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(sessionId),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(bucket));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const now = Date.now();
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const secondsToday = Math.floor((now - midnight.getTime()) / 1000) || 1;

  return `${Math.floor(Number(bucket) / secondsToday)}.${hex}`;
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
    "Content-Type": "application/json",
    AppName: "DataHub",
    "Device-Id": deviceId(),
    "Usas-Sub-Id": active ? active.subId : "Anonymous",
  };
  if (active) {
    headers["Usas-Session-Id"] = active.sessionId;
    headers["rate-key"] = await rateKey(active.sessionId);
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
    // A CORS rejection and an offline browser are indistinguishable here, so
    // say the thing that is true either way.
    throw new ApiError(
      err.name === "TimeoutError"
        ? "USA Swimming did not respond in time."
        : "Could not reach USA Swimming. Check your connection.",
      0,
    );
  }

  if (res.status === 404) return null; // "no records" — a normal empty result

  // 403 means "sign in", not "something went wrong". Say which of the two it is
  // rather than surfacing a status code the reader has to interpret.
  if (res.status === 403) {
    throw new ApiError(
      active
        ? "That USA Swimming session is no longer valid. Sign in again and paste a fresh one."
        : "USA Swimming now requires a sign-in for this. Paste a session to continue.",
      403,
      { needsSession: true },
    );
  }

  if (!res.ok) {
    throw new ApiError(`USA Swimming returned ${res.status}.`, res.status);
  }
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
 * @returns {Promise<Array<{swimTimeRecognitionId,strokeName,strokeAbbreviation,distance,courseCode,swimTime}>>}
 */
export async function bestTimes(memberId) {
  const res = await request(`/TimesSearch/GetBestTimesForMember/${memberId}`);
  return res ?? [];
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

/** Deep link to this swimmer on the official site, for cross-checking. */
export function officialUrl(memberId) {
  return `https://data.usaswimming.org/search/athlete/${memberId}/best-times`;
}
