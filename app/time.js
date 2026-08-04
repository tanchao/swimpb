// Swim time parsing and formatting.
//
// The API returns times as display strings: "22.64", "1:01.61", and sometimes
// with a trailing flag like "22.64r". The `r` marks a relay lead-off — a legal
// time, but one earned off a relay start rather than a flat start, so it is
// worth surfacing rather than silently dropping.

const FLAGS = {
  r: "Relay lead-off (started from a relay, not a flat start)",
  s: "Split",
  y: "Converted from yards",
};

/**
 * @param {string} raw e.g. "1:01.61" or "22.64r"
 * @returns {{hundredths:number|null, flag:string|null, raw:string}}
 */
export function parseTime(raw) {
  if (typeof raw !== "string") return { hundredths: null, flag: null, raw: String(raw ?? "") };

  const trimmed = raw.trim();
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)\s*([a-zA-Z])?$/.exec(trimmed);
  if (!m) return { hundredths: null, flag: null, raw: trimmed };

  const [, mins, secs, flag] = m;
  const total = (mins ? Number(mins) * 60 : 0) + Number(secs);
  return {
    // Round rather than truncate: 61.609 * 100 is 6160.899… in binary float.
    hundredths: Math.round(total * 100),
    flag: flag ? flag.toLowerCase() : null,
    raw: trimmed,
  };
}

/** Hundredths → "22.64" / "1:01.61" / "16:22.05". */
export function formatTime(hundredths) {
  if (hundredths === null || !Number.isFinite(hundredths)) return "—";
  const total = Math.round(hundredths);
  const mins = Math.floor(total / 6000);
  const secs = (total % 6000) / 100;
  if (mins === 0) return secs.toFixed(2);
  return `${mins}:${secs.toFixed(2).padStart(5, "0")}`;
}

export function flagLabel(flag) {
  return flag ? (FLAGS[flag] ?? `Flag "${flag}"`) : null;
}

/** Signed delta for display: negative is faster, and faster is good. */
export function formatDelta(hundredths) {
  if (hundredths === null || !Number.isFinite(hundredths)) return "";
  const sign = hundredths < 0 ? "−" : "+";
  return sign + formatTime(Math.abs(hundredths));
}
