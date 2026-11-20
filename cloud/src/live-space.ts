import { eciToEcf, eciToGeodetic, gstime, jday, propagate, twoline2satrec, type SatRec } from "satellite.js";
import { displayText, londonClock, maxBoardBytes, type Graphic, type LiveOrbitCatalog, type Page } from "./board.js";
import { earthCenter, earthRadius, earthTilt, globeGraphics } from "./earth.js";
import { spaceGraphics } from "./graphics.js";
import { nadirView } from "./nadir.js";
import { packedBitmap } from "./packed.js";
import { groundRegion, regionLines } from "./space-region.js";

const kmPerMile = 1.609344;
const earthKm = 6371;
const radiusKm = 20 * kmPerMile;
const durationMs = 30_000;
const issTrackContextMs = 10 * 60_000;
const issTrackStepMs = 10_000;
const radians = Math.PI / 180;
const issCenter = { x: 29, y: 37 };
const issRadius = 17;
const issGlobe = globeGraphics(issCenter, issRadius);
const sinTilt = Math.sin(earthTilt);
const cosTilt = Math.cos(earthTilt);

type Location = { latitude: number; longitude: number; height: number };
type Target = { record: SatRec; iss: boolean; groundDistance: number; page: Page };

function position(record: SatRec, time: number) {
  const date = new Date(time);
  const point = propagate(record, date)?.position;
  if (!point || typeof point === "boolean") return;
  const siderealTime = gstime(date);
  return { location: eciToGeodetic(point, siderealTime), earthFixed: eciToEcf(point, siderealTime) };
}

function distanceTo(catalog: LiveOrbitCatalog, location: Location): number {
  const lat = catalog.lat * radians;
  const lon = catalog.lon * radians;
  const arc = Math.sin((location.latitude - lat) / 2) ** 2
    + Math.cos(lat) * Math.cos(location.latitude) * Math.sin((location.longitude - lon) / 2) ** 2;
  return 2 * earthKm * Math.asin(Math.sqrt(Math.min(1, arc)));
}

function label(value: number, positive: string, negative: string): string {
  return Math.abs(value / radians).toFixed(1) + (value >= 0 ? positive : negative);
}

function orbitPoint({ x, y, z }: { x: number; y: number; z: number }, center: typeof earthCenter, radius: number) {
  const range = Math.hypot(x, y, z);
  if (!Number.isFinite(range) || range <= 0) return;
  const r = radius + Math.min(6, 2 + 2.2 * Math.log1p(Math.max(0, range - earthKm) / 500));
  return { x: center.x + r * y / range, y: center.y - r * (z * cosTilt - x * sinTilt) / range,
    depth: (x * cosTilt + z * sinTilt) / range };
}

function issOrbit(record: SatRec, time: number): Graphic[] {
  const size = 49;
  const left = issCenter.x - 24;
  const top = issCenter.y - 24;
  const stride = Math.ceil(size / 8);
  const front = Buffer.alloc(stride * size);
  const rear = Buffer.alloc(front.length);
  const siderealTime = gstime(new Date(time));
  const period = 2 * Math.PI * 60_000 / record.no;
  for (let i = 0; i < 360; i++) {
    const coordinate = propagate(record, new Date(time + (i / 360 - .5) * period))?.position;
    if (!coordinate || typeof coordinate === "boolean") continue;
    const point = orbitPoint(eciToEcf(coordinate, siderealTime), issCenter, issRadius);
    if (!point) continue;
    const x = Math.round(point.x) - left;
    const y = Math.round(point.y) - top;
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    const pixels = point.depth >= 0 ? front : rear;
    pixels[y * stride + (x >> 3)] |= 1 << (x & 7);
  }
  return [...packedBitmap(left, top, size, size, 1, 5, rear), ...issGlobe,
    ...packedBitmap(left, top, size, size, 1, 8, front)];
}

export function liveTargets(catalog: LiveOrbitCatalog, time: number): Target[] {
  const epoch = jday(new Date(time));
  const targets = new Map<string, Target>();
  for (const orbit of catalog.orbits) {
    if (/^CSS \((MENGTIAN|WENTIAN)\)|\b(DEB|R\/B)\b/i.test(orbit.name)) continue;
    try {
      const record = twoline2satrec(orbit.line1, orbit.line2);
      if (Math.abs(record.jdsatepoch - epoch) > 7 || !/^[a-z0-9]+$/i.test(record.satnum)) continue;
      const current = position(record, time);
      if (!current) continue;
      const groundDistance = distanceTo(catalog, current.location);
      const iss = record.satnum === "25544" || /^ISS(?: \(ZARYA\))?$/i.test(orbit.name);
      if (!Number.isFinite(groundDistance) || (!iss && groundDistance > radiusKm)) continue;
      if (!iss) {
        const next = position(record, time + 500);
        if (!next || !(distanceTo(catalog, next.location) <= radiusKm)) continue;
      }
      const id = iss ? "space-iss" : `space-${record.satnum}`;
      targets.set(id, { record, groundDistance, iss, page: {
        id, mode: "space", title: displayText(iss ? "ISS (ZARYA)" : orbit.name, 15) || "SATELLITE",
        updated: londonClock.format(time), state: catalog.stale ? "stale" : "live", rows: [],
      } });
    } catch {
      // Individual catalogue entries can expire or become invalid independently.
    }
  }
  return [...targets.values()].sort((a, b) => Number(b.iss) - Number(a.iss) || a.groundDistance - b.groundDistance).slice(0, 5);
}

export function liveSatellitePage(target: Target, catalog: LiveOrbitCatalog, time: number): Page | undefined {
  const current = position(target.record, time);
  if (!current) return;
  let duration = durationMs;
  if (!target.iss) {
    for (let elapsed = 250; elapsed <= durationMs; elapsed += 250) {
      const sample = position(target.record, time + elapsed);
      if (!sample || distanceTo(catalog, sample.location) > radiusKm) {
        duration = elapsed - 250;
        break;
      }
    }
    if (duration < 500) return;
  }
  const samples = Math.max(2, Math.ceil(duration / 2000) + 1);
  const orbit: [number, number, number][] = [];
  const track: Location[] = [];
  const globeCenter = target.iss ? issCenter : earthCenter;
  const globeRadius = target.iss ? issRadius : earthRadius;
  for (let i = 0; i < samples; i++) {
    const sample = position(target.record, time + i * (duration - 1) / (samples - 1));
    if (!sample) return;
    track.push(sample.location);
    const point = orbitPoint(sample.earthFixed, globeCenter, globeRadius);
    if (!point) return;
    orbit.push([
      Math.round(point.x) - 6,
      Math.round(point.y) - 3,
      Math.max(0, Math.min(255, Math.round(128 + 127 * point.depth))),
    ]);
  }
  const { location } = current;
  const altitude = Math.round(location.height);
  const center = target.iss ? location : { latitude: catalog.lat * radians, longitude: catalog.lon * radians };
  const contextTrack: Location[] = [];
  if (target.iss) {
    for (let offset = -issTrackContextMs; offset <= duration + issTrackContextMs; offset += issTrackStepMs) {
      const sample = position(target.record, time + offset);
      if (sample) contextTrack.push(sample.location);
    }
  }
  const map = target.iss ? nadirView(center, track, altitude, samples, 1.2, contextTrack) : nadirView(center, track, altitude, samples, 3);
  const sprite = target.iss ? [96, 246, 4095, 3739, 4095, 246, 96] : [224, 224, 4095, 3739, 4095, 224, 64];
  const marker: Graphic = [
    1, 15, sprite, [globeCenter.x, globeCenter.y, globeRadius], Buffer.from(orbit.flat()).toString("hex"),
  ];
  if (target.iss) {
    const region = groundRegion(location.latitude, location.longitude);
    const [first, second] = region ? regionLines(region, 66)
      : [label(location.latitude, "N", "S"), label(location.longitude, "E", "W")];
    const graphics: Graphic[] = [
      [2, 0, 1, 15, target.page.title], [83, 0, 1, 9, target.page.state.toUpperCase()],
      [129, 0, 1, 12, "GROUND TRACK"], [0, 10, 256, 1, 5],
      [126, 12, 1, 50, 4], [128, 14, 128, 48, 1],
      ...issOrbit(target.record, time),
      [59, 15, 1, 15, `${altitude} KM ALT`],
      [59, 27, 1, 12, first],
      [59, 38, 1, 12, second],
      [59, 50, 1, 11, `${Math.round(target.groundDistance / kmPerMile)} MI`],
    ];
    const page: Page = { ...target.page, starts_at: time, clock: { right: 254, shade: 9 },
      graphics: [...graphics, ...map.graphics], animation: { phase_ms: duration, phases: [[marker, map.motion]] } };
    if (Buffer.byteLength(JSON.stringify({ version: 2, rotation: 60, pages: [page] })) > maxBoardBytes) {
      page.graphics = [...graphics, ...map.graphics.filter((command) => command[5] !== 7)];
    }
    return page;
  }
  return {
    ...target.page, starts_at: time,
    graphics: [
      ...spaceGraphics({ ...target.page, title: "SATELLITE LIVE" }),
      [3, 14, 1, 15, target.page.title],
      [3, 26, 1, 10, `${label(location.latitude, "N", "S")} ${label(location.longitude, "E", "W")}`],
      [3, 38, 1, 15, "OVERHEAD"],
      [3, 51, 1, 10, `${altitude} KM`], ...map.graphics,
    ],
    animation: { phase_ms: duration, phases: [[marker, map.motion]] },
  };
}
