import { maxBoardBytes, type Board, type Graphic, type Page } from "./board.js";
import { earthGraphics } from "./earth.js";

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

export function withGraphics(page: Page): Page {
  if (page.mode === "air") {
    if (page.rows[0]?.[0]) return { ...page, dwell_seconds: 30 };
    if (page.state !== "offline") return { ...page, graphics: [] };
  }
  if (page.mode === "space" && page.animation) {
    const preview = { ...page, title: "SATELLITE ORBIT" };
    const graphics: Graphic[] = [
      ...header(preview),
      [128, 0, 1, 12, "LOOK-DOWN VIEW"],
      [126, 12, 1, 50, 4],
      [128, 14, 128, 48, 2],
      ...earthGraphics,
    ];
    return { ...preview, graphics };
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
  if (page.mode === "energy" && page.usage_blocks && page.rows.length === 4) {
    const [total, used, standing, through] = page.rows;
    const scale = total[2].length <= 5 ? 3 : total[2].length <= 7 ? 2 : 1;
    const graphics: Graphic[] = [
      ...header(page),
      [117, 15, 1, 47, 4],
      [122, 13, 1, 9, "USAGE BY 2H"],
      [122, 51, 133, 1, 4],
      [3, 35, 1, 13, `${used[2]} KWH USED`],
      [3, 54, 1, 9, through[1]],
    ];
    if (total[2]) graphics.push([3, 13, scale, 15, pound], [3 + 6 * scale, 13, scale, 15, total[2]]);
    else graphics.push([3, 21, 1, 10, "COST UNAVAILABLE"]);
    if (standing[2]) graphics.push([3, 44, 1, 10, pound], [9, 44, 1, 10, `${standing[2]} STANDING`]);
    const tallest = Math.max(1, ...page.usage_blocks.map((quantity) => quantity ?? 0));
    page.usage_blocks.forEach((quantity, index) => {
      const x = 122 + index * 11;
      if (index % 3 === 0) graphics.push([x, 54, 1, 9, String(index * 2).padStart(2, "0")]);
      if (quantity !== null) {
        const height = Math.max(1, Math.ceil(29 * quantity / tallest));
        graphics.push([x + 1, 51 - height, 8, height, quantity === tallest ? 15 : 8]);
      }
    });
    return { ...page, graphics };
  }
  return page;
}

export function fitGraphics(board: Board, basePages: Page[]): void {
  const trim = (change: (page: Page) => Page) => {
    if (Buffer.byteLength(JSON.stringify(board)) > maxBoardBytes) board.pages = board.pages.map(change);
  };
  trim((page) => page.graphics?.length ? { ...page, rows: [], usage_blocks: undefined } : page);
  trim((page) => page.mode === "space" && page.animation ? {
    ...page,
    animation: { ...page.animation, phases: page.animation.phases.map((phase) => phase.filter((command, index) =>
      command.length === 4 || !Array.isArray(command[4]) || command[4].length !== 1
        || typeof command[3] !== "number" || command[3] >= 13 || index % 2 === 0)) },
  } : page);
  trim((page) => page.mode === "rail" && page.graphics ? {
    ...page, graphics: page.graphics.filter((command) => command[1] < 54),
  } : page);
  for (const limit of [480, 240, 144]) {
    trim((page) => page.marquee && page.marquee.text.length > limit ? {
      ...page, marquee: { ...page.marquee, text: page.marquee.text.slice(0, limit - 3).replace(/\s+\S*$/, "") + "..." },
    } : page);
  }
  trim((page) => page.mode === "rail" && page.graphics ? {
    ...page, graphics: page.graphics.filter((command) => command[1] < 43),
  } : page);
  trim((page) => page.mode === "space" && page.animation ? {
    ...page,
    animation: { ...page.animation, phases: page.animation.phases.map((phase) => phase.map((command): Graphic => {
      const keep = (_: unknown, index: number, path: unknown[]) => index % 2 === 0 || index === path.length - 1;
      if (command.length === 4) return [command[0], command[1], command[2], command[3].filter(keep)];
      if (command.length === 5 && Array.isArray(command[2]) && Array.isArray(command[3]) && typeof command[4] === "string") {
        const path = command[4].match(/.{6}/g);
        if (path) return [command[0], command[1], command[2], command[3], path.filter(keep).join("")];
      }
      return command;
    })) },
  } : page);
  trim((page) => page.marquee && page.marquee.text.length > 96 ? {
    ...page, marquee: { ...page.marquee, text: page.marquee.text.slice(0, 93).replace(/\s+\S*$/, "") + "..." },
  } : page);
  trim((page) => page.mode === "space" && page.animation ? {
    ...page,
    animation: { ...page.animation, phases: page.animation.phases.map((phase) => phase.filter((command) =>
      command.length === 4 || !Array.isArray(command[4]) || command[4].length !== 1
        || typeof command[3] !== "number" || command[3] >= 13)) },
  } : page);
  if (Buffer.byteLength(JSON.stringify(board)) > maxBoardBytes) {
    board.pages = basePages.map((page) => ({ ...page, graphics: undefined, animation: undefined, marquee: undefined }));
  }
}
