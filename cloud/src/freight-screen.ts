import { displayText, londonClock, row, type Graphic, type Page } from "./board.js";
import { textWidth } from "./font.js";
import type { FreightFile, FreightTrain } from "./freight.js";
import { freightLocations, type Line } from "./freight-locations.js";
import { Canvas } from "./sky.js";

const recent = 3 * 3_600_000;
const maxCards = 6;

// TRUST sector codes (toc_id) for freight and engineering operators, from the Open Rail Data wiki TOC Codes page.
const operators: Record<string, string> = {
  "04": "DB CARGO", "05": "DB CARGO", "08": "DB CARGO", "54": "GB RAILFREIGHT", "66": "FREIGHTLINER", "11": "FREIGHTLINER",
  "42": "COLAS RAIL", "97": "DIRECT RAIL SERVICES", "07": "RAIL OPERATIONS GROUP", "09": "HEAVY HAUL RAIL", "34": "DC RAIL",
  "50": "WEST COAST RAILWAYS", "89": "LOCOMOTIVE SERVICES", "95": "VARAMIS RAIL", "15": "NETWORK RAIL", "31": "NETWORK RAIL",
  "92": "NETWORK RAIL", "39": "HARSCO", "40": "BALFOUR BEATTY", "43": "AMEY", "46": "SB RAIL", "49": "VOLKERRAIL",
  "72": "LEGGE", "17": "HANSON & HALL", "10": "SERCO", "16": "LORAM", "36": "VINTAGE TRAINS", "60": "SCOTRAIL",
  "35": "CALEDONIAN SLEEPER", "71": "TRANSPORT FOR WALES",
};
const lines: Record<Line, string> = {
  inverness: "INVERNESS", "far-north": "FAR NORTH LINE", kyle: "KYLE LINE", approach: "HIGHLAND MAIN LINE",
};
// A small freight train for the card header: a Class 66-style loco with a container wagon.
// Each letter is a grey level; "." is blank.
const trainArt = [
  "..LLLLLLLLLLLLLL...CCCCCCCCCCC..EEEEEEEEEEE",
  ".LL..BBBBBBBBBBB...CCCCCCCCCCC..EEEEEEEEEEE",
  "LL...BBBBBBBBBBB...CCCCCCCCCCC..EEEEEEEEEEE",
  "LBBBBBBBBBBBBBBB...CCCCCCCCCCC..EEEEEEEEEEE",
  "YBBBBBBBBBBBBBBB--WWWWWWWWWWWWW-WWWWWWWWWWWW",
  ".KKKKKKKKKKKKKK....KK.......KK...KK.......KK",
  "..oo.oo...oo.oo....oo.......oo...oo.......oo",
];
const trainShades: Record<string, number> = { L: 15, Y: 15, B: 12, K: 5, o: 9, C: 10, E: 7, W: 5, "-": 5 };
function trainIcon(left: number, top: number): Graphic[] {
  return Object.entries(trainShades).flatMap(([letter, shade]) => {
    const canvas = new Canvas(trainArt[0].length, trainArt.length);
    trainArt.forEach((line, y) => [...line].forEach((char, x) => { if (char === letter) canvas.set(x, y); }));
    return canvas.graphic(left, top, shade);
  });
}

// Reference names describe sidings and signals ("DAVENTRY RECEP SDGS"); keep the place up to the first technical word.
const technical = new Set(["LHS", "RHS", "UP", "DN", "DOWN", "RECP", "RECEP", "SDGS", "SDG", "SS", "SIG", "EMU", "FLT", "SHUNT",
  "LOOP", "LOOPS", "N", "S", "E", "W", "GF", "CE", "LC", "ARR", "DEP", "EXIT", "ENT", "NO", "PLATFORM", "PLAT", "&"]);
export function placeName(raw: string): string {
  const words = raw.replace(/\s*\(.*?\)/g, "").trim().split(/\s+/);
  const end = words.findIndex((word, i) => i > 0 && (technical.has(word) || /\d/.test(word)));
  return words.slice(0, end < 0 ? words.length : end).join(" ");
}

type Sighting = { train: FreightTrain; place: string; line: Line; event: string; at: number; lateness: string };

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
      const event = train.terminated ? "TERMINATED" : train.last.event === "ARRIVAL" ? "ARRIVED" : "DEPARTED";
      return [{ train, place: here.name, line: here.line, event, at: train.last.at, lateness: lateness(train) }];
    }
    const next = train.next ? freightLocations[train.next] : undefined;
    return next && !train.terminated
      ? [{ train, place: next.name, line: next.line, event: "APPROACHING", at: train.last.at, lateness: lateness(train) }]
      : [];
  }).sort((a, b) => b.at - a.at).slice(0, maxCards);
}

function fit(text: string, pixels: number, scale = 1): string {
  while (text && textWidth(text) * scale > pixels) text = text.slice(0, -1);
  return text.trimEnd();
}

// The scrolling line: where the train came from, where it usually goes, and where it has been.
function journey(train: FreightTrain, event: string): string {
  const parts: string[] = [];
  if (train.originName && train.origin !== train.last.stanox) {
    const departed = train.departed && Number.isFinite(train.departed) ? ` ${londonClock.format(train.departed)}` : "";
    parts.push(`FROM ${placeName(train.originName)}${departed}`);
  }
  if (train.destination && train.destinationStanox !== train.last.stanox && !train.terminated) {
    parts.push(`TO ${placeName(train.destination)}`);
  }
  const next = train.next ? freightLocations[train.next] : undefined;
  if (next && event !== "APPROACHING" && !train.terminated) parts.push(`NEXT ${next.name}`);
  const earlier = train.path.slice(0, -1).reverse()
    .flatMap(([stanox, at]) => freightLocations[stanox] ? [`${freightLocations[stanox].name} ${londonClock.format(at)}`] : [])
    .filter((entry, i, all) => all.indexOf(entry) === i).slice(0, 4);
  if (earlier.length) parts.push(`EARLIER ${earlier.join(", ")}`);
  return displayText(parts.join("  -  ") || "NO JOURNEY DETAILS YET", 760);
}

/** One card per freight train: operator and headcode, where it is now, and a scrolling journey line. */
export function freightPages(file: FreightFile | null, nowDate: Date): Page[] {
  const now = nowDate.getTime();
  const sightings = freightSightings(file, now);
  return sightings.map(({ train, place, line, event, at, lateness: late }, i): Page => {
    const headcode = train.headcode;
    const operator = fit(operators[train.toc] ?? "FREIGHT", 248 - textWidth(headcode) - 52);
    const location = displayText(place, 20);
    const big = textWidth(location) * 2 <= 166;
    const when = `${event} ${londonClock.format(at)}`;
    const lateScale = textWidth(late) * 2 <= 80 ? 2 : 1;
    const graphics: Graphic[] = [
      ...trainIcon(3, 1), [52, 0, 1, 15, operator], [254 - textWidth(headcode), 0, 1, 15, headcode],
      [0, 9, 256, 1, 6],
      [3, 12, 1, 8, event === "APPROACHING" ? "APPROACHING" : "NOW AT"],
      big ? [3, 21, 2, 15, location] : [3, 25, 1, 15, fit(location, 166)],
      [254 - textWidth(when), 12, 1, 10, when],
      [254 - textWidth(late) * lateScale, 22 + (lateScale === 1 ? 3 : 0), lateScale, late.includes("LATE") ? 15 : 11, late],
      [0, 40, 256, 1, 3], [0, 53, 256, 1, 3],
      [3, 55, 1, 7, lines[line]],
    ];
    if (sightings.length > 1) {
      const count = `${i + 1} OF ${sightings.length}`;
      graphics.push([254 - textWidth(count), 55, 1, 7, count]);
    }
    return {
      id: `freight-${i + 1}`, mode: "rail", title: displayText(`FREIGHT ${headcode}`, 26), updated: londonClock.format(now), state: "live",
      rows: [row(londonClock.format(at), `${headcode} ${place}`, late)],
      graphics, marquee: { left: 3, top: 43, width: 250, shade: 12, speed: 30, text: journey(train, event) },
      dwell_seconds: 20,
    };
  });
}
