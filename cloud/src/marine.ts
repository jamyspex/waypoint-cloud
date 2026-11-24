import { displayText, londonClock, maxBoardBytes, maxMarinePhases, row, type Graphic, type Page } from "./board.js";
import { textWidth } from "./font.js";
import { chartHeight, charts, chartWidth } from "./marine-charts.js";
import { aisHeaders, aisVesselsUrl, previousPorts, reportedVoyage, shipType } from "./marine-voyage.js";
import { packedBitmap } from "./packed.js";
import { anchorOf, type Wanted } from "./context.js";

const maxAge = 30 * 60_000;
const chartLeft = 148;
const chartTop = 13;
const stride = Math.ceil(chartWidth / 8);
const fallbackDwellSeconds = 60;
const vesselPhaseMs = 15_000;
const areas = [
  { id: "marine-moray", title: "MORAY FIRTH", chart: charts.moray },
  { id: "marine-cromarty", title: "CROMARTY FIRTH", chart: charts.cromarty },
] as const;
const coverage = areas.map(({ chart }) => chart.bounds);
const feedBounds = [
  Math.min(...coverage.map(([south]) => south)), Math.min(...coverage.map(([, west]) => west)),
  Math.max(...coverage.map(([, , north]) => north)), Math.max(...coverage.map(([, , , east]) => east)),
];

type Area = typeof areas[number];
type Contact = ReturnType<typeof reportedVoyage> & {
  mmsi: number; name: string; lat: number; lon: number; seen: number; type: string; speed?: number; nav?: number;
};
type AisFeature = {
  geometry?: { type?: unknown; coordinates?: unknown };
  properties?: { mmsi?: unknown; kind?: unknown; name?: unknown; seen?: unknown; sog?: unknown; nav_status?: unknown;
    type?: unknown; destination?: unknown };
};

function numeric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function inside({ lat, lon }: Contact, [south, west, north, east]: Area["chart"]["bounds"]): boolean {
  return lat >= south && lat <= north && lon >= west && lon <= east;
}

function inCromarty(contact: Contact): boolean {
  if (!inside(contact, charts.cromarty.bounds)) return false;
  // Follow the peninsula from the head of the firth toward the Sutors. The
  // southern part of the zoom box also contains the Moray shore at Fortrose.
  const [, west, , east] = charts.cromarty.bounds;
  const progress = (contact.lon - west) / (east - west);
  return contact.lat >= 57.58 + progress * (57.665 - 57.58);
}

function contactsOf(data: unknown, now: Date): Contact[] {
  const collection = data as { type?: unknown; features?: AisFeature[] } | null;
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) throw new Error("Unexpected AIS snapshot");
  const contacts = new Map<number, Contact>();
  for (const feature of collection.features) {
    const { geometry, properties } = feature ?? {};
    if (geometry?.type !== "Point" || !Array.isArray(geometry.coordinates) || properties?.kind !== "vessel") continue;
    const [lon, lat] = geometry.coordinates;
    const { mmsi, name, seen, sog, nav_status } = properties;
    const time = typeof seen === "string" ? Date.parse(seen) : NaN;
    if (!numeric(mmsi) || !Number.isInteger(mmsi) || mmsi < 100_000_000 || mmsi > 999_999_999
      || !numeric(lon) || !numeric(lat) || !Number.isFinite(time)
      || time < now.getTime() - maxAge || time > now.getTime() + 60_000 || time <= (contacts.get(mmsi)?.seen ?? 0)) continue;
    contacts.set(mmsi, {
      name: (typeof name === "string" && displayText(name, 48)) || `MMSI ${mmsi}`,
      mmsi, lat, lon, seen: time, type: shipType(properties.type), ...reportedVoyage(properties.destination),
      speed: numeric(sog) && sog >= 0 ? sog : undefined,
      nav: numeric(nav_status) ? nav_status : undefined,
    });
  }
  return [...contacts.values()].sort((a, b) => b.seen - a.seen);
}

function status(contact: Contact): string {
  if (contact.nav === 1) return "AT ANCHOR";
  if (contact.nav === 5) return "MOORED";
  if (contact.speed !== undefined) return `${contact.speed.toFixed(1)} KT`;
  return "SPEED UNKNOWN";
}

function fitPanel(text: string, width = chartLeft - 8): string {
  if (textWidth(text) <= width) return text;
  let end = text.length - 1;
  while (textWidth(`${text.slice(0, end)}...`) > width) end--;
  return `${text.slice(0, end).trimEnd()}...`;
}

function chartPosition(chart: Area["chart"], { lat, lon }: Contact) {
  const [south, west, north, east] = chart.bounds;
  return {
    x: Math.round((lon - west) / (east - west) * (chartWidth - 1)),
    y: Math.round((north - lat) / (north - south) * (chartHeight - 1)),
  };
}

function chartGraphics(chart: Area["chart"], contacts: Contact[]): Graphic[] {
  const pixels = Buffer.alloc(stride * chartHeight);
  for (const contact of contacts) {
    const { x, y } = chartPosition(chart, contact);
    pixels[y * stride + (x >> 3)] |= 1 << (x & 7);
  }
  return [
    [chartLeft - 1, chartTop - 1, chartWidth + 2, chartHeight + 2, 4],
    [chartLeft, chartTop, chartWidth, chartHeight, 0],
    [chartLeft, chartTop, chartWidth, chartHeight, 1, 2, chart.land],
    [chartLeft, chartTop, chartWidth, chartHeight, 1, 6, chart.coast],
    ...packedBitmap(chartLeft, chartTop, chartWidth, chartHeight, 1, 11, pixels),
  ];
}

function vesselPhase(chart: Area["chart"], contact: Contact, lastPort?: string): Graphic[] {
  const { x, y } = chartPosition(chart, contact);
  const movement = ` / ${status(contact)}`;
  const origin = contact.origin ? `FROM ${contact.origin}` : lastPort ? `LAST PORT ${lastPort}` : "FROM UNKNOWN";
  const destination = contact.route ? `ROUTE ${contact.route}` : `TO ${contact.destination || "UNKNOWN"}`;
  return [
    [3, 13, 1, 15, fitPanel(contact.name)],
    [3, 23, 1, 11, fitPanel(contact.type, chartLeft - 8 - textWidth(movement)) + movement],
    [3, 34, 1, 9, fitPanel(origin)],
    [3, 44, 1, 12, fitPanel(destination)],
    [chartLeft + x - 2, chartTop + y - 2, 1, 15, [14, 17, 21, 17, 14]],
  ];
}

function marinePage(area: Area, contacts: Contact[] | undefined, now: Date, ports?: Map<number, string>): Page {
  const { id, title, chart } = area;
  const state = contacts ? "live" : "offline";
  const empty = contacts ? "NO RECENT AIS REPORTS" : "AIS FEED UNAVAILABLE";
  const updated = londonClock.format(now);
  const graphics: Graphic[] = [
    [2, 0, 1, 15, title],
    [132, 0, 1, 9, "OPEN WATERS AIS"],
    [0, 10, 256, 1, 5],
    ...chartGraphics(chart, contacts ?? []),
  ];
  const page: Page = {
    id, title, mode: "marine", updated, state, graphics, clock: { right: 254, shade: 9 }, rows: [],
  };
  if (!contacts?.length) {
    graphics.push([3, 26, 1, 13, empty]);
    page.dwell_seconds = fallbackDwellSeconds;
    page.rows = [row("", empty, "")];
    return page;
  }

  const count = contacts.length;
  graphics.push([3, 54, 1, 9, `${count} ${count === 1 ? "VESSEL" : "VESSELS"} / 30 MIN`]);
  // A crowded chart may exceed the screen payload or the number of readable steps in one visit.
  const minute = Math.floor(now.getTime() / 60_000);
  for (let size = Math.min(count, maxMarinePhases); size > 0; size--) {
    const start = size < count ? minute % count : 0;
    const batch = Array.from({ length: size }, (_, i) => contacts[(start + i) % count]);
    page.animation = { phase_ms: vesselPhaseMs,
      phases: batch.map((contact) => vesselPhase(chart, contact, ports?.get(contact.mmsi))) };
    page.rows = [row("", batch[0].name, status(batch[0]))];
    if (Buffer.byteLength(JSON.stringify({ version: 2, rotation: fallbackDwellSeconds, pages: [page] })) <= maxBoardBytes) return page;
  }
  return page;
}

function vesselSubjects(areaId: string, areaTitle: string, contacts: Contact[]): Wanted[] {
  return contacts.slice(0, 6).map((contact) => ({
    parentId: areaId,
    subject: {
      key: `vessel#${contact.mmsi}`, kind: "vessel", label: contact.name,
      anchor: anchorOf({ name: contact.name, mmsi: contact.mmsi, type: contact.type, destination: contact.destination,
        origin: contact.origin, route: contact.route, area: areaTitle, speed: contact.speed === undefined ? undefined : `${contact.speed} knots` }),
    },
  }));
}

/** The marine cards, plus each card's vessels as subjects for "did you know" screens. */
export async function marinePages(now: Date): Promise<{ pages: Page[]; wanted: Wanted[] }> {
  try {
    const url = new URL(aisVesselsUrl);
    url.searchParams.set("bbox", feedBounds.join(","));
    url.searchParams.set("max_age", "30m");
    const response = await fetch(url, {
      headers: aisHeaders,
      signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok) throw new Error(`AIS HTTP ${response.status}`);
    const contacts = contactsOf(await response.json(), now).filter((contact) => coverage.some((bounds) => inside(contact, bounds)));
    const ports = await previousPorts(contacts, now);
    const byArea = areas.map((area) => ({ area, list: contacts.filter((contact) => area.id === "marine-cromarty"
      ? inCromarty(contact) : inside(contact, area.chart.bounds) && !inCromarty(contact)) }));
    return {
      pages: byArea.map(({ area, list }) => marinePage(area, list, now, ports)),
      wanted: byArea.flatMap(({ area, list }) => vesselSubjects(area.id, area.title, list)),
    };
  } catch (error) {
    console.warn("marine: %s", error instanceof Error ? error.message : "fetch error");
    return { pages: areas.map((area) => marinePage(area, undefined, now)), wanted: [] };
  }
}
