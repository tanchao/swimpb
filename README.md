# SwimPB

Type a swimmer's name, get every personal best, switch between yards and meters
with one click. Personal tool, no backend, no build step.

```
cd ~/workspace/supertan/swimpb
python3 -m http.server 8787
open http://localhost:8787
```

**After editing anything, hard-reload — Cmd+Shift+R.** `python3 -m http.server`
sends `Last-Modified` but no `Cache-Control` and no `ETag`, so with no explicit
freshness the browser falls back to heuristic caching: roughly 10% of the file's
age. A month-old file gets treated as fresh for days, and the browser never even
asks the server. A plain reload will happily show you the old app.

Then search a name, click the swimmer, and hit **☆ Save**. From then on the page
opens straight onto him.

- **1 / 2 / 3** switch course (Yards / Short Meters / Long Meters)
- **/** focuses the search box
- `?m=<memberId>` deep-links a swimmer

Tests: `for t in convert ui standards advise; do node tests/$t.test.mjs; done`
(113 checks, no deps)

## How it works

Everything runs in the browser. On search it calls USA Swimming's public Data
Hub API directly — the same API `data.usaswimming.org` uses — and caches the
result in `localStorage`. There is no server, no API key, and no proxy.

The reason that's possible: `times-api.usaswimming.org` responds with
`access-control-allow-origin: *` and echoes back whatever headers the preflight
asks for. See `docs/API.md` for the verified contract and the endpoints that
are *not* public.

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

**What it will not tell you.** No power-point total, no IMX/IMR score, no rank.
Power points are computed on USA Swimming's servers — the official calculator
carries no formula — and every ranking endpoint is closed to anonymous callers.
A lookalike score would get believed, so there isn't one.

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
app/api.js                      times-api client (headers, timeouts, error mapping)
app/cache.js                    localStorage + sessionStorage, TTL, stale-while-revalidate
app/time.js                     time parsing / formatting
app/convert.js                  SCY ↔ SCM ↔ LCM conversion and event mapping
app/standards.js                motivational ladder: age group, level, gap to next
app/standards/motivational.json the cut times (generated — see above)
app/advise.js                   the focus rules (pure, deterministic)
app/ui.js                       pure render functions
app/main.js                     state, URL, event wiring
tools/build-standards.py        official PDF → motivational.json, once per edition
tests/                          node tests incl. real-swim accuracy check
docs/API.md                     verified API contract
```

## Caveats

- The public API exposes **no meet names or swim dates** for best times, so
  there's no progression chart. Those endpoints (`GetSwimmerMeets`,
  `GetAllTimesForFilters`) return 403 without a logged-in USA Swimming session.
- Search matches current members by default. Uncheck the box for swimmers
  without a current registration.
- Cross-check anything surprising against the **Official ↗** link.
- This depends on an API USA Swimming can change without notice. If everything
  breaks at once, re-derive the contract from the SPA bundle the way
  `docs/API.md` describes.
