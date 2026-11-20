import type { Graphic } from "./board.js";

export function packedBitmap(
  left: number, top: number, width: number, height: number, scale: number, shade: number, pixels: Buffer,
): Graphic[] {
  const stride = Math.ceil(width / 8);
  const set = (x: number, y: number) => (pixels[y * stride + (x >> 3)] & (1 << (x & 7))) !== 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!set(x, y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return [];
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const croppedStride = Math.ceil(w / 8);
  const cropped = Buffer.alloc(croppedStride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (set(x + minX, y + minY)) cropped[y * croppedStride + (x >> 3)] |= 1 << (x & 7);
    }
  }
  return [[left + minX * scale, top + minY * scale, w, h, scale, shade, cropped.toString("hex")]];
}
