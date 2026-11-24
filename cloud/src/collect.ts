import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { detailedBoardKey, displayText, isBoard, isDetailedBoard, londonClock, maxBoardBytes, maxDetailedBoardBytes, row, screenIndex, screensOf, type Board, type DetailedBoard, type Graphic, type GraphicAnimation, type Marquee, type Mode, type Page, type Row } from "./board.js";
import { aircraftRadius, busGraphics, busRows, fetchOrbits, nearbyAircraft, railRows, type Orbit, type Settings } from "./feeds.js";

import { energyDay, energyScreens, fetchDemand, fetchEnergyPages, withDemand } from "./octopus.js";
import { combineEnergyDays, compactBitmap, fitGraphics, withGraphics } from "./graphics.js";
import { passPresentation, predictPasses } from "./passes.js";
import { landShade } from "./nadir.js";
import { calendarPage } from "./calendar.js";
import { marinePages } from "./marine.js";
import { skyPages } from "./sky.js";
import { weatherScreen } from "./weather.js";
import { gridScreens } from "./carbon.js";
import { auroraScreen } from "./aurora.js";
import { freightPages, freightWanted } from "./freight-screen.js";
import { contextFacts, satelliteSubject, type Wanted } from "./context.js";
import { contextPage } from "./context-screen.js";
import { costsPage } from "./costs-screen.js";
import { liveTargets } from "./live-space.js";
import type { FreightFile } from "./freight.js";
import { reserveAircraftFallback } from "./air-fallback.js";

const s3 = new S3Client({});
const ssm = new SSMClient({});
const boardKey = "feeds/waypoint.json";
const orbitKey = "feeds/orbits.json";
const energyKey = "feeds/energy.json";
const tideKey = "feeds/tides.json";
const bucket = process.env.SCENES_BUCKET;
const settingsParameter = process.env.FEED_SETTINGS;
const railParameter = process.env.RAIL_API_KEY;
const octopusParameter = process.env.OCTOPUS_API_KEY;
const fr24Parameter = process.env.FR24_API_TOKEN;
const calendarPrefix = process.env.CALENDAR_PREFIX;

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

// The RefreshOrbits Lambda keeps feeds/orbits.json current every two hours; fetch here only to bootstrap.
async function getOrbits(settings: Settings["space"], now: Date): Promise<OrbitCache & { stale: boolean }> {
  const cached = await read(orbitKey).catch(() => null) as OrbitCache | null;
  const sameCatalog = cached?.mask === settings.mask && Array.isArray(cached.orbits);
  if (sameCatalog && cached.version === 2) {
    return { ...cached, stale: now.getTime() - cached.fetchedAt > Math.max(6, settings.cacheHours * 3) * 3600_000 };
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

let forecast: { key: string; expiresAt: number; presentation: ReturnType<typeof passPresentation> } | undefined;

function spacePresentation(catalogue: OrbitCache, settings: Settings["space"], now: Date) {
  const key = [catalogue.fetchedAt, settings.lat, settings.lon, settings.alt].join(":");
  if (forecast?.key === key && now.getTime() < forecast.expiresAt) return forecast.presentation;
  const passes = predictPasses(catalogue.orbits, settings, now);
  forecast = {
    key, expiresAt: Math.min(now.getTime() + 10 * 60_000, passes.find((pass) => pass.rise > now.getTime())?.rise ?? Infinity),
    presentation: passPresentation(passes),
  };
  return forecast.presentation;
}

type EnergyCache = { version: 4; day: number; expiresAt: number; pages: Page[] };

async function getEnergy(key: string, now: Date): Promise<Page[]> {
  const demand = fetchDemand(key, now);
  const pages = await getEnergyTotals(key, now);
  const latest = await demand;
  return pages.map((page) => withDemand(page, latest));
}

async function getEnergyTotals(key: string, now: Date): Promise<Page[]> {
  const cached = await read(energyKey).catch(() => null) as EnergyCache | null;
  const day = energyDay(now);
  const sameDay = cached?.version === 4 && cached.day === day;
  if (sameDay && cached.expiresAt > now.getTime()) return cached.pages;
  try {
    const data = await fetchEnergyPages(key, now);
    await write(energyKey, { version: 4, day, ...data });
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
  getRows: () => Promise<Row[] | { rows: Row[]; stale: boolean; graphics?: Graphic[]; animation?: GraphicAnimation; marquee?: Marquee; clock?: Page["clock"] }>;
};

export async function handler() {
  if (!settingsParameter || !railParameter || !bucket) throw new Error("Collector settings missing");
  const now = new Date();
  const updated = londonClock.format(now);
  const parameterNames = [settingsParameter, railParameter, octopusParameter, fr24Parameter].filter((name): name is string => Boolean(name));
  const [previous, { Parameters }] = await Promise.all([
    read(detailedBoardKey).catch(() => read(boardKey).catch(() => null)),
    ssm.send(new GetParametersCommand({ Names: parameterNames, WithDecryption: true })),
  ]);

  const raw = Parameters?.find((parameter) => parameter.Name === settingsParameter)?.Value;
  const railKey = Parameters?.find((parameter) => parameter.Name === railParameter)?.Value;
  if (!raw || !railKey) throw new Error("Feed credentials missing");

  const octopusKey = Parameters?.find((parameter) => parameter.Name === octopusParameter)?.Value;
  const energy = octopusKey ? getEnergy(octopusKey, now) : Promise.resolve([]);
  const marine = marinePages(now);
  const calendar = calendarPrefix ? calendarPage(ssm, calendarPrefix, now).catch(() => {
    console.warn("calendar: configuration unavailable");
    return undefined;
  }) : Promise.resolve(undefined);
  const settings = JSON.parse(raw) as Settings;
  const space = getOrbits(settings.space, now).then((catalogue) => ({
    liveSpace: { lat: settings.space.lat, lon: settings.space.lon, overhead: settings.space.liveElevation ?? 30, stale: catalogue.stale,
      orbits: catalogue.orbits },
    stale: catalogue.stale, ...spacePresentation(catalogue, settings.space, now),
  })).catch(() => undefined);
  const oldPages = isBoard(previous) ? new Map(previous.pages.map((p) => [p.id, p])) : new Map<string, Page>();
  const previousAircraft = isDetailedBoard(previous) ? previous.aircraft ?? [] : [];
  const airTitle = `AIRCRAFT WITHIN ${aircraftRadius} NM`;
  const fr24Token = Parameters?.find((parameter) => parameter.Name === fr24Parameter)?.Value;
  // Subjects for "did you know" screens, gathered from the cards as they are built.
  const wanted: Wanted[] = [];
  const aircraft = nearbyAircraft(settings.air, () => reserveAircraftFallback(s3, bucket), fr24Token).then((cards) => cards.map(({ subject, ...card }): Page => {
    if (subject) wanted.push({ parentId: card.id, subject });
    return { ...card, mode: "air", updated, state: "live", dwell_seconds: 30 };
  })).catch((error: unknown) => {
    console.warn("air: %s", error instanceof Error ? error.message : "fetch error");
    return previousAircraft.length ? previousAircraft.map((page): Page => ({ ...page, state: "stale" })) : null;
  });
  const sky = skyPages(settings.space, settings.tide ?? settings.space, now, {
    load: () => read(tideKey), save: (cache) => write(tideKey, cache),
  }).catch((error: unknown) => {
    console.warn("sky: %s", error instanceof Error ? error.message : "render error");
    return undefined;
  });
  const weather = weatherScreen(settings.space, now);
  const freight = read("feeds/freight-trains.json").then((file) => {
    wanted.push(...freightWanted(file as FreightFile, now));
    return freightPages(file as FreightFile, now);
  }).catch(() => []);
  const grid = gridScreens(now);
  const aurora = auroraScreen(settings.space, now);
  const buses = settings.buses.slice(0, 4);
  const specs: PageSpec[] = [
    {
      id: "bus", mode: "bus", title: buses[0]?.label ?? "BUS DEPARTURES", empty: "NO UPCOMING BUSES",
      getRows: async () => {
        const rows = await busRows(buses, now);
        return rows.length ? { rows, stale: false, ...busGraphics(rows, buses[0]?.label ?? "BUS DEPARTURES") } : rows;
      },
    },
    ...settings.rails.slice(0, 4).map((station): PageSpec => ({
      id: `rail-${station.crs}`, mode: "rail", title: station.label, empty: "NO UPCOMING TRAINS",
      getRows: async () => ({ ...await railRows(station, railKey, updated), stale: false }),
    })),
    {
      id: "space", mode: "space", title: "CLOSE SATELLITE PASSES", empty: "NO CLOSE PASSES",
      getRows: async () => {
        const result = await space;
        if (!result) throw new Error("Satellite forecast unavailable");
        return { rows: result.previews.slice(0, 4).map(({ title }) => row("", title, "")),
          stale: result.stale, animation: result.animation };
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
        clock: Array.isArray(result) || !result.graphics ? undefined : result.clock ?? (spec.mode === "rail" ? { right: 254, shade: 9 } : undefined),
        animation: Array.isArray(result) ? undefined : result.animation,
        marquee: Array.isArray(result) ? undefined : result.marquee,
        rows: rows.length ? rows : [row("", spec.empty, "")] };
    } catch (error) {
      const reason = error instanceof Error && /^Feed HTTP \d{3}$/.test(error.message) ? error.message : "fetch error";
      console.warn(`${spec.id}: ${reason}`);
      const old = oldPages.get(spec.id);
      return old && old.state !== "offline"
        ? { ...old, title, state: "stale", graphics: undefined, clock: undefined,
          animation: undefined, marquee: undefined }
        : { id: spec.id, mode: spec.mode, title, updated, state: "offline", rows: [row("", "FEED UNAVAILABLE", "")] };
    }
  }));

  const result = await aircraft;
  const contacts = result ?? [];
  const nearest: Page = contacts[0] ?? {
    id: "air", mode: "air", title: airTitle, updated, state: result ? "live" : "offline",
    rows: [row("", result ? "NO AIRCRAFT IN RANGE" : "FEED UNAVAILABLE", "")],
  };
  pages.splice(pages.length - 1, 0, { ...nearest, id: "air", title: airTitle });
  // Keep aircraft already in range in the same order between collection cycles.
  const remaining = new Map(contacts.map((page) => [page.id, page]));
  const ordered = previousAircraft.flatMap(({ id }) => {
    const page = remaining.get(id);
    remaining.delete(id);
    return page ? [page] : [];
  });
  const basePages = [...pages, ...combineEnergyDays(await energy)];
  const board: DetailedBoard = { version: 2, rotation: 60, pages: basePages.map(withGraphics), ...await calendar,
    aircraft: [...ordered, ...remaining.values()].map(withGraphics), marine: (await marine).pages };
  wanted.push(...(await marine).wanted);
  const skyScreens = [...(await weather ? [(await weather)!] : []), ...(await sky ?? [])];
  if (skyScreens.length) board.sky = skyScreens;
  const gridPages = await grid;
  if (gridPages.length) board.grid = gridPages;
  board.aurora = await aurora;
  const freightCards = await freight;
  if (freightCards.length) board.freight = freightCards;
  board.liveSpace = (await space)?.liveSpace;
  if (board.liveSpace) {
    // Satellites up now; their context is shown only while they are still live when the device asks.
    for (const target of liveTargets(board.liveSpace, now.getTime())) {
      const line1 = board.liveSpace.orbits.find((orbit) => orbit.line1.slice(2, 7).trim() === target.record.satnum.trim())?.line1;
      wanted.push({ parentId: target.page.id, subject: satelliteSubject(target.page.title, target.record.satnum,
        target.record.inclo * 180 / Math.PI, target.iss, line1) });
    }
  }
  const modes: Record<string, Page["mode"]> = { aircraft: "air", vessel: "marine", freight: "rail", satellite: "space" };
  const context = await contextFacts(wanted, now.getTime()).catch((error: unknown) => {
    console.warn("context: %s", error instanceof Error ? error.message : "lookup failed");
    return new Map();
  });
  if (context.size) {
    board.context = Object.fromEntries([...context].map(([parentId, { subject, facts }]) =>
      [parentId, contextPage({ id: parentId, mode: modes[subject.kind] }, subject, facts, now.getTime())]));
  }
  board.costs = await costsPage(now).catch((error: unknown) => {
    console.warn("costs: %s", error instanceof Error ? error.message : "read failed");
    return undefined;
  });
  const screens = screensOf(board);
  if (!isDetailedBoard(board) || Buffer.byteLength(JSON.stringify(board)) > maxDetailedBoardBytes
    || Buffer.byteLength(JSON.stringify(screenIndex(screens))) > maxBoardBytes
    || new Set(screens.map((page) => page.id)).size !== screens.length
    || screens.some((page) => Buffer.byteLength(JSON.stringify({ version: 2, rotation: board.rotation, pages: [page] })) > maxBoardBytes)) {
    throw new Error("Collector produced an invalid screen");
  }
  const legacy: Board = { version: 2, rotation: board.rotation, pages: board.pages
    .filter((page) => page.id !== "air" || page.state === "offline" || page.rows[0]?.[0])
    .map((page) =>
    page.mode === "air" && page.graphics ? { ...page, graphics: page.graphics.map((command) => compactBitmap(command, 1)) }
      : page.mode === "space" && page.animation ? {
    ...page, animation: { ...page.animation, phases: page.animation.phases.map((phase) =>
      phase.filter((command) => command.length !== 7 || command[5] === landShade)
        .map((command) => compactBitmap(command, 1))) },
  } : page) };
  fitGraphics(legacy, basePages.filter((page) => legacy.pages.some(({ id }) => id === page.id)));
  if (!isBoard(legacy)) throw new Error("Collector produced an invalid legacy board");
  await Promise.all([write(detailedBoardKey, board), write(boardKey, legacy)]);
  return { pages: board.pages.map(({ id, state }) => ({ id, state })) };
}
