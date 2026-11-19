import type { Graphic } from "./board.js";

export const earthCenter = { x: 106, y: 38 };
export const earthRadius = 10;
export const earthTilt = 24 * Math.PI / 180;

// Simplified coastline polygons for the illustrated globe, in longitude and latitude.
const continents = [
  [[-168,70],[-131,70],[-107,78],[-76,78],[-52,57],[-79,49],[-81,26],[-98,18],[-114,30],[-126,55]],
  [[-81,12],[-70,10],[-50,5],[-35,-8],[-48,-29],[-60,-45],[-68,-55],[-74,-34]],
  [[-74,59],[-56,59],[-22,70],[-19,80],[-54,85],[-71,76]],
  [[-11,36],[-9,44],[8,46],[4,53],[15,60],[19,71],[51,72],[71,77],[114,73],[154,62],[174,69],
    [162,53],[134,44],[123,24],[105,18],[98,27],[79,8],[67,25],[47,30],[31,41],[15,37]],
  [[-17,16],[-15,30],[3,37],[30,35],[40,17],[50,11],[40,-9],[32,-31],[19,-35],[8,-5],[-3,4],[-13,5]],
  [[112,-22],[125,-13],[142,-11],[154,-25],[148,-39],[130,-34],[115,-33]],
];

function inside(lon: number, lat: number, polygon: number[][]): boolean {
  let land = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [x, y] = polygon[i];
    const [a, b] = polygon[j];
    if ((y > lat) !== (b > lat) && lon < (a - x) * (lat - y) / (b - y) + x) land = !land;
  }
  return land;
}

const globe: Graphic[] = [];
const size = 11;
const radians = Math.PI / 180;
for (const [shade, layer] of [[5, "sea"], [11, "land"], [8, "rim"]] as const) {
  const rows = Array<number>(size).fill(0);
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const x = (u - 5) / 5;
      const y = (5 - v) / 5;
      const radius = x * x + y * y;
      if (radius > 1) continue;
      const z = Math.sqrt(1 - radius);
      const latitude = Math.asin(y * Math.cos(earthTilt) + z * Math.sin(earthTilt)) / radians;
      const longitude = Math.atan2(x, z * Math.cos(earthTilt) - y * Math.sin(earthTilt)) / radians;
      if (layer === "sea" || (layer === "rim" && radius >= 0.80)
        || (layer === "land" && continents.some((polygon) => inside(longitude, latitude, polygon)))) {
        rows[v] |= 1 << u;
      }
    }
  }
  globe.push([earthCenter.x - earthRadius, earthCenter.y - earthRadius, 2, shade, rows]);
}

export const earthGraphics = globe;
