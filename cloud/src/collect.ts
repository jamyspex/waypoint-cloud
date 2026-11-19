import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { displayText, isBoard, londonClock, row, type Board, type Graphic, type GraphicAnimation, type Marquee, type Mode, type Page, type Row } from "./board.js";
import { airRows, busRows, fetchOrbits, railRows, spaceRows, type Orbit, type Settings } from "./feeds.js";

import { energyDay, energyScreens, fetchDemand, fetchEnergyPages, withDemand } from "./octopus.js";
import { fitGraphics, withGraphics } from "./graphics.js";
import { passAnimation, predictPasses } from "./passes.js";

const s3 = new S3Client({});
const ssm = new SSMClient({});
const boardKey = "feeds/waypoint.json";
const orbitKey = "feeds/orbits.json";
const energyKey = "feeds/energy.json";
const bucket = process.env.SCENES_BUCKET;
const settingsParameter = process.env.FEED_SETTINGS;
const railParameter = process.env.RAIL_API_KEY;
const octopusParameter = process.env.OCTOPUS_API_KEY;

async function read(key: string): Promise<unknown> {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await object.Body?.transformToString();
  return body ? JSON.parse(body) : null;
}

async function write(key: string, data: unknown) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, ContentType: "application/json", Body: JSON.stringify(data),
  }));
}

type OrbitCache = { version: 2; fetchedAt: number; mask: number; orbits: Orbit[] };

async function getOrbits(settings: Settings["space"], now: Date): Promise<OrbitCache & { stale: boolean }> {
  const cached = await read(orbitKey).catch(() => null) as OrbitCache | null;
  const sameCatalog = cached?.mask === settings.mask && Array.isArray(cached.orbits);
  if (sameCatalog && cached.version === 2 && now.getTime() - cached.fetchedAt < settings.cacheHours * 3600_000) {
    return { ...cached, stale: false };
  }
  try {
    const fresh: OrbitCache = { version: 2, fetchedAt: now.getTime(), mask: settings.mask, orbits: await fetchOrbits(settings.mask) };
    await write(orbitKey, fresh);
    return { ...fresh, stale: false };
  } catch (error) {
    if (sameCatalog && now.getTime() - cached.fetchedAt < 48 * 3600_000) {
      return { ...cached, stale: true };
    }
    throw error;
  }
}

let forecast: { key: string; expiresAt: number; animation?: GraphicAnimation } | undefined;

function spaceAnimation(catalogue: OrbitCache, settings: Settings["space"], now: Date): GraphicAnimation | undefined {
  const key = [catalogue.fetchedAt, settings.lat, settings.lon, settings.alt].join(":");
  if (forecast?.key === key && now.getTime() < forecast.expiresAt) return forecast.animation;
  const passes = predictPasses(catalogue.orbits, settings, now);
  forecast = {
    key, expiresAt: Math.min(now.getTime() + 10 * 60_000, passes[0]?.rise ?? Infinity),
    animation: passAnimation(passes),
  };
  return forecast.animation;
}

type EnergyCache = { version: 3; day: number; expiresAt: number; pages: Page[] };

async function getEnergy(key: string, now: Date): Promise<Page[]> {
  const demand = fetchDemand(key, now);
  const pages = await getEnergyTotals(key, now);
  const latest = await demand;
  return pages.map((page) => withDemand(page, latest));
}

async function getEnergyTotals(key: string, now: Date): Promise<Page[]> {
  const cached = await read(energyKey).catch(() => null) as EnergyCache | null;
  const day = energyDay(now);
  const sameDay = cached?.version === 3 && cached.day === day;
  if (sameDay && cached.expiresAt > now.getTime()) return cached.pages;
  try {
    const data = await fetchEnergyPages(key, now);
    await write(energyKey, { version: 3, day, ...data });
    return data.pages;
  } catch (error) {
    const reason = error instanceof Error && /^Octopus HTTP [0-9]{3}$/.test(error.message) ? error.message : "fetch error";
    console.warn(`energy: ${reason}`);
    if (sameDay) {
      return cached.pages.map((page) => ({ ...page, state: "stale" }));
    }
    return energyScreens.map(([id, title]) => ({
      id, title, mode: "energy", updated: londonClock.format(now), state: "offline",
      rows: [row("", "FEED UNAVAILABLE", "")],
    }));
  }
}

type PageSpec = {
  id: string;
  mode: Mode;
  title: string;
  empty: string;
  getRows: () => Promise<Row[] | { rows: Row[]; stale: boolean; graphics?: Graphic[]; animation?: GraphicAnimation; marquee?: Marquee }>;
};

export async function handler() {
  if (!settingsParameter || !railParameter || !bucket) throw new Error("Collector settings missing");
  const now = new Date();
  const updated = londonClock.format(now);
  const parameterNames = octopusParameter ? [settingsParameter, railParameter, octopusParameter] : [settingsParameter, railParameter];
  const [previous, { Parameters }] = await Promise.all([
    read(boardKey).catch(() => null),
    ssm.send(new GetParametersCommand({ Names: parameterNames, WithDecryption: true })),
  ]);

  const raw = Parameters?.find((parameter) => parameter.Name === settingsParameter)?.Value;
  const railKey = Parameters?.find((parameter) => parameter.Name === railParameter)?.Value;
  if (!raw || !railKey) throw new Error("Feed credentials missing");

  const octopusKey = Parameters?.find((parameter) => parameter.Name === octopusParameter)?.Value;
  const energy = octopusKey ? getEnergy(octopusKey, now) : Promise.resolve([]);
  const settings = JSON.parse(raw) as Settings;
  const oldPages = isBoard(previous) ? new Map(previous.pages.map((p) => [p.id, p])) : new Map<string, Page>();
  const buses = settings.buses.slice(0, 4);
  const specs: PageSpec[] = [
    {
      id: "bus", mode: "bus", title: buses[0]?.label ?? "BUS DEPARTURES", empty: "NO UPCOMING BUSES",
      getRows: () => busRows(buses, now),
    },
    ...settings.rails.slice(0, 4).map((station): PageSpec => ({
      id: `rail-${station.crs}`, mode: "rail", title: station.label, empty: "NO UPCOMING TRAINS",
      getRows: async () => ({ ...await railRows(station, railKey, updated), stale: false }),
    })),
    {
      id: "air", mode: "air", title: `AIRCRAFT WITHIN ${settings.air.radius} NM`, empty: "NO AIRCRAFT IN RANGE",
      getRows: () => airRows(settings.air),
    },
    {
      id: "space", mode: "space", title: "SATELLITES ABOVE 5 DEG", empty: "NO SATELLITES IN VIEW",
      getRows: async () => {
        const catalogue = await getOrbits(settings.space, now);
        return { rows: spaceRows(catalogue.orbits, settings.space, now), stale: catalogue.stale,
          animation: spaceAnimation(catalogue, settings.space, now) };
      },
    },
  ];

  const pages = await Promise.all(specs.map(async (spec): Promise<Page> => {
    const title = displayText(spec.title, 26) || spec.mode.toUpperCase();
    try {
      const result = await spec.getRows();
      const rows = Array.isArray(result) ? result : result.rows;
      return { id: spec.id, mode: spec.mode, title, updated,
        state: !Array.isArray(result) && result.stale ? "stale" : "live",
        graphics: Array.isArray(result) ? undefined : result.graphics,
        animation: Array.isArray(result) ? undefined : result.animation,
        marquee: Array.isArray(result) ? undefined : result.marquee,
        rows: rows.length ? rows : [row("", spec.empty, "")] };
    } catch (error) {
      const reason = error instanceof Error && /^Feed HTTP \d{3}$/.test(error.message) ? error.message : "fetch error";
      console.warn(`${spec.id}: ${reason}`);
      const old = oldPages.get(spec.id);
      return old && old.state !== "offline"
        ? { ...old, title, state: "stale", graphics: undefined, animation: undefined, marquee: undefined }
        : { id: spec.id, mode: spec.mode, title, updated, state: "offline", rows: [row("", "FEED UNAVAILABLE", "")] };
    }
  }));

  const basePages = [...pages, ...await energy];
  const board: Board = { version: 2, rotation: 60, pages: basePages.map(withGraphics) };
  fitGraphics(board, basePages);
  if (!isBoard(board)) throw new Error("Collector produced an invalid board");
  await write(boardKey, board);
  return { pages: board.pages.map(({ id, state }) => ({ id, state })) };
}
