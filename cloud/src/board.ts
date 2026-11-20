export type Mode = "bus" | "rail" | "air" | "space" | "energy" | "calendar" | "marine" | "sky";
export type Row = [lead: string, description: string, status: string];
export type Graphic =
  | [x: number, y: number, width: number, height: number, shade: number]
  | [x: number, y: number, scale: number, shade: number, text: string]
  | [x: number, y: number, scale: number, shade: number, bitmapRows: number[]]
  | [scale: number, shade: number, bitmapRows: number[], path: [number, number][]]
  | [left: number, top: number, width: number, height: number, scale: number, shade: number, pixels: string]
  | [scale: number, shade: number, bitmapRows: number[], occluder: [number, number, number], path: string]
  | [scale: number, shade: number, bitmapRows: number[], viewport: [number, number, number, number, number], path: string];
export type GraphicAnimation = { phase_ms: number; phases: Graphic[][] };
export type Marquee = { left: number; top: number; width: number; shade: number; speed: number; text: string };
export type Page = {
  id: string;
  mode: Mode;
  title: string;
  updated: string;
  state: "live" | "stale" | "offline";
  rows: Row[];
  usage_blocks?: (number | null)[];
  summaries?: { label: string; rows: Row[]; usage: (number | null)[] }[];
  graphics?: Graphic[];
  animation?: GraphicAnimation;
  marquee?: Marquee;
  clock?: { right: number; shade: number };
  starts_at?: number;
  dwell_seconds?: number;
};
export type Board = { version: 2; rotation: number; pages: Page[] };
export type MeetingFocus = { title: string; label: string; starts: number; ends: number; showInProgress: boolean };
export type LiveOrbitCatalog = {
  lat: number; lon: number; stale: boolean;
  orbits: { name: string; line1: string; line2: string }[];
};
export type DetailedBoard = Board & { aircraft?: Page[]; spacePreviews?: Page[]; liveSpace?: LiveOrbitCatalog; agenda?: Page; meetingFocus?: MeetingFocus[]; marine?: Page[]; sky?: Page[]; grid?: Page[]; aurora?: Page; freight?: Page[] };
export const maxBoardBytes = 8192;
export const maxMarinePhases = 40;
export const detailedBoardKey = "feeds/waypoint-detailed.json";
export const maxDetailedBoardBytes = 512 * 1024;
export const screenId = /^[A-Za-z0-9-]{1,24}$/;

export function screensOf(board: DetailedBoard, notification?: Page, satellites?: Page[]): Page[] {
  const screens = board.pages.flatMap((page) => {
    if (page.id === "air" && board.aircraft?.length) return board.aircraft;
    if (page.id === "air" && page.state !== "offline" && !page.rows[0]?.[0]) return [];
    if (page.id === "space" && satellites !== undefined) return satellites;
    if (page.id === "space" && board.spacePreviews?.length) return board.spacePreviews;
    if (!page.animation) return [page];
    const { phase_ms, phases } = page.animation;
    return phases.map((phase, i) => ({
      ...page, id: `${page.id.slice(0, 21)}-${i + 1}`,
      title: typeof phase[0]?.[4] === "string" ? phase[0][4].slice(0, 26) : page.title,
      animation: { phase_ms, phases: [phase] },
    }));
  });
  // Grid carbon follows the electricity screens; an aurora alert goes to the front.
  // Highland freight follows the rail boards.
  const after = (list: Page[], mode: Page["mode"], extra: Page[]) => {
    const last = list.map((page) => page.mode).lastIndexOf(mode);
    return last < 0 ? [...list, ...extra] : [...list.slice(0, last + 1), ...extra, ...list.slice(last + 1)];
  };
  const withGrid = after(after(screens, "rail", board.freight ?? []), "energy", board.grid ?? []);
  return [...(board.agenda ? [board.agenda] : []), ...(notification ? [notification] : []), ...(board.aurora ? [board.aurora] : []),
    ...withGrid, ...(board.marine ?? []), ...(board.sky ?? [])];
}

export function screenIndex(screens: Page[]) {
  return { version: 3, screens: screens.map(({ id, mode, title }) => ({ id, mode, title })) };
}

export function isDetailedBoard(value: unknown): value is DetailedBoard {
  if (!isBoard(value)) return false;
  const { aircraft, spacePreviews, liveSpace, agenda, meetingFocus, marine, sky, grid, aurora, freight } = value as DetailedBoard;
  const validPage = (page: Page) => isBoard({ version: 2, rotation: value.rotation, pages: [page] });
  return (aircraft === undefined || (Array.isArray(aircraft) && aircraft.every((page) => page?.mode === "air" && validPage(page))))
    && (spacePreviews === undefined || (Array.isArray(spacePreviews) && inRange(spacePreviews.length, 1, 5)
      && spacePreviews.every((page) => page?.mode === "space" && validPage(page))))
    && (liveSpace === undefined || (liveSpace && Number.isFinite(liveSpace.lat) && Math.abs(liveSpace.lat) <= 90
      && Number.isFinite(liveSpace.lon) && Math.abs(liveSpace.lon) <= 180 && typeof liveSpace.stale === "boolean"
      && Array.isArray(liveSpace.orbits) && liveSpace.orbits.every((orbit) => orbit && typeof orbit.name === "string"
        && typeof orbit.line1 === "string" && typeof orbit.line2 === "string")))
    && (agenda === undefined || (agenda?.mode === "calendar" && validPage(agenda)))
    && (marine === undefined || (Array.isArray(marine) && inRange(marine.length, 1, 2)
      && marine.every((page) => page?.mode === "marine" && validPage(page))))
    && (grid === undefined || (Array.isArray(grid) && inRange(grid.length, 1, 2)
      && grid.every((page) => page?.mode === "energy" && page.id.startsWith("grid-") && validPage(page))))
    && (aurora === undefined || (aurora?.id === "aurora" && validPage(aurora)))
    && (freight === undefined || (Array.isArray(freight) && inRange(freight.length, 1, 6)
      && freight.every((page) => page?.id.startsWith("freight-") && validPage(page))))
    && (sky === undefined || (Array.isArray(sky) && inRange(sky.length, 1, 5)
      && sky.every((page) => page?.id.startsWith("sky-") && validPage(page))))
    && (meetingFocus === undefined || (Array.isArray(meetingFocus) && meetingFocus.every((meeting) =>
      meeting && typeof meeting.title === "string" && typeof meeting.label === "string" && Number.isSafeInteger(meeting.starts)
      && Number.isSafeInteger(meeting.ends) && meeting.starts < meeting.ends && typeof meeting.showInProgress === "boolean")));
}

export const londonClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function printableText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ")
    .trim();
}

export function displayText(value: string, max: number): string {
  return printableText(value).toUpperCase().slice(0, max);
}

export function row(lead: string, label: string, detail: string): Row {
  return [displayText(lead, 5), displayText(label, 48), displayText(detail, 8)];
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isGraphic(value: unknown): value is Graphic {
  if (!Array.isArray(value)) return false;
  const bitmap = (rows: unknown): boolean => Array.isArray(rows) && inRange(rows.length, 1, 32)
    && rows.every((bits) => inRange(bits, 0, 65535));
  if (value.length === 7) {
    const [x, y, width, height, scale, shade, hex] = value;
    return inRange(x, 0, 255) && inRange(y, 0, 63) && inRange(width, 1, 255) && inRange(height, 1, 64)
      && inRange(scale, 1, 4) && x + width * scale <= 256 && y + height * scale <= 64
      && inRange(shade, 0, 15) && typeof hex === "string" && hex.length <= 2048
      && hex.length === Math.ceil(width / 8) * height * 2 && /^[0-9a-f]+$/.test(hex);
  }
  if (value.length === 4) {
    const [scale, shade, rows, path] = value;
    return inRange(scale, 1, 4) && inRange(shade, 0, 15) && bitmap(rows)
      && Array.isArray(path) && inRange(path.length, 2, 24)
      && path.every((point) => Array.isArray(point) && point.length === 2
        && inRange(point[0], 0, 255) && inRange(point[1], 0, 63));
  }
  if (value.length !== 5) return false;
  const [x, y, scaleOrWidth, shadeOrHeight, content] = value;
  if (Array.isArray(shadeOrHeight)) {
    const [left, top, width, height, samples] = shadeOrHeight;
    if (!inRange(x, 1, 4) || !inRange(y, 0, 15) || !bitmap(scaleOrWidth)
      || !inRange(left, 0, 255) || !inRange(top, 0, 63)
      || typeof content !== "string" || !/^[0-9a-f]+$/.test(content)) return false;
    if (shadeOrHeight.length === 5) {
      return inRange(width, 1, Math.min(255, 256 - left)) && inRange(height, 1, 64 - top)
        && inRange(samples, 2, 24) && inRange(content.length, 8, 4 * samples) && content.length % 4 === 0;
    }
    return shadeOrHeight.length === 3 && inRange(width, 1, 64)
      && inRange(content.length, 12, 144) && content.length % 6 === 0
      && Buffer.from(content, "hex").every((byte, i) => i % 3 !== 1 || byte < 64);
  }
  if (!inRange(x, 0, 255) || !inRange(y, 0, 63)) return false;
  if (typeof content === "number") {
    return inRange(scaleOrWidth, 1, 256) && inRange(shadeOrHeight, 1, 64) && inRange(content, 0, 15);
  }
  return inRange(scaleOrWidth, 1, 4) && inRange(shadeOrHeight, 0, 15)
    && (typeof content === "string"
      ? content.length <= 48 && /^[\x20-\x7e]*$/.test(content)
      : bitmap(content));
}

export function isBoard(value: unknown): value is Board {
  if (!value || typeof value !== "object") return false;
  const board = value as Board;
  return board.version === 2 && Number.isInteger(board.rotation)
    && board.rotation >= 5 && board.rotation <= 60 && Array.isArray(board.pages)
    && board.pages.length >= 1 && board.pages.length <= 10
    && board.pages.every((p) => p && typeof p.id === "string" && p.id.length <= 24
      && ["bus", "rail", "air", "space", "energy", "calendar", "marine", "sky"].includes(p.mode)
      && ["live", "stale", "offline"].includes(p.state)
      && typeof p.title === "string" && p.title.length >= 1 && p.title.length <= 26
      && typeof p.updated === "string" && /^\d{2}:\d{2}$/.test(p.updated)
      && (p.dwell_seconds === undefined || inRange(p.dwell_seconds, 5, 120))
      && (p.starts_at === undefined || inRange(p.starts_at, 1_704_067_200_000, 4_102_444_800_000))
      && (p.usage_blocks === undefined || (p.mode === "energy" && Array.isArray(p.usage_blocks)
        && p.usage_blocks.length === 12 && p.usage_blocks.every((value) => value === null
          || inRange(value, 0, 1_000_000))))
      && (p.graphics === undefined || (Array.isArray(p.graphics)
        && p.graphics.length <= 32 && p.graphics.every(isGraphic)))
      && (p.marquee === undefined || (p.marquee && inRange(p.marquee.left, 0, 255)
        && inRange(p.marquee.top, 0, 55) && inRange(p.marquee.width, 1, 256 - p.marquee.left)
        && inRange(p.marquee.shade, 0, 15) && inRange(p.marquee.speed, 10, 100)
        && typeof p.marquee.text === "string" && inRange(p.marquee.text.length, 1, 768)
        && /^[\x20-\x7e]+$/.test(p.marquee.text)))
      && (p.clock === undefined || (p.clock && inRange(p.clock.right, 32, 255)
        && inRange(p.clock.shade, 0, 15)))
      && (p.animation === undefined || (p.animation && inRange(p.animation.phase_ms, 500, 120000)
        && Array.isArray(p.animation.phases) && inRange(p.animation.phases.length, 1, p.mode === "marine" ? maxMarinePhases : 5)
        && p.animation.phases.every((phase) => Array.isArray(phase)
          && phase.length <= 16 && phase.every(isGraphic))))
      && Array.isArray(p.rows) && p.rows.length <= 4
      && p.rows.every((r) => Array.isArray(r) && r.length === 3
        && r.every((s, index) => typeof s === "string" && s.length <= [5, 48, 8][index]
          && /^[\x20-\x7e]*$/.test(s))));
}
