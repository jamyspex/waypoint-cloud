import { maxBoardBytes, row, type Board, type Graphic, type Page } from "./board.js";
import { earthGraphics } from "./earth.js";
import { packedBitmap } from "./packed.js";
import { fitCallingText } from "./rail.js";

// One bit per pixel, from left to right. The display scales each source pixel.
const bolt = [
  0x380, 0x3c0, 0x1c0, 0x1e0, 0x0e0, 0x0f0, 0x7f0, 0x3f8,
  0x3fc, 0x1c0, 0x0e0, 0x0e0, 0x070, 0x030, 0x018, 0x008,
];
const pound = [14, 18, 2, 15, 2, 2, 31];

function header(page: Page): Graphic[] {
  return [
    [2, 0, 1, 15, page.title],
    [212, 0, 1, 10, page.state.toUpperCase()],
    [0, 10, 256, 1, 5],
  ];
}

export function spaceGraphics(page: Page): Graphic[] {
  return [
    ...header(page),
    [128, 0, 1, 12, "GROUND TRACK"],
    [126, 12, 1, 50, 4],
    [128, 14, 128, 48, 1],
    ...earthGraphics,
  ];
}

const spark: Graphic = [196, 0, 1, 15, [16, 24, 12, 126, 60, 24, 12, 6, 2]];

export function combineEnergyDays(pages: Page[]): Page[] {
  const today = pages.find((page) => page.id === "energy-today");
  const yesterday = pages.find((page) => page.id === "energy-yesterday");
  if (!today || !yesterday) return pages;
  const summaries = [today, yesterday].map(({ title, rows, usage_blocks }) => ({
    label: title, rows, usage: usage_blocks ?? [],
  }));
  const combined: Page = { ...today, id: "energy-days", title: "DAILY ELECTRICITY", usage_blocks: undefined, summaries };
  return pages.flatMap((page) => page === today ? [combined] : page === yesterday ? [] : [page]);
}

function usageChart(usage: (number | null)[]): Graphic[] {
  const width = 64;
  const height = 14;
  const stride = width / 8;
  const pixels = Buffer.alloc(stride * height);
  const largest = Math.max(1, ...usage.map((value) => value ?? 0));
  usage.forEach((value, index) => {
    if (value === null) return;
    const left = Math.floor(index * width / usage.length) + 1;
    const right = Math.floor((index + 1) * width / usage.length) - 1;
    const bar = Math.max(1, Math.ceil(value * height / largest));
    for (let y = height - bar; y < height; y++) {
      for (let x = left; x < right; x++) pixels[y * stride + (x >> 3)] |= 1 << (x & 7);
    }
  });
  return packedBitmap(122, 23, width, height, 2, 11, pixels);
}

function weeklyBars(usage: (number | null)[]): Graphic[] {
  const largest = Math.max(1, ...usage.map((value) => value ?? 0));
  return usage.flatMap((value, i): Graphic[] => {
    if (value === null) return [];
    const bar = Math.max(1, Math.ceil(value * 28 / largest));
    return [[124 + i * 18, 51 - bar, 12, bar, 11]];
  });
}

export function compactBitmap(command: Graphic, sourceScale = 2): Graphic {
  if (command.length !== 7 || command[4] !== sourceScale) return command;
  const [left, top, width, height, , shade, data] = command;
  const scale = 2 * sourceScale;
  const bytes = Buffer.from(data, "hex");
  const stride = Math.ceil(width / 8);
  const w = Math.min(Math.ceil(width / 2), Math.floor((256 - left) / scale));
  const h = Math.min(Math.ceil(height / 2), Math.floor((64 - top) / scale));
  if (!w || !h) return command;
  const outputStride = Math.ceil(w / 8);
  const output = Buffer.alloc(outputStride * h);
  for (let y = 0; y < Math.min(height, h * 2); y++) {
    for (let x = 0; x < Math.min(width, w * 2); x++) {
      if ((bytes[y * stride + (x >> 3)] & (1 << (x & 7))) !== 0) {
        output[(y >> 1) * outputStride + (x >> 4)] |= 1 << ((x >> 1) & 7);
      }
    }
  }
  return [left, top, w, h, scale, shade, output.toString("hex")];
}

function energySummaries(page: Page): Page {
  const weekly = page.id === "energy-weekly";
  const summaries = page.summaries ?? ["THIS WEEK ELECTRICITY", "LAST WEEK ELECTRICITY"]
    .map((label) => ({ label, rows: [row("", "FEED UNAVAILABLE", "")], usage: [] }));
  const ticks: Graphic[] = weekly
    ? ["M", "T", "W", "T", "F", "S", "S"].map((name, i) => [128 + i * 18, 54, 1, 8, name])
    : ["00", "06", "12", "18"].map((name, i) => [122 + i * 32, 54, 1, 8, name]);
  const graphics: Graphic[] = [
    [0, 10, 256, 1, 5], spark, [212, 0, 1, 10, page.state.toUpperCase()],
    [117, 15, 1, 47, 4], [122, 13, 1, 9, weekly ? "USAGE BY DAY" : "USAGE BY 2H"],
    [122, 51, 128, 1, 4], ...ticks,
  ];
  const phases: Graphic[][] = summaries.map(({ label, rows, usage }) => {
    const [total, used, standing, through] = rows;
    const frame: Graphic[] = [[2, 0, 1, 15, label]];
    if (!used || !standing || !through) {
      frame.push([3, 29, 1, 12, total?.[1] ?? "WAITING FOR METER READINGS"]);
      return frame;
    }
    const scale = total[2].length <= 5 ? 3 : total[2].length <= 7 ? 2 : 1;
    if (total[2]) frame.push([3, 13, scale, 15, pound], [3 + 6 * scale, 13, scale, 15, total[2]]);
    else frame.push([3, 21, 1, 10, "COST UNAVAILABLE"]);
    frame.push([3, 35, 1, 13, `${used[2]} KWH USED`], [3, 54, 1, 9, through[1]]);
    if (standing[2]) frame.push([3, 44, 1, 10, pound], [9, 44, 1, 10, `${standing[2]} STANDING`]);
    return [...frame, ...(weekly ? weeklyBars(usage) : usageChart(usage))];
  });
  return { ...page, summaries: undefined, graphics, animation: { phase_ms: 30_000, phases } };
}

export function withGraphics(page: Page): Page {
  if (page.mode === "energy") {
    page = { ...page, dwell_seconds: 30 };
    if (page.id === "energy-days" || page.id === "energy-weekly") return energySummaries(page);
    if (page.rows.length !== 4) {
      return { ...page, graphics: [...header(page), spark, [28, 29, 1, 12, page.rows[0]?.[1] ?? "FEED UNAVAILABLE"]] };
    }
  }
  if (page.mode === "air") {
    if (page.rows[0]?.[0]) return {
      ...page, dwell_seconds: 30,
      graphics: page.state === "stale" && page.graphics?.length
        ? [...page.graphics.filter((command) => !(command.length === 5 && command[0] === 224 && command[4] === "STALE")),
          [224, 0, 1, 9, "STALE"]]
        : page.graphics,
    };
    if (page.state !== "offline") return { ...page, graphics: [] };
  }
  if (page.mode === "space" && page.animation) {
    const preview = { ...page, title: "SATELLITE ORBIT" };
    return { ...preview, graphics: spaceGraphics(preview) };
  }
  if (page.id === "energy-now" && page.rows.length === 4) {
    const [power, unit, standing, time] = page.rows;
    const graphics: Graphic[] = [
      ...header(page),
      [5, 20, 2, 12, bolt],
      [39, 17, power[2].length <= 6 ? 3 : 2, 15, power[2] || "--"],
      [39, 44, 1, 13, power[1]],
      [39, 54, 1, 9, time[1]],
      [163, 15, 1, 47, 4],
      [172, 14, 1, 10, "RATE / KWH"],
      [172, 25, 1, 15, `${unit[2]} INC VAT`],
      [172, 41, 1, 10, "STANDING / DAY"],
      [172, 52, 1, 15, standing[2]],
    ];
    return { ...page, graphics };
  }
  return page;
}

export function fitGraphics(board: Board, basePages: Page[]): void {
  const trim = (change: (page: Page) => Page) => {
    if (Buffer.byteLength(JSON.stringify(board)) > maxBoardBytes) board.pages = board.pages.map(change);
  };
  trim((page) => page.graphics?.length && page.mode !== "air" ? { ...page, rows: [], usage_blocks: undefined } : page);
  trim((page) => page.mode === "space" && page.animation ? {
    ...page,
    animation: { ...page.animation, phases: page.animation.phases.map((phase) => phase.filter((command, index) =>
      command.length === 4 || !Array.isArray(command[4]) || command[4].length !== 1
        || typeof command[3] !== "number" || command[3] >= 13 || index % 2 === 0)) },
  } : page);
  trim((page) => page.mode === "rail" && page.graphics ? {
    ...page, graphics: page.graphics.filter((command) => command[1] < 54),
  } : page);
  trim((page) => page.mode === "rail" && page.graphics ? {
    ...page, graphics: page.graphics.filter((command) => command[1] < 43),
  } : page);
  trim((page) => page.mode === "space" && page.animation ? {
    ...page,
    animation: { ...page.animation, phases: page.animation.phases.map((phase) => phase.map((command): Graphic => {
      const keep = (_: unknown, index: number, path: unknown[]) => index % 2 === 0 || index === path.length - 1;
      if (command.length === 4) return [command[0], command[1], command[2], command[3].filter(keep)];
      if (command.length === 5 && Array.isArray(command[2]) && Array.isArray(command[3]) && typeof command[4] === "string") {
        if (command[3].length === 5) {
          const [left, top, width, height, samples] = command[3];
          const path = command[4].match(/.{4}/g);
          // Both Space paths have an even number of intervals, including the local prefix.
          return path ? [command[0], command[1], command[2],
            [left, top, width, height, Math.floor(samples / 2) + 1], path.filter(keep).join("")] : command;
        }
        const path = command[4].match(/.{6}/g);
        if (path) return [command[0], command[1], command[2], command[3], path.filter(keep).join("")];
      }
      return command;
    })) },
  } : page);
  trim((page) => page.mode === "space" && page.animation ? {
    ...page,
    animation: { ...page.animation, phases: page.animation.phases.map((phase) => phase.filter((command) =>
      command.length === 4 || !Array.isArray(command[4]) || command[4].length !== 1
        || typeof command[3] !== "number" || command[3] >= 13)) },
  } : page);
  trim((page) => page.mode === "space" && page.animation ? {
    ...page,
    animation: { ...page.animation, phases: page.animation.phases.map((phase) => phase.filter((command, index) =>
      command.length !== 5 || typeof command[4] !== "number" || command[0] < 128
        || command[4] === 15 || index % 2 === 0)) },
  } : page);
  trim((page) => page.mode === "space" && page.graphics ? {
    ...page, graphics: page.graphics.filter((command) => command.length !== 7 || command[5] !== 6),
  } : page);
  trim((page) => page.id === "energy-days" && page.animation ? {
    ...page, animation: { ...page.animation, phases: page.animation.phases.map((phase) => phase.map((command) => compactBitmap(command))) },
  } : page);
  trim((page) => page.mode === "space" && page.animation ? {
    ...page, animation: { ...page.animation, phases: page.animation.phases.map((phase) => phase.filter((command) =>
      command.length !== 5 || typeof command[4] !== "number" || command[0] < 128 || command[4] === 15)) },
  } : page);
  trim((page) => page.mode === "space" && page.animation ? {
    ...page,
    animation: { ...page.animation, phases: page.animation.phases.map((phase) => phase.map((command) => compactBitmap(command))) },
  } : page);
  for (const limit of [480, 240, 144, 96, 64]) {
    trim((page) => page.marquee && page.marquee.text.length > limit ? {
      ...page,
      marquee: { ...page.marquee, text: fitCallingText(page.marquee.text, limit,
        page.graphics?.some((command) => command.length === 5 && command[4] === "Calling at:") ?? false) },
    } : page);
  }
  if (Buffer.byteLength(JSON.stringify(board)) > maxBoardBytes) {
    board.pages = basePages.map((page) => ({ ...page, graphics: undefined, animation: undefined, marquee: undefined, summaries: undefined }));
  }
}
