import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { displayText } from "./board.js";
import { fetchAurora } from "./aurora.js";
import { apiKey, meter } from "./context-facts.js";
import type { Settings } from "./feeds.js";
import { overnightPages, type Digest, type Exhibit, type Summary } from "./overnight-screen.js";
import { dayOf, sightingsOn, type Sighting } from "./sightings.js";
import { londonMidnight } from "./sky.js";

// Builds the overnight highlights (21:00-07:00 London) at 07:00 and stores the screen in ContextFacts as
// digest#<day>; the collector shows it from 08:00 to 12:00. Invoke with {"day": "2026-11-26", "force": true}
// to rebuild or replay a past night.
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const ssm = new SSMClient({});
const contextTable = process.env.CONTEXT_TABLE;
const model = process.env.GEMINI_MODEL ?? "gemini-4-hydrogen";
const maxExhibits = 5;
const hhmm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const londonHour = (time: number) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/London" }).format(time));

type Candidate = Exhibit & { score: number };

/** 21:00 the evening before `day` to 07:00 on `day`, London time. */
export function nightOf(day: string): { from: number; to: number; evening: string } {
  const [year, month, date] = day.split("-").map(Number);
  const midnight = londonMidnight(Date.UTC(year, month - 1, date, 12));
  return { from: midnight - 3 * 3_600_000, to: midnight + 7 * 3_600_000, evening: dayOf(midnight - 3 * 3_600_000) };
}

// Aircraft worth calling out: big or unusual types, and anything military.
const notableTypes = /A380|747|777|787|A350|A330|A340|767|C-17|C17|GLOBEMASTER|AN-?124|AN-?225|A400|KC-|POSEIDON|P-8|RC-135|E-3|SENTRY|VOYAGER|ATLAS|HERCULES|C-130|TYPHOON|F-35|F-15|OSPREY|CHINOOK/i;

type Research = { headline: string; facts: string[] };
async function research(keys: string[]): Promise<Map<string, Research>> {
  const found = new Map<string, Research>();
  const unique = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < unique.length && contextTable; i += 100) {
    const { Responses } = await dynamo.send(new BatchGetCommand({
      RequestItems: { [contextTable]: { Keys: unique.slice(i, i + 100).map((subject) => ({ subject })), ProjectionExpression: "subject, headline, facts, #s", ExpressionAttributeNames: { "#s": "status" } } },
    }));
    for (const item of Responses?.[contextTable] ?? []) {
      if (item.status === "ready" && item.headline) found.set(String(item.subject), { headline: String(item.headline), facts: (item.facts as string[] | undefined) ?? [] });
    }
  }
  return found;
}

/** Merge a subject's rows across the two London days that make up the night. */
function merge(rows: Sighting[]): Sighting[] {
  const bySubject = new Map<string, Sighting>();
  for (const row of rows) {
    const known = bySubject.get(row.subject);
    if (!known) bySubject.set(row.subject, { ...row });
    else Object.assign(known, {
      firstSeen: Math.min(known.firstSeen, row.firstSeen), lastSeen: Math.max(known.lastSeen, row.lastSeen),
      closest: Math.min(known.closest ?? Infinity, row.closest ?? Infinity),
      elevation: Math.max(known.elevation ?? -90, row.elevation ?? -90),
    });
  }
  return [...bySubject.values()];
}

async function weather(settings: Settings, from: number, to: number): Promise<{ low?: { value: number; at: number }; gust?: { value: number; at: number }; rain: number }> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  for (const [key, value] of Object.entries({
    latitude: settings.air.lat.toFixed(4), longitude: settings.air.lon.toFixed(4), timezone: "GMT", wind_speed_unit: "mph",
    past_days: "1", forecast_days: "1", hourly: "temperature_2m,wind_gusts_10m,precipitation",
  })) url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`weather HTTP ${response.status}`);
  const { hourly } = await response.json() as { hourly?: { time?: string[]; temperature_2m?: (number | null)[]; wind_gusts_10m?: (number | null)[]; precipitation?: (number | null)[] } };
  let low: { value: number; at: number } | undefined;
  let gust: { value: number; at: number } | undefined;
  let rain = 0;
  (hourly?.time ?? []).forEach((time, i) => {
    const at = Date.parse(`${time}Z`);
    if (!(at >= from && at <= to)) return;
    const temperature = hourly?.temperature_2m?.[i];
    const wind = hourly?.wind_gusts_10m?.[i];
    if (typeof temperature === "number" && (!low || temperature < low.value)) low = { value: temperature, at };
    if (typeof wind === "number" && (!gust || wind > gust.value)) gust = { value: wind, at };
    rain += hourly?.precipitation?.[i] ?? 0;
  });
  return { low, gust, rain };
}

async function grid(from: number, to: number): Promise<{ wind?: { value: number; at: number } }> {
  const iso = (time: number) => new Date(time).toISOString().slice(0, 16) + "Z";
  const response = await fetch(`https://api.carbonintensity.org.uk/regional/intensity/${iso(from)}/${iso(to)}/regionid/1`, {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`grid HTTP ${response.status}`);
  const body = await response.json() as { data?: { data?: { from?: string; generationmix?: { fuel?: string; perc?: number }[] }[] } };
  let wind: { value: number; at: number } | undefined;
  for (const period of body.data?.data ?? []) {
    const share = period.generationmix?.find(({ fuel }) => fuel === "wind")?.perc;
    const at = Date.parse(period.from ?? "");
    if (typeof share === "number" && at >= from && at < to && (!wind || share > wind.value)) wind = { value: share, at };
  }
  return { wind };
}

/** Ranked highlights and summary figures for one night. */
export async function buildDigest(day: string, settings: Settings): Promise<Digest & { facts: string[] }> {
  const { from, to, evening } = nightOf(day);
  const rows = (await sightingsOn([evening, day])).filter((row) => row.kind === "freight"
    ? (row.at ?? 0) >= from && (row.at ?? 0) <= to
    : row.lastSeen >= from && row.firstSeen <= to);
  const freight = rows.filter((row) => row.kind === "freight");
  const others = merge(rows.filter((row) => row.kind !== "freight"));
  const [weatherResult, gridResult, auroraResult] = await Promise.allSettled([weather(settings, from, to), grid(from, to), fetchAurora(Date.now())]);
  const known = await research([
    ...others.map((row) => row.kind === "satellite" ? row.anchor?.context ?? "" : row.subject),
    ...freight.map((row) => (row as Sighting & { context?: string }).context ?? ""),
  ]);
  const candidates: Candidate[] = [];
  const time = (at: number) => hhmm.format(at);
  const join = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(" - ");
  const span = (row: Sighting) => row.lastSeen - row.firstSeen >= 120_000 ? `${time(row.firstSeen)}-${time(row.lastSeen)}` : time(row.firstSeen);

  for (const row of others.filter((entry) => entry.kind === "aircraft")) {
    const anchor = row.anchor ?? {};
    const military = /^yes$/i.test(anchor.military ?? "");
    const type = anchor.type ?? "";
    const found = known.get(row.subject);
    const closest = row.closest !== undefined && Number.isFinite(row.closest)
      ? `CLOSEST ${Math.round(row.closest)} NM${row.altitude ? ` AT ${row.altitude.toLocaleString("en-GB")} FT` : ""}` : undefined;
    const route = anchor.from && anchor.to ? `${anchor.from} TO ${anchor.to}` : anchor.from ? `FROM ${anchor.from}` : anchor.to ? `TO ${anchor.to}` : undefined;
    const operator = (anchor.airline || anchor.operator || "").replace(/\s+-\s+/g, " ");
    candidates.push({
      at: row.firstSeen, icon: "aircraft", score: 1 + (military ? 5 : 0) + (notableTypes.test(type) ? 2 : 0) + (found ? 1 : 0) + ((row.closest ?? 99) < 5 ? 2 : 0),
      title: `${row.label} ${found?.headline ?? type}`,
      lines: [[type, anchor.registration].filter(Boolean).join(" "), route ?? operator, closest ?? `SEEN ${span(row)}`],
      facts: found?.facts,
    });
  }
  for (const row of others.filter((entry) => entry.kind === "vessel")) {
    const anchor = row.anchor ?? {};
    const found = known.get(row.subject);
    candidates.push({
      at: row.firstSeen, icon: "vessel", score: 2 + (found ? 2 : 0),
      // Headlines usually name the vessel already.
      title: found?.headline.includes(row.label) ? found.headline : `${row.label} ${found?.headline ?? ""}`,
      lines: [anchor.type ?? "", anchor.destination ? `BOUND FOR ${anchor.destination}` : "", [row.area && `${row.area}`, span(row)].filter(Boolean).join(" ")],
      facts: found?.facts,
    });
  }
  for (const row of others.filter((entry) => entry.kind === "satellite")) {
    const iss = /^yes$/i.test(row.anchor?.iss ?? "");
    const elevation = row.elevation !== undefined && row.elevation > -90 ? Math.round(row.elevation) : undefined;
    const found = known.get(row.anchor?.context ?? "");
    candidates.push({
      at: row.firstSeen, icon: "satellite", score: (iss ? 5 : 1) + (elevation ?? 0) / 30,
      title: row.label,
      lines: [found?.headline ?? row.anchor?.constellation ?? "SATELLITE PASS", elevation !== undefined ? `UP TO ${elevation} DEG ABOVE THE HORIZON` : "", `OVERHEAD ${span(row)}`],
      facts: found?.facts,
    });
  }
  // One exhibit per train: its local reports in order, with the research headline if there is one.
  const trains = new Map<string, (Sighting & { context?: string })[]>();
  for (const row of freight.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    if (!row.local) continue;
    trains.set(row.headcode ?? "", [...trains.get(row.headcode ?? "") ?? [], row]);
  }
  for (const [headcode, reports] of trains) {
    const first = reports[0];
    const found = first.context ? known.get(first.context) : undefined;
    const places = [...new Map(reports.map((report) => [report.place, `${report.place} ${time(report.at ?? from)}`])).values()];
    candidates.push({
      at: first.at ?? from, icon: "freight", score: 6,
      title: `${headcode} ${found?.headline.replace(new RegExp(`^${headcode}\\s*`), "") ?? first.operator ?? "FREIGHT"}`,
      lines: [first.operator ?? "", first.origin && first.destination === first.origin ? `FROM ${first.origin} AND BACK`
        : [first.origin && `FROM ${first.origin}`, first.destination && `TO ${first.destination}`].filter(Boolean).join(" "), places.join(", ")],
      facts: found?.facts,
    });
  }
  const summary: Summary[] = [];
  const count = (kind: Sighting["kind"]) => others.filter((row) => row.kind === kind).length;
  if (count("aircraft")) summary.push({ icon: "aircraft", text: `${count("aircraft")}` });
  if (trains.size) summary.push({ icon: "freight", text: `${trains.size}` });
  if (count("vessel")) summary.push({ icon: "vessel", text: `${count("vessel")}` });
  if (count("satellite")) summary.push({ icon: "satellite", text: `${count("satellite")}` });

  if (auroraResult.status === "fulfilled") {
    const alerts = auroraResult.value.activity.filter(({ t, status }) => t >= from && t <= to && status !== "green");
    const order = ["yellow", "amber", "red"];
    const worst = [...alerts].sort((a, b) => order.indexOf(b.status) - order.indexOf(a.status))[0];
    if (worst) {
      const meaning: Record<string, string> = { yellow: "POSSIBLY VISIBLE BY EYE FROM SCOTLAND", amber: "LIKELY VISIBLE BY EYE FROM SCOTLAND", red: "LIKELY VISIBLE BY EYE ACROSS THE UK" };
      candidates.push({
        at: worst.t, icon: "aurora", score: 8 + order.indexOf(worst.status), title: `AURORA ${worst.status.toUpperCase()} ALERT`,
        lines: [meaning[worst.status], `${alerts.length} ALERT ${alerts.length === 1 ? "HOUR" : "HOURS"}, PEAK ${Math.round(worst.value)} NT AT ${time(worst.t)}`],
      });
      summary.push({ icon: "aurora", text: worst.status.toUpperCase() });
    }
  }
  if (weatherResult.status === "fulfilled") {
    const { low, gust, rain } = weatherResult.value;
    if (low) {
      summary.push({ icon: "temperature", text: `${Math.round(low.value)}C` });
      if (low.value <= 0) candidates.push({ at: low.at, icon: "temperature", score: 4, title: "A FROSTY NIGHT", lines: [`LOW OF ${low.value.toFixed(1)}C AT ${time(low.at)}`, "OPEN-METEO"] });
    }
    if (gust) {
      summary.push({ icon: "wind", text: `${Math.round(gust.value)}MPH` });
      if (gust.value >= 40) candidates.push({ at: gust.at, icon: "wind", score: 4, title: "A WILD NIGHT", lines: [`GUSTS OF ${Math.round(gust.value)} MPH AT ${time(gust.at)}`, rain >= 1 ? `${rain.toFixed(1)} MM OF RAIN` : "OPEN-METEO"] });
    }
    if (rain >= 1) summary.push({ icon: "rain", text: `${rain.toFixed(rain >= 10 ? 0 : 1)}MM` });
    if (rain >= 5 && !(gust && gust.value >= 40)) candidates.push({ at: to, icon: "rain", score: 3, title: "A WET NIGHT", lines: [`${rain.toFixed(1)} MM OF RAIN OVERNIGHT`, "OPEN-METEO"] });
  }
  if (gridResult.status === "fulfilled" && gridResult.value.wind && gridResult.value.wind.value >= 70) {
    const { value, at } = gridResult.value.wind;
    candidates.push({
      at, icon: "wind", score: 3 + (value >= 90 ? 2 : 0), title: `WIND POWER ${Math.round(value)}%`,
      lines: ["OF NORTH SCOTLAND'S ELECTRICITY", `PEAK AT ${time(at)}`, "FROM NATIONAL GRID ESO"],
    });
  }

  const ranked = candidates.sort((a, b) => b.score - a.score);
  const exhibits = ranked.slice(0, maxExhibits).sort((a, b) => a.at - b.at)
    .map(({ score: _, ...exhibit }) => ({ ...exhibit, title: exhibit.title.replace(/\s+/g, " ").trim() }));
  return { day, headline: "", summary, exhibits, facts: ranked.slice(0, 10).map(({ title, lines }) => join(title, ...lines)) };
}

/** A one-line detective-style summary of the night from Gemini (no search). */
async function writeHeadline(facts: string[], day: string): Promise<string> {
  if (!facts.length) return "A QUIET NIGHT. NOTHING SUSPICIOUS TO REPORT.";
  const prompt = [
    "You write one line for a small pixel display in the Scottish Highlands, as a playful detective's case summary of last night (21:00-07:00).",
    "What the display saw, most interesting first:", ...facts.map((fact) => `- ${fact}`),
    "Reply with a single sentence of at most 96 characters, plain ASCII, no quotes, no emoji. Mention the most interesting one or two things.",
  ].join("\n");
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { "x-goog-api-key": await apiKey(), "Api-Revision": "2026-05-20", "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: prompt, generation_config: { thinking_level: "low" } }),
  });
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
  const data = await response.json() as { model?: string; steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
    usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number } } | { model?: string }[];
  const interaction = (Array.isArray(data) ? data[0] : data) as Exclude<typeof data, unknown[]>;
  const usage = interaction.usage ?? {};
  await meter({
    input: usage.total_input_tokens ?? 0, output: (usage.total_output_tokens ?? 0) + (usage.total_thought_tokens ?? 0),
    thinking: usage.total_thought_tokens ?? 0, searches: 0, model: interaction.model ?? model,
  }, day);
  const text = (interaction.steps ?? []).filter(({ type }) => type === "model_output").flatMap(({ content }) => content ?? [])
    .flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join(" ");
  return displayText(text.replace(/["“”]/g, "").replace(/\s+/g, " ").trim(), 100);
}

export async function handler(event: { day?: string; force?: boolean } = {}) {
  if (!contextTable) throw new Error("Context table missing");
  const now = Date.now();
  // The cron fires at 06:00 and 07:00 UTC; only the run at 07:00 London time builds.
  if (!event.day && !event.force && londonHour(now) !== 7) return { skipped: "not 07:00 in London" };
  const day = event.day ?? dayOf(now);
  const { Parameter } = await ssm.send(new GetParameterCommand({ Name: process.env.FEED_SETTINGS, WithDecryption: true }));
  const settings = JSON.parse(Parameter?.Value ?? "{}") as Settings;
  const { facts, ...digest } = await buildDigest(day, settings);
  digest.headline = await writeHeadline(facts, day).catch((error: unknown) => {
    console.warn("overnight: headline %s", error instanceof Error ? error.message : "failed");
    return facts.length ? "THE NIGHT WATCH REPORT IS IN." : "A QUIET NIGHT. NOTHING SUSPICIOUS TO REPORT.";
  });
  const pages = overnightPages(digest, now);
  await dynamo.send(new PutCommand({
    TableName: contextTable,
    Item: { subject: `digest#${day}`, digest, pages, builtAt: now, expireAt: Math.floor(now / 1000) + 40 * 86_400 },
  }));
  console.log("overnight: %s built with %d exhibits: %s", day, digest.exhibits.length, digest.headline);
  return { day, headline: digest.headline, exhibits: digest.exhibits.map(({ title, lines }) => [title, ...lines].join(" | ")), summary: digest.summary };
}
