import { printableText, row, type Graphic, type Marquee, type Row } from "./board.js";

import { textWidth as width } from "./font.js";

const clock = /^\d{1,2}:\d{2}$/;

export function fitCallingText(text: string, limit: number, calling: boolean): string {
  if (text.length <= limit) return text;
  if (!calling) {
    const suffix = " (shortened)";
    const cut = text.slice(0, limit - suffix.length).replace(/\s+\S*$/, "").trimEnd();
    return cut + suffix;
  }
  const suffix = text.match(/(?:^|, )\+(\d+) more stops$/);
  const omitted = Number(suffix?.[1] ?? 0);
  const stops = (suffix ? text.slice(0, suffix.index) : text).split(", ").filter(Boolean)
    .map((stop) => stop.replace(/ \d{1,2}:\d{2}$/, ""));
  const condensed = [...stops, ...(omitted ? [`+${omitted} more stops`] : [])].join(", ");
  if (condensed.length <= limit) return condensed;
  const count = stops.length + omitted;
  while (stops.length) {
    stops.pop();
    const candidate = [...stops, `+${count - stops.length} more stops`].join(", ");
    if (candidate.length <= limit) return candidate;
  }
  return `+${count} more stops`;
}

type Stop = { locationName?: string; st?: string; et?: string; at?: string; isCancelled?: boolean };
export type Train = {
  std?: string;
  etd?: string;
  isCancelled?: boolean;
  platform?: string;
  destination?: { locationName?: string }[];
  subsequentCallingPoints?: { callingPoint?: Stop[]; assocIsCancelled?: boolean }[];
  cancelReason?: string;
};

function fits(text: string, pixels: number): boolean {
  return text.length <= 48 && width(text) <= pixels;
}

function clip(text: string, pixels: number): string {
  if (fits(text, pixels)) return text;
  let end = Math.min(45, text.length);
  while (end > 0 && !fits(text.slice(0, end).trimEnd() + "...", pixels)) end--;
  return end > 0 ? text.slice(0, end).trimEnd() + "..." : "";
}

function statusOf(train: Train): string {
  const status = printableText(train.etd ?? "");
  if (train.isCancelled || /^cancelled$/i.test(status)) return "Cancelled";
  if (clock.test(status)) return `Exp ${status}`;
  if (/^delayed$/i.test(status)) return "Delayed";
  if (/^on time$/i.test(status)) return "On time";
  return status || "Scheduled";
}

function callingText(train: Train): string {
  if (statusOf(train) === "Cancelled") return printableText(train.cancelReason ?? "");
  const stops = train.subsequentCallingPoints?.filter((leg) => !leg.assocIsCancelled)
    .flatMap((leg) => leg.callingPoint ?? []) ?? [];
  const points = stops.flatMap((stop) => {
    const name = printableText(stop.locationName ?? "");
    if (!name || stop.isCancelled) return [];
    const time = [stop.at, stop.et, stop.st].find((value) => value && clock.test(value));
    return [time ? `${name} ${time}` : name];
  });
  return points.length ? `Calling at: ${[...new Set(points)].join(", ")}` : "";
}

export function railPresentation(
  trains: Train[],
  station: string,
  updated: string,
  platformAvailable: boolean,
): { rows: Row[]; graphics?: Graphic[]; marquee?: Marquee } {
  const rows: Row[] = [];
  if (!trains.length) return { rows };
  const title = clip(printableText(station), 204);
  const graphics: Graphic[] = [
    [Math.floor((256 - width(title)) / 2), 0, 1, 11, title],
    [254 - width(updated), 0, 1, 9, updated],
    [0, 10, 256, 1, 4],
  ];
  const ordinals = ["", "2nd ", "3rd "];
  for (const [index, train] of trains.slice(0, 3).entries()) {
    const destination = train.destination?.map(({ locationName }) => printableText(locationName ?? ""))
      .filter(Boolean).join(" / ") || "Train";
    const scheduled = clock.test(train.std ?? "") ? train.std! : "--:--";
    const status = statusOf(train);
    const platform = platformAvailable ? printableText(train.platform ?? "").slice(0, 3) : "";
    const y = [14, 43, 54][index];
    const shade = index === 0 ? 15 : 12;
    const clockText = ordinals[index] + scheduled;
    const left = 9 + width(clockText);
    const rightText = clip(platform ? `Plat ${platform}   ${status}` : status, 121);
    const right = 254 - width(rightText);
    graphics.push(
      [2, y, 1, shade, clockText],
      [left, y, 1, shade, clip(destination, right - left - 5)],
      [right, y, 1, shade, rightText],
    );
    rows.push(row(scheduled, destination, status.replace(/^Exp /, "")));
  }

  const detail = callingText(trains[0]);
  if (!detail) return { rows, graphics };
  const prefix = "Calling at:";
  const top = 27;
  const calling = detail.startsWith(prefix);
  const text = calling ? detail.slice(prefix.length).trimStart() : detail;
  if (calling) graphics.push([2, top, 1, 12, prefix]);
  const left = calling ? 8 + width(prefix) : 2;
  const marquee = {
    left, top, width: 254 - left, shade: 12, speed: 40,
    text: fitCallingText(text, 768, calling),
  };
  return { rows, graphics, marquee };
}
