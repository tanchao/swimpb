# SwimPB

Type a swimmer's name, get every personal best, switch between yards and meters
with one click. Personal tool, no backend, no build step.

```
cd ~/workspace/supertan/swimpb
python3 -m http.server 8787
open http://localhost:8787
```

Then search a name, click the swimmer, and hit **☆ Save**. From then on the page
opens straight onto him.

- **1 / 2 / 3** switch course (Yards / Short Meters / Long Meters)
- **/** focuses the search box
- `?m=<memberId>` deep-links a swimmer

Tests: `node tests/convert.test.mjs && node tests/ui.test.mjs` (41 checks, no deps)

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
index.html          markup + the legend
app/api.js          times-api client (headers, timeouts, error mapping)
app/cache.js        localStorage + sessionStorage, TTL, stale-while-revalidate
app/time.js         time parsing / formatting
app/convert.js      SCY ↔ SCM ↔ LCM conversion and event mapping
app/ui.js           pure render functions
app/main.js         state, URL, event wiring
tests/              node tests incl. real-swim accuracy check
docs/API.md         verified API contract
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
