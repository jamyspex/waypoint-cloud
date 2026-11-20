import type { Graphic } from "./board.js";
import { packedBitmap } from "./packed.js";

type Point = [number, number];
type Engines = "jet" | "four" | "rear" | "turboprop" | "four-prop" | "piston" | "rotor" | "delta";
type Profile = {
  length: number; depth: number; nose: number; tail: number; engines: Engines;
  deck?: "hump" | "full"; highWing?: boolean; tTail?: boolean;
};

const jet: Profile = { length: 76, depth: 7, nose: 10, tail: 12, engines: "jet" };

function profileFor(type: string, category: string): Profile | undefined {
  if (category === "A7" || /^(EC|AS[35]|R[24][24]|H1[2345]|B(06|47)|S(76|92)|A(109|139|169))/.test(type)) {
    return { ...jet, length: 68, engines: "rotor" };
  }
  if (/^B74/.test(type)) return { ...jet, length: 86, depth: 9, nose: 12, tail: 14, engines: "four", deck: "hump" };
  if (type === "A388") return { ...jet, length: 86, depth: 12, nose: 9, tail: 14, engines: "four", deck: "full" };
  if (/^(A33|A34|A35|B76|B77|B78)/.test(type)) {
    return { ...jet, length: 85, depth: 9, nose: /^A35/.test(type) ? 13 : 11, engines: /^A34/.test(type) ? "four" : "jet" };
  }
  if (/^(A31[89]|A32[01]|A(19|20|21)N|B73|B3[789]M|B752|B753|BCS|E1[679]|E2[79])/.test(type)) {
    return { ...jet, length: /^(A318|A319|B736|B737|E17)/.test(type) ? 69 : /^(A321|A21N|B753)/.test(type) ? 83 : 76,
      nose: /^B/.test(type) ? 13 : 9, depth: /^E/.test(type) ? 6 : 7 };
  }
  if (/^(CRJ|CL[36]|GLF|F[0-9]{3}|C5[02556]|E50|LJ)/.test(type)) {
    return { ...jet, length: 68, depth: 6, engines: "rear", tTail: true };
  }
  if (/^(AT[47]|DH[78]|SF34|JS[34]|B190|BE[23]|C130|A400)/.test(type)) {
    return { ...jet, length: 73, depth: /^A400|^C130/.test(type) ? 9 : 7, nose: 8,
      engines: /^(A400|C130)/.test(type) ? "four-prop" : "turboprop",
      highWing: /^(AT|DH|A400|C130)/.test(type), tTail: /^(AT|DH|A400)/.test(type) };
  }
  if (/^(C1[2578]|C20[68]|CH7|PA[234]|SR2|DA[45]|P28|PC12|TBM)/.test(type) || category === "A1") {
    return { ...jet, length: 56, depth: 8, nose: 7, tail: 8, engines: "piston", highWing: /^(C1|C20|CH7)/.test(type) };
  }
  if (/^(CONC|EUFI|F16|F18|F35|RFAL|JAS)/.test(type)) {
    return { ...jet, nose: 19, depth: 5, engines: "delta" };
  }
  return type || /^A[2356]$/.test(category) ? jet : undefined;
}

export function aircraftDrawing(type: string, category: string): Graphic[] {
  const profile = profileFor(type, category);
  if (!profile) return [];
  const { length, depth, nose, tail, engines, deck, highWing, tTail } = profile;
  const width = 88;
  const height = 31;
  const stride = width / 8;
  const pixels = new Uint8Array(width * height);
  const left = Math.floor((width - length) / 2);
  const top = depth >= 9 ? 11 : 14;
  const bottom = top + depth;
  const put = (x: number, y: number, shade: number) => {
    x += left;
    if (x >= 0 && x < width && y >= 0 && y < height) pixels[y * width + x] = shade;
  };
  function fill(shade: number, points: Point[]) {
    for (let y = 0; y < height; y++) {
      const crossings = points.flatMap(([x1, y1], i) => {
        const [x2, y2] = points[(i + 1) % points.length];
        return (y1 > y + .5) !== (y2 > y + .5) ? [x1 + (x2 - x1) * (y + .5 - y1) / (y2 - y1)] : [];
      }).sort((a, b) => a - b);
      for (let i = 0; i < crossings.length; i += 2) {
        for (let x = Math.ceil(crossings[i]); x < crossings[i + 1]; x++) put(x, y, shade);
      }
    }
  }
  function rect(shade: number, x: number, y: number, w: number, h: number) {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) put(x + dx, y + dy, shade);
  }

  if (engines === "rotor") {
    fill(14, [[6, 20], [11, 13], [18, 10], [32, 10], [42, 16], [63, 13], [65, 8], [67, 8],
      [65, 17], [44, 22], [35, 25], [12, 25], [6, 23]]);
    rect(14, 23, 6, 4, 5);
    rect(14, 0, 5, 53, 1);
    rect(9, 64, 10, 1, 10);
    fill(5, [[10, 20], [15, 14], [21, 13], [20, 20]]);
    rect(5, 24, 14, 6, 5);
    rect(9, 16, 25, 2, 4);
    rect(9, 33, 25, 2, 4);
    rect(14, 11, 29, 27, 1);
  } else {
    const wing = Math.round(length * .41);
    const fin = Math.round(length * .77);
    const finTop = Math.max(1, top - tail);
    fill(9, [[fin - 6, top + 1], [fin + 5, finTop], [fin + 10, finTop], [fin + 11, top + 5]]);
    if (tTail) rect(14, fin + 2, finTop + 2, 13, 2);
    const roof: Point[] = deck === "hump"
      ? [[nose, top - 5], [nose + 15, top - 5], [nose + 24, top]]
      : [[nose, top]];
    fill(14, [[0, top + 5], [3, deck === "hump" ? top - 1 : top + 2], ...roof,
      [length - 18, top], [length - 9, top + 2], [length, top + 3], [length - 7, top + 6],
      [length - 17, bottom], [nose - 2, bottom], [4, bottom - 1], [0, bottom - 3]]);
    const wingTop = highWing ? top + 1 : bottom - 3;
    fill(9, [[wing, wingTop], [wing + 15, wingTop], [wing + 25, bottom + 5], [wing + 19, bottom + 6]]);
    if (!tTail) fill(9, [[length - 22, top + 5], [length - 13, top + 4], [length - 1, top + 8], [length - 9, top + 8]]);
    if (engines === "rear") {
      fill(9, [[length - 23, top + 1], [length - 8, top + 1], [length - 10, top + 6], [length - 23, top + 6]]);
      rect(5, length - 22, top + 2, 2, 3);
    } else if (engines === "piston") {
      rect(14, -1, top + 1, 1, depth + 4);
      fill(5, [[nose, top + 1], [nose + 14, top + 1], [nose + 14, top + 5], [nose - 2, top + 5]]);
    } else if (engines !== "delta") {
      const prop = engines === "turboprop" || engines === "four-prop";
      const pods = engines === "four" || engines === "four-prop" ? [wing - 2, wing + 15] : [wing + 2];
      for (const [i, x] of pods.entries()) {
        const y = (prop ? wingTop + 1 : bottom + 1) + i * 2;
        fill(14, [[x, y], [x + 9, y], [x + 12, y + 2], [x + 10, y + 5], [x, y + 5], [x - 1, y + 3]]);
        rect(5, x, y + 1, 2, 3);
        if (prop) rect(14, x - 2, y - 4, 1, 13);
      }
    }
    if (engines !== "piston") {
      const cockpit = deck === "hump" ? top - 2 : top + 2;
      fill(5, [[5, cockpit + 1], [nose + 1, cockpit - 1], [nose + 3, cockpit - 1], [nose + 3, cockpit + 2], [5, cockpit + 2]]);
      if (engines !== "delta") {
        for (let x = nose + 7; x < length - 18; x += 3) {
          rect(5, x, top + (deck === "full" ? 7 : 3), 1, 1);
          if (deck === "full" || (deck === "hump" && x < nose + 17)) rect(5, x, cockpit, 1, 1);
        }
      }
    }
  }

  return [14, 9, 5].flatMap((shade) => {
    const layer = Buffer.alloc(stride * height);
    pixels.forEach((value, i) => {
      if (value === shade) layer[i >> 3] |= 1 << (i & 7);
    });
    return packedBitmap(167, 10, width, height, 1, shade, layer);
  });
}
