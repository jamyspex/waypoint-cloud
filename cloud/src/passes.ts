import { ecfToLookAngles, eciToEcf, eciToGeodetic, gstime, jday, propagate, radiansLat, radiansLong, twoline2satrec, type SatRec } from "satellite.js";
import { displayText, londonClock, type Graphic, type GraphicAnimation } from "./board.js";
import type { Orbit, Settings } from "./feeds.js";
import { earthCenter, earthRadius, earthTilt } from "./earth.js";
import { nadirView } from "./nadir.js";

const hour = 3_600_000;
const cadence = 60_000;
const radiansToDegrees = 180 / Math.PI;
const compass = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" });
const stationSprite = [96, 246, 4095, 3739, 4095, 246, 96];
const dishSprite = [96, 240, 510, 2047, 510, 240, 96];
const panelSprite = [0, 4032, 2016, 1020, 510, 126, 0];
const satelliteSprite = [224, 224, 4095, 3739, 4095, 224, 64];
type Angles = { azimuth: number; elevation: number };
type Point = [number, number];
type Pass = {
  name: string;
  group: number;
  rise: number;
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
  if (/^ISS \(ZARYA\)/i.test(name)) return 0;
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

function previewOrbit(record: SatRec, rise: number, set: number):
  Pick<Pass, "path" | "trace" | "inclination" | "altitude" | "nadir" | "groundTrack"> | undefined {
  const midpoint = new Date((rise + set) / 2);
  const orientation = gstime(midpoint);
  const atPass = propagate(record, midpoint)?.position;
  if (!atPass || typeof atPass === "boolean" || record.no <= 0) return;
  const center = eciToGeodetic(atPass, orientation);
  const altitude = Math.round(center.height);
  const groundTrack: Pass["groundTrack"] = [];
  for (let i = 0; i < 4; i++) {
    const time = new Date(rise + i * (set - rise) / 3);
    const position = propagate(record, time)?.position;
    if (position && typeof position !== "boolean") groundTrack.push(eciToGeodetic(position, gstime(time)));
  }
  const period = 2 * Math.PI / record.no * 60_000;
  const path: Pass["path"] = [];
  const trace: Pass["trace"] = [];
  const tiltSin = Math.sin(earthTilt);
  const tiltCos = Math.cos(earthTilt);
  for (let step = 0; step <= 23; step++) {
    const time = rise + step * period / 23;
    const point = propagate(record, new Date(time))?.position;
    if (!point || typeof point === "boolean") return;
    // Freeze Greenwich orientation at the pass midpoint so Earth's rotation does not warp the ellipse.
    const { x, y, z } = eciToEcf(point, orientation);
    const distance = Math.hypot(x, y, z);
    if (!Number.isFinite(distance) || distance <= 0) return;
    // Expand low-orbit altitudes and compress high ones to fit one view on the OLED.
    const radius = earthRadius + Math.min(6, 2 + 2.2 * Math.log1p(Math.max(0, distance - 6371) / 500));
    const center: Point = [
      Math.round(earthCenter.x + radius * y / distance),
      Math.round(earthCenter.y - radius * (z * tiltCos - x * tiltSin) / distance),
    ];
    const depth = (x * tiltCos + z * tiltSin) / distance;
    const front = depth >= 0;
    path.push([center[0] - 6, center[1] - 3, Math.max(0, Math.min(255, Math.round(128 + depth * 127)))]);
    if (step % 6 === 0 && (front || Math.hypot(center[0] - earthCenter.x, center[1] - earthCenter.y) > earthRadius)) {
      trace.push({ position: center, front, bright: time <= set });
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
      let chosen: { rise: number; set: number; score: number; peak: number } | undefined;
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
              chosen = { rise, set: crossing(lookAt, time - cadence, time, false), score, peak };
            }
            rise = undefined;
          }
        } else if (!current) {
          rise = undefined;
        }
        previous = current;
      }
      if (!chosen) return [];
      const preview = previewOrbit(record, chosen.rise, chosen.set);
      const riseAngle = lookAt(chosen.rise);
      const setAngle = lookAt(chosen.set);
      if (!preview || !riseAngle || !setAngle) return [];
      const peakElevation = Math.max(chosen.peak, ...Array.from({ length: 19 }, (_, i) =>
        lookAt(chosen.rise + (chosen.set - chosen.rise) * (i + 1) / 20)?.elevation ?? 0));
      const name = orbit.name.toUpperCase().startsWith("CSS (TIANHE)") ? "TIANGONG" : orbit.name;
      return [{
        name, group: mission(orbit.name), rise: chosen.rise,
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

export function passAnimation(passes: Pass[]): GraphicAnimation | undefined {
  if (!passes.length) return;
  return {
    phase_ms: 30_000,
    phases: passes.map((pass) => {
      const date = new Date(pass.rise);
      const trace: Graphic[] = pass.trace.map(({ position: [x, y], front, bright }) =>
        [x, y, 1, bright ? 13 : front ? 8 : 4, [1]]);
      const sprite = pass.group <= 1 ? stationSprite : pass.group === 3 ? dishSprite
        : pass.group === 5 ? panelSprite : satelliteSprite;
      return [
        [3, 14, 1, 15, displayText(pass.name, 15)],
        [3, 26, 1, 10, `RISE ${weekday.format(date).toUpperCase()} ${londonClock.format(date)}`],
        [3, 38, 1, 15, `${pass.start} > ${pass.end}  ${Math.round(pass.peak)}DEG`],
        [3, 51, 1, 10, `INC ${pass.inclination.toFixed(1)}  ${pass.altitude}KM`],
        ...trace,
        ...nadirView(pass.nadir, pass.groundTrack),
        [1, 15, sprite, [earthCenter.x, earthCenter.y, earthRadius], Buffer.from(pass.path.flat()).toString("hex")],
      ];
    }),
  };
}
