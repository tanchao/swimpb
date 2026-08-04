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

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path, body) {
  const headers = {
    "Content-Type": "application/json",
    AppName: "DataHub",
    "Device-Id": deviceId(),
    "Usas-Sub-Id": "Anonymous",
  };

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
