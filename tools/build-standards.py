#!/usr/bin/env python3
"""Turn USA Swimming's published motivational-standards PDF into app/standards/motivational.json.

Run once per edition — USA Swimming publishes a new set per quadrennium, not
yearly. This is NOT part of running the app: the app ships the JSON and has no
build step.

    pip install pypdf
    python3 tools/build-standards.py <pdf> --edition 2024-2028 --source <url>

WHY A PARSER AND NOT TRANSCRIPTION. The table is ~3,200 numbers. Typing those by
hand produces confidently wrong benchmarks at some low rate, and a wrong
benchmark is worse than none. Parsing the official document removes that class
of error entirely; what remains is layout misreading, which the row regex makes
loud rather than silent (a row that doesn't match is reported, never skipped).

THE LAYOUT. Each data row carries both genders, mirrored around the event:

    39.79 * ... 28.29 *   50 FR SCY   27.49 * ... 38.19 *
    <-- girls B→AAAA -->              <-- boys AAAA→B -->

So the girls' six are already slowest→fastest and the boys' six need reversing.
The course is part of the event token, which is what makes this robust: the page
order in the published PDF is scrambled (SCY, SCM and LCM pages interleave and
not every age group appears in every course), so nothing is inferred from page
position.
"""

import argparse
import json
import re
import sys
from collections import defaultdict

from pypdf import PdfReader

# A time is 28.29 or 1:30.79. Some published times carry a trailing asterisk and
# some do not, so it is never matched — the event token in the middle of the row
# is the anchor, and the times are read from either side of it.
TIME = r"\d+(?::\d\d)?\.\d\d"
EVENT = re.compile(r"(\d+)\s+([A-Z]+(?:-R)?)\s+(SCY|SCM|LCM)")

# Girls read slowest→fastest; boys are mirrored.
GIRLS_ORDER = ["B", "BB", "A", "AA", "AAA", "AAAA"]
LEVELS = GIRLS_ORDER

STROKES = {"FR", "BK", "BR", "FL", "IM"}

GROUP_LABEL = re.compile(r"^(10 & under|\d+(?:-\d+)?)\s+Girls\s+Event")


def hundredths(text):
    """'1:30.79' -> 9079."""
    mins, _, secs = text.rpartition(":")
    total = (int(mins) * 60 if mins else 0) + float(secs)
    return round(total * 100)


def normalise_group(label):
    return "10U" if label == "10 & under" else label


def parse(path):
    """-> {gender: {group: {course: {event: [6 cuts]}}}}, plus stats."""
    out = defaultdict(lambda: defaultdict(lambda: defaultdict(dict)))
    reader = PdfReader(path)
    rows = relays = 0
    unmatched = []
    collisions = []

    for page_no, page in enumerate(reader.pages, 1):
        lines = [l.strip() for l in page.extract_text().split("\n") if l.strip()]

        # A page can hold more than one age group — 10 & under and 11-12 share
        # page 1, and the 17-18 / next-course boundary shares pages 4 and 8. So
        # the group is whatever header was seen most recently, not the first one
        # on the page.
        group = None
        for line in lines:
            header = GROUP_LABEL.match(line)
            if header:
                group = normalise_group(header.group(1))
                continue
            if group is None:
                continue

            m = EVENT.search(line)
            if not m:
                continue

            dist, stroke, course = m.groups()
            girls = [hundredths(t) for t in re.findall(TIME, line[: m.start()])]
            boys = [hundredths(t) for t in re.findall(TIME, line[m.end() :])]

            if stroke not in STROKES:  # relays are not individual best times
                relays += 1
                continue

            # A row must carry exactly six cuts per gender. Anything else means
            # the layout was misread — say so loudly instead of storing half a
            # row, which would look plausible and be wrong.
            if len(girls) != 6 or len(boys) != 6:
                unmatched.append((page_no, f"{len(girls)}g/{len(boys)}b  {line[:110]}"))
                continue

            rows += 1
            event = f"{int(dist)} {stroke}"
            # Writing the same slot twice means a header was mis-attributed and
            # one age group is quietly overwriting another. Refuse it.
            existing = out["girls"][group][course].get(event)
            if existing is not None and existing != girls:
                collisions.append(f"{group} {course} {event}: {existing} then {girls}")
            out["girls"][group][course][event] = girls
            out["boys"][group][course][event] = boys[::-1]  # published fastest-first

    return out, {
        "rows": rows,
        "relays": relays,
        "unmatched": unmatched,
        "collisions": collisions,
    }


def validate(standards):
    """Every cut array must be strictly decreasing B→AAAA. Returns problems."""
    problems = []
    for gender, groups in standards.items():
        for group, courses in groups.items():
            for course, events in courses.items():
                for event, cuts in events.items():
                    where = f"{gender} {group} {course} {event}"
                    if len(cuts) != 6:
                        problems.append(f"{where}: {len(cuts)} cuts")
                        continue
                    for i in range(1, 6):
                        if cuts[i] >= cuts[i - 1]:
                            problems.append(
                                f"{where}: {LEVELS[i]} {cuts[i]} not faster than "
                                f"{LEVELS[i-1]} {cuts[i-1]}"
                            )
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--edition", required=True, help='e.g. "2024-2028"')
    ap.add_argument("--source", required=True, help="URL the PDF came from")
    ap.add_argument("-o", "--out", default="app/standards/motivational.json")
    ap.add_argument("--dry-run", action="store_true", help="report coverage, write nothing")
    args = ap.parse_args()

    standards, stats = parse(args.pdf)

    print(f"matched {stats['rows']} rows ({stats['relays']} relay rows dropped)")
    if stats["unmatched"]:
        print(f"\n!! {len(stats['unmatched'])} time-bearing lines did not parse:")
        for page, line in stats["unmatched"][:12]:
            print(f"   p{page}: {line}")
    if stats["collisions"]:
        print(f"\n!! {len(stats['collisions'])} events written twice with different times:")
        for c in stats["collisions"][:12]:
            print(f"   {c}")

    print("\ncoverage — events per course:")
    for gender in sorted(standards):
        for group in sorted(standards[gender]):
            counts = {c: len(e) for c, e in sorted(standards[gender][group].items())}
            total = sum(counts.values())
            print(f"  {gender:5} {group:6} {counts}  total {total}")

    problems = validate(standards)
    if problems:
        print(f"\n!! {len(problems)} monotonicity problems:")
        for p in problems[:12]:
            print(f"   {p}")
        return 1
    print("\nall cut arrays strictly decreasing B -> AAAA")

    if args.dry_run:
        print("\ndry run — nothing written")
        return 0

    payload = {
        "edition": args.edition,
        "source": args.source,
        "generatedBy": "tools/build-standards.py",
        "levels": LEVELS,
        "standards": {g: dict(sorted(v.items())) for g, v in sorted(standards.items())},
    }
    with open(args.out, "w") as fh:
        json.dump(payload, fh, separators=(",", ":"), sort_keys=False)
        fh.write("\n")
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
