import { londonClock, type Graphic, type Page } from "./board.js";
import { textWidth } from "./font.js";
import { Canvas, header, page, type Place } from "./sky.js";

type Forecast = {
  current: { temperature: number; feels: number; code: number; wind: number; gusts: number; direction: number; day: boolean };
  hours: { t: number; temperature: number; chance: number; rain: number }[];
};
type Icon = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "showers" | "snow" | "thunder";

const hour = 3_600_000;
let cache: { key: string; fetched: number; forecast: Forecast } | undefined;

function describe(code: number): { icon: Icon; text: string } {
  if (code === 0) return { icon: "clear", text: "CLEAR" };
  if (code === 1) return { icon: "partly", text: "MAINLY CLEAR" };
  if (code === 2) return { icon: "partly", text: "PARTLY CLOUDY" };
  if (code === 3) return { icon: "cloudy", text: "OVERCAST" };
  if (code === 45 || code === 48) return { icon: "fog", text: "FOG" };
  if (code >= 51 && code <= 57) return { icon: "drizzle", text: "DRIZZLE" };
  if (code === 65 || code === 67) return { icon: "rain", text: "HEAVY RAIN" };
  if (code >= 61 && code <= 67) return { icon: "rain", text: "RAIN" };
  if (code >= 71 && code <= 77) return { icon: "snow", text: "SNOW" };
  if (code >= 80 && code <= 82) return { icon: "showers", text: "SHOWERS" };
  if (code === 85 || code === 86) return { icon: "snow", text: "SNOW SHOWERS" };
  if (code >= 95) return { icon: "thunder", text: "THUNDER" };
  return { icon: "cloudy", text: "CLOUDY" };
}

const compass = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const temperature = (value: number) => `${Math.round(value) === 0 ? 0 : Math.round(value)}C`;

async function fetchForecast(place: Place, now: number): Promise<{ forecast: Forecast; stale: boolean }> {
  const key = `${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;
  if (cache?.key === key && now - cache.fetched < 15 * 60_000) return { forecast: cache.forecast, stale: false };
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: place.lat.toFixed(4), longitude: place.lon.toFixed(4), timezone: "GMT", wind_speed_unit: "mph", forecast_hours: "13",
      current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day",
      hourly: "temperature_2m,precipitation_probability,precipitation",
    }).toString();
    const response = await fetch(url, { headers: { "User-Agent": "Linespeed Waypoint display" }, signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
    const data = await response.json() as {
      current?: Record<string, number>;
      hourly?: { time?: string[]; temperature_2m?: number[]; precipitation_probability?: (number | null)[]; precipitation?: (number | null)[] };
    };
    const c = data.current ?? {};
    const numbers = [c.temperature_2m, c.apparent_temperature, c.weather_code, c.wind_speed_10m, c.wind_gusts_10m, c.wind_direction_10m];
    if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value))) throw new Error("Unexpected weather response");
    const hours = (data.hourly?.time ?? []).flatMap((time, i) => {
      const t = Date.parse(`${time}Z`);
      const value = data.hourly?.temperature_2m?.[i];
      return Number.isFinite(t) && typeof value === "number"
        ? [{ t, temperature: value, chance: data.hourly?.precipitation_probability?.[i] ?? 0, rain: data.hourly?.precipitation?.[i] ?? 0 }]
        : [];
    });
    if (hours.length < 6) throw new Error("Unexpected weather response");
    const forecast: Forecast = {
      current: {
        temperature: c.temperature_2m, feels: c.apparent_temperature, code: c.weather_code, wind: c.wind_speed_10m,
        gusts: c.wind_gusts_10m, direction: c.wind_direction_10m, day: c.is_day === 1,
      },
      hours,
    };
    cache = { key, fetched: now, forecast };
    return { forecast, stale: false };
  } catch (error) {
    if (cache?.key === key && now - cache.fetched < 3 * hour) return { forecast: cache.forecast, stale: true };
    throw error;
  }
}

// Icons ----------------------------------------------------------------------

const size = 32;

function shape(test: (x: number, y: number) => boolean): Canvas {
  const canvas = new Canvas(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (test(x, y)) canvas.set(x, y);
  return canvas;
}

const disc = (cx: number, cy: number, r: number) => (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function cloudTest(dx: number, dy: number) {
  const parts = [disc(dx + 10, dy + 14, 6), disc(dx + 17, dy + 10, 7.5), disc(dx + 24, dy + 15, 5)];
  return (x: number, y: number) => parts.some((part) => part(x, y)) || (x >= dx + 6 && x <= dx + 27 && y >= dy + 14 && y <= dy + 20);
}

// A cloud drawn as a filled body with a brighter rim so it reads against a sun or another cloud.
function cloud(dx: number, dy: number, body: number, rim: number): [Canvas, number][] {
  const inside = cloudTest(dx, dy);
  const fill = shape(inside);
  const edge = shape((x, y) => inside(x, y) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oy]) => !inside(x + ox, y + oy)));
  return [[fill, body], [edge, rim]];
}

function sun(cx: number, cy: number, r: number): Canvas {
  const core = disc(cx, cy, r);
  return shape((x, y) => {
    if (core(x, y)) return true;
    const distance = Math.hypot(x - cx, y - cy);
    const angle = (Math.atan2(y - cy, x - cx) / (Math.PI / 4) + 8) % 1;
    return distance >= r + 3 && distance <= r + 6 && (angle < 0.14 || angle > 0.86);
  });
}

function moon(cx: number, cy: number, r: number): Canvas {
  const outer = disc(cx, cy, r);
  const bite = disc(cx + r * 0.55, cy - r * 0.35, r * 0.85);
  return shape((x, y) => outer(x, y) && !bite(x, y));
}

function drops(kind: "drizzle" | "rain" | "snow"): Canvas {
  return shape((x, y) => {
    if (y < 23) return false;
    if (kind === "snow") return [[9, 25], [17, 28], [25, 25], [13, 30], [21, 31]].some(([cx, cy]) => Math.abs(x - cx) + Math.abs(y - cy) <= 1);
    const columns = kind === "drizzle" ? [10, 18, 26] : [8, 13, 18, 23, 28];
    return columns.some((cx, i) => {
      const start = 24 + (i % 2) * 2;
      const length = kind === "drizzle" ? 1 : 4;
      return y >= start && y <= start + length && x === cx - Math.floor((y - start) / 2);
    });
  });
}

function icon(kind: Icon, day: boolean, left: number, top: number): Graphic[] {
  const layers: [Canvas, number][] = [];
  const light = (cx: number, cy: number, r: number): [Canvas, number] => day ? [sun(cx, cy, r), 15] : [moon(cx, cy, r + 2), 13];
  if (kind === "clear") layers.push(light(15, 15, 7));
  else if (kind === "partly" || kind === "showers") layers.push(light(11, 10, 5), ...cloud(2, 8, 10, 14));
  else if (kind === "cloudy") layers.push(...cloud(6, 0, 5, 8), ...cloud(-1, 7, 11, 14));
  else if (kind === "fog") {
    layers.push(...cloud(1, -2, 8, 11));
    layers.push([shape((x, y) => [22, 25, 28].includes(y) && x >= 3 + (y % 2) * 3 && x <= 28 - (y % 2) * 4 && (x + y) % 9 !== 0), 9]);
  } else if (kind === "thunder") {
    layers.push(...cloud(1, 0, 6, 9));
    layers.push([shape((x, y) => (y >= 18 && y <= 24 && x === 19 - Math.floor((y - 18) / 1.5)) || (y === 24 && x >= 15 && x <= 19)
      || (y >= 24 && y <= 31 && x === 19 - Math.floor((y - 24) / 1.6))), 15]);
  } else layers.push(...cloud(1, 0, 10, 14));
  if (kind === "drizzle" || kind === "rain" || kind === "showers") layers.push([drops(kind === "drizzle" ? "drizzle" : "rain"), 11]);
  if (kind === "snow") layers.push([drops("snow"), 15]);
  return layers.flatMap(([canvas, shade]) => canvas.graphic(left, top, shade));
}

// Page -----------------------------------------------------------------------

export function weatherPage(forecast: Forecast, now: number, stale: boolean): Page {
  const { current, hours } = forecast;
  const { icon: kind, text } = describe(current.code);
  const graphics: Graphic[] = [...header("WEATHER", now), ...icon(kind, current.day, 3, 13)];
  const temp = temperature(current.temperature);
  graphics.push(
    [40, 15, 2, 15, temp],
    [40, 34, 1, 9, `FEELS ${temperature(current.feels)}`],
    [3, 46, 1, 13, text],
    [3, 55, 1, 9, `${compass[Math.round(current.direction / 45) % 8]} ${Math.round(current.wind)} MPH G${Math.round(current.gusts)}`],
    [98, 13, 1, 50, 3],
  );

  // Rain chance as bars and temperature as a line for the next 12 hours.
  const left = 102;
  const width = 152;
  const top = 22;
  const bottom = 52;
  const upcoming = hours.filter(({ t }) => t >= now - hour).slice(0, 13);
  const span = Math.max(1, upcoming.length - 1);
  const xOf = (i: number) => Math.round(i / span * (width - 8));
  const bars = new Canvas(width, bottom - top + 1);
  const wet = new Canvas(width, bottom - top + 1);
  upcoming.forEach(({ chance, rain }, i) => {
    const height = Math.round(Math.min(100, chance) / 100 * (bottom - top - 2));
    for (let x = xOf(i); x < xOf(i) + 7; x++) for (let y = bottom - top - height + 1; y <= bottom - top; y++) (rain >= 0.5 ? wet : bars).set(x, y);
  });
  const temperatures = upcoming.map(({ temperature: value }) => value);
  const low = Math.min(...temperatures);
  const high = Math.max(...temperatures);
  const mid = (low + high) / 2;
  const range = Math.max(4, high - low);
  const yOf = (value: number) => Math.round(top + 6 + (1 - ((value - mid) / range + 0.5)) * (bottom - top - 14));
  const line = new Canvas(width, bottom - top + 1);
  const valueAt = (x: number) => {
    const position = x / xOf(span) * span;
    const i = Math.min(span - 1, Math.floor(position));
    return temperatures[i] + (temperatures[i + 1] - temperatures[i]) * (position - i);
  };
  for (let x = 0; x <= xOf(span); x++) line.column(x + 3, yOf(valueAt(x)) - top, yOf(valueAt(Math.max(0, x - 1))) - top);
  graphics.push(...bars.graphic(left, top, 3), ...wet.graphic(left, top, 6), ...line.graphic(left, top, 13));

  const wettest = upcoming.reduce((best, hourly) => hourly.chance > best.chance ? hourly : best, upcoming[0]);
  const summary = wettest.chance >= 30 ? `RAIN ${Math.round(wettest.chance)}% AT ${londonClock.format(wettest.t)}` : "DRY NEXT 12 HOURS";
  graphics.push([left, 12, 1, 11, summary]);
  const extremes = `${temperature(high)}/${temperature(low)}`;
  graphics.push([254 - textWidth(extremes), 12, 1, 8, extremes]);
  for (let i = 0; i <= span; i += 3) {
    const label = londonClock.format(upcoming[i].t).slice(0, 2);
    graphics.push([Math.max(left, left + xOf(i) + 3 - Math.floor(textWidth(label) / 2)), 55, 1, 6, label]);
  }
  return page("sky-weather", "sky", "WEATHER", now, graphics, stale ? "stale" : "live");
}

export async function weatherScreen(place: Place, nowDate: Date): Promise<Page | undefined> {
  const now = nowDate.getTime();
  try {
    const { forecast, stale } = await fetchForecast(place, now);
    return weatherPage(forecast, now, stale);
  } catch (error) {
    console.warn("weather: %s", error instanceof Error ? error.message : "fetch error");
    return undefined;
  }
}
