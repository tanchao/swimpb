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

### Swimmer search

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
GET /SearchFilter/GetAllTimeStandards   → [{timeStandardTypeId, timeStandardType, standardName, sortOrder}]
GET /TimesSearch/AllTimes/SwimTime/{swimTimeId}
```

`GetAllTimeStandards` returns only the standard *names* (B, BB, A, … "Slower Than
B"), **not** the qualifying times. Motivational cut times are not available here.

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
POST /TimesSearch/GetAllTimesForFilters
```

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
