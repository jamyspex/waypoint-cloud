import { gunzipSync } from "node:zlib";
import type { Graphic } from "./board.js";
import { naturalEarth } from "./natural-earth.js";

type Vector = [number, number, number];
type Location = { latitude: number; longitude: number };
const width = 64;
const height = 24;
const left = 128;
const top = 14;

function unit(latitude: number, longitude: number): Vector {
  return [Math.cos(latitude) * Math.cos(longitude), Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude)];
}

const raw = gunzipSync(Buffer.from(naturalEarth, "base64"));
const geography: Vector[][] = [];
let line: Vector[] = [];
for (let offset = 0; offset < raw.length; offset += 4) {
  const lon = raw.readInt16LE(offset);
  if (lon === -32768) {
    if (line.length) geography.push(line);
    line = [];
  } else {
    line.push(unit(raw.readInt16LE(offset + 2) * Math.PI / 1800, lon * Math.PI / 1800));
  }
}

export function nadirView(center: Location, groundTrack: Location[]): Graphic[] {
  const { latitude: lat, longitude: lon } = center;
  const camera = unit(lat, lon);
  const east: Vector = [-Math.sin(lon), Math.cos(lon), 0];
  const north: Vector = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const track = groundTrack.map((point) => unit(point.latitude, point.longitude));
  const minScale = (extent: number, axis: Vector) =>
    extent / Math.max(0.01, ...track.map((point) => Math.abs(dot(point, axis))));
  const scale = Math.min(72, minScale(width / 2 - 3, east), minScale(height / 2 - 3, north));
  function project(point: Vector): [number, number] | undefined {
    if (dot(point, camera) < 0) return;
    return [Math.round((width - 1) / 2 + dot(point, east) * scale),
      Math.round((height - 1) / 2 - dot(point, north) * scale)];
  }

  const stride = Math.ceil(width / 8);
  const pixels = Buffer.alloc(stride * height);
  function draw([x0, y0]: [number, number], [x1, y1]: [number, number]) {
    if (Math.max(x0, x1) < 0 || Math.min(x0, x1) >= width
      || Math.max(y0, y1) < 0 || Math.min(y0, y1) >= height) return;
    const steps = Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let step = 0; step <= steps; step++) {
      const x = Math.round(x0 + (x1 - x0) * step / steps);
      const y = Math.round(y0 + (y1 - y0) * step / steps);
      if (x >= 0 && x < width && y >= 0 && y < height) pixels[y * stride + (x >> 3)] |= 1 << (x & 7);
    }
  }
  for (const boundary of geography) {
    let previous: [number, number] | undefined;
    for (const point of boundary) {
      const next = project(point);
      if (previous && next) draw(previous, next);
      previous = next;
    }
  }
  const marks: Graphic[] = [];
  for (const [index, point] of track.entries()) {
    const pixel = project(point);
    if (!pixel) continue;
    const [x, y] = pixel;
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    marks.push([left + x * 2, top + y * 2, 2, 2, index === 0 ? 15 : 12]);
  }
  return [[left, top, width, height, 2, 8, pixels.toString("hex")], ...marks];
}
