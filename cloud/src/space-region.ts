import { gunzipSync } from "node:zlib";
import { displayText } from "./board.js";
import { textWidth } from "./font.js";
import { regionCells, regionNames } from "./natural-earth-regions.js";

const cells = gunzipSync(Buffer.from(regionCells, "base64"));
const cellsPerDegree = 4;
const width = 360 * cellsPerDegree;
const height = 180 * cellsPerDegree;
const degrees = 180 / Math.PI;

export function groundRegion(latitude: number, longitude: number): string | undefined {
  const x = Math.floor((longitude * degrees + 180) * cellsPerDegree) % width;
  const y = Math.max(0, Math.min(height - 1, Math.floor((90 - latitude * degrees) * cellsPerDegree)));
  const cell = y * width + (x + width) % width;
  return regionNames[cells.readUInt16LE(cell * 2)] || undefined;
}

export function regionLines(region: string, width: number): [string, string] {
  const name = displayText(region, 48);
  if (textWidth(name) <= width) return ["OVER", name];
  const fit = (line: string) => {
    if (textWidth(line) <= width) return line;
    while (textWidth(line + ".") > width) line = line.slice(0, -1);
    return line.trimEnd() + ".";
  };
  const words = name.split(" ");
  if (words.length < 2) return ["OVER", fit(name)];
  let lines: [string, string] = [words[0], words.slice(1).join(" ")];
  let longest = Math.max(...lines.map(textWidth));
  for (let i = 2; i < words.length; i++) {
    const candidate: [string, string] = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
    const candidateWidth = Math.max(...candidate.map(textWidth));
    if (candidateWidth >= longest) continue;
    longest = candidateWidth;
    lines = candidate;
  }
  return [fit(lines[0]), fit(lines[1])];
}
