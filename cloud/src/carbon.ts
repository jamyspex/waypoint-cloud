import { londonClock, type Graphic, type Page } from "./board.js";
import { textWidth } from "./font.js";
import { bitmap, Canvas, header, page } from "./sky.js";

type Slot = { from: number; intensity: number };
type Mix = { fuel: string; perc: number }[];
type Grid = { national: Slot[]; nationalIndex: string; region: { intensity: number; index: string; mix: Mix } };

const api = "https://api.carbonintensity.org.uk";
let cache: { fetched: number; grid: Grid } | undefined;

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${api}${path}`, {
    headers: { Accept: "application/json", "User-Agent": "Linespeed Waypoint display" }, signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Carbon HTTP ${response.status}`);
  return await response.json() as T;
}

type Period = { from?: string; intensity?: { forecast?: number; index?: string }; generationmix?: { fuel?: string; perc?: number }[] };

async function fetchGrid(now: number): Promise<{ grid: Grid; stale: boolean }> {
  // Intensity is published per half hour, so refreshing twice an hour keeps the chart current.
  if (cache && now - cache.fetched < 15 * 60_000) return { grid: cache.grid, stale: false };
  try {
    const from = new Date(now).toISOString().slice(0, 16) + "Z";
    const [forecast, regional] = await Promise.all([
      get<{ data?: Period[] }>(`/intensity/${from}/fw24h`),
      get<{ data?: { data?: Period[] }[] }>("/regional/regionid/1"),
    ]);
    const national = (forecast.data ?? []).flatMap(({ from: start, intensity }) => {
      const t = Date.parse(start ?? "");
      return Number.isFinite(t) && typeof intensity?.forecast === "number" ? [{ from: t, intensity: intensity.forecast }] : [];
    });
    const current = regional.data?.[0]?.data?.[0];
    if (national.length < 24 || typeof current?.intensity?.forecast !== "number") throw new Error("Unexpected carbon response");
    const mix = (current.generationmix ?? []).flatMap(({ fuel, perc }) =>
      typeof fuel === "string" && typeof perc === "number" && perc > 0 ? [{ fuel, perc }] : []).sort((a, b) => b.perc - a.perc);
    const grid: Grid = {
      national, nationalIndex: forecast.data?.[0]?.intensity?.index ?? "",
      region: { intensity: current.intensity.forecast, index: current.intensity.index ?? "", mix },
    };
    cache = { fetched: now, grid };
    return { grid, stale: false };
  } catch (error) {
    if (cache && now - cache.fetched < 2 * 3_600_000) return { grid: cache.grid, stale: true };
    throw error;
  }
}

// Visuals ----------------------------------------------------------------------

const fuels: Record<string, { label: string; shade: number; icon: string[] }> = {
  wind: { label: "WIND", shade: 14, icon: [
    "....#....", "....#....", "....#....", "...###...", "..#.#.#..", ".#..#..#.", "#...#...#", "....#....", "...###..."] },
  hydro: { label: "HYDRO", shade: 11, icon: [
    "....#....", "...###...", "..#####..", ".#######.", ".#######.", "#########", ".#######.", "..#####..", "...###..."] },
  nuclear: { label: "NUCLEAR", shade: 9, icon: [
    "..#####..", ".#.....#.", "#..###..#", "#.#...#.#", "#.#.#.#.#", "#.#...#.#", "#..###..#", ".#.....#.", "..#####.."] },
  gas: { label: "GAS", shade: 6, icon: [
    "....#....", "...##....", "...###...", "..####...", "..#####..", ".###.##..", ".##..###.", ".##...##.", "..#####.."] },
  solar: { label: "SOLAR", shade: 13, icon: [
    "#...#...#", ".#..#..#.", "...###...", "..#####..", "#########", "..#####..", "...###...", ".#..#..#.", "#...#...#"] },
  imports: { label: "IMPORTS", shade: 7, icon: [
    ".........", "....#....", ".....#...", "......#..", "#########", "......#..", ".....#...", "....#....", "........."] },
  biomass: { label: "BIOMASS", shade: 8, icon: [
    "......###", "....#####", "...######", "..######.", ".######..", ".#####...", ".####....", "#.##.....", "#........"] },
  coal: { label: "COAL", shade: 4, icon: [
    "...###...", ".#######.", "#########", "#########", "#########", ".#######.", "..#####..", ".........", "........."] },
  other: { label: "OTHER", shade: 5, icon: [
    ".........", ".........", "...###...", "..#####..", "..#####..", "..#####..", "...###...", ".........", "........."] },
};
const fuel = (name: string) => fuels[name] ?? fuels.other;

export function mixPage(grid: Grid, now: number, stale: boolean): Page {
  const { region } = grid;
  const graphics: Graphic[] = [...header("N SCOTLAND MIX", now)];

  // Ring chart: each fuel is a slice of a donut, starting at twelve o'clock.
  const [cx, cy, outer, inner] = [26, 37, 23.5, 14];
  const total = region.mix.reduce((sum, { perc }) => sum + perc, 0) || 1;
  const slices: { canvas: Canvas; shade: number; start: number; end: number }[] = [];
  let start = 0;
  for (const { fuel: name, perc } of region.mix) {
    const end = start + perc / total;
    slices.push({ canvas: new Canvas(48, 48), shade: fuel(name).shade, start, end });
    start = end;
  }
  const gaps = new Canvas(48, 48);
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      const [dx, dy] = [x - 23.5, y - 23.5];
      const distance = Math.hypot(dx, dy);
      if (distance > outer || distance < inner) continue;
      const turn = ((Math.atan2(dx, -dy) / (2 * Math.PI)) + 1) % 1;
      const slice = slices.find(({ start: from, end }) => turn >= from && turn < end) ?? slices.at(-1);
      // A thin dark seam between slices keeps neighbouring shades distinct.
      const seam = slices.length > 1 && slices.some(({ start: from }) => Math.abs(turn - from) * 2 * Math.PI * distance < 0.8);
      (seam ? gaps : slice?.canvas)?.set(x, y);
    }
  }
  for (const { canvas, shade } of slices) graphics.push(...canvas.graphic(cx - 24, cy - 24, shade));
  const value = String(Math.round(region.intensity));
  graphics.push([cx - Math.floor(textWidth(value) / 2), cy - 8, 1, 15, value], [cx - Math.floor(textWidth("G") / 2), cy + 1, 1, 7, "G"]);

  // Legend: icon, name, share bar and percentage for the main sources.
  const rows = region.mix.filter(({ perc }) => perc >= 0.5).slice(0, 4);
  rows.forEach(({ fuel: name, perc }, i) => {
    const { label, shade, icon } = fuel(name);
    const y = 14 + i * 12 + (4 - rows.length) * 6;
    const percent = `${Math.round(perc)}%`;
    const barLeft = 128;
    const barWidth = Math.max(1, Math.round(perc / 100 * (226 - barLeft)));
    graphics.push(
      [60, y, 1, shade, bitmap(icon)], [73, y, 1, 12, label],
      [barLeft, y + 2, 226 - barLeft, 5, 2], [barLeft, y + 2, barWidth, 5, shade],
      [254 - textWidth(percent), y, 1, 15, percent],
    );
  });
  if (!rows.length) graphics.push([60, 30, 1, 10, "NO GENERATION DATA"]);
  return page("grid-mix", "energy", "N SCOTLAND MIX", now, graphics, stale ? "stale" : "live");
}

const indexShade: Record<string, number> = { "very low": 15, low: 13, moderate: 10, high: 7, "very high": 5 };

export function carbonPage(grid: Grid, now: number, stale: boolean): Page {
  const slots = grid.national.filter(({ from }) => from > now - 30 * 60_000).slice(0, 48);
  const graphics: Graphic[] = [...header("GRID CARBON", now)];
  const current = slots[0];
  const value = String(Math.round(current.intensity));
  graphics.push(
    [3, 13, 1, 8, "GB NOW"],
    [3, 23, 2, 15, value], [5 + textWidth(value) * 2, 30, 1, 8, "G/KWH"],
    [3, 43, 1, indexShade[grid.nationalIndex] ?? 11, grid.nationalIndex.toUpperCase() || "--"],
  );

  // The greenest two hours (four half-hour slots) in the forecast.
  let best = 0;
  for (let i = 1; i + 4 <= slots.length; i++) {
    const sum = (from: number) => slots.slice(from, from + 4).reduce((total, slot) => total + slot.intensity, 0);
    if (sum(i) < sum(best)) best = i;
  }
  const bestEnd = slots[Math.min(slots.length - 1, best + 3)].from + 30 * 60_000;
  graphics.push([3, 54, 1, 12, `BEST ${londonClock.format(slots[best].from)}-${londonClock.format(bestEnd)}`], [98, 13, 1, 50, 3]);

  // Forecast bars: two pixels per half hour, with the best window highlighted.
  const left = 103;
  const top = 13;
  const bottom = 50;
  const peak = Math.max(100, ...slots.map(({ intensity }) => intensity)) * 1.05;
  const normal = new Canvas(150, bottom - top + 1);
  const highlight = new Canvas(150, bottom - top + 1);
  const present = new Canvas(150, bottom - top + 1);
  slots.forEach(({ intensity }, i) => {
    const height = Math.max(1, Math.round(intensity / peak * (bottom - top)));
    const target = i === 0 ? present : i >= best && i < best + 4 ? highlight : normal;
    target.column(i * 3, bottom - top - height + 1, bottom - top);
    target.column(i * 3 + 1, bottom - top - height + 1, bottom - top);
  });
  graphics.push(...normal.graphic(left, top, 5), ...highlight.graphic(left, top, 14), ...present.graphic(left, top, 10));
  for (let i = 0; i < slots.length; i += 12) {
    const label = londonClock.format(slots[i].from).slice(0, 2);
    graphics.push([left + i * 3, 54, 1, 6, label]);
  }
  return page("grid-carbon", "energy", "GRID CARBON", now, graphics, stale ? "stale" : "live");
}

export async function gridScreens(nowDate: Date): Promise<Page[]> {
  const now = nowDate.getTime();
  try {
    const { grid, stale } = await fetchGrid(now);
    return [carbonPage(grid, now, stale), mixPage(grid, now, stale)];
  } catch (error) {
    console.warn("grid: %s", error instanceof Error ? error.message : "fetch error");
    return [];
  }
}
