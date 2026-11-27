import { displayText, londonClock, row, type Graphic, type Page } from "./board.js";
import { blipArt, bubbleTail, rowsOf, standing, striding, wrap } from "./context-screen.js";
import { textWidth } from "./font.js";
import { bitmap } from "./sky.js";

// The overnight highlights, presented by Blip on detective duty: deerstalker hat (his antenna pokes through),
// magnifying glass and notebook. Four 11-second scenes: he walks in peering through the glass, sweeps it
// over the ground for clues, writes it all down, then has an "aha!" moment, tips his hat and walks off.
// The highlights scroll in the speech bubble throughout.
type Point = [row: number, col: number];
type Layer = { shade: number; frames: Point[][]; ms: number };

export type Icon = keyof typeof icons;
export type Summary = { icon: Icon; text: string };
/** One of the night's top sightings: a title, its sighting details and any "did you know" facts about it. */
export type Exhibit = { at: number; icon: Icon; title: string; lines: string[]; facts?: string[] };
export type Digest = { day: string; headline: string; summary: Summary[]; exhibits: Exhibit[] };

const scale = 2;
const rest = { x: 4, y: 22 };
const offset = 32; // MotionFrames path coordinates are offset so sprites can start off screen
const coverPhaseMs = 11_000;
const exhibitMs = 9_000; // per fact
const maxScreenBytes = 7_900; // under the device's 8,192-byte screen limit, with room to spare
const pathPoints = 12;

const art = (lines: string[], top = 0, left = 0): Point[] =>
  lines.flatMap((line, y) => [...line].flatMap((char, x): Point[] => char === "#" ? [[top + y, left + x]] : []));
const letters = (wanted: string): Point[] =>
  blipArt.flatMap((line, y) => [...line].flatMap((char, x): Point[] => wanted.includes(char) ? [[y, x]] : []));
const shift = (points: Point[], rows: number, cols = 0): Point[] => points.map(([y, x]) => [y + rows, x + cols]);

// Deerstalker: crown over the head with the antenna tip poking out of the top, and a peak at the front and back.
const hat = art([
  "......####......",
  ".....######.....",
  "....########....",
  "..############..",
], 2);
const hatBand: Point[] = art(["....########...."], 4);
const body = letters("BH").filter(([y]) => y >= 5);
const tip = letters("T");
const leftArm: Point[] = [[9, 1], [10, 1], [11, 1], [12, 1], [9, 2]];
const leftEye: Point[] = [[8, 5], [8, 6], [9, 5], [9, 6]];
const smile: Point[] = [[12, 6], [13, 7], [13, 8], [12, 9]];
const hmm: Point[] = [[12, 7], [12, 8], [12, 9]];
const grin: Point[] = [[12, 5], [13, 6], [13, 7], [13, 8], [13, 9], [12, 10]];

// Magnifying glass: a ring with a handle running down and right to the hand.
const ring = (top: number, left: number): Point[] => art([
  ".####.",
  "#....#",
  "#....#",
  "#....#",
  "#....#",
  ".####.",
], top, left);
const handle = (top: number, left: number): Point[] => [[top + 5, left + 5], [top + 6, left + 6], [top + 7, left + 7]];
// Through the glass his right eye looks huge.
const bigEye = (look: number): Point[] => art(["###", "###", "###"], 8, 9 + look);

const question = art(["###", "#.#", "..#", ".##", ".#.", "...", ".#."], -9, 12);
const exclaim = art(["##", "##", "##", "##", "##", "..", "##"], -9, 12);

const notebook = art([
  "########",
  "#......#",
  "#......#",
  "#......#",
  "#......#",
  "########",
], 11, 3);
// Lines of notes appear one at a time.
const noteLines = (count: number): Point[] =>
  [[12, 4, 5], [13, 4, 3], [14, 4, 5], [15, 4, 4]].slice(0, count).flatMap(([y, x, length]) => Array.from({ length }, (_, i): Point => [y, x + i]));
const pencil = (dx: number, dy: number): Point[] => [[9 + dy, 13 + dx], [10 + dy, 12 + dx], [11 + dy, 11 + dx], [12 + dy, 10 + dx]];

// Blip's top-left corner at each of the 12 path points.
const walkIn: [number, number][] = [[-32, 22], [-24, 22], [-16, 22], [-8, 22], [-2, 22], [4, 22], [4, 22], [4, 22], [4, 22], [4, 22], [4, 22], [4, 22]];
const walkOut: [number, number][] = [[4, 22], [4, 22], [4, 22], [4, 22], [4, 22], [4, 22], [4, 22], [-2, 22], [-10, 22], [-18, 22], [-24, 22], [-32, 22]];
const moving = (path: [number, number][], frame: number, frames: number) => {
  const at = (n: number) => path[Math.min(path.length - 1, Math.floor(n / frames * (path.length - 1)))][0];
  return at(frame) !== at(frame + 1);
};

// Draw layers either still at the rest position (Frames) or carried along a path (MotionFrames).
function draw(layers: Layer[], path?: [number, number][]): Graphic[] {
  return layers.map(({ shade, frames, ms }): Graphic => {
    const all = frames.flat();
    // Each sprite covers only its own rows.
    const top = all.length ? Math.min(...all.map(([y]) => y)) : 0;
    const bottom = (all.length ? Math.max(...all.map(([y]) => y)) : 0) + 1;
    const rows = frames.map((points) => rowsOf(shift(points, -top), 0, bottom - top));
    if (!path) return [rest.x, rest.y + top * scale, scale, shade, rows, ms];
    return [scale, shade, rows, path.map(([x, y]) => [x + offset, y + offset + top * scale]), ms];
  });
}

const blink = (eyes: Point[], frames: number, closedAt: number[]) =>
  Array.from({ length: frames }, (_, i) => closedAt.includes(i) ? eyes.filter(([y]) => y === Math.max(...eyes.map(([r]) => r))) : eyes);

function arrive(phaseMs: number): Graphic[] {
  const legs = Array.from({ length: 16 }, (_, i) => moving(walkIn, i, 16) && i % 2 ? striding : standing);
  return draw([
    { shade: 15, frames: [tip, []], ms: 1200 },
    { shade: 12, frames: [[...body, ...leftArm]], ms: 5000 },
    { shade: 7, frames: legs, ms: Math.round(phaseMs / 16) },
    { shade: 9, frames: [hat], ms: 5000 },
    { shade: 5, frames: [hatBand], ms: 5000 },
    // Peering about: the big eye looks left and right; the other eye blinks now and then.
    { shade: 0, frames: [0, 1, 1, 0, -1, -1, 0, 0].map((look, i) => [...bigEye(look), ...(i === 5 ? [] : leftEye), ...hmm]), ms: Math.round(phaseMs / 8) },
    { shade: 15, frames: [ring(7, 8)], ms: 5000 },
    { shade: 10, frames: [handle(7, 8)], ms: 5000 },
  ], walkIn);
}

function search(phaseMs: number): Graphic[] {
  // The glass sweeps over the ground in front of him and back, twice; his eyes follow it down.
  const sweep = [0, 1, 3, 5, 6, 5, 3, 1];
  const frames = [...sweep, ...sweep];
  return draw([
    { shade: 15, frames: [tip, []], ms: 1200 },
    { shade: 12, frames: [[...body, ...leftArm]], ms: 5000 },
    { shade: 7, frames: [standing], ms: 5000 },
    { shade: 9, frames: [hat], ms: 5000 },
    { shade: 5, frames: [hatBand], ms: 5000 },
    { shade: 0, frames: frames.map((x, i) => [...shift(leftEye, 1, x > 3 ? 1 : 0), ...art(["##", "##"], 9, 9 + (x > 3 ? 1 : 0)), ...(i % 8 === 7 ? [] : hmm)]), ms: Math.round(phaseMs / 16) },
    { shade: 15, frames: frames.map((x) => ring(13, x)), ms: Math.round(phaseMs / 16) },
    { shade: 10, frames: frames.map((x) => [[12, x + 6], [11, x + 7], [10, x + 8]]), ms: Math.round(phaseMs / 16) },
    // A question mark bobs above his hat while he hunts.
    { shade: 11, frames: [question, shift(question, -1), question, []], ms: 700 },
  ]);
}

function notes(phaseMs: number): Graphic[] {
  return draw([
    { shade: 15, frames: [tip, []], ms: 1200 },
    { shade: 12, frames: [[...body, ...leftArm]], ms: 5000 },
    { shade: 7, frames: [standing], ms: 5000 },
    { shade: 9, frames: [hat], ms: 5000 },
    { shade: 5, frames: [hatBand], ms: 5000 },
    // Eyes down on the page, tongue-out concentration on every other line.
    { shade: 0, frames: blink(shift([...leftEye, [8, 9], [8, 10], [9, 9], [9, 10]], 1), 8, [3, 7]).map((eyes, i) => [...eyes, ...(i % 2 ? hmm : smile)]), ms: Math.round(phaseMs / 8) },
    { shade: 15, frames: [notebook], ms: 5000 },
    { shade: 6, frames: [1, 1, 2, 2, 3, 3, 4, 4].map((count) => noteLines(count)), ms: Math.round(phaseMs / 8) },
    // The pencil scribbles across the page.
    { shade: 4, frames: [pencil(0, 0), pencil(-1, 1), pencil(-2, 0), pencil(-1, 1)], ms: 250 },
  ]);
}

function aha(phaseMs: number): Graphic[] {
  const legs = Array.from({ length: 16 }, (_, i) => moving(walkOut, i, 16) && i % 2 ? striding : standing);
  // Timeline over 8 frames: "!" pops up, he grins, tips his hat (frames 3-4), then walks off.
  return draw([
    { shade: 15, frames: [tip, tip, tip, shift(tip, -2), shift(tip, -2), tip, tip, tip], ms: Math.round(phaseMs / 8) },
    { shade: 12, frames: [[...body, ...leftArm]], ms: 5000 },
    { shade: 7, frames: legs, ms: Math.round(phaseMs / 16) },
    { shade: 9, frames: [hat, hat, hat, shift(hat, -2), shift(hat, -2), hat, hat, hat], ms: Math.round(phaseMs / 8) },
    { shade: 5, frames: [hatBand, hatBand, hatBand, shift(hatBand, -2), shift(hatBand, -2), hatBand, hatBand, hatBand], ms: Math.round(phaseMs / 8) },
    // A wink with the grin.
    { shade: 0, frames: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [...(i === 3 || i === 4 ? [[9, 5], [9, 6]] as Point[] : leftEye), [8, 9], [8, 10], [9, 9], [9, 10], ...(i < 1 ? hmm : grin)]), ms: Math.round(phaseMs / 8) },
    { shade: 15, frames: [exclaim, exclaim, [], [], [], [], [], []], ms: Math.round(phaseMs / 8) },
    // The hat-tipping hand.
    { shade: 12, frames: [[], [], [], [[8, 13], [7, 14], [6, 14], [5, 14], [4, 14]], [[8, 13], [7, 14], [6, 14], [5, 14], [4, 14]], [], [], []], ms: Math.round(phaseMs / 8) },
  ], walkOut);
}

// Icons for the summary line, 9 pixels tall at most.
export const icons = {
  aircraft: bitmap([".....#.....", "....###....", "..#######..", "###########", "....###....", "....###....", "...##.##..."]),
  freight: bitmap([".#######.", "##.#.#.##", "#########", "#########", "#.#...#.#"]),
  vessel: bitmap([".....#.....", ".....##....", "...#####...", "###########", ".#########.", "..#######.."]),
  satellite: bitmap(["##.....##", "##..#..##", "##.###.##", "#########", "##.###.##", "##..#..##", "##.....##"]),
  aurora: bitmap(["#...#...#", "#..##..##", "##.##.##.", ".##.##.##", "..#..#..#"]),
  temperature: bitmap([".#.", "#.#", "#.#", "#.#", "###", "###", ".#."]),
  wind: bitmap(["#####..", ".....#.", "######.", ".......", "####...", "....#..", "####..."]),
  rain: bitmap(["..###..", ".#####.", "#######", ".......", "#..#..#", ".#..#.."]),
};
const iconWidth = (icon: number[]) => Math.max(...icon.map((bits) => 32 - Math.clz32(bits)));

const fit = (text: string, pixels: number) => {
  while (text && textWidth(text) > pixels) text = text.slice(0, -1);
  return text.trimEnd();
};
const clock = (at: number) => londonClock.format(at);

// The speech bubble pointing at Blip, shared by every page.
const bubble: Graphic[] = [[41, 0, 213, 1, 6], [41, 63, 213, 1, 6], [40, 1, 1, 62, 6], [254, 1, 1, 62, 6], [34, 26, 1, 6, bubbleTail]];

/**
 * The overnight section: a cover with Gemini's one-line summary and the night's counts (Blip walks in and
 * takes notes), then one exhibit per top sighting (Blip searches with his glass; on the last he has his
 * "aha!" and walks off).
 */
export function overnightPages(digest: Digest, now: number): Page[] {
  const updated = londonClock.format(now);
  const count = digest.exhibits.length;
  const cover: Graphic[] = [
    ...bubble,
    [46, 3, 1, 13, "CASE FILE: LAST NIGHT"], [251 - textWidth("21:00-07:00"), 3, 1, 7, "21:00-07:00"],
    [44, 12, 208, 1, 3],
    ...wrap(displayText(digest.headline, 120), 204, 3).map((line, n): Graphic => [46, 15 + n * 10, 1, 15, line]),
    [44, 46, 208, 1, 2],
  ];
  // Summary: icon and figure for each, as many as fit.
  let x = 46;
  for (const { icon, text } of digest.summary) {
    const art = icons[icon];
    const width = iconWidth(art) + 2 + textWidth(text);
    if (x + width > 251) break;
    cover.push([x, 50 + Math.floor((9 - art.length) / 2), 1, 10, art], [x + iconWidth(art) + 2, 51, 1, 12, text]);
    x += width + 8;
  }
  const pages: Page[] = [{
    id: "overnight", mode: "overnight", title: "LAST NIGHT", updated, state: "live",
    rows: [row("", displayText(digest.headline || "OVERNIGHT", 48), "")],
    graphics: cover, animation: { phase_ms: coverPhaseMs, phases: [arrive(coverPhaseMs), notes(coverPhaseMs)] },
  }];
  const build = (exhibit: Exhibit, i: number): void => {
    const art = icons[exhibit.icon];
    const time = clock(exhibit.at);
    const facts = (exhibit.facts ?? []).slice(0, 4).map((fact) => displayText(fact, 160));
    const details = exhibit.lines.filter(Boolean).map((line) => displayText(line, 90));
    const graphics: Graphic[] = [
      ...bubble,
      [46, 3, 1, 9, `EXHIBIT ${i + 1} OF ${count}`], [251 - textWidth(time), 3, 1, 13, time],
      [44, 12, 208, 1, 3],
      [46, 14 + Math.floor((9 - art.length) / 2), 1, 15, art],
      [48 + iconWidth(art), 14, 1, 15, fit(displayText(exhibit.title, 60), 203 - iconWidth(art))],
    ];
    // The sighting details along the bottom: still if they fit, otherwise scrolling slowly.
    const bottom = details.join(" - ");
    let marquee: Page["marquee"];
    if (facts.length) {
      if (textWidth(bottom) <= 205) graphics.push([46, 53, 1, 9, bottom]);
      else marquee = { left: 46, top: 53, width: 205, shade: 9, speed: 25, text: displayText(bottom, 300) };
    }
    // Research pages through in the main pane, one fact per phase with pips; without research the details go there.
    const panes = facts.length ? facts.map((fact) => wrap(fact, 205, 3)) : [details.flatMap((line) => wrap(line, 205, 2)).slice(0, 4)];
    // Progress pips in the header, left of the time.
    const pip = (n: number): [number, number] => [247 - textWidth(time) - (panes.length - n) * 7, 5];
    if (panes.length > 1) for (let n = 0; n < panes.length; n++) graphics.push([...pip(n), 5, 3, 5]);
    const last = i === count - 1;
    const phases = panes.map((rows, n): Graphic[] => {
      const scene = last && n === panes.length - 1 ? aha(exhibitMs) : n % 2 ? notes(exhibitMs) : search(exhibitMs);
      return [
        ...scene,
        ...rows.map((line, r): Graphic => [46, 24 + r * 9, 1, facts.length ? 15 : 11, line]),
        ...(panes.length > 1 ? [[...pip(n), 5, 3, 15] as Graphic] : []),
      ];
    });
    pages.push({
      id: `overnight-${i + 1}`, mode: "overnight", title: `EXHIBIT ${i + 1}`, updated, state: "live",
      rows: [row("", displayText(exhibit.title, 48), "")], graphics,
      animation: { phase_ms: exhibitMs, phases }, ...(marquee ? { marquee } : {}),
    });
  };
  digest.exhibits.forEach((exhibit, i) => {
    // Each screen must stay under the device's 8 KB limit: drop facts from the end until it fits.
    for (let facts = (exhibit.facts ?? []).length; ; facts--) {
      build({ ...exhibit, facts: exhibit.facts?.slice(0, facts) }, i);
      if (Buffer.byteLength(JSON.stringify({ version: 2, rotation: 60, pages: [pages.at(-1)] })) <= maxScreenBytes || facts <= 0) break;
      pages.pop();
    }
  });
  return pages;
}
