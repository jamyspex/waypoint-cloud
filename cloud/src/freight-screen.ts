import { displayText, londonClock, row, type Graphic, type Page } from "./board.js";
import { textWidth } from "./font.js";
import type { FreightFile, FreightTrain } from "./freight.js";
import { freightLocations } from "./freight-locations.js";

const recent = 3 * 3_600_000;
// TRUST sector codes (toc_id) for freight and engineering operators, from the Open Rail Data wiki TOC Codes page.
const operators: Record<string, string> = {
  "04": "DBC", "05": "DBC", "08": "DBC", "54": "GBRF", "66": "FLR", "11": "FLR", "42": "COLAS", "97": "DRS",
  "07": "ROG", "09": "HHR", "34": "DCR", "50": "WCR", "89": "LSL", "95": "VRMS", "15": "NR", "31": "NR", "92": "NR",
  "39": "HRSCO", "40": "BBR", "43": "AMEY", "46": "SBR", "49": "VOLKR", "72": "LEGGE", "17": "H&H", "10": "SERCO",
  "16": "LORAM", "36": "VINTG", "60": "SR", "35": "CS", "71": "TFW",
};
const title = "INVERNESS, FAR NORTH & KYLE";

// Reference names describe sidings and signals ("DAVENTRY RECEP SDGS"); keep the place up to the first technical word.
const technical = new Set(["LHS", "RHS", "UP", "DN", "DOWN", "RECP", "RECEP", "SDGS", "SDG", "SS", "SIG", "EMU", "FLT", "SHUNT",
  "LOOP", "LOOPS", "N", "S", "E", "W", "GF", "CE", "LC", "ARR", "DEP", "EXIT", "ENT", "NO", "PLATFORM", "PLAT", "&"]);
export function placeName(raw: string): string {
  const words = raw.replace(/\s*\(.*?\)/g, "").trim().split(/\s+/);
  const end = words.findIndex((word, i) => i > 0 && (technical.has(word) || /\d/.test(word)));
  return words.slice(0, end < 0 ? words.length : end).join(" ");
}

type Sighting = { train: FreightTrain; place: string; event: string; at: number; lateness: string };

function lateness(train: FreightTrain): string {
  const minutes = Number.isFinite(train.last.variation) ? Math.round(train.last.variation) : NaN;
  if (!Number.isFinite(minutes)) return "";
  if (train.last.status === "ON TIME" || minutes === 0) return "ON TIME";
  return `${minutes} ${train.last.status === "EARLY" ? "EARLY" : "LATE"}`;
}

/** Freight trains reported in, or about to enter, the Inverness, Far North and Kyle area. */
export function freightSightings(file: FreightFile | null, now: number): Sighting[] {
  return Object.values(file?.trains ?? {}).flatMap((train): Sighting[] => {
    if (now - train.last.at > (train.terminated ? recent / 3 : recent)) return [];
    const here = freightLocations[train.last.stanox];
    if (here) {
      const event = train.terminated ? "TERM" : train.last.event === "ARRIVAL" ? "ARR" : "DEP";
      return [{ train, place: here.name, event, at: train.last.at, lateness: lateness(train) }];
    }
    const next = train.next ? freightLocations[train.next] : undefined;
    return next && !train.terminated ? [{ train, place: next.name, event: "APPR", at: train.last.at, lateness: lateness(train) }] : [];
  }).sort((a, b) => b.at - a.at).slice(0, 4);
}

export function freightPage(file: FreightFile | null, nowDate: Date): Page | undefined {
  const now = nowDate.getTime();
  const sightings = freightSightings(file, now);
  if (!sightings.length) return undefined;
  const graphics: Graphic[] = [
    [2, 0, 1, 15, "FREIGHT"], [254 - textWidth("LIVE"), 0, 1, 11, "LIVE"],
    [2, 9, 1, 15, title], [0, 18, 256, 1, 5], [0, 63, 256, 1, 3],
  ];
  // Four 7.5 second phases alternate the middle of each row between where the train is now
  // and where it set off from, so the 30 second screen shows each twice.
  const current: Graphic[] = [];
  const from: Graphic[] = [];
  sightings.forEach(({ train, place, event, at, lateness: late }, i) => {
    const top = 21 + i * 10;
    let name = displayText(place, 18);
    while (textWidth(name) > 90) name = name.slice(0, -1);
    let operator = operators[train.toc] ?? "";
    while (textWidth(operator) > 31) operator = operator.slice(0, -1);
    graphics.push(
      [2, top, 1, 15, train.headcode],
      [30, top, 1, 8, operator],
      [254 - textWidth(late), top, 1, late.includes("LATE") ? 13 : 9, late],
    );
    const here: Graphic[] = [[62, top, 1, event === "APPR" ? 9 : 12, name], [158, top, 1, 10, `${event} ${londonClock.format(at)}`]];
    current.push(...here);
    const origin = train.originName ? placeName(train.originName) : undefined;
    if (!origin || train.origin === train.last.stanox) {
      from.push(...here);
      return;
    }
    let label = displayText(origin, 24);
    const room = 254 - textWidth(late) - 8 - (62 + textWidth("FROM "));
    while (textWidth(label) > room) label = label.slice(0, -1);
    from.push([62, top, 1, 7, "FROM"], [62 + textWidth("FROM "), top, 1, 12, label.trimEnd()]);
  });
  return {
    id: "freight", mode: "rail", title: "HIGHLAND FREIGHT", updated: londonClock.format(now), state: "live",
    rows: sightings.map(({ train, place, at }) => row(londonClock.format(at), `${train.headcode} ${place}`, "")),
    graphics, animation: { phase_ms: 7500, phases: [current, from, current, from] },
    clock: { right: 128 + Math.ceil(textWidth("00:00") / 2), shade: 8 },
  };
}
