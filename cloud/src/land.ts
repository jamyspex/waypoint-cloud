import { gunzipSync } from "node:zlib";
import { naturalEarthLand } from "./natural-earth-land.js";

const width = 5760;
const height = 2880;
const cells = gunzipSync(Buffer.from(naturalEarthLand, "base64"));

export function isLand(latitude: number, longitude: number): boolean {
  const x = Math.floor((longitude + Math.PI) * width / (2 * Math.PI)) % width;
  const y = Math.max(0, Math.min(height - 1, Math.floor((Math.PI / 2 - latitude) * height / Math.PI)));
  const pixel = y * width + x;
  return (cells[pixel >> 3] & (1 << (pixel & 7))) !== 0;
}
