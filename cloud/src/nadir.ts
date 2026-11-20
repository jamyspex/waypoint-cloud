import type { Graphic } from "./board.js";
import { isLand } from "./land.js";
import { packedBitmap } from "./packed.js";

type Vector = [number, number, number];
type Location = { latitude: number; longitude: number };
type Pixel = [number, number];
type ViewportMotion = [number, number, number[], [number, number, number, number, number], string];
const width = 128;
const height = 48;
const left = 128;
const top = 14;
const satellite = [8, 42, 127, 42, 8];
export const landShade = 4;
const samplesPerSide = 4;
const fullCoverage = samplesPerSide ** 2;

function unit(latitude: number, longitude: number): Vector {
  return [Math.cos(latitude) * Math.cos(longitude), Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude)];
}

function inside([x, y]: Pixel): boolean {
  return x >= 0 && x < width && y >= 0 && y < height;
}

function walk([x0, y0]: Pixel, [x1, y1]: Pixel, plot: (point: Pixel) => void) {
  if (Math.max(x0, x1) < 0 || Math.min(x0, x1) >= width
    || Math.max(y0, y1) < 0 || Math.min(y0, y1) >= height) return;
  const steps = Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let step = 0; step <= steps; step++) {
    const point: Pixel = [Math.round(x0 + (x1 - x0) * step / steps), Math.round(y0 + (y1 - y0) * step / steps)];
    if (inside(point)) plot(point);
  }
}

export function nadirView(center: Location, groundTrack: Location[], altitude: number, samples: number, zoom = 1,
  contextTrack?: Location[]): { graphics: Graphic[]; motion: ViewportMotion } {
  const { latitude: lat, longitude: lon } = center;
  const camera = unit(lat, lon);
  const east: Vector = [-Math.sin(lon), Math.cos(lon), 0];
  const north: Vector = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  let scale = zoom * Math.min(240, Math.max(148, 230 * Math.sqrt(420 / Math.max(250, altitude))));
  function landAt(x: number, y: number): number {
    const e = (x - centerX) / scale;
    const n = (centerY - y) / scale;
    const z = Math.sqrt(1 - e * e - n * n);
    const vx = camera[0] * z + east[0] * e + north[0] * n;
    const vy = camera[1] * z + east[1] * e + north[1] * n;
    const vz = camera[2] * z + north[2] * n;
    return Number(isLand(Math.asin(Math.max(-1, Math.min(1, vz))), Math.atan2(vy, vx)));
  }
  for (;;) {
    let coverage = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) coverage += landAt(x, y);
    }
    if ((coverage >= width * height / 48 && coverage <= width * height * 11 / 48) || scale <= 114 * zoom) break;
    scale = Math.max(114 * zoom, scale * .8);
  }

  function project(point: Vector): Pixel | undefined {
    if (dot(point, camera) < 0) return;
    return [Math.round(centerX + dot(point, east) * scale), Math.round(centerY - dot(point, north) * scale)];
  }

  // Sample a one-pixel border so the viewport itself cannot create a coastline.
  const stride = width + 2;
  const coverage = new Uint8Array(stride * (height + 2));
  for (let y = -1; y <= height; y++) {
    for (let x = -1; x <= width; x++) {
      let land = 0;
      for (let sy = 0; sy < samplesPerSide; sy++) {
        for (let sx = 0; sx < samplesPerSide; sx++) {
          land += landAt(x + (sx + .5) / samplesPerSide - .5, y + (sy + .5) / samplesPerSide - .5);
        }
      }
      coverage[(y + 1) * stride + x + 1] = land;
    }
  }
  const pixels = Buffer.alloc(width * height / 8);
  const soft = Buffer.alloc(pixels.length);
  const coast = Buffer.alloc(pixels.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y + 1) * stride + x + 1;
      const land = coverage[i];
      const adjacent = Math.min(coverage[i - 1], coverage[i + 1], coverage[i - stride], coverage[i + stride]);
      const inside = land >= fullCoverage / 2;
      const edge = Math.max(2 * Math.min(land, fullCoverage - land), inside ? fullCoverage / 2 - adjacent : 0);
      const bit = y * width + x;
      if (inside) pixels[bit >> 3] |= 1 << (bit & 7);
      if (edge >= 10) coast[bit >> 3] |= 1 << (bit & 7);
      else if (edge >= 4) soft[bit >> 3] |= 1 << (bit & 7);
    }
  }

  const route: Pixel[] = [];
  let last: Pixel | undefined;
  const projected = groundTrack.map((point) => project(unit(point.latitude, point.longitude)));
  const overview = contextTrack?.map((point) => project(unit(point.latitude, point.longitude))) ?? projected;
  for (const next of overview) {
    if (last && next) walk(last, next, (pixel) => {
      const tail = route.at(-1);
      if (!tail || tail[0] !== pixel[0] || tail[1] !== pixel[1]) route.push(pixel);
    });
    last = next;
  }
  const layer = [
    ...packedBitmap(left, top, width, height, 1, landShade, pixels),
    ...packedBitmap(left, top, width, height, 1, 7, soft),
    ...packedBitmap(left, top, width, height, 1, 10, coast),
  ];
  if (contextTrack && layer.length < 2) {
    const grid = Buffer.alloc(pixels.length);
    const drawGrid = (vertical: boolean, coordinate: number) => {
      let last: Pixel | undefined;
      const limit = vertical ? 90 : 180;
      for (let offset = -limit; offset <= limit; offset++) {
        const rad = Math.PI / 180;
        const next = project(unit((vertical ? offset : coordinate) * rad, (vertical ? coordinate : offset) * rad));
        if (last && next) walk(last, next, ([x, y]) => {
          if ((x + y) % 2 === 0) grid[y * (width / 8) + (x >> 3)] |= 1 << (x & 7);
        });
        last = next;
      }
    };
    for (let lon = -180; lon < 180; lon += 10) drawGrid(true, lon);
    for (let lat = -80; lat <= 80; lat += 10) drawGrid(false, lat);
    layer.push(...packedBitmap(left, top, width, height, 1, layer.length ? 5 : 3, grid));
  }
  const line = Buffer.alloc(pixels.length);
  for (let i = 0; i < route.length; i += 3) {
    const [x, y] = route[i];
    const bit = y * width + x;
    line[bit >> 3] |= 1 << (bit & 7);
  }
  layer.push(...packedBitmap(left, top, width, height, 1, 12, line));
  // Encode signed coordinates relative to the map, including points beyond its edges.
  const encode = (value: number) => Math.max(0, Math.min(255, value + 64));
  const path = Buffer.from(projected.flatMap((point) => point
    ? [encode(point[0] - 3), encode(point[1] - 2)] : [0, 0])).toString("hex");
  return { graphics: layer, motion: [1, 15, satellite, [left, top, width, height, samples], path] };
}
