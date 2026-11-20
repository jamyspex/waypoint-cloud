import SunCalc from "suncalc";
import { londonClock, type Graphic, type Page } from "./board.js";
import { textWidth } from "./font.js";
import { packedBitmap } from "./packed.js";

export type Place = { lat: number; lon: number; label?: string };
type TidePoint = { t: number; h: number };
type Extreme = TidePoint & { high: boolean };

const hour = 3_600_000;
const day = 24 * hour;
const step = 15 * 60_000;
const clock = { right: 254, shade: 11 };
const dwell = 20;
const londonDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short",
});
const londonParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
});

// One-bit drawing surface that becomes a packed bitmap graphic.
class Canvas {
  readonly pixels: Buffer;
  private readonly stride: number;
  constructor(readonly width: number, readonly height: number) {
    this.stride = Math.ceil(width / 8);
    this.pixels = Buffer.alloc(this.stride * height);
  }
  set(x: number, y: number): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels[y * this.stride + (x >> 3)] |= 1 << (x & 7);
  }
  column(x: number, from: number, to: number): void {
    for (let y = Math.round(Math.min(from, to)); y <= Math.round(Math.max(from, to)); y++) this.set(x, y);
  }
  graphic(left: number, top: number, shade: number): Graphic[] {
    return packedBitmap(left, top, this.width, this.height, 1, shade, this.pixels);
  }
}

function bitmap(art: string[]): number[] {
  return art.map((line) => [...line].reduce((bits, char, x) => char === "#" ? bits | (1 << x) : bits, 0));
}

const sunIcon = bitmap([
  ".....#.....",
  ".#...#...#.",
  "..#.....#..",
  "....###....",
  "...#####...",
  "##.#####.##",
  "...#####...",
  "....###....",
  "..#.....#..",
  ".#...#...#.",
  ".....#.....",
]);
const dimSun = bitmap([".###.", "#####", "#####", "#####", ".###."]);
const marker = bitmap([".###.", "#####", "#####", "#####", ".###."]);
const upArrow = bitmap(["...#...", "..###..", ".#####.", "#######", "..###..", "..###..", "..###.."]);
const downArrow = [...upArrow].reverse();

function london(time: number): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = Object.fromEntries(londonParts.formatToParts(time).map(({ type, value }) => [type, Number(value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

export function londonMidnight(time: number): number {
  const { year, month, day: date } = london(time);
  const guess = Date.UTC(year, month - 1, date);
  const wall = london(guess);
  const offset = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - guess;
  return guess - offset;
}

const hhmm = (time: number | undefined) => time === undefined || !Number.isFinite(time) ? "--:--" : londonClock.format(time);
const dateLabel = (time: number) => londonDate.format(time).replace(",", "").toUpperCase();

function header(title: string, now: number): Graphic[] {
  const date = dateLabel(now);
  return [[3, 0, 1, 15, title], [128 - Math.floor(textWidth(date) / 2), 0, 1, 9, date], [0, 10, 256, 1, 3]];
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}H ${String(minutes % 60).padStart(2, "0")}M` : `${minutes}M`;
}

function page(id: string, mode: Page["mode"], title: string, now: number, graphics: Graphic[], state: Page["state"] = "live"): Page {
  if (graphics.length > 32) throw new Error(`${id} has too many graphics`);
  return { id, mode, title, updated: londonClock.format(now), state, rows: [], graphics, clock, dwell_seconds: dwell };
}

// Tides ---------------------------------------------------------------------

type TideCache = { version: 1; key: string; fetched: number; series: TidePoint[] };
export type TideStore = { load: () => Promise<unknown>; save: (cache: TideCache) => Promise<void> };
let tideCache: TideCache | undefined;

function isTideCache(value: unknown): value is TideCache {
  const cache = value as TideCache | null;
  return cache?.version === 1 && typeof cache.key === "string" && Number.isFinite(cache.fetched)
    && Array.isArray(cache.series) && cache.series.length >= 96
    && cache.series.every((point) => Number.isFinite(point?.t) && Number.isFinite(point?.h));
}

// Tides are cached in Lambda memory and in S3, so a cold start reuses recent data.
async function tideSeries(place: Place, now: number, store: TideStore): Promise<{ series: TidePoint[]; stale: boolean }> {
  const key = `${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;
  if (tideCache?.key !== key) {
    const stored = await store.load().catch(() => undefined);
    if (isTideCache(stored) && stored.key === key) tideCache = stored;
  }
  if (tideCache?.key === key && now - tideCache.fetched < 6 * hour) return { series: tideCache.series, stale: false };
  try {
    const url = new URL("https://marine-api.open-meteo.com/v1/marine");
    url.search = new URLSearchParams({
      latitude: place.lat.toFixed(4), longitude: place.lon.toFixed(4), minutely_15: "sea_level_height_msl",
      timezone: "GMT", past_days: "1", forecast_days: "3",
    }).toString();
    const response = await fetch(url, { headers: { "User-Agent": "Linespeed Waypoint display" }, signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`Tide HTTP ${response.status}`);
    const data = await response.json() as { minutely_15?: { time?: unknown[]; sea_level_height_msl?: unknown[] } };
    const times = data.minutely_15?.time ?? [];
    const heights = data.minutely_15?.sea_level_height_msl ?? [];
    const series = times.flatMap((time, i) => {
      const t = typeof time === "string" ? Date.parse(`${time}Z`) : NaN;
      const h = heights[i];
      return Number.isFinite(t) && typeof h === "number" && Number.isFinite(h) ? [{ t, h }] : [];
    });
    if (series.length < 96) throw new Error("Unexpected tide response");
    tideCache = { version: 1, key, fetched: now, series };
    await store.save(tideCache).catch(() => console.warn("tides: cache write failed"));
    return { series, stale: false };
  } catch (error) {
    if (tideCache?.key === key && tideCache.series.at(-1)!.t > now + 20 * hour) return { series: tideCache.series, stale: true };
    throw error;
  }
}

function heightAt(series: TidePoint[], time: number): number {
  const position = Math.min(series.length - 1.001, Math.max(0, (time - series[0].t) / step));
  const i = Math.floor(position);
  return series[i].h + (series[i + 1].h - series[i].h) * (position - i);
}

// The model can produce small wobbles near low water, so merge them into one turning point.
export function tideExtremes(series: TidePoint[]): Extreme[] {
  const raw: Extreme[] = [];
  for (let i = 1; i < series.length - 1; i++) {
    const [a, b, c] = [series[i - 1].h, series[i].h, series[i + 1].h];
    const high = b >= a && b > c;
    if (!high && !(b <= a && b < c)) continue;
    const curve = a - 2 * b + c;
    const shift = curve === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (a - c) / (2 * curve)));
    raw.push({ t: series[i].t + shift * step, h: b - (a - c) * shift / 4, high });
  }
  const merged: Extreme[] = [];
  for (const extreme of raw) {
    const last = merged.at(-1);
    if (last && last.high === extreme.high) {
      if (extreme.high ? extreme.h > last.h : extreme.h < last.h) merged[merged.length - 1] = extreme;
    } else if (last && (Math.abs(extreme.h - last.h) < 0.2 || extreme.t - last.t < 3 * hour)) {
      // Ignore a shallow reversal between two turning points of the same kind.
    } else merged.push(extreme);
  }
  return merged;
}

export function tidePage(series: TidePoint[], now: number, stale: boolean, label?: string): Page {
  const left = 100;
  const width = 155;
  const top = 12;
  const floor = 56;
  const start = now - 4 * hour;
  const span = 24 * hour;
  const msPerPx = span / (width - 1);
  const heights = Array.from({ length: width }, (_, x) => heightAt(series, start + x * msPerPx));
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  const [high, low] = [23, 46];
  const yOf = (h: number) => low - (h - min) / Math.max(0.1, max - min) * (low - high);
  const ys = heights.map(yOf);
  const nowX = Math.round((now - start) / msPerPx);

  const canvases = Array.from({ length: 4 }, () => new Canvas(width, floor - top + 1));
  const [pastFill, futureFill, pastLine, futureLine] = canvases;
  ys.forEach((y, x) => {
    const future = x >= nowX;
    const fill = future ? futureFill : pastFill;
    for (let row = Math.round(y) + 1; row <= floor; row++) if (future || (x + row) % 2 === 0) fill.set(x, row - top);
    (future ? futureLine : pastLine).column(x, y - top, (ys[x - 1] ?? y) - top);
  });

  const extremes = tideExtremes(series);
  const visible = extremes.filter(({ t }) => t >= start && t <= start + span);
  const labels: Graphic[] = visible.flatMap(({ t, high: isHigh }) => {
    const x = Math.round((t - start) / msPerPx);
    const text = hhmm(t);
    const textLeft = Math.max(left, Math.min(255 - textWidth(text), left + x - Math.floor(textWidth(text) / 2)));
    const y = isHigh ? Math.max(top, Math.round(ys[x]) - 11) : Math.round(ys[x]) + 3;
    return [[textLeft, y, 1, t < now ? 7 : 14, text]];
  });

  const next = extremes.find(({ t }) => t > now);
  const rising = next?.high ?? true;
  const markerY = Math.round(ys[nowX]) - 2;
  const graphics: Graphic[] = [
    ...header(label ? `TIDES ${label}`.slice(0, 22) : "TIDES", now),
    ...pastFill.graphic(left, top, 1), ...futureFill.graphic(left, top, 3),
    [left + nowX, top + 1, 1, floor - top, 7],
    ...pastLine.graphic(left, top, 6), ...futureLine.graphic(left, top, 13),
    [left + nowX - 2, markerY, 1, 15, marker],
    ...labels,
    [96, 13, 1, 50, 3],
    [3, 14, 1, 13, rising ? upArrow : downArrow], [13, 13, 1, 13, rising ? "RISING" : "FALLING"],
    [3, 26, 1, 8, next ? (next.high ? "NEXT HIGH" : "NEXT LOW") : "NEXT TIDE"],
    [3, 35, 2, 15, hhmm(next?.t)],
  ];
  if (next) graphics.push([3, 54, 1, 9, `IN ${duration(next.t - now)}`]);
  return page("sky-tides", "sky", "TIDES", now, graphics, stale ? "stale" : "live");
}

function tideUnavailable(now: number): Page {
  return page("sky-tides", "sky", "TIDES", now, [...header("TIDES", now), [64, 30, 1, 12, "TIDE DATA UNAVAILABLE"]], "offline");
}

// Sun -----------------------------------------------------------------------

const valid = (date: Date | undefined) => date && Number.isFinite(date.getTime()) ? date.getTime() : undefined;

export function sunPage(place: Place, now: number): Page {
  const midnight = londonMidnight(now);
  const times = SunCalc.getTimes(new Date(midnight + 12 * hour), place.lat, place.lon);
  const [rise, set, dusk] = [valid(times.sunrise), valid(times.sunset), valid(times.dusk)];
  const daylight = rise && set ? set - rise : undefined;

  const left = 4;
  const width = 146;
  const top = 12;
  const horizon = 42;
  const noon = valid(times.solarNoon) ?? midnight + 12 * hour;
  const altitude = (time: number) => SunCalc.getPosition(new Date(time), place.lat, place.lon).altitude * 180 / Math.PI;
  // Scale each day so its arc fills the panel; night dips are compressed so they stay above the hour labels.
  const peak = Math.max(12, altitude(noon));
  const yOf = (degrees: number) => degrees >= 0
    ? Math.max(top + 4, horizon - degrees * (horizon - top - 6) / peak)
    : Math.min(52, horizon - degrees * 0.2);
  const timeAt = (x: number) => midnight + x / (width - 1) * day;
  const ys = Array.from({ length: width }, (_, x) => yOf(altitude(timeAt(x))));
  const fill = new Canvas(width, horizon - top);
  const arc = new Canvas(width, horizon - top);
  const night = new Canvas(width, 64 - horizon);
  ys.forEach((y, x) => {
    const previousY = ys[x - 1] ?? y;
    if (y < horizon) {
      for (let row = Math.round(y) + 1; row < horizon; row++) if ((row + x) % 2 === 0 || row < y + 3) fill.set(x, row - top);
      arc.column(x, y - top, Math.min(previousY, horizon - 1) - top);
    } else if (x % 3 === 0) night.set(x, y - horizon - 1);
  });

  const xOf = (time: number) => left + Math.round((time - midnight) / day * (width - 1));
  const sunAltitude = altitude(now);
  const sunY = Math.round(yOf(sunAltitude));
  const ticks: Graphic[] = [6, 12, 18].flatMap((h) => {
    const x = left + Math.round(h / 24 * (width - 1));
    const text = String(h).padStart(2, "0");
    return [[x, horizon + 1, 1, 2, 4], [x - Math.floor(textWidth(text) / 2), 54, 1, 5, text]];
  });
  const edges: Graphic[] = [rise, set].flatMap((time): Graphic[] => time === undefined ? [] : [[xOf(time), horizon - 2, 1, 5, 12]]);
  const rows: [string, string][] = [
    ["SUNRISE", hhmm(rise)], ["SUNSET", hhmm(set)], ["NOON", hhmm(noon)], ["DAYLIGHT", daylight ? duration(daylight) : "--"],
    ["DUSK", hhmm(dusk)],
  ];
  const graphics: Graphic[] = [
    ...header("SUN", now),
    ...fill.graphic(left, top, 2), [left, horizon, width, 1, 7], ...night.graphic(left, horizon + 1, 3),
    ...arc.graphic(left, top, 13), ...edges, ...ticks,
    sunAltitude > -0.833
      ? [xOf(now) - 5, sunY - 5, 1, 15, sunIcon]
      : [xOf(now) - 2, sunY - 2, 1, 7, dimSun],
    [154, 13, 1, 50, 3],
    ...rows.flatMap(([name, value], i): Graphic[] => [[158, 13 + i * 10, 1, 8, name], [254 - textWidth(value), 13 + i * 10, 1, 15, value]]),
  ];
  return page("sky-sun", "sky", "SUN", now, graphics);
}

// Moon ----------------------------------------------------------------------

export function phaseName(phase: number): string {
  if (phase < 0.03 || phase > 0.97) return "NEW MOON";
  if (phase < 0.22) return "WAXING CRESCENT";
  if (phase < 0.28) return "FIRST QUARTER";
  if (phase < 0.47) return "WAXING GIBBOUS";
  if (phase < 0.53) return "FULL MOON";
  if (phase < 0.72) return "WANING GIBBOUS";
  if (phase < 0.78) return "LAST QUARTER";
  return "WANING CRESCENT";
}

// Meeus, Astronomical Algorithms ch. 49: new and full moon times to within a few minutes.
function lunarPhase(k: number): number {
  const deg = Math.PI / 180;
  const T = k / 1236.85;
  const jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T ** 2 - 0.00000015 * T ** 3 + 0.00000000073 * T ** 4;
  const E = 1 - 0.002516 * T - 0.0000074 * T ** 2;
  const M = (2.5534 + 29.1053567 * k - 0.0000014 * T ** 2 - 0.00000011 * T ** 3) * deg;
  const Mp = (201.5643 + 385.81693528 * k + 0.0107582 * T ** 2 + 0.00001238 * T ** 3 - 0.000000058 * T ** 4) * deg;
  const F = (160.7108 + 390.67050284 * k - 0.0016118 * T ** 2 - 0.00000227 * T ** 3 + 0.000000011 * T ** 4) * deg;
  const omega = (124.7746 - 1.56375588 * k + 0.0020672 * T ** 2 + 0.00000215 * T ** 3) * deg;
  const full = k % 1 !== 0;
  const correction = (full ? -0.40614 : -0.4072) * Math.sin(Mp) + (full ? 0.17302 : 0.17241) * E * Math.sin(M)
    + (full ? 0.01614 : 0.01608) * Math.sin(2 * Mp) + (full ? 0.01043 : 0.01039) * Math.sin(2 * F)
    + (full ? 0.00734 : 0.00739) * E * Math.sin(Mp - M) - (full ? 0.00515 : 0.00514) * E * Math.sin(Mp + M)
    + (full ? 0.00209 : 0.00208) * E * E * Math.sin(2 * M) - 0.00111 * Math.sin(Mp - 2 * F) - 0.00057 * Math.sin(Mp + 2 * F)
    + 0.00056 * E * Math.sin(2 * Mp + M) - 0.00042 * Math.sin(3 * Mp) + 0.00042 * E * Math.sin(M + 2 * F)
    + 0.00038 * E * Math.sin(M - 2 * F) - 0.00024 * E * Math.sin(2 * Mp - M) - 0.00017 * Math.sin(omega);
  return (jde + correction - 2440587.5) * day;
}

export function nextPhases(now: number): { full: number; fullK: number; new: number } {
  const years = (now - Date.UTC(2000, 0, 6)) / (365.25 * day);
  let k = Math.floor(years * 12.3685) - 1;
  while (lunarPhase(k) <= now) k++;
  const fullK = lunarPhase(k - 0.5) > now ? k - 0.5 : k + 0.5;
  return { new: lunarPhase(k), full: lunarPhase(fullK), fullK };
}

const monthNames = ["WOLF", "SNOW", "WORM", "PINK", "FLOWER", "STRAWBERRY", "BUCK", "STURGEON", "CORN", "HUNTER'S", "BEAVER", "COLD"];
const londonMonth = (time: number) => london(time).month - 1;

// The Harvest Moon is the full moon nearest the September equinox and the Hunter's Moon follows it.
function isHarvest(k: number): boolean {
  const time = lunarPhase(k);
  const equinox = Date.UTC(new Date(time).getUTCFullYear(), 8, 22, 12);
  const gap = (other: number) => Math.abs(lunarPhase(other) - equinox);
  return gap(k) < gap(k - 1) && gap(k) < gap(k + 1);
}

export function fullMoonName(k: number): string {
  const time = lunarPhase(k);
  if (isHarvest(k)) return "HARVEST MOON";
  if (isHarvest(k - 1)) return "HUNTER'S MOON";
  if (londonMonth(lunarPhase(k - 1)) === londonMonth(time)) return "BLUE MOON";
  return `${monthNames[londonMonth(time)]} MOON`;
}

function nextMoonEvents(place: Place, now: number): { rise?: number; set?: number } {
  const events = [0, 1, 2].map((offset) => SunCalc.getMoonTimes(new Date(londonMidnight(now) + offset * day + 12 * hour), place.lat, place.lon));
  const after = (key: "rise" | "set") => events.map((event) => valid(event[key])).filter((time): time is number => time !== undefined && time > now)
    .sort((a, b) => a - b)[0];
  return { rise: after("rise"), set: after("set") };
}

function dayLabel(time: number, now: number): string {
  if (!Number.isFinite(time)) return "--";
  const days = Math.round((londonMidnight(time) - londonMidnight(now)) / day);
  if (days === 0) return "TODAY";
  if (days === 1) return "TMRW";
  return londonDate.format(time).replace(",", "").toUpperCase().split(" ").slice(1).join(" ");
}

const maria: [number, number, number][] = [
  [-0.32, -0.3, 0.2], [0.2, -0.38, 0.16], [0.28, 0.12, 0.22], [-0.12, 0.38, 0.14], [-0.5, 0.18, 0.13], [0.52, -0.05, 0.09],
];

function starfield(): Graphic[] {
  const dim = new Canvas(60, 52);
  const bright = new Canvas(60, 52);
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(random() * 60);
    const y = Math.floor(random() * 52);
    if ((x - 28) ** 2 + (y - 23) ** 2 < 26 ** 2) continue;
    (i % 4 === 0 ? bright : dim).set(x, y);
  }
  return [...dim.graphic(0, 12, 5), ...bright.graphic(0, 12, 11)];
}

export function moonPage(place: Place, now: number): Page {
  const { fraction, phase } = SunCalc.getMoonIllumination(new Date(now));
  const size = 41;
  const radius = (size - 1) / 2;
  const [dark, rim, lit, seas] = Array.from({ length: 4 }, () => new Canvas(size, size));
  const southern = place.lat < 0;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px - radius) / radius * (southern ? -1 : 1);
      const y = (py - radius) / radius;
      const distance = x * x + y * y;
      if (distance > 1.02) continue;
      dark.set(px, py);
      if (distance > 0.86) rim.set(px, py);
      const edge = Math.sqrt(Math.max(0, 1 - y * y));
      const terminator = edge * Math.cos(2 * Math.PI * phase);
      const isLit = phase < 0.5 ? x > terminator : x < -terminator;
      if (!isLit) continue;
      lit.set(px, py);
      if (maria.some(([mx, my, mr]) => (x - mx) ** 2 + (y - my) ** 2 < mr * mr)) seas.set(px, py);
    }
  }
  const phases = nextPhases(now);
  const { rise, set } = nextMoonEvents(place, now);
  const name = phaseName(phase);
  const percent = `${Math.round(fraction * 100)}%`;
  // Name the full moon in the title area for a day either side of it.
  const nearestFull = Math.abs(lunarPhase(phases.fullK - 1) - now) < Math.abs(phases.full - now) ? phases.fullK - 1 : phases.fullK;
  const fullNow = Math.abs(lunarPhase(nearestFull) - now) < 1.5 * day;
  const columns: [string, string][] = [
    ["FULL", dayLabel(fullNow ? lunarPhase(nearestFull) : phases.full, now)], ["NEW", dayLabel(phases.new, now)], ["RISE", hhmm(rise)], ["SET", hhmm(set)],
  ];
  const graphics: Graphic[] = [
    ...header("MOON", now),
    ...starfield(),
    ...dark.graphic(8, 15, 2), ...rim.graphic(8, 15, 4), ...lit.graphic(8, 15, 14), ...seas.graphic(8, 15, 10),
    [66, 14, 1, 15, name],
    [254 - textWidth(percent), 14, 1, 10, percent],
    fullNow ? [66, 24, 1, 14, fullMoonName(nearestFull)] : [66, 24, 1, 9, `NEXT FULL: ${fullMoonName(phases.fullK)}`],
    [66, 35, 189, 1, 3],
    ...columns.flatMap(([label, value], i): Graphic[] => [[66 + i * 48, 39, 1, 8, label], [66 + i * 48, 50, 1, 15, value]]),
  ];
  return page("sky-moon", "sky", "MOON", now, graphics);
}

export async function skyPages(place: Place, tidePlace: Place, nowDate: Date, store: TideStore): Promise<Page[]> {
  const now = nowDate.getTime();
  const tides = await tideSeries(tidePlace, now, store)
    .then(({ series, stale }) => {
      if (series[0].t > now - 4 * hour || series.at(-1)!.t < now + 20 * hour) throw new Error("Tide data does not cover the chart");
      return tidePage(series, now, stale, tidePlace.label);
    })
    .catch((error: unknown) => {
      console.warn("tides: %s", error instanceof Error ? error.message : "fetch error");
      return tideUnavailable(now);
    });
  return [tides, sunPage(place, now), moonPage(place, now)];
}
