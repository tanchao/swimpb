// Pacific Northwest Swimming meet qualification standards.
//
// These are separate from the national motivational ladder: one time can be an
// "A" time and also qualify for AGI, Champs, both, or neither. Meet cuts change
// by season, so their edition and official source travel with the data.

import { mapDistance } from "./convert.js";

const URL_PATH = "standards/pns.json";
const STROKE_ABBREV = {
  Freestyle: "FR",
  Backstroke: "BK",
  Breaststroke: "BR",
  Butterfly: "FL",
  "Individual Medley": "IM",
};

let loaded = null;
let inFlight = null;

export function loadRegionalStandards() {
  if (loaded) return Promise.resolve(loaded);
  if (inFlight) return inFlight;
  inFlight = fetch(new URL(URL_PATH, import.meta.url))
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      loaded = data;
      return data;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function meetAgeGroup(ageGroup, meetId) {
  if (meetId === "agi" && (ageGroup === "15-16" || ageGroup === "17-18")) return "15O";
  return ageGroup;
}

/**
 * All published meet cuts for one event.
 * @returns {Array<{id:string,label:string,edition:string,source:string,cut:number}>}
 */
export function meetCutsFor(data, { gender, ageGroup, course, distance, stroke }) {
  if (!data || !gender || !ageGroup) return [];
  const abbrev = STROKE_ABBREV[stroke];
  if (!abbrev) return [];
  const raced = mapDistance(distance, stroke, "SCY", course);
  const event = `${raced} ${abbrev}`;

  return (data.meets ?? []).flatMap((meet) => {
    const group = meetAgeGroup(ageGroup, meet.id);
    const cut = data.standards?.[meet.id]?.[gender]?.[group]?.[course]?.[event];
    return Number.isInteger(cut) ? [{ ...meet, cut }] : [];
  });
}
