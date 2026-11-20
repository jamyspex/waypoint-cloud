import type { Graphic } from "./board.js";
import { packedBitmap } from "./packed.js";

type Point = [number, number];
type Engines = "jet" | "four" | "rear" | "turboprop" | "four-prop" | "piston" | "rotor" | "delta";
type Profile = {
  length: number; depth: number; nose: number; tail: number; engines: Engines;
  deck?: "hump" | "full"; highWing?: boolean; tTail?: boolean; tanker?: boolean; canards?: boolean;
};

const jet: Profile = { length: 76, depth: 7, nose: 10, tail: 12, engines: "jet" };

function profileFor(type: string, category: string): Profile | undefined {
  if (category === "A7" || /^(EC|AS[35]|R[24][24]|H1[2345]|B(06|47)|S(76|92)|A(109|139|169)|H60|EH10|NH90|CH47|AW)/.test(type)) {
    return { ...jet, length: 68, engines: "rotor" };
  }
  if (/^(K35R|K35E|C135|R135|E3TF|E3CF|B703|KC10|DC10|MD11)/.test(type)) {
    return { ...jet, length: 82, depth: 7, nose: 11, tail: 13, engines: /^(KC10|DC10|MD11)/.test(type) ? "jet" : "four",
      tanker: /^(K35R|K35E|KC10)/.test(type) };
  }
  if (/^B74/.test(type)) return { ...jet, length: 86, depth: 8, nose: 12, tail: 14, engines: "four", deck: "hump" };
  if (type === "A388") return { ...jet, length: 86, depth: 11, nose: 10, tail: 14, engines: "four", deck: "full" };
  if (/^(A33|A34|A35|B76|B77|B78|K46|A3ST)/.test(type)) {
    return { ...jet, length: 85, depth: 8, nose: /^A35/.test(type) ? 13 : 11, engines: /^A34/.test(type) ? "four" : "jet",
      tanker: type === "K46" };
  }
  if (/^(A31[89]|A32[01]|A(19|20|21)N|B73|B3[789]M|B752|B753|BCS|E1[679]|E2[79]|P8)/.test(type)) {
    return { ...jet, length: /^(A318|A319|B736|B737|E17)/.test(type) ? 70 : /^(A321|A21N|B753)/.test(type) ? 82 : 76,
      nose: /^B/.test(type) ? 12 : 10, depth: /^E/.test(type) ? 6 : 7 };
  }
  if (/^(CRJ|CL[36]|GLF|GL[57E]|F[0-9]{3}|C5[02556]|C68|E50|E55|LJ|FA[5789]|H25)/.test(type)) {
    return { ...jet, length: 66, depth: 6, nose: 9, engines: "rear", tTail: !/^(GLF|GL[57E]|FA|C68)/.test(type) };
  }
  if (/^(AT[47]|DH[78]|SF34|JS[34]|B190|BE[23]|C130|A400|SW4|D328)/.test(type)) {
    return { ...jet, length: 72, depth: /^A400|^C130/.test(type) ? 9 : 7, nose: 8,
      engines: /^(A400|C130)/.test(type) ? "four-prop" : "turboprop",
      highWing: /^(AT|DH|A400|C130|D328)/.test(type), tTail: /^(AT|DH|A400|D328)/.test(type) };
  }
  if (/^(C1[2578]|C20[68]|CH7|PA[234]|SR2|DA[45]|P28|PC12|TBM|BE[3-9][0-9]|M20)/.test(type) || category === "A1") {
    return { ...jet, length: 56, depth: 8, nose: 6, tail: 18, engines: "piston", highWing: /^(C1|C20|CH7)/.test(type) };
  }
  if (/^(CONC|EUFI|F16|F18|F15|F35|F22|RFAL|JAS|TOR|HAWK|A10)/.test(type) || category === "A6") {
    return { ...jet, length: 72, nose: 20, depth: 5, tail: 8, engines: "delta", canards: /^(EUFI|RFAL|JAS)/.test(type) };
  }
  return type || /^A[2356]$/.test(category) ? jet : undefined;
}

const width = 88;
const height = 31;
// Five tones: highlight, body, shadow, dark detail and glass.
const [LIGHT, BODY, SHADE, DARK, GLASS] = [15, 12, 9, 6, 3];

class Art {
  readonly pixels = new Uint8Array(width * height);
  constructor(private readonly left: number) {}

  put(x: number, y: number, shade: number): void {
    x = Math.round(x) + this.left;
    y = Math.round(y);
    if (x >= 0 && x < width && y >= 0 && y < height) this.pixels[y * width + x] = shade;
  }

  fill(shade: number, points: Point[]): void {
    for (let y = 0; y < height; y++) {
      const crossings = points.flatMap(([x1, y1], i) => {
        const [x2, y2] = points[(i + 1) % points.length];
        return (y1 > y + .5) !== (y2 > y + .5) ? [x1 + (x2 - x1) * (y + .5 - y1) / (y2 - y1)] : [];
      }).sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        for (let x = Math.ceil(crossings[i] - .5); x < crossings[i + 1] - .5; x++) this.put(x, y, shade);
      }
    }
  }

  line(shade: number, [x0, y0]: Point, [x1, y1]: Point): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= steps; i++) this.put(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, shade);
  }

  // A shaded oval, lit from above like the fuselage.
  pod(cx: number, cy: number, rx: number, ry: number, intake = true): void {
    // A dark rim keeps the pod distinct where it overlaps the fuselage or wing.
    for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
      for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
        if (((x - cx) / (rx + .9)) ** 2 + ((y - cy) / (ry + .9)) ** 2 <= 1) this.put(x, y, DARK);
      }
    }
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
        const f = (y - (cy - ry)) / (2 * ry);
        this.put(x, y, f < .3 ? LIGHT : f < .7 ? BODY : SHADE);
      }
    }
    if (!intake) return;
    for (let y = Math.ceil(cy - ry + 1); y <= Math.floor(cy + ry - 1); y++) this.put(cx - rx + 1, y, GLASS);
    for (let y = Math.ceil(cy - ry + 2); y <= Math.floor(cy + ry - 1); y++) this.put(cx + rx, y, DARK);
  }

  layers(): Graphic[] {
    return [LIGHT, BODY, SHADE, DARK, GLASS].flatMap((shade) => {
      const layer = Buffer.alloc(width / 8 * height);
      this.pixels.forEach((value, i) => {
        if (value === shade) layer[i >> 3] |= 1 << (i & 7);
      });
      return packedBitmap(167, 10, width, height, 1, shade, layer);
    });
  }
}

// Fuselage drawn column by column: elliptical nose, straight body and a tail cone whose belly sweeps up.
function fuselage(art: Art, profile: Profile, top: number): { tops: number[]; bottoms: number[] } {
  const { length, depth, nose, tail, deck } = profile;
  const mid = top + depth / 2;
  const tops: number[] = [];
  const bottoms: number[] = [];
  const ellipse = (x: number, reach: number) => Math.sqrt(Math.max(0, 1 - ((reach - x) / reach) ** 2));
  for (let x = 0; x < length; x++) {
    const cx = x + .5;
    let t = top;
    let b = top + depth;
    if (cx < nose) {
      t = mid - depth / 2 * ellipse(cx, nose);
      b = mid + depth / 2 * ellipse(cx, nose * .6);
    }
    if (cx > length - tail) {
      const k = (cx - (length - tail)) / tail;
      b = top + depth - k * (depth - 2.5);
      t = top + k * k * 1.2;
    }
    if (deck === "hump") {
      const hump = nose + 22;
      const rise = cx < nose ? ellipse(cx, nose) : cx < hump * .7 ? 1 : Math.max(0, 1 - (cx - hump * .7) / (hump * .3));
      t = Math.min(t, top - 3.5 * rise);
    }
    tops.push(t);
    bottoms.push(b);
    for (let y = Math.ceil(t - .3); y <= Math.floor(b); y++) {
      const f = (y - t) / Math.max(1, b - t);
      art.put(x, y, f < .28 ? LIGHT : f < .72 ? BODY : SHADE);
    }
  }
  return { tops, bottoms };
}

function fin(art: Art, length: number, tail: number, top: number, high: number, tTail: boolean): void {
  const base = length - tail - 2;
  const peak = Math.max(1, top - high);
  const front = base + (top - peak) * 1.05;
  art.fill(SHADE, [[base, top + 1], [front, peak], [length + 1, peak], [length, top + 2]]);
  art.line(BODY, [base, top + 1], [front, peak]);
  if (tTail) {
    art.fill(BODY, [[front - 4, peak], [length + 3, peak], [length + 2, peak + 1.6], [front - 2, peak + 1.6]]);
    art.line(LIGHT, [front - 4, peak], [length + 3, peak]);
  }
}

function stabiliser(art: Art, length: number, tail: number, y: number): void {
  art.fill(DARK, [[length - tail * .75, y], [length - 3, y - 1.5], [length + 2, y + 1.2], [length - 5, y + 2]]);
  art.line(SHADE, [length - tail * .75, y], [length - 3, y - 1.5]);
}

function windows(art: Art, from: number, to: number, y: number): void {
  for (let x = Math.round(from); x < to; x += 2) art.put(x, y, GLASS);
}

function windscreen(art: Art, nose: number, tops: number[]): void {
  for (let i = 0; i < 4; i++) {
    const x = nose - 4 + i;
    art.put(x, Math.ceil(tops[Math.max(0, x)] ?? 0) + (i === 0 ? 2 : 1), GLASS);
  }
}

function airliner(art: Art, profile: Profile): void {
  const { length, depth, nose, tail, engines, deck, highWing, tTail, tanker } = profile;
  const top = deck ? 12 : depth >= 9 ? 11 : 12;
  fin(art, length, tail, top, tail + (deck ? 0 : 1), Boolean(tTail));
  const { tops, bottoms } = fuselage(art, profile, top);
  if (!tTail) stabiliser(art, length, tail, top + depth * .35);

  const cabinEnd = length - tail - 1;
  if (deck === "full") {
    windows(art, nose + 2, cabinEnd, top + Math.round(depth * .3));
    windows(art, nose + 3, cabinEnd - 2, top + Math.round(depth * .62));
  } else {
    windows(art, nose + 4, cabinEnd, top + Math.round(depth * .38));
    if (deck === "hump") windows(art, nose + 1, nose + 15, top - 1);
  }
  windscreen(art, deck === "hump" ? nose - 2 : nose, tops);

  const wingX = Math.round(length * .36);
  const chord = Math.round(length * .2);
  const sweep = Math.round(length * .12);
  const prop = engines === "turboprop" || engines === "four-prop";
  if (highWing) {
    art.line(DARK, [wingX - 2, top + 2], [wingX + chord + 1, top + 2]);
    art.fill(SHADE, [[wingX - 2, top - 1], [wingX + chord, top - 1], [wingX + chord + 1, top + 1.5], [wingX - 1, top + 1.5]]);
    art.line(LIGHT, [wingX - 2, top - 1.5], [wingX + chord, top - 1.5]);
  } else {
    const root = bottoms[wingX] - 1.5;
    const drop = root + 7;
    art.fill(SHADE, [[wingX, root], [wingX + chord, root], [wingX + chord + sweep, drop], [wingX + sweep + chord * .45, drop]]);
    art.line(BODY, [wingX, root], [wingX + sweep + chord * .45, drop]);
  }

  if (engines === "rear") {
    const pod = Math.max(9, length * .15);
    art.pod(length - tail - pod / 2 + 3, top + .5, pod / 2, 2.2);
  } else if (prop) {
    const pods = engines === "four-prop" ? [wingX - 5, wingX + chord * .55] : [wingX - 3];
    pods.forEach((x, i) => {
      const cy = top + 3.5 + i;
      art.pod(x + 6, cy, 6, 2, false);
      art.line(DARK, [x - 1, cy - 6], [x - 1, cy + 6]);
      art.put(x - 1, cy, LIGHT);
    });
  } else if (engines !== "delta") {
    const pod = Math.max(9, Math.round(length * .15));
    const root = bottoms[wingX];
    const pods = engines === "four" ? [[wingX - pod * .55, root + 2.5], [wingX - pod * .55 + sweep * .9, root + 5.5]] : [[wingX - pod * .45 + 1, root + 3]];
    for (const [x, cy] of pods) {
      art.line(SHADE, [x + pod * .6, cy - 2], [x + pod * .75, cy - 4]);
      art.pod(x + pod / 2, cy, pod / 2, 2.4);
    }
  }
  if (tanker) {
    const from: Point = [length - tail - 1, bottoms[length - tail - 1]];
    art.line(SHADE, from, [length + 4, from[1] + 9]);
    art.line(DARK, [length + 2, from[1] + 7], [length + 5, from[1] + 6]);
  }
}

function lightAircraft(art: Art, profile: Profile): void {
  const { length, depth, nose, tail, highWing } = profile;
  const top = 13;
  fin(art, length, tail * .6, top + 1, 9, false);
  const { tops, bottoms } = fuselage(art, profile, top);
  stabiliser(art, length, tail * .7, top + 3);
  for (const [from, to] of [[nose + 6, nose + 10], [nose + 12, nose + 16]]) {
    for (let x = from; x <= to; x++) for (let y = top + 1; y <= top + 3; y++) art.put(x, y, GLASS);
  }
  art.line(GLASS, [nose + 3, top + 4], [nose + 5, Math.ceil(tops[nose + 5])]);
  const wingX = nose + 7;
  if (highWing) {
    art.fill(SHADE, [[wingX, top - 1.5], [wingX + 15, top - 1.5], [wingX + 15, top + .5], [wingX, top + .5]]);
    art.line(LIGHT, [wingX, top - 2], [wingX + 15, top - 2]);
    art.line(DARK, [wingX + 10, top + 1], [wingX + 4, bottoms[wingX + 4] - 1]);
  } else {
    const root = bottoms[wingX] - 1;
    art.fill(SHADE, [[wingX, root], [wingX + 15, root], [wingX + 17, root + 3], [wingX + 1, root + 3]]);
    art.line(BODY, [wingX, root], [wingX + 1, root + 3]);
  }
  const ground = top + depth + 5;
  art.line(DARK, [wingX + 4, bottoms[wingX + 4]], [wingX + 3, ground - 1]);
  art.line(DARK, [4, bottoms[4]], [4, ground - 1]);
  for (const x of [wingX + 3, 4]) art.pod(x, ground, 1.6, 1.6, false);
  const mid = top + depth / 2;
  art.line(DARK, [-2, mid - 7], [-2, mid + 7]);
  art.fill(LIGHT, [[-1, mid - 1], [1, mid - 1.5], [1, mid + 1.5], [-1, mid + 1]]);
}

function fighter(art: Art, profile: Profile): void {
  const { length, depth, nose, tail, canards } = profile;
  const top = 15;
  const mid = top + depth / 2;
  art.fill(SHADE, [[length - 17, top + 1], [length - 8, top - 11], [length - 3, top - 11], [length - 1, top + 1]]);
  art.line(BODY, [length - 17, top + 1], [length - 8, top - 11]);
  const { bottoms } = fuselage(art, profile, top);
  // Delta wing seen from slightly below: a broad swept triangle under the body.
  art.fill(DARK, [[length * .36, mid + 1.5], [length - 3, mid + 1.5], [length - 5, bottoms[length - 6] + 6.5], [length * .66, bottoms[length - 20] + 4.5]]);
  art.fill(SHADE, [[length * .38, mid + 1], [length - 4, mid + 1], [length - 6, bottoms[length - 6] + 5.5], [length * .66, bottoms[length - 20] + 3.5]]);
  art.line(LIGHT, [length * .38, mid + 1], [length * .66, bottoms[length - 20] + 3.5]);
  if (canards) art.fill(SHADE, [[nose + 6, mid], [nose + 11, mid], [nose + 12, mid + 2.5]]);
  art.fill(DARK, [[nose + 9, bottoms[nose + 9]], [nose + 19, bottoms[nose + 19]], [nose + 19, bottoms[nose + 19] + 2.5], [nose + 10, bottoms[nose + 10] + 2.5]]);
  art.line(GLASS, [nose + 9, bottoms[nose + 9] + .5], [nose + 9, bottoms[nose + 9] + 2]);
  for (let x = nose - 1; x <= nose + 9; x++) {
    const h = Math.sqrt(Math.max(0, 1 - ((x - nose - 4) / 5.5) ** 2)) * 3;
    for (let y = Math.round(top - h); y < top + 1; y++) art.put(x, y, y === Math.round(top - h) && x > nose + 1 && x < nose + 6 ? SHADE : GLASS);
  }
  art.fill(DARK, [[length - 1, mid - 1.5], [length + 2, mid - 2], [length + 2, mid + 2], [length - 1, mid + 1.5]]);
  void tail;
}

function helicopter(art: Art): void {
  const [cx, cy, rx, ry] = [24, 19, 15, 6.5];
  art.fill(SHADE, [[cx + 10, cy - 3.5], [66, cy - 5.5], [66, cy - 3.5], [cx + 10, cy + 2]]);
  art.line(BODY, [cx + 10, cy - 3.5], [66, cy - 5.5]);
  art.fill(SHADE, [[62, cy - 5], [66, cy - 12], [69, cy - 12], [68, cy - 4]]);
  art.line(BODY, [62, cy - 5], [66, cy - 12]);
  for (let a = 0; a < 24; a++) art.put(68 + Math.cos(a / 24 * 2 * Math.PI) * 4, cy - 7 + Math.sin(a / 24 * 2 * Math.PI) * 4, DARK);
  art.put(68, cy - 7, LIGHT);
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const inside = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      if (!inside) continue;
      const canopy = x < cx - 5 && y > cy - ry + 1.5 && y < cy + 2.5;
      const f = (y - (cy - ry)) / (2 * ry);
      art.put(x, y, canopy ? GLASS : f < .3 ? LIGHT : f < .72 ? BODY : SHADE);
    }
  }
  art.line(BODY, [cx - 5, cy - 4], [cx - 5, cy + 2]);
  for (let x = cx + 1; x < cx + 9; x += 3) art.put(x, cy - 1, GLASS);
  art.fill(BODY, [[cx - 4, cy - 6.5], [cx + 9, cy - 6.5], [cx + 11, cy - 4.5], [cx - 4, cy - 4.5]]);
  art.line(LIGHT, [cx - 4, cy - 7], [cx + 9, cy - 7]);
  art.line(DARK, [cx + 2, cy - 10], [cx + 2, cy - 7.5]);
  art.line(SHADE, [cx - 24, cy - 10.5], [cx + 34, cy - 10.5]);
  art.put(cx + 2, cy - 11, LIGHT);
  art.put(cx + 1, cy - 11, LIGHT);
  art.line(DARK, [cx - 7, cy + ry - 1], [cx - 8, cy + 9]);
  art.line(DARK, [cx + 6, cy + ry - 1], [cx + 7, cy + 9]);
  art.line(SHADE, [cx - 13, cy + 9.5], [cx + 11, cy + 9.5]);
  art.put(cx - 14, cy + 8.5, SHADE);
}

export function aircraftDrawing(type: string, category: string): Graphic[] {
  const profile = profileFor(type, category);
  if (!profile) return [];
  const art = new Art(Math.floor((width - profile.length) / 2) - (profile.tanker ? 2 : 0));
  if (profile.engines === "rotor") helicopter(art);
  else if (profile.engines === "piston") lightAircraft(art, profile);
  else if (profile.engines === "delta") fighter(art, profile);
  else airliner(art, profile);
  return art.layers();
}
