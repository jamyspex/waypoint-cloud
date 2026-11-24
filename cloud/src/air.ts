import { aircraftDrawing } from "./aircraft-art.js";
import { printableText, row, type Graphic, type Row } from "./board.js";
import { textWidth } from "./font.js";

export type Aircraft = {
  hex?: string; flight?: string; r?: string; t?: string; desc?: string; ownOp?: string; category?: string; dbFlags?: number;
  lat?: number; lon?: number; dst?: number; alt_baro?: number | "ground"; alt_geom?: number; gs?: number; seen_pos?: number;
};

export type Airport = { iata_code?: string | null; icao_code?: string; municipality?: string | null; name?: string; latitude?: number; longitude?: number };
export type Route = {
  callsign_iata?: string | null;
  airline?: { name?: string } | null;
  origin?: Airport;
  destination?: Airport;
};
export type Lookup = { route?: Route; airline?: string; owner?: string };
const lookupCache = new Map<string, { expires: number; data: Lookup }>();

function clean(value: unknown): string {
  return typeof value === "string" ? printableText(value).toUpperCase() : "";
}

export function isMilitary(aircraft: Aircraft): boolean {
  return ((aircraft.dbFlags ?? 0) & 1) !== 0
    || /\b(?:AIR FORCE|AIR NATIONAL GUARD|ARMY|NAVY|MILITARY)\b/.test(clean(aircraft.ownOp));
}

function cacheLookup(key: string, data: Lookup, minutes: number): void {
  if (lookupCache.size >= 64 && !lookupCache.has(key)) {
    const first = lookupCache.keys().next().value;
    if (first) lookupCache.delete(first);
  }
  lookupCache.set(key, { expires: Date.now() + minutes * 60_000, data });
}

async function lookup<T>(path: string, deadline?: AbortSignal): Promise<T | undefined> {
  const timeout = AbortSignal.timeout(2400);
  const response = await fetch(`https://api.adsbdb.com/v0/${path}`, {
    headers: { Accept: "application/json", "User-Agent": "Linespeed Waypoint display" },
    signal: deadline ? AbortSignal.any([deadline, timeout]) : timeout,
  });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`Aircraft lookup HTTP ${response.status}`);
  return (await response.json() as { response?: T }).response;
}

async function lookupFlight(callsign: string, deadline?: AbortSignal): Promise<Lookup> {
  if (!/^[A-Z0-9]{2,8}$/.test(callsign)) return {};
  const cached = lookupCache.get(callsign);
  if (cached && Date.now() < cached.expires) return cached.data;
  if (deadline?.aborted) return {};
  try {
    const route = (await lookup<{ flightroute?: Route }>(`callsign/${callsign}`, deadline))?.flightroute;
    const prefix = callsign.match(/^([A-Z]{3})\d/)?.[1];
    const airline = clean(route?.airline?.name) || (prefix
      ? clean((await lookup<Array<{ name?: string }>>(`airline/${prefix}`, deadline).catch(() => undefined))?.[0]?.name)
      : "");
    const data = { route, airline };
    cacheLookup(callsign, data, route ? 15 : 3);
    return data;
  } catch {
    // Route metadata can fail independently of the live ADS-B position.
    return {};
  }
}

async function lookupOwner(registration: string, hex: string, deadline?: AbortSignal): Promise<string> {
  const id = /^[A-Z0-9][A-Z0-9-]{0,14}$/.test(registration) ? registration : /^[A-F0-9]{6}$/.test(hex) ? hex : "";
  if (!id || deadline?.aborted) return "";
  const path = `aircraft/${id}`;
  const cached = lookupCache.get(path);
  if (cached && Date.now() < cached.expires) return cached.data.owner ?? "";
  try {
    const data = await lookup<{ aircraft?: { registered_owner?: string } }>(path, deadline);
    const owner = clean(data?.aircraft?.registered_owner);
    cacheLookup(path, { owner }, owner ? 24 * 60 : 15);
    return owner;
  } catch {
    return "";
  }
}

function nauticalMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const arc = Math.sin((lat2 - lat1) * rad / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 3440.065 * 2 * Math.asin(Math.min(1, Math.sqrt(arc)));
}

// adsbdb keeps routes for reused callsigns (e.g. Loganair's LOG78LC listed as MAN-NQY while flying SYY-INV),
// so drop a route when the aircraft is far outside the corridor between its stated airports.
export function plausibleRoute(route: Route | undefined, aircraft: Aircraft): Route | undefined {
  const { lat, lon } = aircraft;
  const from = route?.origin;
  const to = route?.destination;
  if (!route || typeof lat !== "number" || typeof lon !== "number"
    || typeof from?.latitude !== "number" || typeof from.longitude !== "number"
    || typeof to?.latitude !== "number" || typeof to.longitude !== "number") return route;
  const direct = nauticalMiles(from.latitude, from.longitude, to.latitude, to.longitude);
  const via = nauticalMiles(from.latitude, from.longitude, lat, lon) + nauticalMiles(lat, lon, to.latitude, to.longitude);
  return via <= direct * 1.25 + 60 ? route : undefined;
}

function fit(text: string, pixels: number): string {
  text = text.slice(0, 48);
  while (textWidth(text) > pixels) text = text.slice(0, -1);
  return text.trimEnd();
}

function center(text: string, left: number, width: number, scale: number): number {
  return left + Math.floor((width - textWidth(text) * scale) / 2);
}

function airportCode(airport?: Airport): string {
  const iata = clean(airport?.iata_code);
  const icao = clean(airport?.icao_code);
  return /^[A-Z0-9]{3}$/.test(iata) ? iata : /^[A-Z0-9]{4}$/.test(icao) ? icao : "---";
}

export async function airPresentation(aircraft: Aircraft, distance: number, deadline?: AbortSignal, known?: Lookup): Promise<{ title: string; rows: Row[]; graphics: Graphic[] }> {
  const callsign = clean(aircraft.flight);
  const registration = clean(aircraft.r);
  const hex = clean(aircraft.hex);
  const identity = callsign || registration || hex || "AIRCRAFT";
  const type = clean(aircraft.t);
  const description = clean(aircraft.desc);
  const operator = clean(aircraft.ownOp);
  const military = isMilitary(aircraft);
  // Flightradar24 (when available) knows this flight's actual route; adsbdb is the fallback.
  const [{ route: listed, airline }, owner] = await Promise.all([
    known?.route ? Promise.resolve({ ...known, airline: known.airline || "" }) : lookupFlight(callsign, deadline),
    military && !operator ? lookupOwner(registration, hex, deadline) : Promise.resolve(""),
  ]);
  const route = plausibleRoute(listed, aircraft);
  const carrier = fit(military ? operator || owner || "MILITARY AIRCRAFT" : airline || operator || "NEARBY AIRCRAFT", 132);
  const number = clean(route?.callsign_iata);
  const both = `${number}/${identity}`;
  const flight = fit(number && number !== callsign && textWidth(both) <= 78 ? both : number || identity, 78);
  const from = airportCode(route?.origin);
  const to = airportCode(route?.destination);
  const fromCity = fit(clean(route?.origin?.municipality) || clean(route?.origin?.name), 72);
  const toCity = fit(clean(route?.destination?.municipality) || clean(route?.destination?.name), 76);
  const shortDescription = description.replace(/^(AIRBUS|BOEING|EMBRAER|BOMBARDIER|CESSNA)\s+/i, "");
  const designation = fit(textWidth(shortDescription) <= 84 ? shortDescription || type || "TYPE UNKNOWN" : type, 84) || "AIRCRAFT";
  const registrationLabel = `${type} ${registration}`;
  const model = type && registration && identity !== registration && textWidth(registrationLabel) <= 84
    ? registrationLabel : designation;
  const altitude = typeof aircraft.alt_baro === "number" ? aircraft.alt_baro : aircraft.alt_geom;
  const feet = Number.isFinite(altitude) ? `${Math.round(altitude!).toLocaleString("en-GB")} FT` : "--";
  const knots = Number.isFinite(aircraft.gs) ? `${Math.round(aircraft.gs!)} KT` : "--";
  const range = `${Math.round(distance)} NM`;

  const graphics: Graphic[] = [
    [3, 0, 1, 15, carrier], [218 - textWidth(flight), 0, 1, 15, flight],
    [0, 9, 256, 1, 6], [164, 12, 1, 37, 4], [0, 51, 256, 1, 6],
    [4, 12, 1, 9, "FROM"], [85, 12, 1, 9, "TO"],
    [4, 20, 2, 15, from], [85, 20, 2, 15, to],
    [58, 29, 14, 1, 9], [68, 25, 1, 11, [1, 2, 4, 8, 16, 8, 4, 2, 1]],
    ...aircraftDrawing(type, clean(aircraft.category)),
    [center(model, 165, 91, 1), 41, 1, 13, model],
    [4, 54, 1, 9, "ALT"], [27, 54, 1, 15, feet],
    [97, 54, 1, 9, "SPD"], [122, 54, 1, 15, knots],
    [184, 54, 1, 9, "RANGE"], [219, 54, 1, 15, range],
  ];
  if (fromCity) graphics.push([4, 40, 1, 12, fromCity]);
  if (toCity) graphics.push([85, 40, 1, 12, toCity]);
  if (from === "---" && to === "---") graphics.push([4, 40, 1, 10, "ROUTE UNAVAILABLE"]);
  const status = Number.isFinite(altitude) ? `FL${Math.round(altitude! / 100)}` : knots.replace(" ", "");
  return {
    title: fit(`${identity} ${type}`.trim(), 123).slice(0, 22),
    rows: [row(range.replace(" ", ""), `${identity} ${type}`, status)],
    graphics,
  };
}
