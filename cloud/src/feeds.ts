import { parse } from "node-html-parser";
import { ecfToLookAngles, eciToEcf, gstime, propagate, radiansLat, radiansLong, twoline2satrec } from "satellite.js";
import { londonClock, row, type Row } from "./board.js";
import { railPresentation, type Train } from "./rail.js";

export type Settings = {
  buses: { stop: string; label: string; filter: string; offset: number }[];
  rails: { crs: string; label: string; calling: string; platform: string; offset: number }[];
  air: { lat: number; lon: number; radius: number };
  space: { lat: number; lon: number; alt: number; mask: number; overhead: number; cacheHours: number };
};

const headers = { "User-Agent": "Linespeed Waypoint display" };

async function request(url: string, extra?: Record<string, string>): Promise<Response> {
  const result = await fetch(url, { headers: { ...headers, ...extra }, signal: AbortSignal.timeout(8000) });
  if (!result.ok) throw new Error(`Feed HTTP ${result.status}`);
  return result;
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

type Aircraft = { hex?: string; flight?: string; r?: string; t?: string; dst?: number; alt_baro?: number | "ground"; gs?: number; seen_pos?: number };

export async function airRows(settings: Settings["air"]): Promise<Row[]> {
  const { lat, lon, radius } = settings;
  const data = await (await request(`https://api.adsb.lol/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${radius}`)).json() as {
    ac?: Aircraft[];
  };
  if (!Array.isArray(data.ac)) throw new Error("Unexpected aircraft response");
  return data.ac.filter((a) => a.alt_baro !== "ground" && (a.seen_pos ?? 0) <= 60 && Number.isFinite(a.dst))
    .sort((a, b) => a.dst! - b.dst!).slice(0, 1).map((a) => {
      const identity = a.flight?.trim() || a.r || a.hex || "AIRCRAFT";
      const altitude = typeof a.alt_baro === "number" ? `FL${Math.round(a.alt_baro / 100)}` : "";
      const speed = typeof a.gs === "number" ? `${Math.round(a.gs)}KT` : "";
      return row(`${Math.round(a.dst!)}NM`, `${identity} ${a.t ?? ""}`, altitude || speed || "---");
    });
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

export function spaceRows(orbits: Orbit[], settings: Settings["space"], now: Date): Row[] {
  const observer = { latitude: radiansLat(settings.lat), longitude: radiansLong(settings.lon), height: settings.alt / 1000 };
  const time = gstime(now);
  return orbits.flatMap((orbit) => {
    try {
      const record = twoline2satrec(orbit.line1, orbit.line2);
      const state = propagate(record, now);
      if (!state || !state.position || typeof state.position === "boolean") return [];
      const angles = ecfToLookAngles(observer, eciToEcf(state.position, time));
      const elevation = angles.elevation * (180 / Math.PI);
      if (!Number.isFinite(elevation) || elevation < 5) return [];
      return [{ elevation, row: row(`${Math.round(elevation)}DEG`, orbit.name,
        elevation >= settings.overhead ? "OVERHEAD" : `${Math.round(angles.rangeSat)}KM`) }];
    } catch {
      return [];
    }
  }).sort((a, b) => b.elevation - a.elevation).slice(0, 4).map((item) => item.row);
}
