import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { displayText, londonClock, row, type Graphic, type Page } from "./board.js";
import { textWidth } from "./font.js";
import { freeSearchesPerMonth, searchCost, searchPricePerThousand } from "./gemini-pricing.js";
import { Canvas, header } from "./sky.js";

// Gemini spending for the "did you know" research, priced from the usage each API response reports
// (Google offers no spend API for AI Studio prepay). Totals are metered by the ContextResearch Lambda.
type Usage = { calls?: number; inputTokens?: number; outputTokens?: number; searches?: number; tokenMicros?: number };

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = process.env.CONTEXT_TABLE;

const dollars = (value: number) => value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
const count = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M`
  : value >= 10_000 ? `${Math.round(value / 1000)}K` : value.toLocaleString("en-GB");

async function usage(keys: string[]): Promise<Map<string, Usage>> {
  const { Responses } = await dynamo.send(new BatchGetCommand({
    RequestItems: { [table!]: { Keys: keys.map((subject) => ({ subject })) } },
  }));
  return new Map((Responses?.[table!] ?? []).map((item) => [String(item.subject), item as Usage]));
}

export async function costsPage(nowDate: Date): Promise<Page | undefined> {
  if (!table) return;
  const now = nowDate.getTime();
  const today = nowDate.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const dayOfMonth = nowDate.getUTCDate();
  const daysInMonth = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 0)).getUTCDate();
  const days = Array.from({ length: dayOfMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  const items = await usage([`usage#${month}`, ...days.map((day) => `usage#${day}`)]);
  const total = items.get(`usage#${month}`);
  if (!total?.calls) return;

  // Each day pays its token cost plus whatever search cost its searches added beyond the free allowance.
  let searchesSoFar = 0;
  const daily = days.map((day) => {
    const entry = items.get(`usage#${day}`) ?? {};
    const before = searchesSoFar;
    searchesSoFar += entry.searches ?? 0;
    return (entry.tokenMicros ?? 0) / 1_000_000 + searchCost(searchesSoFar) - searchCost(before);
  });
  const searches = total.searches ?? 0;
  const tokens = (total.tokenMicros ?? 0) / 1_000_000;
  const monthCost = tokens + searchCost(searches);
  const todayCost = daily.at(-1) ?? 0;
  const freeLeft = freeSearchesPerMonth - searches;

  const graphics: Graphic[] = [
    ...header("GEMINI COSTS", now),
    [3, 13, 1, 8, "THIS MONTH (EST)"],
    [3, 22, 2, 15, dollars(monthCost)],
    [3, 41, 1, 11, `TODAY ${dollars(todayCost)}`],
    [3, 52, 1, freeLeft > 0 ? 9 : 13, freeLeft > 0 ? `${count(freeLeft)} FREE SEARCHES` : `${count(-freeLeft)} PAID SEARCHES`],
    [116, 13, 1, 50, 3],
  ];

  // One bar per day of the month, today highlighted.
  const left = 121;
  const top = 14;
  const height = 27;
  const step = Math.floor(132 / daysInMonth);
  const peak = Math.max(0.01, ...daily);
  const past = new Canvas(132, height);
  const current = new Canvas(132, height);
  daily.forEach((cost, i) => {
    const bar = Math.max(cost > 0 ? 1 : 0, Math.round(cost / peak * height));
    if (!bar) return;
    for (let x = i * step; x < i * step + Math.max(1, step - 1); x++) {
      (i === daily.length - 1 ? current : past).column(x, height - bar, height - 1);
    }
  });
  graphics.push(...past.graphic(left, top, 6), ...current.graphic(left, top, 14), [left, top + height, 132, 1, 3]);
  const label = `${daysInMonth}`;
  graphics.push([left, top + height + 2, 1, 5, "1"], [left + (daysInMonth - 1) * step - textWidth(label) + step, top + height + 2, 1, 5, label]);

  const breakdown = [
    `${count(searches)} SEARCHES (${count(freeSearchesPerMonth)} FREE)`,
    `TOKENS ${count(total.inputTokens ?? 0)} IN / ${count(total.outputTokens ?? 0)} OUT`,
    `${count(total.calls)} CALLS`,
    `TOKENS ${dollars(tokens)} + SEARCH ${dollars(searchCost(searches))}`,
    `SEARCH $${searchPricePerThousand} PER 1K AFTER FREE`,
  ].join("  -  ");
  return {
    id: "gemini-costs", mode: "energy", title: "GEMINI COSTS", updated: londonClock.format(now), state: "live",
    rows: [row("", `GEMINI ${dollars(monthCost)} THIS MONTH`, "")],
    graphics, clock: { right: 254, shade: 11 }, dwell_seconds: 20,
    marquee: { left: 121, top: 53, width: 132, shade: 10, speed: 30, text: displayText(breakdown, 760) },
  };
}
