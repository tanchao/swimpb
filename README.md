# SwimPB

Type a swimmer's name, get every personal best, switch between yards and meters
with one click. Personal tool. Locally there is no build step.

```
cd ~/workspace/supertan/swimpb
python3 serve.py
open http://localhost:8787
```

`serve.py` serves the static files (with `Cache-Control: no-cache`) and proxies
`/api/times/swims/*` to `https://data.usaswimming.org`.

Then search a name, click the swimmer, and hit **☆ Save**. From then on the page
opens straight onto him.

- **1 / 2 / 3** switch course (Yards / Short Meters / Long Meters)
- **/** focuses the search box
- `?m=<memberId>` deep-links a swimmer

Tests: `for t in convert api ui standards regional advise progress history splits upstream; do node tests/$t.test.mjs; done`

## How it works

The UI runs in the browser and caches results in `localStorage`. In October 2026
USA Swimming moved its frontend off `times-api.usaswimming.org` and behind a
same-origin BFF at `https://data.usaswimming.org/api/times/swims` authenticated
by an `HttpOnly` `bff_auth_session` cookie, rejecting cross-origin requests with
HTTP 400. `serve.py` is a tiny stdlib server that serves the static files and
forwards `/api/*/swims/*` upstream with your `bff_auth_session` cookie. The
hosted site uses the Pages Function in `functions/` for the same forwarding.
See `docs/API.md` for the verified contract.

## Signing in

Every Data Hub endpoint now requires a signed-in session (anonymous requests
return 401). Sign in directly on the page or paste a session cookie:

1. Open the **Sign in to USA Swimming** row and enter your `data.usaswimming.org`
   username and password. Local `serve.py` completes the OIDC PKCE handshake,
   saves the resulting `bff_auth_session` cookie to `.bff_session` with `0600`
   permissions, and discards the password immediately. The hosted function
   returns that cookie only to the browser that signed in and saves nothing.
2. Or expand **Or paste a copied cURL / session cookie** and paste a copied
   `/api/times/swims` cURL command from DevTools.
3. Optional, local only: set `SWIMPB_USER` and `SWIMPB_PASS` in a gitignored
   `.env` file so `serve.py` refreshes `.bff_session` whenever a `401` occurs.
   Do not set those on the hosted project.

Everything not behind the API keeps working without a session: any swimmer
already cached, plus all of the motivational standards, PNS meet cuts, and the
focus panel, which are computed locally.

One call, `GetBestTimesForMember`, returns the swimmer's bests in all three
courses at once. So the course switch is a re-render, not a refetch — it's
instant and works offline.

## Actual vs converted times

The distinction the UI is built around:

| | meaning |
|---|---|
| `1:02.14` | a real swim on record in that course |
| `~1:02.14` dimmed, dotted underline | an estimate converted from another course |

A converted time is not an official time and is never a personal best. Hover it
to see which course it came from. Conversion uses the factor set published by
Colorado Swimming — pool length (×1.11 per 25 yd → 25 m) plus a per-turn
increment that depends on stroke, with distance freestyle handled by direct
ratio because 500 yd and 400 m are different races.

Median error against 46 real multi-course swims is **1.6%**. Treat conversions as
a ballpark, not a time.

## Motivational standards

Each real time carries the USA Swimming motivational standard it has reached —
B, BB, A, AA, AAA, AAAA — and under the highlighted course, the gap to the next
one:

```
 100   53.88 AAA        59.90 AA        ~1:01.2
       AAAA −1.12
```

A converted estimate never gets one. Only a real swim can achieve a standard.

**The set is chosen per swimmer.** The age group comes from `swimmerAge`, and the
gender is a toggle you set once, because the public API returns no gender field
at all — it is never guessed from a name. Both stay overridable, which doubles as
a way to see what the next age group up demands. Past 18 there are no
motivational standards and the bar says so rather than going quietly blank.

**Where the numbers come from.** No public endpoint serves cut times, so they
ship with the app in `app/standards/motivational.json` (22 KB, lazy-loaded, then
cached). The file is *generated*, not typed:

```
pip install pypdf
python3 tools/build-standards.py 2028-motivational-standards-age-group.pdf \
  --edition 2024-2028 --source <url>
```

That is ~2,900 numbers. Transcribing them by hand would be wrong at some low
rate, and a wrong benchmark is worse than no benchmark, so the official PDF is
parsed instead. The parser refuses to guess: a row that doesn't yield exactly six
cuts per gender is reported rather than skipped, and writing the same event twice
is an error — that check is what caught the published layout putting two age
groups on one page.

Three checks guard the result (`tests/standards.test.mjs`):

- every cut array is strictly **decreasing** B → AAAA, which catches most typos
- **no relays** leak in from the published table, where they sit beside the
  individual events
- **SCY and LCM agree** — 948 event pairs converted with `convert.js` land within
  5.5% of the published LCM cut (median 1.2%). A transposed row or a shifted
  column misses by far more

Standards are published **per quadrennium**, not yearly. The current set is
2024-2028; the edition is recorded inside the JSON and shown in the UI, so a new
one is a single regenerated file.

## PNS meet qualification

The highlighted course also shows whether each recorded swim qualifies for the
current Pacific Northwest Swimming meets, or the exact time still needed:

```
AGI ✓
14&U Champs −0.64
```

The app ships the official 2026-27 AGI and 2026 SC 14&U Champs cuts in
`app/standards/pns.json`. Converted estimates never qualify. PNS lists 2027 NW
Age Group Regionals but has not published its cuts, so the UI says that plainly
instead of using expired 2026 standards.

## Focus — what to work on next

Under the board, a ranked list of two or three things to work on, each with the
numbers behind it:

```
1  Breaststroke is the stroke holding the set back      1.4 standards behind
   It sits at B on its one recorded event, against BB in Freestyle.

2  200 Freestyle is the closest cut to reach                 −0.81, 0.6% off
   2:12.50 now — A is 2:11.69.
```

Five rules, in `app/advise.js`, all reading real swims only:

| rule | what it looks for |
|---|---|
| quickest win | smallest gap to the next cut **as a percentage** — four tenths off a 50 is not four tenths off a 500 |
| weakest stroke | the stroke whose mean ladder position trails the strongest by a full standard |
| IM balance | the 200 IM against the four strokes — a weak leg shows up there even when it isn't raced alone |
| never raced | published events for the age group with no time on record |
| range | sprint-leaning or distance-leaning, when the split is pronounced |

Comparing events needs more than the level: "AA in both" hides that one is a
tenth off AAA and the other barely scraped in. So each swim gets a *continuous*
ladder position — 0 is exactly B, 5 is exactly AAAA, interpolated between the
bracketing cuts — and the rules compare those.

It is deliberately a rule engine, not generated prose. There is no backend and no
model behind it, so the same times always produce the same list, offline and
instantly, and every line shows its evidence so you can disagree with it.

**What it will not tell you.** No power-point total and no IMX/IMR score.
Power points are computed on USA Swimming's servers — the official calculator
carries no formula. A lookalike score would get believed, so there isn't one.
The Focus list is also not a rank; see Rankings below.

## Rankings

Under Focus, a Rankings panel (closed by default; it makes no request until you
open it) shows where a swimmer's time stands in the swimmer's club, LSC, zone and
the US, and a browseable leaderboard for any event, gender, age and season.

It needs a signed-in session. USA Swimming returns only the **fastest 100
swimmers** per list, so a rank appears only when the swimmer is in that list.
Otherwise the card says "Not in the top 100" and shows the 100th time. It never
guesses. The club rank is counted from clubmates in the list; unattached
swimmers have none. The zone comes from a table of LSCs built from the server.
The leaderboard filters on the age at the swim, not the age today. Contract
details are in `docs/API.md`.

## Views

Three tabs sit under the standards bar. They all follow the selected course and
read the swim history from `GetAllTimesForFilters`, which needs a signed-in session.

**Best times** is the board above.

**By age** has one row per event and one column per age, newest age first. Each
cell is the fastest recorded swim at that age, the standard it earned *for the age
group the swimmer was in then*, and the drop from the previous age raced. A
comparison that spans more than one year says so (`−2.30²ʸ`). A year with no race
shows as a gap. Swims with no age on record cannot be placed and are counted in
the footnote. Pick Girls or Boys to see the standards.

**Meets** has one row per meet and one column per event, newest meet first (the
flip button reverses it). Each swim shows its time, the drop against the previous
swim of that event whichever meet it was at, and `PB` when it was the fastest to
that date. Prelims and finals at one meet both appear, in order. Click a time to
load its lap splits in a row under the meet.

## Event progress report

Click any row of the board or the By age table (or focus it and press Enter) to
open that event's report in a drawer. Esc or **Close** dismisses it. It follows
the selected course, so pressing 1 / 2 / 3 re-reads the same event in another
pool.

It shows the best time and its standard, then four figures in one row: swims on
record, personal bests set, total drop since the first recorded swim, and the drop
over the last 12 months. Below that is a time-against-date chart. Every swim is a
dot, and the best-so-far is a step line that falls as the swimmer gets faster. A
tick marks every half year. A dashed line shows the next motivational standard,
and one more shows each meet cut not yet met. Each is named beside its time at the
left edge. Then comes **every swim**, newest first, with its age, its drop against
the swim before it, and a Splits button. Then the best of each season. A season
runs 1 September to 31 August.

**Focus for this event** is a second rule engine, in `app/progress.js`, next to
the one above. It reads the event's own history and where the event sits among
the swimmer's other events on the same ladder:

| rule | what it looks for |
|---|---|
| fade | the back half of the best swim is 4% or more slower than the front half (needs splits) |
| stall | no new best for 12 months, with at least 3 swims since, and still racing the event |
| consistency | the typical recent swim is 2% or more slower than the best done before it |
| endurance gap | a longer event (200 and up) a full standard behind the same stroke at 50-100 |
| speed gap | a 50 or 100 a full standard behind the same stroke at 200 and up |
| IM gap | the IM behind the four strokes, naming the weakest stroke |
| behind / ahead of programme | the event against the mean of the other events, when no range rule fired |
| reachable cut | the next cut is within 1.5% of the swim, with the pace of recent personal bests |

Each finding carries its evidence and a "Try" line, such as threshold sets and
broken swims for an endurance gap. The suggestions are starting points for a
coach, not a training plan.

"Compared to others" means the swimmer's own other events. No ranking endpoint
is open to us, so a comparison with other swimmers would be invented.

## Lap splits

Fetched on demand from `GET /TimesSearch/AllTimes/SwimTime/{swimTimeId}` and
cached per swim. The id is `swimTimeId` from the swim history, **not**
`swimTimeRecognitionId` from the best times (a different id space). For events of
200 and up the report also fetches the best swim's splits once, because the fade
rule needs them. A sprint and an IM have no meaningful halves, so they skip it.

**The payload shape is not verified.** `docs/API.md` shows `"splits": null` in the
one sample on record, and no populated response has been captured. So
`app/splits.js` assumes nothing: it accepts a few plausible shapes, then checks
them against the swim's own final time. Running totals must end at the final time;
lap times must add up to it; a missing last lap is added only when the distance
divides evenly. Anything that fits none of these is shown as received, labelled
"do not add up", with no analysis. If a real response turns out to look
different, `normalizeSplits` is the one place to change, and `tests/splits.test.mjs`
is where to add it.

## Hosting

Production is a second Cloudflare Pages project, `swim.tanchao.xyz`. It does
not share a deployment with the `tanchao.xyz` blog. Build command:
`sh scripts/pages-dist.sh`. Build output directory: `dist`. The function in
`functions/` is deployed from the repository root and keeps no session of its
own. Put the hostname behind Cloudflare Access before sharing it.

## Layout notes

The board is deliberately **one table**, with stroke groups as full-width rows
inside it, rather than one card per stroke. That gives a single set of column
headers, identical column widths throughout, and an unbroken highlight band down
the selected course. The first version used five separate cards and every one of
them clipped its own Long Meters column.

Column order is fixed and the selected course is highlighted in place. Moving the
selected column to the front made the number you were reading jump sideways on
every toggle.

Type is Barlow Condensed for structural labels and IBM Plex Mono for every
number — times are read by column alignment, so the figures must be tabular and
must not be italicised.

## Layout

```
index.html                      markup + the legend
serve.py                        local static server + /api/times/swims proxy
functions/                      hosted sign-in and proxy; no stored session
scripts/pages-dist.sh           copy static files to dist/ for Pages
app/api.js                      Data Hub BFF client (device-id, bff_auth_session, errors)
app/cache.js                    localStorage + sessionStorage, TTL, stale-while-revalidate
app/time.js                     time parsing / formatting
app/convert.js                  SCY ↔ SCM ↔ LCM conversion and event mapping
app/standards.js                motivational ladder: age group, level, gap to next
app/standards/motivational.json the cut times (generated — see above)
app/regional.js                 PNS meet qualification lookup
app/standards/pns.json          current AGI and 14&U Champs cuts
app/advise.js                   the focus rules (pure, deterministic)
app/progress.js                 per-event history and its focus rules (pure)
app/history.js                  age-best matrix and meets table data (pure)
app/splits.js                   lap splits: verified normalisation, front/back half
app/views.js                    report, age-best, meets, splits renderers
app/rank.js                     rankings logic: request body, zones, standings (pure)
app/rankings.js                 rankings controller: state, fetching, caching
app/rankviews.js                rankings panel render
app/ui.js                       pure render functions
app/main.js                     state, URL, event wiring
tools/build-standards.py        official PDF → motivational.json, once per edition
tests/                          node tests incl. real-swim accuracy check
docs/API.md                     verified API contract
```

## Caveats

- `GetBestTimesForMember` carries no meet names or swim dates. The progress
  report gets them from `GetAllTimesForFilters`, which needs a signed-in session.
- Search matches current members by default. Uncheck the box for swimmers
  without a current registration.
- Cross-check anything surprising against the **Official ↗** link.
- This depends on an API USA Swimming can change without notice — and they did,
  on 2026-08-28. If everything breaks at once, re-derive the contract from the
  SPA bundle the way `docs/API.md` describes; the bundle hash changes on every
  deploy, so start from the `modulepreload` link on the home page.
- A session expires. When it does you get "that session is no longer valid" and
  paste a fresh one.
