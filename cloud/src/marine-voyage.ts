import { displayText } from "./board.js";
import { regionalPorts } from "./marine-ports.js";

export const aisVesselsUrl = "https://ais.openwaters.io/v1/vessels";
export const aisHeaders = { Accept: "application/geo+json, application/json", "User-Agent": "Waypoint/1.0 (https://github.com/jamyspex/waypoint-cloud)" };

const portNames = new Map(regionalPorts.filter(([, code]) => code).map(([name, code]) => [code, name]));
const specialTypes: Record<number, string> = {
  30: "FISHING", 31: "TOWING", 32: "TOWING", 33: "DREDGER", 34: "DIVING VESSEL", 35: "MILITARY",
  36: "SAILING", 37: "PLEASURE CRAFT", 50: "PILOT BOAT", 51: "RESCUE VESSEL", 52: "TUG", 53: "PORT TENDER",
  54: "POLLUTION RESPONSE", 55: "LAW ENFORCEMENT", 58: "MEDICAL TRANSPORT",
};
const typeGroups: Record<number, string> = {
  2: "WING-IN-GROUND", 4: "HIGH-SPEED CRAFT", 6: "PASSENGER", 7: "CARGO", 8: "TANKER", 9: "OTHER VESSEL",
};

export function shipType(code: unknown): string {
  if (typeof code !== "number" || !Number.isInteger(code) || code < 20 || code > 99) return "TYPE UNKNOWN";
  return specialTypes[code] ?? typeGroups[Math.floor(code / 10)] ?? "TYPE UNKNOWN";
}

function place(text: string): string {
  text = text.trim();
  if (!/[A-Z0-9]/.test(text) || /^(?:N\/?A|UNKNOWN|NONE|NOT AVAILABLE)$/.test(text)) return "";
  return displayText(portNames.get(text.replace(/\s/g, "")) ?? text, 48);
}

export function reportedVoyage(value: unknown): { origin?: string; destination?: string; route?: string } {
  const text = typeof value === "string" ? displayText(value, 48) : "";
  const route = text.match(/^([^<>]+?)(?:->|>)([^<>]+)$/);
  if (route) return { origin: place(route[1]), destination: place(route[2]) };
  if (/[<>]/.test(text)) return { route: place(text) };
  return { destination: place(text) };
}

type Port = typeof regionalPorts[number];
type Vessel = { mmsi: number; lat: number; lon: number; origin?: string };
type Track = { geometry?: { type?: string; coordinates?: [number, number][] }; properties?: {
  times?: string[]; sog?: (number | null)[]; nav_status?: (number | null)[];
} };
const portRadiusKm = 1.1;
const cache = new Map<number, { expires: number; port?: Port }>();

function distanceSquared(lat: number, lon: number, port: Port): number {
  const kmNorth = (lat - port[2]) * 111.2;
  const kmEast = (lon - port[3]) * 111.2 * Math.cos(lat * Math.PI / 180);
  return kmNorth * kmNorth + kmEast * kmEast;
}

function portAt(lat: number, lon: number): Port | undefined {
  let distance = portRadiusKm ** 2;
  let match: Port | undefined;
  for (const port of regionalPorts) {
    const candidate = distanceSquared(lat, lon, port);
    if (candidate < distance) {
      distance = candidate;
      match = port;
    }
  }
  return match;
}

function observedPort(track: Track, vessel: Vessel): Port | undefined {
  const { geometry, properties } = track;
  if (geometry?.type !== "LineString" || !properties?.times || !properties.sog) return;
  let previous: { port?: Port; time: number } | undefined;
  // Work backwards through the track and require two consecutive low-speed fixes near the same port.
  for (let i = (geometry.coordinates?.length ?? 0) - 1; i >= 0; i--) {
    const [lon, lat] = geometry.coordinates?.[i] ?? [];
    const speed = properties.sog[i];
    const nav = properties.nav_status?.[i];
    const time = Date.parse(properties.times[i]);
    const stopped = nav !== 1 && ((typeof speed === "number" && speed >= 0 && speed <= 0.6) || (speed == null && nav === 5));
    const port = stopped && lat !== undefined && lon !== undefined ? portAt(lat, lon) : undefined;
    if (port && port === previous?.port && previous.time - time >= 8 * 60_000 && previous.time - time <= 60 * 60_000
      && distanceSquared(vessel.lat, vessel.lon, port) > portRadiusKm ** 2) return port;
    previous = { port, time };
  }
}

export async function previousPorts(vessels: Vessel[], now: Date): Promise<Map<number, string>> {
  const time = now.getTime();
  for (const [id, value] of cache) if (value.expires <= time) cache.delete(id);
  const missing = vessels.filter(({ mmsi, origin }) => !origin && !cache.has(mmsi)).slice(0, 24);
  await Promise.all(missing.map(async (vessel) => {
    try {
      const url = new URL(`${aisVesselsUrl}/${vessel.mmsi}/track`);
      url.searchParams.set("interval", "10m");
      url.searchParams.set("limit", "150");
      const response = await fetch(url, { headers: aisHeaders, signal: AbortSignal.timeout(3200) });
      const port = response.ok ? observedPort(await response.json() as Track, vessel) : undefined;
      cache.set(vessel.mmsi, { port, expires: time + (response.ok ? 15 : 2) * 60_000 });
    } catch {
      cache.set(vessel.mmsi, { expires: time + 2 * 60_000 });
    }
  }));
  const ports = new Map<number, string>();
  for (const vessel of vessels) {
    const port = cache.get(vessel.mmsi)?.port;
    if (port && distanceSquared(vessel.lat, vessel.lon, port) > portRadiusKm ** 2) ports.set(vessel.mmsi, displayText(port[0], 48));
  }
  return ports;
}
