#!/usr/bin/env python3
"""Build PNS meet cuts from the official AGI and 14&U Champs publications.

The Champs PDF contains extractable text and is parsed directly. The current
AGI PDF encodes every glyph as an image, so its compact source rows below are a
reviewable transcription of that official two-page table. Validation rejects
missing courses, duplicate events, and invalid times before writing JSON.
"""

import argparse
import json
import re
from collections import defaultdict

from pypdf import PdfReader

AGI_SOURCE = (
    "https://www.pns.org/pnws2/UserFiles/Image/QuickUpload/"
    "age-group-invitational-standards_015640.pdf"
)
CHAMPS_SOURCE = (
    "https://www.pns.org/pnws2/UserFiles/Image/QuickUpload/"
    "2026-14u-sc-champs-standards_019804.pdf"
)

# group|event|girls SCM,LCM,SCY|boys SCY,LCM,SCM
AGI_ROWS = """
10U|50 Free|43.09,43.69,42.29|42.49,43.99,43.29
10U|100 Free|1:37.99,1:39.09,1:33.09|1:33.29,1:38.99,1:38.19
10U|200 Free|3:16.19,3:19.09,3:05.19|3:05.89,3:18.39,3:15.89
10U|400/500 Free|6:51.69,7:01.69,7:20.09|7:20.09,7:01.69,6:51.69
10U|50 Back|50.29,51.29,48.99|49.09,52.59,51.59
10U|100 Back|1:48.99,1:50.29,1:39.19|1:41.19,1:51.09,1:49.19
10U|50 Breast|57.79,58.99,51.89|53.49,58.89,57.79
10U|100 Breast|2:00.09,2:01.89,1:50.89|1:52.69,2:03.89,2:01.99
10U|50 Fly|51.29,52.69,48.09|48.59,52.29,51.59
10U|100 Fly|1:47.09,1:48.29,1:38.19|1:38.19,1:54.39,1:53.39
10U|100 IM|1:47.89,N/A,1:40.19|1:40.89,N/A,1:48.09
10U|200 IM|3:38.29,3:40.89,3:22.79|3:25.99,3:49.69,3:46.89
11-12|50 Free|35.89,36.49,34.19|32.79,35.59,34.99
11-12|100 Free|1:17.79,1:18.89,1:15.89|1:15.69,1:19.99,1:18.69
11-12|200 Free|2:52.29,2:54.19,2:40.59|2:41.79,2:50.99,2:48.29
11-12|400/500 Free|5:50.09,6:00.09,6:44.99|6:44.99,6:00.09,5:50.09
11-12|50 Back|42.99,43.99,40.49|40.49,43.59,42.29
11-12|100 Back|1:32.59,1:34.09,1:25.09|1:24.99,1:32.99,1:31.09
11-12|200 Back|3:11.89,3:13.39,2:54.39|2:52.99,3:14.09,3:12.09
11-12|50 Breast|49.09,50.19,45.19|45.09,48.89,47.79
11-12|100 Breast|1:45.99,1:47.09,1:35.49|1:34.89,1:44.59,1:42.29
11-12|200 Breast|3:36.59,3:40.29,3:21.69|3:15.99,3:44.79,3:40.29
11-12|50 Fly|41.89,42.29,38.99|38.19,41.69,41.09
11-12|100 Fly|1:31.79,1:32.79,1:24.09|1:24.69,1:31.89,1:30.09
11-12|200 Fly|3:22.99,3:25.09,3:00.09|3:00.09,3:25.09,3:22.99
11-12|100 IM|1:30.09,N/A,1:24.29|1:24.79,N/A,1:30.39
11-12|200 IM|3:12.89,3:14.69,2:54.79|2:51.69,3:11.79,3:08.89
11-12|400 IM|7:02.29,7:10.09,6:20.99|6:20.99,7:10.09,7:02.29
13-14|50 Free|32.89,33.29,30.19|28.29,31.19,30.69
13-14|100 Free|1:12.49,1:13.49,1:07.69|1:02.59,1:08.49,1:07.09
13-14|200 Free|2:36.99,2:38.59,2:24.09|2:14.39,2:29.49,2:27.89
13-14|400/500 Free|5:30.29,5:35.39,6:13.09|5:56.79,5:19.09,5:14.99
13-14|50 Back|39.39,40.39,35.69|34.89,38.69,38.09
13-14|100 Back|1:23.99,1:25.89,1:15.99|1:10.99,1:20.79,1:19.29
13-14|200 Back|2:51.49,2:55.49,2:38.39|2:29.19,2:49.29,2:46.49
13-14|50 Breast|44.69,45.79,41.19|37.99,42.29,41.69
13-14|100 Breast|1:35.69,1:37.59,1:27.19|1:20.79,1:29.59,1:28.09
13-14|200 Breast|3:21.69,3:24.59,3:03.29|2:49.99,3:10.99,3:07.09
13-14|50 Fly|36.89,37.69,34.79|31.79,34.59,33.89
13-14|100 Fly|1:20.69,1:22.59,1:16.09|1:09.39,1:16.59,1:15.09
13-14|200 Fly|3:23.59,3:25.99,2:44.99|2:30.29,2:56.29,2:53.79
13-14|100 IM|1:24.09,N/A,1:18.39|1:13.29,N/A,1:19.59
13-14|200 IM|2:56.19,2:59.69,2:41.09|2:29.09,2:46.99,2:44.49
13-14|400 IM|6:20.59,6:27.89,5:24.99|5:10.59,6:00.09,5:54.09
15O|50 Free|30.19,31.09,27.49|24.39,27.49,26.59
15O|100 Free|1:05.99,1:07.49,59.99|53.69,1:00.29,58.89
15O|200 Free|2:26.19,2:28.59,2:11.29|1:57.39,2:14.49,2:12.09
15O|400/500 Free|5:14.69,5:18.89,5:51.59|5:23.69,4:49.09,4:45.59
15O|50 Back|36.79,37.89,32.19|28.99,33.79,32.29
15O|100 Back|1:16.69,1:18.99,1:08.69|1:01.49,1:11.59,1:09.29
15O|200 Back|2:47.09,2:49.19,2:25.99|2:11.99,2:33.89,2:30.59
15O|50 Breast|41.49,42.59,37.29|32.29,37.19,35.79
15O|100 Breast|1:29.09,1:30.69,1:18.79|1:09.39,1:19.89,1:18.19
15O|200 Breast|3:12.29,3:15.89,2:47.89|2:28.79,2:53.19,2:50.99
15O|50 Fly|33.19,34.09,30.39|27.09,30.69,29.99
15O|100 Fly|1:15.09,1:16.39,1:06.19|59.09,1:06.09,1:04.99
15O|200 Fly|3:07.89,3:09.99,2:37.89|2:14.89,2:40.49,2:37.59
15O|100 IM|1:16.99,N/A,1:11.39|1:04.19,N/A,1:09.99
15O|200 IM|2:43.89,2:46.99,2:26.49|2:12.69,2:31.99,2:29.79
15O|400 IM|5:53.69,5:58.69,5:16.49|4:50.99,5:31.39,5:26.29
""".strip()

COURSES_LEFT = ("SCM", "LCM", "SCY")
COURSES_RIGHT = ("SCY", "LCM", "SCM")
STROKES = {
    "Free": "FR",
    "Back": "BK",
    "Breast": "BR",
    "Fly": "FL",
    "IM": "IM",
}
TIME = r"(?:\d+:)?\d+\.\d\d|N/A"


def hundredths(value):
    if value == "N/A":
        return None
    mins, sep, secs = value.partition(":")
    seconds = int(mins) * 60 + float(secs) if sep else float(mins)
    return round(seconds * 100)


def event_key(label, course):
    distance, stroke = label.split(" ", 1)
    if "/" in distance:
        metric, yards = map(int, distance.split("/"))
        distance = yards if course == "SCY" else metric
    return f"{int(distance)} {STROKES[stroke]}"


def put(out, meet, gender, group, course, label, value):
    if value is None:
        return
    events = out[meet][gender][group][course]
    key = event_key(label, course)
    if key in events:
        raise ValueError(f"duplicate {meet} {gender} {group} {course} {key}")
    events[key] = value


def parse_agi(out):
    for line in AGI_ROWS.splitlines():
        group, label, girls_text, boys_text = line.split("|")
        girls = [hundredths(v) for v in girls_text.split(",")]
        boys = [hundredths(v) for v in boys_text.split(",")]
        if len(girls) != 3 or len(boys) != 3:
            raise ValueError(f"bad AGI row: {line}")
        for course, value in zip(COURSES_LEFT, girls):
            put(out, "agi", "girls", group, course, label, value)
        for course, value in zip(COURSES_RIGHT, boys):
            put(out, "agi", "boys", group, course, label, value)


def parse_champs(out, pdf):
    group = None
    row = re.compile(
        rf"^({TIME}) ({TIME}) ({TIME}) (\d+(?:/\d+)? (?:Free|Back|Breast|Fly|IM)) "
        rf"({TIME}) ({TIME}) ({TIME})$"
    )
    header = re.compile(r"Girls (10&U|11-12|13-14) Events Boys")

    for page in PdfReader(pdf).pages:
        for raw in page.extract_text().splitlines():
            line = " ".join(raw.split())
            found = header.search(line)
            if found:
                group = "10U" if found.group(1) == "10&U" else found.group(1)
                continue
            if group is None or "Relay" in line:
                continue
            found = row.match(line)
            if not found:
                continue
            girls = [hundredths(v) for v in found.groups()[:3]]
            label = found.group(4)
            boys = [hundredths(v) for v in found.groups()[4:]]
            for course, value in zip(COURSES_LEFT, girls):
                put(out, "champs", "girls", group, course, label, value)
            for course, value in zip(COURSES_RIGHT, boys):
                put(out, "champs", "boys", group, course, label, value)


def validate(out):
    expected_groups = {"agi": {"10U", "11-12", "13-14", "15O"}, "champs": {"10U", "11-12", "13-14"}}
    for meet, groups in expected_groups.items():
        for gender in ("girls", "boys"):
            actual = set(out[meet][gender])
            if actual != groups:
                raise ValueError(f"{meet} {gender}: groups {actual}, expected {groups}")
            for group in groups:
                courses = out[meet][gender][group]
                if set(courses) != set(COURSES_LEFT):
                    raise ValueError(f"{meet} {gender} {group}: incomplete courses")
                if any(len(events) < 10 for events in courses.values()):
                    raise ValueError(f"{meet} {gender} {group}: too few events")


def plain(value):
    if isinstance(value, defaultdict):
        return {key: plain(child) for key, child in sorted(value.items())}
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("champs_pdf")
    parser.add_argument("-o", "--out", default="app/standards/pns.json")
    args = parser.parse_args()

    out = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(dict))))
    parse_agi(out)
    parse_champs(out, args.champs_pdf)
    validate(out)

    payload = {
        "region": "Pacific Northwest Swimming",
        "meets": [
            {"id": "agi", "label": "AGI", "edition": "2026-27", "source": AGI_SOURCE},
            {"id": "champs", "label": "14&U Champs", "edition": "2026 SC", "source": CHAMPS_SOURCE},
        ],
        "unavailable": [
            {"id": "regionals", "label": "NW Regionals", "edition": "2027", "reason": "Cuts not published by PNS"}
        ],
        "generatedBy": "tools/build-pns-standards.py",
        "standards": plain(out),
    }
    with open(args.out, "w") as handle:
        json.dump(payload, handle, separators=(",", ":"))
        handle.write("\n")


if __name__ == "__main__":
    main()
