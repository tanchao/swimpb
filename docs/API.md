# USA Swimming public API — verified contract

Everything here was verified by direct request on **2026-08-03**. Anything not
verified is marked.

## Base

```
https://times-api.usaswimming.org/swims
```

### Required headers — all four, on every request

```
Content-Type: application/json
AppName:      DataHub
Device-Id:    <see below>
Usas-Sub-Id:  Anonymous
```

Omitting `AppName` / `Device-Id` gives `HTTP 500`. A malformed `Device-Id` gives
`HTTP 400 "Invalid Device-Id format in request headers."`

### Device-Id format

The server validates the *shape* the official SPA produces: base64, with the
first 5 characters re-inserted at offset 15.

```js
const b64 = btoa(`platform - vendor - unknown - ${Date.now()}`);
const deviceId = b64.slice(0, 15) + b64.slice(0, 5) + b64.slice(15);
```

The real SPA feeds a browser fingerprint (canvas/audio) into that string; the
server doesn't check the contents, only the pattern. Generate once and persist —
a new id per request looks like a new device every time.

### CORS

```
access-control-allow-origin: *
access-control-allow-headers: <echoes whatever the preflight requested>
```

No token, no cookie, no proxy. Callable from any origin, including `localhost`.
Responses sit behind Fastly/Varnish, so repeat reads are edge-cached.

---

## Public endpoints

> **Changed 2026-08-28.** Swimmer search and best times are **no longer
> anonymous** — both now return 403. They worked on 2026-08-03. They still work
> with a signed-in session; see *Session* below. `GetMember` and `GetLscs` remain
> open.

### Swimmer search — now needs a session

```http
POST /TimesSearch/GetMembersForFilters
{ "name": "Ledecky", "orgCode": null, "lscCode": null, "isCurrent": 1 }
```

`isCurrent` must be **numeric** — `true` fails with a JSON parse error.
`lscCode` narrows to one LSC. `orgCode` is `null` for USA Swimming athletes (it
carries `"NCAA Div I"`-style values on the NCAA search).

```json
[{
  "memberId": "6CD35348E5824C",
  "fullName": "Katie Genevieve Ledecky",
  "shortName": "Katie Ledecky",
  "clubName": "Gator Swim Club",
  "lscCode": "FL",
  "swimmerAge": 29,
  "profilePicUrl": null,
  "isNcaa": 0
}]
```

`404` with body `No records returned for this query.` means no match — not an error.

### Personal bests — all courses in one call

```http
GET /TimesSearch/GetBestTimesForMember/{memberId}
```

```json
[{
  "swimTimeRecognitionId": 170567980,
  "strokeName": "Freestyle",
  "strokeAbbreviation": "FR",
  "distance": 50,
  "courseCode": "SCY",
  "swimTime": "22.64r"
}]
```

One record per (stroke, distance, course). `courseCode` ∈ `SCY | SCM | LCM`.
`swimTime` is a display string, optionally flagged — `r` is a relay lead-off.

**No meet name, no date, no age.** That's the single biggest limitation of the
public surface.

`swimTimeRecognitionId` is **not** the key for `AllTimes/SwimTime/{id}` — that's
a different id space; passing one returns a different swimmer's swim.

### Reference data

```http
GET /SearchFilter/GetLscs               → [{orgUnitId, lscCode, lscName}]
GET /TimesSearch/AllTimes/SwimTime/{swimTimeId}
```

`GetMember/{memberId}` is public too, and returns `swimmerAge` — but **no gender
field**. Verified 2026-08-25:

```json
{"memberId":"…","fullName":"…","clubName":"…","lscCode":"FL",
 "swimmerAge":29,"shortName":"…","profilePicUrl":"…","isNcaa":1}
```

That is why the app asks which motivational standards set to use instead of
deriving it.

### GetAllTimeStandards — was public, now 403

```http
GET /SearchFilter/GetAllTimeStandards   → 403 as of 2026-08-25
```

On 2026-08-03 this returned `[{timeStandardTypeId, timeStandardType, standardName,
sortOrder}]` — only the standard *names* (B, BB, A, … "Slower Than B"), never the
qualifying times. It now 403s anonymously like the endpoints below.

**No public endpoint serves motivational cut times.** Both this and
`GetSwimmerTimeStandards` are closed, so the app ships the numbers itself,
generated from USA Swimming's published PDF by `tools/build-standards.py`. See the
README.

`AllTimes/SwimTime/{swimTimeId}` is the rich per-swim record, when you have a
valid id from elsewhere:

```json
{
  "meetName": "2019 OZ CFAC MLK Invitational",
  "eventCode": "100 BK SCY", "swimDate": "Jan 19, 2019",
  "memberId": "1E70A0F7A9CE44", "fullName": "…", "swimmerAge": 13,
  "clubName": "…", "lscCode": "IL", "splits": null,
  "swimTime": "1:01.61", "timeDrop": -4.02, "finishPosition": 2,
  "timeStandard": "A", "powerPoints": 591
}
```

---

## Endpoints that return 403 anonymously

Confirmed auth-gated, not rate-limited (`GetBestTimesForMember` kept returning
200 in the same sequence):

```
GET  /TimesSearch/GetSwimmerCourses/{memberId}
GET  /TimesSearch/GetSwimmerMeets/{memberId}
GET  /SearchFilter/GetSwimmerEvents/{memberId}
GET  /SearchFilter/GetSwimmerTimeStandards/{memberId}
GET  /SearchFilter/GetAllTimeStandards          ← newly closed, see above
POST /TimesSearch/GetAllTimesForFilters
```

These probes returned 404 rather than 403, i.e. they don't exist:
`GetTimeStandards`, `GetMotivationalTimes`, `GetTimeStandardTimes`,
`GetTimeStandardsForFilters`, `GetCompetitionCategories`, `GetGenders`.

### Resolved: the 403s are authorization, not client filtering

On 2026-08-25 `POST /TimesSearch/GetMembersForFilters` returned 403 from a Node
client and the cause was open — possibly edge filtering on a non-browser client.
**Settled on 2026-08-28: it is per-endpoint authorization.** The same 403 appears
in a real browser, and back-to-back requests on one connection gave

```
403  GET /TimesSearch/GetBestTimesForMember/<id>    x-cache=MISS
200  GET /TimesSearch/GetMember/<id>                x-cache=MISS
```

Both reached the origin. A throttle or an IP block would have hit both.

---

## Session

`times-api` accepts a session in **headers**, with no cookie:

```
Usas-Sub-Id:      <the sub claim, a UUID>   (not "Anonymous")
Usas-Session-Id:  <32 hex characters>
rate-key:         <derived, see below>
```

Verified 2026-08-28: this turns 403 into 200 on both closed endpoints, sending
no cookie, no `Origin` and no `Sec-*`. Responses then carry `User-Logged-In:
true`. The best-times payload shape is unchanged.

### rate-key

HMAC-SHA256 of a 10-second time bucket, keyed by the session id, prefixed with
that bucket divided by the seconds elapsed since UTC midnight:

```js
const bucket = Math.floor(Date.now() / 10_000).toString();
const hex    = hmacSha256(key = sessionId, message = bucket);   // hex digest
const today  = Math.floor((Date.now() - utcMidnight) / 1000) || 1;
const key    = `${Math.floor(Number(bucket) / today)}.${hex}`;
```

Ported in `app/api.js` and checked against an independent HMAC in
`tests/api.test.mjs`. Note a request carrying a correctly derived key is
accepted — that does **not** prove the server rejects a wrong one.

### Why the app can't sign in by itself

The session originates as an HttpOnly cookie on `.usaswimming.org`, which the
official app reads with `fetch("…/bff/userinfo", {credentials:"include"})`. A
page on another origin cannot: both auth endpoints refuse the preflight
outright, returning **400 with no CORS headers at all**.

```
OPTIONS https://dhy-prod.usaswimming.org/bff/userinfo                    → 400, no CORS
OPTIONS https://security-api.usaswimming.org/security/auth/GetDataHub…   → 400, no CORS
```

No client-side code gets past that; it would need a backend proxy. So the user
pastes their own session in, which works because `times-api` itself is open:

```
OPTIONS https://times-api.usaswimming.org/swims/TimesSearch/GetBestTimesForMember/<id>
  Origin: http://localhost:8787
→ 200
  access-control-allow-origin:  *
  access-control-allow-headers: appname,device-id,rate-key,usas-session-id,usas-sub-id
```

Those are exactly the headers required, permitted from any origin.

### Where the SPA keeps it

Cookies `usasauth`, `usasauthrt`, `usasauthed`, `usasauthu` on domain
`.usaswimming.org`, `sameSite=lax`. The device id moved to a real browser
fingerprint (canvas/audio) persisted at `localStorage.deviceId`, but the server
still only checks the *shape*, so the generator in `app/api.js` remains valid.

They need a logged-in session (`Usas-Session-Id` from the
`dhy-prod.usaswimming.org/bff/userinfo` cookie flow).

Also broken/unused:

- `GET /SearchFilter/GetAllEvents` — `500` even with correct headers.
- `POST /TimesSearch/BestTimes` — accepts the filter body but `404`s for a
  per-member query; it appears to be a leaderboard, not a swimmer lookup.

---

## Dead ends worth recording

`ajzxhub.net` — the site this project was modelled on — targets a path that no
longer works:

- `usaswimming.sisense.com` (Sisense JAQL) **does not resolve** in public DNS
  (checked against `1.1.1.1` and `8.8.8.8`).
- `securityapi.usaswimming.org` enforces an **Origin allowlist**:
  `HTTP 400 "The origin 'https://ajzxhub.net' is not allowed."` Only
  `https://data.usaswimming.org` is admitted, which is why that design needs a
  proxy at all.

The current API needs neither.

## Re-deriving this if it breaks

1. `curl -sS --compressed https://data.usaswimming.org/ -o home.html` and pull
   the entry bundle from the `modulepreload` link.
2. Download that bundle and grep for `times-api.usaswimming.org` to get the
   endpoint inventory.
3. Find the fetch wrapper (search for `AppName`) to see the current required
   headers, and the `deviceId` generator near it.
4. Lazy route chunks are listed inside the bundle as `"./<name>.js"` and live at
   `https://data.usaswimming.org/assets/<name>.js`. Use python for extraction —
   `grep -oE` with large windows blows up on these minified single-line files.
