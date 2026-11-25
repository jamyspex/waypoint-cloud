import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
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

const dollars = (value: number) => value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
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

export async function runningCostsPage(nowDate: Date, awsCosts: AwsCosts | undefined): Promise<Page | undefined> {
  const now = nowDate.getTime();
  const aws = awsCosts && awsCosts.total > 0 ? awsCosts.total : undefined;
  const [gemini, fr24] = await Promise.all([
    geminiSpend(nowDate).catch(() => undefined),
    fr24Credits(nowDate).catch(() => undefined),
  ]);
  const lines: { logo: number[]; name: string; detail: string; amount: string }[] = [];
  if (aws !== undefined) lines.push({ logo: logos.aws, name: "AWS", detail: `${awsCosts!.services.length} SERVICES`, amount: dollars(aws) });
  if (gemini) lines.push({ logo: logos.gemini, name: "GEMINI", detail: `${count(gemini.calls)} CALLS, ${count(gemini.searches)} SEARCHES`, amount: dollars(gemini.cost) });
  if (fr24) lines.push({ logo: logos.fr24, name: "FR24", detail: fr24.left === undefined ? "CREDITS USED" : `${count(fr24.left)} CREDITS LEFT`, amount: `${count(fr24.used)} CR` });
  if (!lines.length) return;

  const graphics: Graphic[] = [...header("RUNNING COSTS", now)];
  lines.forEach(({ logo, name, detail, amount }, i) => {
    const top = 14 + i * 13;
    graphics.push(
      [3, top, 1, 15, logo], [21, top, 1, 13, name], [62, top, 1, 8, detail],
      [254 - textWidth(amount), top, 1, 15, amount],
    );
  });
  const total = (aws ?? 0) + (gemini?.cost ?? 0);
  const totalText = dollars(total);
  graphics.push(
    [0, 51, 256, 1, 3],
    [3, 54, 1, 8, aws === undefined ? "THIS MONTH (EST, AWS PENDING)" : "THIS MONTH (EST)"],
    [254 - textWidth(totalText), 54, 1, 15, totalText],
  );
  return {
    id: "running-costs", mode: "costs", title: "RUNNING COSTS", updated: londonClock.format(now), state: "live",
    rows: [row("", `RUNNING COSTS ${totalText} THIS MONTH`, "")], graphics, clock: { right: 254, shade: 11 }, dwell_seconds: 20,
  };
}
