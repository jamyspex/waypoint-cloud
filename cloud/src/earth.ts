import type { Graphic } from "./board.js";
import { isLand } from "./land.js";
import { packedBitmap } from "./packed.js";

export const earthCenter = { x: 102, y: 39 };
export const earthRadius = 12;
export const earthTilt = 24 * Math.PI / 180;

const cosTilt = Math.cos(earthTilt);
const sinTilt = Math.sin(earthTilt);

export function globeGraphics(center: { x: number; y: number }, radius: number): Graphic[] {
  const diameter = radius * 2 + 1;
  const stride = Math.ceil(diameter / 8);
  const relief = Buffer.alloc(stride * diameter);
  const daylight = Buffer.alloc(stride * diameter);
  const land = Buffer.alloc(stride * diameter);
  for (let py = 0; py < diameter; py++) {
    for (let px = 0; px < diameter; px++) {
      const x = (px - radius) / radius;
      const y = (radius - py) / radius;
      if (x * x + y * y > 1) continue;
      const z = Math.sqrt(1 - x * x - y * y);
      const light = -.43 * x + .42 * y + .78 * z;
      const bit = 1 << (px % 8);
      const offset = py * stride + Math.floor(px / 8);
      relief[offset] |= bit;
      if (light > .38) daylight[offset] |= bit;
      const latitude = Math.asin(y * cosTilt + z * sinTilt);
      const longitude = Math.atan2(x, z * cosTilt - y * sinTilt);
      if (light > .18 && isLand(latitude, longitude)) land[offset] |= bit;
    }
  }
  return ([[3, relief], [6, daylight], [12, land]] as const).flatMap(([shade, pixels]) =>
    packedBitmap(center.x - radius, center.y - radius, diameter, diameter, 1, shade, pixels));
}

export const earthGraphics = globeGraphics(earthCenter, earthRadius);
