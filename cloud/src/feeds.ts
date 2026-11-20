import { parse } from "node-html-parser";
import { createHash } from "node:crypto";
import { displayText, londonClock, row, type Graphic, type Page, type Row } from "./board.js";
import { textWidth } from "./font.js";
import { airPresentation, type Aircraft, isMilitary } from "./air.js";
import { railPresentation, type Train } from "./rail.js";

export type Settings = {
  buses: { stop: string; label: string; filter: string; offset: number }[];
  rails: { crs: string; label: string; calling: string; platform: string; offset: number }[];
  air: { lat: number; lon: number; radius: number };
  space: { lat: number; lon: number; alt: number; mask: number; overhead: number; cacheHours: number };
  // Optional sea point for tides when the display location is inland.
  tide?: { lat: number; lon: number; label?: string };
};

const headers = { "User-Agent": "Linespeed Waypoint display" };

async function request(url: string, extra?: Record<string, string>, timeoutMs = 8000): Promise<Response> {
  const result = await fetch(url, { headers: { ...headers, ...extra }, signal: AbortSignal.timeout(timeoutMs) });
  if (!result.ok) throw new Error(`Feed HTTP ${result.status}`);
  return result;
}

function fitText(text: string, pixels: number): string {
  while (text && textWidth(text) > pixels) text = text.slice(0, -1);
  return text.trimEnd();
}

// Draw the departures with a fixed route column so destinations line up whatever the route numbers are.
export function busGraphics(rows: Row[], title: string): { graphics: Graphic[]; clock: NonNullable<Page["clock"]> } {
  const split = rows.map(([, label]) => {
    const space = label.indexOf(" ");
    return space < 0 ? ["", label] : [label.slice(0, space), label.slice(space + 1)];
  });
  const column = Math.max(0, ...split.map(([route]) => textWidth(route))) + 6;
  const graphics: Graphic[] = [
    [2, 0, 1, 15, "BUS"], [254 - textWidth("LIVE"), 0, 1, 11, "LIVE"],
    [2, 9, 1, 15, displayText(title, 26)], [0, 18, 256, 1, 5], [0, 63, 256, 1, 3],
  ];
  rows.forEach(([lead, , detail], index) => {
    const [route, destination] = split[index];
    const top = 21 + index * 10;
    graphics.push([2, top, 1, 12, lead]);
    if (route) graphics.push([44, top, 1, 12, route]);
    const left = 44 + (route ? column : 0);
    const text = fitText(destination, 250 - textWidth(detail) - 6 - left);
    if (text) graphics.push([left, top, 1, 15, text]);
    graphics.push([254 - textWidth(detail), top, 1, 10, detail]);
  });
  // The firmware draws the live clock right-aligned, so centre it like the text layout.
  return { graphics, clock: { right: 128 + Math.ceil(textWidth("00:00") / 2), shade: 8 } };
}

export async function busRows(stops: Settings["buses"], now: Date): Promise<Row[]> {
  const time = londonClock.format(now);
  const asMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const current = asMinutes(time);
  const departures = await Promise.all(stops.map(async (stop) => {
    const html = await (await request(`https://bustimes.org/stops/${encodeURIComponent(stop.stop)}/departures`)).text();
    const page = parse(html);
    if (!page.querySelector("#departures")) throw new Error("Bus departures markup missing");
    const routes = stop.filter.toUpperCase().split(/[,\s]+/).filter(Boolean);
    return page.querySelectorAll("table tbody tr").flatMap((tr) => {
      const cells = tr.querySelectorAll("td");
      if (cells.length < 3) return [];
      cells[1].querySelectorAll(".vehicle").forEach((vehicle) => vehicle.remove());
      const route = cells[0].text.trim();
      const label = cells[1].text.trim();
      const time = cells[2].text.trim().match(/\b\d{2}:\d{2}\b/)?.[0];
      const expected = cells[3]?.text.trim().match(/\b\d{2}:\d{2}\b/)?.[0];
      if (!route || !label || !time || (routes.length && !routes.includes(route.toUpperCase()))) return [];
      let order = asMinutes(expected ?? time) - current;
      if (order < -600) order += 1440; // Departures after midnight.
      if (order < stop.offset) return [];
      return [{ order, row: row(time, `${route} ${label}`, expected ?? "SCHED") }];
    });
  }));
  return departures.flat().sort((a, b) => a.order - b.order).slice(0, 4).map((item) => item.row);
}

export async function railRows(station: Settings["rails"][number], credential: string, updated: string) {
  const url = new URL(`https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/GetDepBoardWithDetails/${encodeURIComponent(station.crs)}`);
  url.searchParams.set("numRows", station.platform ? "12" : "4");
  url.searchParams.set("timeOffset", String(station.offset));
  if (station.calling) {
    url.searchParams.set("filterCrs", station.calling);
    url.searchParams.set("filterType", "to");
  }
  const data = await (await request(url.href, { "x-apikey": credential, Accept: "application/json" })).json() as {
    trainServices?: Train[] | null;
    locationName?: string;
    platformAvailable?: boolean;
  };
  if (!data.locationName || (data.trainServices != null && !Array.isArray(data.trainServices))) {
    throw new Error("Unexpected rail response");
  }
  const trains = (data.trainServices ?? []).filter((train) => !station.platform || train.platform === station.platform);
  return railPresentation(trains, data.locationName, updated, data.platformAvailable !== false);
}

export const aircraftRadius = 10;
export const milAircraftRadius = 50;

async function aircraftSnapshot(path: string, reserveFallback: () => Promise<boolean>): Promise<Aircraft[]> {
  const from = async (base: string): Promise<Aircraft[]> => {
    const response = await request(`${base}${path}`, { Accept: "application/json" }, 4000);
    const data = await response.json() as { ac?: Aircraft[] } | null;
    if (!Array.isArray(data?.ac)) throw new Error("Unexpected aircraft response");
    return data.ac;
  };
  try {
    return await from("https://opendata.adsb.fi/api/v3");
  } catch (error) {
    console.warn("air adsb.fi: %s", error instanceof Error ? error.message : "fetch error");
    if (!await reserveFallback()) throw error;
    return await from("https://api.adsb.lol/v2");
  }
}

export async function nearbyAircraft(settings: Settings["air"], reserveFallback: () => Promise<boolean>) {
  const { lat, lon } = settings;
  const radius = Math.max(milAircraftRadius, aircraftRadius);
  const snapshot = await aircraftSnapshot(`/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${radius}`, reserveFallback);
  const aircraft = snapshot.filter((a) => a && a.alt_baro !== "ground" && (a.seen_pos ?? 0) <= 60)
    .flatMap((a) => {
      let distance = a.dst;
      if (typeof a.lat === "number" && typeof a.lon === "number" && Math.abs(a.lat) <= 90 && Math.abs(a.lon) <= 180) {
        const rad = Math.PI / 180;
        const arc = Math.sin((a.lat - lat) * rad / 2) ** 2
          + Math.cos(lat * rad) * Math.cos(a.lat * rad) * Math.sin((a.lon - lon) * rad / 2) ** 2;
        distance = 3440.065 * 2 * Math.asin(Math.min(1, Math.sqrt(arc)));
      }
      return typeof distance === "number" && distance >= 0 && (distance <= aircraftRadius || isMilitary(a) && distance <= milAircraftRadius) ? [{ a, distance }] : [];
    }).sort((a, b) => a.distance - b.distance);
  const unique = new Map<string, typeof aircraft[number]>();
  for (const contact of aircraft) {
    const { hex, r, flight, lat, lon, t } = contact.a;
    const key = [hex, r, flight].find((value) => typeof value === "string" && value.trim())?.trim().toUpperCase()
      ?? JSON.stringify([lat, lon, t, contact.distance]);
    const id = `air-${createHash("sha256").update(key).digest("hex").slice(0, 14)}`;
    if (!unique.has(id)) unique.set(id, contact);
  }
  const contacts = [...unique];
  const deadline = AbortSignal.timeout(4500);
  const cards = [];
  for (let i = 0; i < contacts.length; i += 4) {
    cards.push(...await Promise.all(contacts.slice(i, i + 4).map(async ([id, { a, distance }]) => ({
      id, ...await airPresentation(a, distance, deadline),
    }))));
  }
  return cards;
}

export type Orbit = { name: string; line1: string; line2: string };
const groups = [["ISS", "CSS"], ["STARLINK"], ["NOAA", "METOP"], ["AO-", "SO-"], ["GALILEO"], ["HST", "IRIDIUM"]];

export async function fetchOrbits(mask: number): Promise<Orbit[]> {
  const queries = groups.filter((_, index) => Boolean(mask & (1 << index))).flat();
  if (!queries.length) return [];
  const catalogues = [
    { enabled: mask & 1, group: "stations", name: /^(ISS \(ZARYA\)|CSS \(TIANHE\))/i },
    { enabled: mask & 4, group: "weather", name: /^(NOAA 2[01]|METOP|SUOMI)/i },
    { enabled: mask & 32, group: "science", name: /^(HST|TERRA|AQUA|SENTINEL|LANDSAT|SWOT|PACE)/i },
  ];
  const results = await Promise.allSettled([
    ...queries.map(async (name) => {
      const url = `https://tle.ivanstanojevic.me/api/tle/?search=${encodeURIComponent(name)}&page-size=${name === "STARLINK" ? 100 : 30}`;
      const data = await (await request(url)).json() as { member?: Orbit[] };
      if (!Array.isArray(data.member)) throw new Error("Unexpected TLE response");
      return data.member;
    }),
    ...catalogues.filter(({ enabled }) => enabled).map(async ({ group, name }) => {
      const text = await (await request(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`)).text();
      const lines = text.trim().split(/\r?\n/);
      const orbits: Orbit[] = [];
      for (let index = 0; index + 2 < lines.length; index += 3) {
        const label = lines[index].trim();
        if (name.test(label)) orbits.push({ name: label, line1: lines[index + 1], line2: lines[index + 2] });
      }
      return orbits;
    }),
  ]);
  const records = new Map<string, Orbit>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const orbit of result.value) {
      if (typeof orbit?.name !== "string" || !/^1 /.test(orbit.line1) || !/^2 /.test(orbit.line2)) continue;
      records.set(orbit.line1.slice(2, 7), { name: orbit.name, line1: orbit.line1, line2: orbit.line2 });
    }
  }
  if (!records.size) throw new Error("No orbital elements returned");
  return [...records.values()];
}
