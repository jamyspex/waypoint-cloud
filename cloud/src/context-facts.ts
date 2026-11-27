import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { parseFacts, prompt, ttlDays, type Kind, type Subject } from "./context.js";
import { tokenCost } from "./gemini-pricing.js";

// Researches queued subjects with Gemini + Google Search grounding (Interactions API) and caches the facts.
// Spending is capped per day (subjects) and per month (search queries); a payment or rate-limit error
// stops the run and leaves the queue for later.
const endpoint = "https://generativelanguage.googleapis.com/v1beta/interactions";
const apiRevision = "2026-05-20";
const perRun = 5;
const dailySubjects = Number(process.env.CONTEXT_DAILY_SUBJECTS ?? 150);
const monthlySearches = Number(process.env.CONTEXT_MONTHLY_SEARCHES ?? 12_000);
const model = process.env.GEMINI_MODEL ?? "gemini-4-hydrogen";
const thinDays = 7;
const maxAttempts = 3;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const table = process.env.CONTEXT_TABLE;
let key: string | undefined;

type Pending = { subject: string; kind: Kind; label: string; anchor: Record<string, string>; createdAt: number; attempts?: number };
type Step = { type?: string; arguments?: { queries?: string[] }; content?: { type?: string; text?: string; annotations?: { url?: string; title?: string }[] }[] };
type Usage = {
  total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number; total_tool_use_tokens?: number;
  grounding_tool_count?: { type?: string; count?: number }[];
};
type Interaction = { model?: string; steps?: Step[]; usage?: Usage };
export type Metered = { input: number; output: number; thinking: number; searches: number; model: string };

class StopRun extends Error {}

export async function apiKey(): Promise<string> {
  if (key) return key;
  const { Parameter } = await ssm.send(new GetParameterCommand({ Name: process.env.GEMINI_API_KEY, WithDecryption: true }));
  if (!Parameter?.Value) throw new Error("Gemini key missing");
  return key = Parameter.Value;
}

// Atomically add to a counter unless that would pass its limit.
async function spend(counter: string, amount: number, limit: number, days: number): Promise<boolean> {
  try {
    await dynamo.send(new UpdateCommand({
      TableName: table, Key: { subject: counter },
      UpdateExpression: "ADD spent :amount SET expireAt = :expiry",
      ConditionExpression: "attribute_not_exists(spent) OR spent <= :limit",
      ExpressionAttributeValues: { ":amount": amount, ":limit": limit - amount, ":expiry": Math.floor(Date.now() / 1000) + days * 86_400 },
    }));
    return true;
  } catch {
    return false;
  }
}

// Add one call's usage to today's and this month's totals, which the cost screen reads.
export async function meter({ input, output, thinking, searches, model: used }: Metered, day: string): Promise<void> {
  const micros = Math.round(tokenCost(used, input, output, day) * 1_000_000);
  await Promise.all([`usage#${day}`, `usage#${day.slice(0, 7)}`].map((counter) => dynamo.send(new UpdateCommand({
    TableName: table, Key: { subject: counter },
    UpdateExpression: "ADD calls :one, inputTokens :input, outputTokens :output, thinkingTokens :thinking, searches :searches, tokenMicros :micros SET expireAt = :expiry",
    ExpressionAttributeValues: {
      ":one": 1, ":input": input, ":output": output, ":thinking": thinking, ":searches": searches, ":micros": micros,
      ":expiry": Math.floor(Date.now() / 1000) + 400 * 86_400,
    },
  })))).catch((error: unknown) => console.warn("context: metering failed: %s", error instanceof Error ? error.message : "error"));
}

async function research(subject: Subject): Promise<{ text: string; searches: number; queries: string[]; source: string; sources: string[]; answeredBy: string; usage: Metered }> {
  const response = await fetch(endpoint, {
    method: "POST", signal: AbortSignal.timeout(60_000),
    headers: { "x-goog-api-key": await apiKey(), "Api-Revision": apiRevision, "Content-Type": "application/json" },
    // Low thinking cut thinking tokens and cost by about 90% in testing with no loss of confidence.
    body: JSON.stringify({ model, input: prompt(subject), tools: [{ type: "google_search" }], generation_config: { thinking_level: "low" } }),
  });
  if (response.status === 402 || response.status === 429) throw new StopRun(`Gemini HTTP ${response.status}`);
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
  const data = await response.json() as Interaction | Interaction[];
  const interaction = Array.isArray(data) ? data[0] : data;
  const outputs = (interaction.steps ?? []).filter(({ type }) => type === "model_output").flatMap(({ content }) => content ?? []);
  const text = outputs.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("\n");
  // Citation URLs are Google grounding redirects; their titles name the sites, kept for tracing facts.
  const sources = [...new Set(outputs.flatMap((part) => part.annotations ?? []).flatMap(({ title }) => title ? [title.toLowerCase()] : []))].slice(0, 8);
  const source = "GOOGLE SEARCH";
  const searches = (interaction.usage?.grounding_tool_count ?? []).reduce((sum, { count = 0 }) => sum + count, 0);
  const usage = interaction.usage ?? {};
  const queries = (interaction.steps ?? []).filter(({ type }) => type === "google_search_call").flatMap((step) => step.arguments?.queries ?? []).slice(0, 20);
  const answeredBy = interaction.model ?? model;
  return { text, searches, queries, source, sources, answeredBy, usage: {
    // Thinking tokens are billed as output; tool-use tokens are part of the prompt.
    input: (usage.total_input_tokens ?? 0) + (usage.total_tool_use_tokens ?? 0),
    output: (usage.total_output_tokens ?? 0) + (usage.total_thought_tokens ?? 0),
    thinking: usage.total_thought_tokens ?? 0, searches, model: answeredBy,
  } };
}

async function pending(): Promise<Pending[]> {
  const items: Pending[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await dynamo.send(new ScanCommand({
      TableName: table, FilterExpression: "#status = :pending", ExclusiveStartKey: start,
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":pending": "pending" },
    }));
    items.push(...(page.Items ?? []) as Pending[]);
    start = page.LastEvaluatedKey;
  } while (start);
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

export async function handler() {
  if (!table) throw new Error("Context table missing");
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const queue = await pending();
  let done = 0;
  for (const item of queue.slice(0, perRun)) {
    if (!await spend(`budget#subjects#${day}`, 1, dailySubjects, 3)) {
      console.log("context: daily subject cap of %d reached", dailySubjects);
      break;
    }
    // Reserve a typical three searches up front; the actual count is recorded afterwards.
    if (!await spend(`budget#searches#${month}`, 3, monthlySearches, 40)) {
      console.log("context: monthly search cap of %d reached", monthlySearches);
      break;
    }
    const subject: Subject = { key: item.subject, kind: item.kind, label: item.label, anchor: item.anchor ?? {} };
    try {
      const { text, searches, queries, source, sources, answeredBy, usage } = await research(subject);
      await meter(usage, day);
      if (searches !== 3) await spend(`budget#searches#${month}`, searches - 3, Number.MAX_SAFE_INTEGER, 40);
      const parsed = parseFacts(text);
      const usable = parsed && parsed.facts.length > 0 && parsed.confidence !== "low";
      await dynamo.send(new UpdateCommand({
        TableName: table, Key: { subject: item.subject },
        UpdateExpression: "SET #status = :status, headline = :headline, facts = :facts, #source = :source, #model = :model, sources = :sources, queries = :queries, thinkingTokens = :thinking, searches = :searches, researchedAt = :now, expireAt = :expiry",
        ExpressionAttributeNames: { "#status": "status", "#source": "source", "#model": "model" },
        ExpressionAttributeValues: {
          ":status": usable ? "ready" : "thin", ":headline": parsed?.headline ?? "", ":facts": parsed?.facts ?? [],
          ":source": source, ":model": answeredBy, ":sources": sources, ":queries": queries, ":thinking": usage.thinking, ":searches": searches, ":now": now.getTime(),
          ":expiry": Math.floor(now.getTime() / 1000) + (usable ? ttlDays[item.kind] : thinDays) * 86_400,
        },
      }));
      done++;
      console.log("context: %s %s (%d searches, %d facts)", item.subject, usable ? "ready" : "thin", searches, parsed?.facts.length ?? 0);
    } catch (error) {
      if (error instanceof StopRun) {
        console.warn("context: stopping run: %s", error.message);
        break;
      }
      const attempts = (item.attempts ?? 0) + 1;
      console.warn("context: %s failed (%d): %s", item.subject, attempts, error instanceof Error ? error.message : "error");
      await dynamo.send(new UpdateCommand({
        TableName: table, Key: { subject: item.subject },
        UpdateExpression: "SET attempts = :attempts, #status = :status, expireAt = :expiry",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":attempts": attempts, ":status": attempts >= maxAttempts ? "failed" : "pending",
          ":expiry": Math.floor(now.getTime() / 1000) + 86_400,
        },
      }));
    }
  }
  console.log("context: %d researched, %d still queued", done, Math.max(0, queue.length - done));
}
