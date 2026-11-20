import SunCalc from "suncalc";
import { londonClock, type Graphic, type Page } from "./board.js";
import { textWidth } from "./font.js";
import { Canvas, header, page, type Place } from "./sky.js";

type Status = "green" | "yellow" | "amber" | "red";
type Activity = { t: number; value: number; status: Status };

const api = "https://aurorawatch-api.lancs.ac.uk/0.2.5/status";
const statuses: Status[] = ["green", "yellow", "amber", "red"];
let cache: { fetched: number; status: Status; activity: Activity[] } | undefined;

async function xml(path: string): Promise<string> {
  const response = await fetch(`${api}/${path}`, {
    headers: { "User-Agent": "Linespeed Waypoint display" }, signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`AuroraWatch HTTP ${response.status}`);
  return await response.text();
}

const asStatus = (value: string | undefined): Status | undefined => statuses.find((status) => status === value);

async function fetchAurora(now: number): Promise<{ status: Status; activity: Activity[] }> {
  // AuroraWatch UK updates every few minutes; polling every five keeps load on their service low.
  if (cache && now - cache.fetched < 5 * 60_000) return cache;
  try {
    const [current, recent] = await Promise.all([xml("current-status.xml"), xml("alerting-site-activity.xml")]);
    const status = asStatus(current.match(/<site_status[^>]*status_id="(\w+)"/)?.[1]);
    if (!status) throw new Error("Unexpected AuroraWatch status");
    const activity = [...recent.matchAll(/<activity status_id="(\w+)"><datetime>([^<]+)<\/datetime><value>([\d.]+)<\/value><\/activity>/g)]
      .flatMap(([, level, time, value]) => {
        const t = Date.parse(time.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
        const parsed = asStatus(level);
        return Number.isFinite(t) && parsed ? [{ t, value: Number(value), status: parsed }] : [];
      });
    cache = { fetched: now, status, activity };
    return cache;
  } catch (error) {
    if (cache && now - cache.fetched < 30 * 60_000) return cache;
    throw error;
  }
}

const meaning: Record<Exclude<Status, "green">, [string, string]> = {
  yellow: ["POSSIBLY VISIBLE BY", "EYE FROM SCOTLAND"],
  amber: ["LIKELY VISIBLE BY EYE", "FROM SCOTLAND"],
  red: ["LIKELY VISIBLE FROM", "ANYWHERE IN THE UK"],
};
const statusShade: Record<Status, number> = { green: 4, yellow: 8, amber: 12, red: 15 };

export function auroraPage(status: Exclude<Status, "green">, activity: Activity[], place: Place, now: number): Page {
  const graphics: Graphic[] = [...header("AURORA", now)];
  graphics.push([3, 14, 2, 15, `${status.toUpperCase()} ALERT`]);
  const [first, second] = meaning[status];
  graphics.push([3, 34, 1, 11, first], [3, 43, 1, 11, second]);

  // The aurora is only worth looking for once the sky is properly dark.
  const altitude = SunCalc.getPosition(new Date(now), place.lat, place.lon).altitude * 180 / Math.PI;
  const dusk = SunCalc.getTimes(new Date(now), place.lat, place.lon).nauticalDusk?.getTime();
  const sky = altitude < -6 ? "SKY IS DARK NOW" : dusk && dusk > now ? `DARK FROM ${londonClock.format(dusk)}` : "WAIT FOR DARK";
  graphics.push([3, 54, 1, 13, sky]);

  // Magnetic activity over the last 24 hours, with the alert thresholds.
  const left = 140;
  const top = 13;
  const bottom = 50;
  const hours = activity.filter(({ t }) => t > now - 24 * 3_600_000).slice(-24);
  const peak = Math.max(220, ...hours.map(({ value }) => value));
  const yOf = (value: number) => bottom - Math.round(value / peak * (bottom - top));
  const layers = new Map<Status, Canvas>(statuses.map((level) => [level, new Canvas(114, bottom - top + 1)]));
  const offset = 114 - hours.length * 4;
  hours.forEach(({ value, status: level }, i) => {
    for (let y = yOf(value); y <= bottom; y++) for (let x = offset + i * 4; x < offset + i * 4 + 3; x++) layers.get(level)!.set(x, y - top);
  });
  const thresholds = new Canvas(114, bottom - top + 1);
  for (const value of [50, 100, 200]) for (let x = 0; x < 114; x += 3) thresholds.set(x, yOf(value) - top);
  graphics.push(...thresholds.graphic(left, top, 3));
  for (const level of statuses) graphics.push(...layers.get(level)!.graphic(left, top, statusShade[level]));
  graphics.push([left - 4, 13, 1, 50, 3], [left, 54, 1, 6, "AURORAWATCH UK"]);
  return page("aurora", "sky", "AURORA ALERT", now, graphics, "live", 30);
}

/** An aurora card only when AuroraWatch UK reports yellow or higher. */
export async function auroraScreen(place: Place, nowDate: Date): Promise<Page | undefined> {
  const now = nowDate.getTime();
  try {
    const { status, activity } = await fetchAurora(now);
    return status === "green" ? undefined : auroraPage(status, activity, place, now);
  } catch (error) {
    console.warn("aurora: %s", error instanceof Error ? error.message : "fetch error");
    return undefined;
  }
}
