import { displayText, londonClock, row, type Graphic, type Page } from "./board.js";
import type { Facts, Subject } from "./context.js";
import { textWidth } from "./font.js";

// "Did you know" screens presented by Blip, a small blocky pixel critter with a radio antenna.
// His body is drawn as static bitmaps; the parts that move are Frames sprites (looping frames,
// firmware with the Frames primitive): the antenna tip blinks, he blinks, talks and waves.
// Each fact gets its own pose.
type Pose = "talk" | "point" | "think" | "wave";

// 16 x 20 at scale 2. B body, R arm, H highlight, T antenna tip, A antenna, L legs, E eyes and mouth.
export const blipArt = [
  ".......TT.......",
  ".......TT.......",
  "........A.......",
  "........A.......",
  "........A.......",
  "....HHHHHHHH....",
  "...HBBBBBBBBB...",
  "...HBBBBBBBBB...",
  "...HBEEBBEEBB...",
  "...HBEEBBEEBB...",
  "...HBBBBBBBBB...",
  "...HBBBBBBBBB...",
  "...HBBMMMMBBB...",
  "...HBBBBBBBBB...",
  "...HBBBBBBBBB...",
  "....BBBBBBBBB...",
  ".....LL..LL.....",
  ".....LL..LL.....",
  ".....LL..LL.....",
  "....LLL..LLL....",
];
const arms: Record<Pose, [row: number, col: number][]> = {
  talk: [[9, 1], [9, 2], [10, 1], [11, 1], [12, 1], [9, 13], [9, 14], [10, 14], [11, 14], [12, 14]],
  point: [[9, 1], [10, 1], [11, 1], [12, 1], [9, 2], [8, 13], [8, 14], [8, 15], [7, 15]],
  think: [[9, 1], [10, 1], [11, 1], [12, 1], [9, 2], [10, 13], [9, 14], [8, 14], [7, 14], [6, 13]],
  wave: [[9, 1], [10, 1], [11, 1], [12, 1], [9, 2], [8, 13], [7, 14], [6, 14], [5, 15], [4, 15], [3, 15]],
};
// Mouth shapes: open while talking, a smile otherwise; thinking looks up and to the right.
const faces: Record<Pose, { eyes: [number, number][]; mouth: [number, number][] }> = {
  talk: { eyes: [[8, 5], [8, 6], [9, 5], [9, 6], [8, 9], [8, 10], [9, 9], [9, 10]], mouth: [[12, 6], [12, 7], [12, 8], [12, 9], [13, 7], [13, 8]] },
  point: { eyes: [[8, 6], [8, 7], [9, 6], [9, 7], [8, 10], [8, 11], [9, 10], [9, 11]], mouth: [[12, 6], [13, 7], [13, 8], [12, 9]] },
  think: { eyes: [[7, 6], [7, 7], [8, 6], [8, 7], [7, 10], [7, 11], [8, 10], [8, 11]], mouth: [[13, 7], [13, 8], [13, 9]] },
  wave: { eyes: [[8, 5], [8, 6], [9, 5], [9, 6], [8, 9], [8, 10], [9, 9], [9, 10]], mouth: [[12, 5], [13, 6], [13, 7], [13, 8], [13, 9], [12, 10]] },
};
const poses: Pose[] = ["talk", "point", "think", "wave"];

// Blip enters on the first fact, stays on screen doing something for the middle ones and leaves on the last.
type Entrance = "parachute" | "walk" | "jump";
type Idle = "scuttle" | "bounce";
type Exit = "walk" | "jump" | "zoom";
type Moves = { enter?: Entrance; idle?: Idle; leave?: Exit };

const scale = 2;
const rest: [number, number] = [4, 22];
const offset = 32; // MotionFrames path coordinates are offset so sprites can start off screen
const pathPoints = 12; // spread evenly over the 7.5 s phase, about 0.68 s apart
const phaseMs = 7500;
const faceMs = 375; // face loop of 8 frames: a mouth flap about every 0.75 s and a blink every 3 s
const armMs = 150;
const stepMs = 470; // legs: 16 frames span the whole phase

// Five-point moves into and out of the rest position.
const entering: Record<Entrance, [number, number][]> = {
  parachute: [[6, -20], [2, -4], [5, 10], [3, 18], rest],
  walk: [[-32, 22], [-20, 22], [-8, 22], [0, 22], rest],
  jump: [[4, 80], [4, 30], [4, 6], [4, 14], rest],
};
const leaving: Record<Exit, [number, number][]> = {
  walk: [rest, [-6, 22], [-16, 22], [-26, 22], [-32, 22]],
  jump: [rest, [4, 8], [4, 2], [4, 30], [4, 90]],
  zoom: [rest, [4, 18], [4, 4], [4, -14], [4, -32]],
};
const idling: Record<Idle, [number, number][]> = {
  scuttle: [0, 3, 6, 3, 0, -3, -4, -1, 2, 4, 1, 0].map((dx): [number, number] => [rest[0] + dx, rest[1]]),
  bounce: [0, -4, 0, -6, 0, -4, 0, 0, -3, 0, 0, 0].map((dy): [number, number] => [rest[0], rest[1] + dy]),
};

// Where Blip's top-left corner is at each of the 12 path points.
function route({ enter, idle, leave }: Moves): [number, number][] {
  if (idle) return idling[idle];
  const still = (count: number) => Array.from({ length: count }, () => rest);
  if (enter && leave) return [...entering[enter].slice(1), ...still(3), ...leaving[leave].slice(0, 5)].slice(0, pathPoints);
  if (enter) return [...entering[enter], ...still(pathPoints - 5)];
  if (leave) return [...still(pathPoints - 5), ...leaving[leave]];
  return still(pathPoints);
}

// Linear position along the path at a time in the phase, to know when Blip is walking sideways.
function xAt(path: [number, number][], ms: number): number {
  const position = Math.min(path.length - 1, ms / phaseMs * (path.length - 1));
  const i = Math.floor(position);
  const next = path[Math.min(i + 1, path.length - 1)];
  return path[i][0] + (next[0] - path[i][0]) * (position - i);
}

/** The moves for each fact: in, then idles, then out (both on a single fact), varied by subject. */
function movesFor(count: number, seed: number): Moves[] {
  const enter = (["parachute", "walk", "jump"] as const)[seed % 3];
  const leave = (["walk", "jump", "zoom"] as const)[Math.floor(seed / 3) % 3];
  const idles: Idle[] = seed % 2 ? ["scuttle", "bounce"] : ["bounce", "scuttle"];
  if (count === 1) return [{ enter, leave }];
  return Array.from({ length: count }, (_, i) => i === 0 ? { enter } : i === count - 1 ? { leave } : { idle: idles[(i - 1) % 2] });
}

export function rowsOf(points: [number, number][], from: number, to: number): number[] {
  const rows = Array.from({ length: to - from }, () => 0);
  for (const [y, x] of points) if (y >= from && y < to) rows[y - from] |= 1 << x;
  return rows;
}

const letters = (wanted: string) => blipArt.flatMap((line, y) => [...line].flatMap((char, x): [number, number][] => wanted.includes(char) ? [[y, x]] : []));
const waveHigh: [number, number][] = [[8, 13], [7, 14], [6, 14], [5, 15], [4, 15], [3, 15]];
const waveLow: [number, number][] = [[8, 13], [8, 14], [7, 15], [6, 15], [5, 15]];
const closedEyes: [number, number][] = [[9, 5], [9, 6], [9, 9], [9, 10]];
const closedMouth: [number, number][] = [[12, 6], [12, 7], [12, 8], [12, 9]];
export const standing: [number, number][] = [[16, 5], [16, 6], [17, 5], [17, 6], [18, 5], [18, 6], [19, 4], [19, 5], [19, 6],
  [16, 9], [16, 10], [17, 9], [17, 10], [18, 9], [18, 10], [19, 9], [19, 10], [19, 11]];
// A stride: one leg forward, one back.
export const striding: [number, number][] = [[16, 5], [16, 6], [17, 4], [17, 5], [18, 3], [18, 4], [19, 2], [19, 3], [19, 4],
  [16, 9], [16, 10], [17, 10], [17, 11], [18, 11], [18, 12], [19, 11], [19, 12], [19, 13]];
// A parachute canopy with rigging lines, drawn above Blip's head.
const canopy = [
  "....HHHHHHHH....",
  "..HHHHHHHHHHHH..",
  ".HHHHHHHHHHHHHH.",
  "HH.H..H..H..H.HH",
  ".#....#..#....#.",
  "..#...#..#...#..",
  "...#..#..#..#...",
].map((line) => [...line].reduce((bits, char, x) => char !== "." ? bits | (1 << x) : bits, 0));
const canopyRows = canopy.length;

function blip(pose: Pose, moves: Moves): Graphic[] {
  const path = route(moves);
  // A path for a layer whose first row is `row` rows below Blip's top, with the off-screen offset applied.
  const along = (row: number, up = 0): [number, number][] =>
    path.map(([x, y]) => [Math.max(0, Math.min(255, x + offset)), Math.max(0, Math.min(127, y + offset + row * scale - up))]);
  const loop = (count: number, make: (frame: number) => [number, number][], from: number, to: number) =>
    Array.from({ length: count }, (_, frame) => rowsOf(make(frame), from, to));
  const arm = pose === "wave" ? [] : arms[pose].filter(([, x]) => x >= 13);
  const otherArm = arms[pose].filter(([, x]) => x < 13);
  const face = faces[pose];
  // Legs stride whenever Blip is moving sideways during that 0.47 s step; scuttling shuffles quickly.
  const moving = (frame: number) => Math.abs(xAt(path, (frame + 1) * stepMs) - xAt(path, frame * stepMs)) > 0.5;
  const legs: Graphic = moves.idle === "scuttle"
    ? [scale, 7, loop(2, (frame) => frame ? striding : standing, 16, 20), along(16), 300]
    : [scale, 7, loop(16, (frame) => moving(frame) && frame % 2 === 1 ? striding : standing, 16, 20), along(16), stepMs];
  // Face, 8 frames: talking, a pause, then a blink.
  const faceFrames = loop(8, (frame) => [
    ...(frame === 6 ? closedEyes : face.eyes),
    ...(frame < 4 && frame % 2 === 1 ? closedMouth : face.mouth),
  ], 7, 14);
  const graphics: Graphic[] = [
    [scale, 7, [rowsOf(letters("A"), 0, 5)], along(0), 1000],
    legs,
    [scale, 12, [rowsOf([...letters("BEM"), ...otherArm, ...arm], 5, 16)], along(5), 1000],
    [scale, 15, [rowsOf(letters("H"), 5, 16)], along(5), 1000],
    [scale, 15, loop(2, (frame) => frame ? [] : letters("T"), 0, 2), along(0), 1200],
    [scale, 0, faceFrames, along(7), faceMs],
  ];
  if (pose === "wave") graphics.push([scale, 12, loop(4, (frame) => frame < 2 ? waveHigh : waveLow, 3, 10), along(3), armMs]);
  // The canopy rides above Blip until he lands (about 3.3 s), then is packed away for the rest of the fact.
  if (moves.enter === "parachute") graphics.push([scale, 13, [canopy, [0], [0]], along(0, canopyRows * scale), 3300]);
  return graphics;
}

export const bubbleTail = [0b100000, 0b110000, 0b111000, 0b111100, 0b111000, 0b110000, 0b100000].map((bits) => {
  // Mirror so the point faces left, towards Blip.
  let mirrored = 0;
  for (let x = 0; x < 6; x++) if (bits & (1 << x)) mirrored |= 1 << (5 - x);
  return mirrored;
});

export function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next) <= width) line = next;
    else {
      if (line) out.push(line);
      line = word;
      while (textWidth(line) > width) line = line.slice(0, -1);
    }
    if (out.length === lines) break;
  }
  if (line && out.length < lines) out.push(line);
  return out.slice(0, lines);
}

const fit = (text: string, pixels: number) => {
  while (text && textWidth(text) > pixels) text = text.slice(0, -1);
  return text.trimEnd();
};

/** A context screen that follows its parent card, in the parent's mode so long presses skip them together. */
export function contextPage(parent: { id: string; mode: Page["mode"] }, subject: Subject, facts: Facts, now: number): Page {
  const label = fit(displayText(subject.label, 24), 120);
  // "VIA GEMINI 3.8 FLASH + GOOGLE SEARCH", shortened step by step if it would run into the page counter.
  const model = facts.model ? displayText(facts.model.replace(/^models\//, "").replace(/[-_]+/g, " "), 24) : "";
  const via = facts.source || "GOOGLE SEARCH";
  const room = 251 - 46;
  const source = [
    model ? `VIA ${model} + ${via}` : `VIA ${via}`, model ? `${model} + ${via}` : via,
    model ? `VIA ${model} + SEARCH` : via, model ? `${model} + SEARCH` : via,
  ].find((text) => textWidth(text) <= room) ?? fit(model || via, room);
  const graphics: Graphic[] = [
    [41, 0, 213, 1, 6], [41, 63, 213, 1, 6], [40, 1, 1, 62, 6], [254, 1, 1, 62, 6],
    [34, 26, 1, 6, bubbleTail],
    [46, 3, 1, 13, "DID YOU KNOW?"], [251 - textWidth(label), 3, 1, 9, label],
    [44, 12, 208, 1, 3],
    [46, 55, 1, 5, source],
  ];
  const list = facts.facts.slice(0, 4);
  const seed = [...subject.key].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7);
  const moves = movesFor(list.length, seed);
  // Progress pips on the divider: dim for every fact, lit for the one being shown.
  const pip = (i: number): [number, number] => [252 - (list.length - i) * 7, 11];
  if (list.length > 1) for (let i = 0; i < list.length; i++) graphics.push([...pip(i), 5, 3, 5]);
  const phases = list.map((fact, i): Graphic[] => [
    ...blip(i === list.length - 1 && list.length > 1 ? "wave" : poses[i % 3], moves[i]),
    ...wrap(fact, 204, 4).map((line, n): Graphic => [46, 15 + n * 10, 1, 15, line]),
    ...(list.length > 1 ? [[...pip(i), 5, 3, 15] as Graphic] : []),
  ]);
  return {
    id: `ctx-${parent.id}`.slice(0, 24), mode: parent.mode, title: "DID YOU KNOW", updated: londonClock.format(now), state: "live",
    rows: [row("", displayText(facts.headline || subject.label, 48), "")],
    graphics, animation: { phase_ms: 7500, phases },
  };
}
