import { ecfToLookAngles, eciToEcf, eciToGeodetic, gstime, jday, propagate, radiansLat, radiansLong, twoline2satrec, type SatRec } from "satellite.js";
import { displayText, londonClock, type Graphic, type GraphicAnimation } from "./board.js";
import type { Orbit, Settings } from "./feeds.js";
import { earthCenter, earthRadius, earthTilt } from "./earth.js";
import { nadirView } from "./nadir.js";

const hour = 3_600_000;
const cadence = 60_000;
const earthRadiusKm = 6371;
const maximumGroundDistanceKm = 20 * 1.609344;
const radiansToDegrees = 180 / Math.PI;
const compass = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" });
const stationSprite = [96, 246, 4095, 3739, 4095, 246, 96];
const dishSprite = [96, 240, 510, 2047, 510, 240, 96];
const panelSprite = [0, 4032, 2016, 1020, 510, 126, 0];
const satelliteSprite = [224, 224, 4095, 3739, 4095, 224, 64];
// Make the nearby pass long enough to read, then show the rest of the same orbit.
const passSteps = 12;
const orbitSteps = 20;
const closestStep = 6;
type Angles = { azimuth: number; elevation: number };
type Point = [number, number];
type Pass = {
  name: string;
  group: number;
  rise: number;
  hasRise: boolean;
  closest: number;
  groundDistance: number;
  peak: number;
  start: string;
  end: string;
  path: [number, number, number][];
  nadir: { latitude: number; longitude: number };
  groundTrack: { latitude: number; longitude: number }[];
  trace: { position: Point; bright: boolean; front: boolean }[];
  inclination: number;
  altitude: number;
};

function mission(name: string): number {
  if (/^ISS(?: \(ZARYA\))?$/i.test(name)) return 0;
  if (/^CSS \(TIANHE\)/i.test(name)) return 1;
  if (/\b(HST|TERRA|AQUA|SENTINEL|LANDSAT|SWOT|PACE)\b/i.test(name)) return 2;
  if (/^(NOAA|METOP|SUOMI)/i.test(name)) return 3;
  if (/^(AO-|SO-|FO-|RS-)/i.test(name)) return 4;
  if (/^STARLINK/i.test(name)) return 5;
  if (/IRIDIUM|GALILEO/i.test(name)) return 6;
  return 7;
}

function compassPoint(azimuth: number): string {
  return compass[Math.round(azimuth / (Math.PI / 4)) % compass.length];
}

function crossing(lookAt: (time: number) => Angles | undefined, from: number, to: number, rising: boolean): number {
  while (to - from > 1000) {
    const mid = Math.floor((from + to) / 2);
    const above = (lookAt(mid)?.elevation ?? -90) > 0;
    if (above === rising) to = mid;
    else from = mid;
  }
  return Math.round((to + from) / 2);
}

function subpoint(record: SatRec, time: number) {
  const date = new Date(time);
  const position = propagate(record, date)?.position;
  return position && typeof position !== "boolean" ? eciToGeodetic(position, gstime(date)) : undefined;
}

function closestGroundPass(record: SatRec, observer: Pass["nadir"], rise: number, set: number) {
  const distanceAt = (time: number) => {
    const point = subpoint(record, time);
    if (!point) return Infinity;
    const haversine = Math.sin((point.latitude - observer.latitude) / 2) ** 2
      + Math.cos(point.latitude) * Math.cos(observer.latitude) * Math.sin((point.longitude - observer.longitude) / 2) ** 2;
    return 2 * earthRadiusKm * Math.asin(Math.sqrt(Math.min(1, haversine)));
  };
  let best = rise;
  let distance = distanceAt(rise);
  for (let time = Math.min(set, rise + cadence); ; time = Math.min(set, time + cadence)) {
    const candidate = distanceAt(time);
    if (candidate < distance) { best = time; distance = candidate; }
    if (time === set) break;
  }
  let left = Math.max(rise, best - cadence);
  let right = Math.min(set, best + cadence);
  while (right - left > 500) {
    const first = left + (right - left) / 3;
    const second = right - (right - left) / 3;
    if (distanceAt(first) < distanceAt(second)) right = second;
    else left = first;
  }
  const closest = Math.round((left + right) / 2);
  const refined = distanceAt(closest);
  return refined < distance ? { closest, groundDistance: refined } : { closest: best, groundDistance: distance };
}

function previewOrbit(record: SatRec, rise: number, set: number, closest: number):
  Pick<Pass, "path" | "trace" | "inclination" | "altitude" | "nadir" | "groundTrack"> | undefined {
  const center = subpoint(record, closest);
  if (!center || record.no <= 0) return;
  const altitude = Math.round(center.height);
  const groundTrack: Pass["groundTrack"] = [];
  const period = 2 * Math.PI / record.no * 60_000;
  const passDuration = Math.min(set - rise, period);
  const nearest = Math.min(closest, rise + passDuration);
  const path: Pass["path"] = [];
  const trace: Pass["trace"] = [];
  const tiltSin = Math.sin(earthTilt);
  const tiltCos = Math.cos(earthTilt);
  for (let step = 0; step <= orbitSteps; step++) {
    const time = new Date(step <= closestStep ? rise + step * (nearest - rise) / closestStep
      : step <= passSteps ? nearest + (step - closestStep) * (rise + passDuration - nearest) / (passSteps - closestStep)
      : rise + passDuration + (step - passSteps) * (period - passDuration) / (orbitSteps - passSteps));
    const point = propagate(record, time)?.position;
    if (!point || typeof point === "boolean") return;
    const siderealTime = gstime(time);
    if (step <= passSteps) groundTrack.push(eciToGeodetic(point, siderealTime));
    const { x, y, z } = eciToEcf(point, siderealTime);
    const distance = Math.hypot(x, y, z);
    if (!Number.isFinite(distance) || distance <= 0) return;
    // Expand low-orbit altitudes and compress high ones to fit one view on the OLED.
    const radius = earthRadius + Math.min(6, 2 + 2.2 * Math.log1p(Math.max(0, distance - earthRadiusKm) / 500));
    const center: Point = [
      Math.round(earthCenter.x + radius * y / distance),
      Math.round(earthCenter.y - radius * (z * tiltCos - x * tiltSin) / distance),
    ];
    const depth = (x * tiltCos + z * tiltSin) / distance;
    const front = depth >= 0;
    path.push([center[0] - 6, center[1] - 3, Math.max(0, Math.min(255, Math.round(128 + depth * 127)))]);
    if (step % 4 === 0 && (front || Math.hypot(center[0] - earthCenter.x, center[1] - earthCenter.y) > earthRadius)) {
      trace.push({ position: center, front, bright: step <= passSteps });
    }
  }
  return { path, trace, inclination: record.inclo * radiansToDegrees, altitude, nadir: center, groundTrack };
}

export function predictPasses(orbits: Orbit[], settings: Settings["space"], now: Date): Pass[] {
  const observer = { latitude: radiansLat(settings.lat), longitude: radiansLong(settings.lon), height: settings.alt / 1000 };
  const start = now.getTime();
  const epoch = jday(now);
  const candidates = orbits.flatMap((orbit): Pass[] => {
    // The station and its attached modules share one orbit.
    if (/^CSS \((MENGTIAN|WENTIAN)\)|\b(DEB|R\/B)\b/i.test(orbit.name)) return [];
    try {
      const record = twoline2satrec(orbit.line1, orbit.line2);
      const group = mission(orbit.name);
      if (Math.abs(record.jdsatepoch - epoch) > 7) return [];
      const lookAt = (time: number): Angles | undefined => {
        const date = new Date(time);
        const state = propagate(record, date);
        if (!state?.position || typeof state.position === "boolean") return;
        const angles = ecfToLookAngles(observer, eciToEcf(state.position, gstime(date)));
        if (![angles.azimuth, angles.elevation, angles.rangeSat].every(Number.isFinite)) return;
        return { azimuth: angles.azimuth, elevation: angles.elevation * radiansToDegrees };
      };
      let previous = lookAt(start);
      let rise: number | undefined;
      let peak = 0;
      let chosen: { rise: number; set: number; score: number; peak: number; closest: number; groundDistance: number } | undefined;
      for (let time = start + cadence; time <= start + 24 * hour; time += cadence) {
        const current = lookAt(time);
        if (previous && current && previous.elevation <= 0 && current.elevation > 0) {
          rise = crossing(lookAt, time - cadence, time, true);
          peak = 0;
        }
        if (rise !== undefined && current) {
          peak = Math.max(peak, current.elevation);
          if (current.elevation <= 0) {
            const score = peak - (rise - start) / hour * 2;
            if (peak >= 5 && (!chosen || score > chosen.score)) {
              const set = crossing(lookAt, time - cadence, time, false);
              const distance = closestGroundPass(record, observer, rise, set);
              if (Number.isFinite(distance.groundDistance) && (group === 0 || distance.groundDistance <= maximumGroundDistanceKm)) {
                chosen = { rise, set, score, peak, ...distance };
              }
            }
            rise = undefined;
          }
        } else if (!current) {
          rise = undefined;
        }
        previous = current;
      }
      const hasRise = chosen !== undefined;
      if (!chosen && group === 0) {
        const end = start + 24 * hour;
        const distance = closestGroundPass(record, observer, start, end);
        if (!Number.isFinite(distance.groundDistance)) return [];
        chosen = {
          rise: Math.max(start, distance.closest - 5 * cadence),
          set: Math.min(end, distance.closest + 5 * cadence),
          score: 0, peak: lookAt(distance.closest)?.elevation ?? -90, ...distance,
        };
      }
      if (!chosen) return [];
      const preview = previewOrbit(record, chosen.rise, chosen.set, chosen.closest);
      const riseAngle = lookAt(chosen.rise);
      const setAngle = lookAt(chosen.set);
      if (!preview || !riseAngle || !setAngle) return [];
      const peakElevation = Math.max(chosen.peak, ...Array.from({ length: 19 }, (_, i) =>
        lookAt(chosen.rise + (chosen.set - chosen.rise) * (i + 1) / 20)?.elevation ?? 0));
      const name = orbit.name.toUpperCase().startsWith("CSS (TIANHE)") ? "TIANGONG" : orbit.name;
      return [{
        name, group, rise: chosen.rise, hasRise, closest: chosen.closest, groundDistance: chosen.groundDistance,
        start: compassPoint(riseAngle.azimuth), end: compassPoint(setAngle.azimuth),
        peak: peakElevation, ...preview,
      }];
    } catch {
      return [];
    }
  });
  const score = (pass: Pass) => pass.peak - (pass.rise - start) / hour * 2;
  const ranked = candidates.sort((a, b) => a.group - b.group || score(b) - score(a));
  const distinct = new Map<number, Pass>();
  for (const pass of ranked) {
    if (!distinct.has(pass.group)) distinct.set(pass.group, pass);
  }
  const choices = [...distinct.values()];
  return [...choices, ...ranked.filter((pass) => !choices.includes(pass))]
    .slice(0, 5).sort((a, b) => a.rise - b.rise);
}

type Preview = { title: string; graphics: Graphic[]; animation: GraphicAnimation };

function blink(sprite: number[], x: number, y: number): Graphic {
  // The existing occlusion mask switches a stationary sprite on and off as depth changes.
  const frames = Array.from({ length: 13 }, (_, i) => [x, y, i % 2 === 0 ? 255 : 0]);
  return [1, 15, sprite, [x, y, 16], Buffer.from(frames.flat()).toString("hex")];
}

export function passPresentation(passes: Pass[]): { animation?: GraphicAnimation; previews: Preview[] } {
  const legacy: Graphic[][] = [];
  const previews = passes.map((pass): Preview => {
    const date = new Date(pass.rise);
    const trace: Graphic[] = pass.trace.map(({ position: [x, y], front, bright }) =>
      [x, y, 1, bright ? 13 : front ? 8 : 4, [1]]);
    const sprite = pass.group <= 1 ? stationSprite : pass.group === 3 ? dishSprite
      : pass.group === 5 ? panelSprite : satelliteSprite;
    const circle: [number, number, number] = [earthCenter.x, earthCenter.y, earthRadius];
    const orbital = (from: number, to: number): Graphic =>
      [1, 15, sprite, circle, Buffer.from(pass.path.slice(from, to + 1).flat()).toString("hex")];
    const { graphics: map, motion } = nadirView(pass.nadir, pass.groundTrack, pass.altitude, pass.path.length);
    const [scale, shade, mapSprite, [left, top, width, height], mapPath] = motion;
    const title = displayText(pass.name, 15);
    const direction = pass.peak < 0 ? "BELOW HORIZON" : pass.hasRise
      ? `${pass.start} > ${pass.end}  ${Math.round(pass.peak)}DEG` : `MAX ${Math.round(pass.peak)}DEG`;
    legacy.push([
      [3, 14, 1, 15, title],
      [3, 26, 1, 10, pass.hasRise
        ? `RISE ${weekday.format(date).toUpperCase()} ${londonClock.format(date)}` : `CLOSE ${londonClock.format(pass.closest)}`],
      [3, 38, 1, 15, direction],
      [3, 51, 1, 10, `INC ${pass.inclination.toFixed(1)}  ${pass.altitude}KM`],
      ...trace, ...map, motion, orbital(0, orbitSteps),
    ]);

    const moving = (from: number, to: number): Graphic[] => [
      orbital(from, to),
      [scale, shade, mapSprite, [left, top, width, height, to - from + 1], mapPath.slice(from * 4, (to + 1) * 4)],
    ];
    const [x, y, depth] = pass.path[closestStep];
    const visible = depth >= 128 ? sprite : sprite.map((row, dy) => {
      let bits = 0;
      for (let dx = 0; dx < 16; dx++) {
        if ((x + dx - circle[0]) ** 2 + (y + dy - circle[1]) ** 2 > circle[2] ** 2) bits |= row & (1 << dx);
      }
      return bits;
    });
    const [mx, my] = Buffer.from(mapPath.slice(closestStep * 4, closestStep * 4 + 4), "hex");
    return {
      title,
      graphics: [
        [3, 14, 1, 15, title],
        [3, 26, 1, 10, `CLOSE ${londonClock.format(pass.closest)}`],
        [3, 38, 1, 15, direction],
        [3, 51, 1, 10, `${Math.round(pass.groundDistance / 1.609344)}MI  ${pass.altitude}KM`],
        ...trace, ...map,
      ],
      animation: { phase_ms: 6000, phases: [
        moving(0, closestStep / 2),
        moving(closestStep / 2, closestStep),
        [blink(visible, x, y), blink(mapSprite, left + mx - 64, top + my - 64)],
        moving(closestStep, passSteps),
        [orbital(passSteps, orbitSteps)],
      ] },
    };
  });
  return { animation: legacy.length ? { phase_ms: 30_000, phases: legacy } : undefined, previews };
}
