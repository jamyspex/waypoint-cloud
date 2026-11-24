import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { displayText } from "./board.js";

// "Did you know" context for the things on the cards. Facts are researched by Gemini with Google Search
// grounding in the ContextFacts Lambda and cached for weeks; the collector only reads and enqueues.
export type Kind = "aircraft" | "vessel" | "freight" | "satellite";
export type Subject = { key: string; kind: Kind; label: string; anchor: Record<string, string> };
export type Facts = { headline: string; facts: string[]; source: string; model?: string };
export type Wanted = { parentId: string; subject: Subject };

export const ttlDays: Record<Kind, number> = { aircraft: 30, vessel: 30, freight: 30, satellite: 90 };
const windowMs = 10 * 60_000;
const cooldownMs = 3 * 3_600_000;
const pendingDays = 2;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = process.env.CONTEXT_TABLE;

/** Drop empty anchor values and keep everything printable. */
export function anchorOf(values: Record<string, string | number | undefined | null>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).flatMap(([name, value]) => {
    const text = value === undefined || value === null ? "" : displayText(String(value), 60);
    return text ? [[name, text]] : [];
  }));
}

const subjects: Record<Kind, string> = {
  aircraft: "an aircraft flying near Inverness in the Scottish Highlands",
  vessel: "a ship in the Moray Firth or Cromarty Firth, Scotland",
  freight: "a freight train working in the Scottish Highlands (Inverness, the Far North line or the Kyle line)",
  satellite: "a satellite passing over the Scottish Highlands",
};
const angles: Record<Kind, string> = {
  aircraft: "the specific airframe (age, history, previous operators), the aircraft type, the airline or military unit, and the route",
  vessel: "the specific vessel (builder, year, size, owner or operator, what it carries, notable voyages) and why it would be in these waters",
  freight: "what this regular working carries, its origin and destination terminals, the operator, and the line it runs on",
  satellite: "the satellite's mission, operator, launch, orbit and anything notable about it",
};

// Big constellations are researched once as a group: individual Starlinks or Iridiums have little written
// about them, and each pass would otherwise be a new subject.
const constellations = ["STARLINK", "IRIDIUM", "ONEWEB", "YUNYAO", "GLOBALSTAR", "ORBCOMM", "FLOCK", "LEMUR", "SPIRE",
  "KUIPER", "QIANFAN", "GUOWANG", "TIANQI", "SWARM"];

/** COSPAR launch (e.g. "2024-175") from the international designator in TLE line 1 ("24175F"). */
export function launchOf(line1: string | undefined): string | undefined {
  const match = line1?.slice(9, 17).trim().match(/^(\d{2})(\d{3})[A-Z]*$/);
  if (!match) return;
  const year = Number(match[1]);
  return `${year < 57 ? 2000 + year : 1900 + year}-${match[2]}`;
}

/**
 * The subject for a satellite. Constellation satellites are grouped by launch: a batch of near-identical
 * satellites shares a launch date, rocket, group number and version. Others are researched individually.
 */
export function satelliteSubject(name: string, norad: string, inclinationDegrees: number, iss: boolean, line1?: string): Subject {
  const clean = displayText(name, 24);
  const group = constellations.find((constellation) => clean.startsWith(constellation));
  const launch = launchOf(line1);
  if (group && launch) {
    return { key: `launch#${group}#${launch}`, kind: "satellite", label: `${group} ${launch}`,
      anchor: anchorOf({ constellation: group, "cospar launch": launch, "example satellite": clean,
        focus: "facts about this launch and its batch of satellites: date, rocket, launch site, mission or group name, satellite version and any special hardware" }) };
  }
  if (group) {
    return { key: `constellation#${group}`, kind: "satellite", label: group,
      anchor: anchorOf({ constellation: group, "example satellite": clean, focus: "facts about the constellation as a whole" }) };
  }
  return { key: `satellite#${norad}`, kind: "satellite", label: clean,
    anchor: anchorOf({ name: clean, "norad id": norad, inclination: `${inclinationDegrees.toFixed(1)} degrees`, "space station": iss ? "yes" : undefined }) };
}

export function prompt(subject: Subject): string {
  const known = Object.entries(subject.anchor).map(([name, value]) => `${name}: ${value}`).join("; ");
  return [
    `The display is showing ${subjects[subject.kind]}. Known details: ${known}.`,
    `Use Google Search to find interesting, verifiable facts about ${angles[subject.kind]}.`,
    "Reply with ONLY a JSON object: {\"headline\": string (max 28 characters), \"facts\": [up to 4 strings, each max 110 characters, plain ASCII, each a complete standalone sentence], \"confidence\": \"high\"|\"medium\"|\"low\"}.",
    "Prefer specific, surprising details over generic ones. Do not invent facts: omit anything you cannot verify, and use low confidence if the search found little about this specific subject.",
    // Each search costs money and leads to more thinking. Three gave solid but plainer facts in testing
    // (G-LMSB: 11 -> 3); five keeps more of the colourful detail at a fraction of the unlimited cost.
    "Use at most 5 Google searches; stop searching once you have enough.",
  ].join(" ");
}

/** Pull the JSON object out of a model reply (which may be wrapped in a code fence) and tidy it for the OLED. */
export function parseFacts(text: string): { headline: string; facts: string[]; confidence: string } | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return;
  try {
    const data = JSON.parse(text.slice(start, end + 1)) as { headline?: unknown; facts?: unknown; confidence?: unknown };
    const facts = (Array.isArray(data.facts) ? data.facts : [])
      .flatMap((fact) => typeof fact === "string" ? [displayText(fact, 130)] : []).filter((fact) => fact.length >= 12).slice(0, 4);
    const headline = typeof data.headline === "string" ? displayText(data.headline, 28) : "";
    const confidence = typeof data.confidence === "string" ? data.confidence.toLowerCase() : "low";
    return { headline, facts, confidence };
  } catch {
    return;
  }
}

type Item = { subject: string; status?: string; headline?: string; facts?: string[]; source?: string; model?: string; lastIncluded?: number; expireAt?: number };

/**
 * Collector side: look up facts for the wanted subjects, queue research for new ones, and return the facts
 * to show now. Each subject shows for one rotation-length window, then rests for three hours.
 */
export async function contextFacts(wanted: Wanted[], now: number): Promise<Map<string, { subject: Subject; facts: Facts }>> {
  const shown = new Map<string, { subject: Subject; facts: Facts }>();
  if (!table || !wanted.length) return shown;
  const keys = [...new Set(wanted.map(({ subject }) => subject.key))];
  const items = new Map<string, Item>();
  for (let i = 0; i < keys.length; i += 100) {
    const { Responses } = await dynamo.send(new BatchGetCommand({
      RequestItems: { [table]: { Keys: keys.slice(i, i + 100).map((subject) => ({ subject })) } },
    }));
    for (const item of (Responses?.[table] ?? []) as Item[]) {
      if (!item.expireAt || item.expireAt * 1000 > now) items.set(item.subject, item);
    }
  }
  const queued = new Set<string>();
  for (const { parentId, subject } of wanted) {
    const item = items.get(subject.key);
    if (!item) {
      if (queued.has(subject.key)) continue;
      queued.add(subject.key);
      await dynamo.send(new PutCommand({
        TableName: table, ConditionExpression: "attribute_not_exists(subject)",
        Item: { subject: subject.key, status: "pending", kind: subject.kind, label: subject.label, anchor: subject.anchor,
          createdAt: now, expireAt: Math.floor(now / 1000) + pendingDays * 86_400 },
      })).catch(() => undefined);
      continue;
    }
    if (item.status !== "ready" || !item.facts?.length || shown.has(parentId)) continue;
    const since = item.lastIncluded ? now - item.lastIncluded : Infinity;
    if (since > cooldownMs) {
      // Start a new showing window.
      await dynamo.send(new UpdateCommand({
        TableName: table, Key: { subject: subject.key },
        UpdateExpression: "SET lastIncluded = :now", ExpressionAttributeValues: { ":now": now },
      })).catch(() => undefined);
    } else if (since > windowMs) {
      continue;
    }
    shown.set(parentId, { subject, facts: { headline: item.headline ?? "", facts: item.facts, source: item.source ?? "", model: item.model } });
  }
  return shown;
}
