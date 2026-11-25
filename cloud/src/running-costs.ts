import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { AwsCosts } from "./aws-costs.js";
import { londonClock, row, type Graphic, type Page } from "./board.js";
import { textWidth } from "./font.js";
import { searchCost } from "./gemini-pricing.js";
import { bitmap, header } from "./sky.js";

// One screen for what Waypoint costs to run this month: AWS (Cost Explorer, filtered on the SST app tag),
// Gemini (priced from metered usage) and Flightradar24 (credits). Providers without data yet are left off.
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const contextTable = process.env.CONTEXT_TABLE;
const fr24Table = process.env.FR24_CACHE_TABLE;

// Small pixel marks suggesting each provider (not their logos).
const logos = {
  aws: bitmap([
    "..........####",
    "............##",
    "...........#.#",
    "#.........#...",
    ".##.....##....",
    "...#####......",
  ]),
  gemini: bitmap([
    ".....#.....",
    "....###....",
    "...#####...",
    "###########",
    "...#####...",
    "....###....",
    ".....#.....",
  ]),
  fr24: bitmap([
    ".....#.....",
    "....###....",
    "....###....",
    "..#######..",
    "###########",
    "....###....",
    "....###....",
    "...#####...",
    "...##.##...",
  ]),
};

const count = (value: number) => Math.round(value).toLocaleString("en-GB");

async function getItems(table: string, key: string, values: string[]): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < values.length; i += 100) {
    const { Responses } = await dynamo.send(new BatchGetCommand({
      RequestItems: { [table]: { Keys: values.slice(i, i + 100).map((value) => ({ [key]: value })) } },
    }));
    for (const item of Responses?.[table] ?? []) found.set(String(item[key]), item);
  }
  return found;
}

async function geminiSpend(now: Date): Promise<{ cost: number; calls: number; searches: number } | undefined> {
  if (!contextTable) return;
  const month = now.toISOString().slice(0, 7);
  const usage = (await getItems(contextTable, "subject", [`usage#${month}`])).get(`usage#${month}`);
  if (!usage?.calls) return;
  const searches = Number(usage.searches ?? 0);
  return { cost: Number(usage.tokenMicros ?? 0) / 1_000_000 + searchCost(searches), calls: Number(usage.calls), searches };
}

async function fr24Credits(now: Date): Promise<{ used: number; left?: number } | undefined> {
  if (!fr24Table) return;
  const month = now.toISOString().slice(0, 7);
  const days = Array.from({ length: now.getUTCDate() }, (_, i) => `budget#${month}-${String(i + 1).padStart(2, "0")}`);
  const items = await getItems(fr24Table, "key", [...days, "credits#remaining"]);
  const used = days.reduce((sum, day) => sum + Number(items.get(day)?.spent ?? 0), 0);
  const remaining = items.get("credits#remaining")?.remaining;
  if (!used && remaining === undefined) return;
  return { used, left: remaining === undefined ? undefined : Number(remaining) };
}

// Flightradar24 API subscription, charged in dollars on the 23rd of each month.
const fr24MonthlyUsd = 10.8;
const fr24BillingDay = 23;

// The font is ASCII, so the pound sign is drawn as a bitmap sized like the font's digits (5x7 on a 6px step).
const poundSign = bitmap([
  "..##.",
  ".#..#",
  ".#...",
  "###..",
  ".#...",
  ".#...",
  "#####",
]);

/**
 * Dollars to pounds at the European Central Bank's daily reference rate (via frankfurter.dev), cached for the
 * day. Card payments use Mastercard's rate, which is within a fraction of a percent of it; Mastercard's own
 * rate page refuses automated requests.
 */
async function usdToGbp(nowDate: Date): Promise<number | undefined> {
  if (!contextTable) return;
  const day = nowDate.toISOString().slice(0, 10);
  const cached = (await getItems(contextTable, "subject", ["fx#USD-GBP"])).get("fx#USD-GBP");
  if (cached?.day === day) return Number(cached.rate);
  try {
    const response = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP", { signal: AbortSignal.timeout(3000) });
    const rate = Number((await response.json() as { rates?: { GBP?: number } }).rates?.GBP);
    if (!response.ok || !(rate > 0.3 && rate < 2)) throw new Error(`rate ${response.status}`);
    await dynamo.send(new PutCommand({
      TableName: contextTable,
      Item: { subject: "fx#USD-GBP", day, rate, expireAt: Math.floor(nowDate.getTime() / 1000) + 30 * 86_400 },
    }));
    return rate;
  } catch (error) {
    console.warn("costs: exchange rate %s", error instanceof Error ? error.message : "unavailable");
    return cached ? Number(cached.rate) : undefined;
  }
}

function nextBilling(nowDate: Date): string {
  const after = nowDate.getUTCDate() >= fr24BillingDay;
  const date = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + (after ? 1 : 0), fr24BillingDay));
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).toUpperCase();
}

const short = (value: number) => value >= 10_000 ? `${Math.round(value / 1000)}K` : count(value);

export async function runningCostsPage(nowDate: Date, awsCosts: AwsCosts | undefined): Promise<Page | undefined> {
  const now = nowDate.getTime();
  const aws = awsCosts && awsCosts.total > 0 ? awsCosts.total : undefined;
  const [gemini, fr24, rate] = await Promise.all([
    geminiSpend(nowDate).catch(() => undefined),
    fr24Credits(nowDate).catch(() => undefined),
    usdToGbp(nowDate).catch(() => undefined),
  ]);
  // Amounts in pounds when a rate is available, otherwise in dollars.
  const money = (usd: number) => {
    const value = rate ? usd * rate : usd;
    return { symbol: rate ? "" : "$", text: value >= 100 ? `${Math.round(value)}` : value.toFixed(2) };
  };
  const lines: { logo: number[]; name: string; detail: string; usd: number }[] = [];
  if (aws !== undefined) lines.push({ logo: logos.aws, name: "AWS", detail: `${awsCosts!.services.length} SERVICES`, usd: aws });
  if (gemini) lines.push({ logo: logos.gemini, name: "GEMINI", detail: `${count(gemini.calls)} CALLS, ${count(gemini.searches)} SEARCHES`, usd: gemini.cost });
  lines.push({
    logo: logos.fr24, name: "FR24", usd: fr24MonthlyUsd,
    detail: fr24?.left === undefined ? `RENEWS ${nextBilling(nowDate)}` : `${short(fr24.left)} CR LEFT, DUE ${nextBilling(nowDate)}`,
  });

  const graphics: Graphic[] = [...header("RUNNING COSTS", now)];
  // Right-aligned amount at `top`, with a drawn pound sign or a "$" from the font.
  const amount = (usd: number, top: number) => {
    const { symbol, text } = money(usd);
    const label = symbol + text;
    const left = 254 - textWidth(label);
    graphics.push([left, top, 1, 15, label]);
    if (!symbol) graphics.push([left - 6, top, 1, 15, poundSign]);
  };
  lines.forEach(({ logo, name, detail, usd }, i) => {
    const top = 14 + i * 13;
    graphics.push([3, top, 1, 15, logo], [21, top, 1, 13, name], [62, top, 1, 8, detail]);
    amount(usd, top);
  });
  const total = lines.reduce((sum, { usd }) => sum + usd, 0);
  graphics.push([0, 51, 256, 1, 3], [3, 54, 1, 8, aws === undefined ? "THIS MONTH (EST, AWS PENDING)" : "THIS MONTH (EST)"]);
  amount(total, 54);
  const { symbol, text } = money(total);
  return {
    id: "running-costs", mode: "costs", title: "RUNNING COSTS", updated: londonClock.format(now), state: "live",
    rows: [row("", `RUNNING COSTS ${symbol || "GBP "}${text} THIS MONTH`, "")], graphics, clock: { right: 254, shade: 11 }, dwell_seconds: 20,
  };
}
