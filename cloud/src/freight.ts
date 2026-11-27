import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { stanoxNames } from "./stanox-names.js";
import { freightLocations, operators } from "./freight-locations.js";

// Lambda reads TRUST train movements from the RDM Kafka topic (TRAIN_MVT_ALL_TOC) through a
// self-managed Kafka event source and keeps the latest position of every freight train.
type KafkaEvent = { records?: Record<string, { value?: string }[]> };
type Message = { header?: { msg_type?: string }; body?: Record<string, string> };
export type Report = { stanox: string; event: string; at: number; planned: number; variation: number; status: string };
export type FreightTrain = {
  id: string; headcode: string; toc: string; origin?: string; originName?: string; departed?: number;
  last: Report; next?: string; terminated: boolean; path: [stanox: string, at: number][];
  // Usual terminus learned from earlier runs of the same headcode and origin (see FreightRoutes).
  destination?: string; destinationStanox?: string; routeChecked?: string; learned?: boolean;
};
export type FreightFile = {
  version: 1; updated: number; trains: Record<string, FreightTrain>;
  // Activations seen before a train's first movement report: origin STANOX and departure time.
  pending: Record<string, [origin: string, departed: number]>;
};

const s3 = new S3Client({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const routesTable = process.env.ROUTES_TABLE;
const routeLifetime = 60 * 86_400;
const bucket = process.env.SCENES_BUCKET;
const key = "feeds/freight-trains.json";
const keepFor = 6 * 3_600_000;
const keepTerminated = 3_600_000;

// The headcode is characters 3-6 of the TRUST train ID; classes 4, 6, 7 and 8 are freight and 0 is a light locomotive.
const headcodeOf = (trainId: string) => trainId.slice(2, 6);
const isFreight = (trainId: string) => /^[04678][A-Z0-9][0-9]{2}$/.test(headcodeOf(trainId));
const number = (value: string | undefined) => Number(value ?? NaN);

// Each report from a train in (or heading into) the local area becomes a row in Sightings (see sightings.ts), so
// movements can be traced after the train drops out of the state file; the bySubject index lists one headcode's runs.
const sightingsTable = process.env.SIGHTINGS_TABLE;
const sightingLifetime = 180 * 86_400;
const londonDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });

function sighting(train: FreightTrain): Record<string, unknown> | undefined {
  const here = freightLocations[train.last.stanox];
  const next = train.next ? freightLocations[train.next] : undefined;
  if (!here && !next) return;
  const { event, at, planned, variation, status, stanox } = train.last;
  const row: Record<string, unknown> = {
    day: londonDay.format(at), sk: `freight#${new Date(at).toISOString()}#${train.id}#${stanox}#${event}`,
    subject: `freight#${train.headcode}`, kind: "freight", label: train.headcode, headcode: train.headcode, at, firstSeen: at, lastSeen: at,
    // The "did you know" subject for this train (see freightWanted), so the digest can reuse its headline.
    context: `freight#${train.headcode}#${train.origin ?? "unknown"}`,
    trainId: train.id, operator: operators[train.toc] ?? train.toc, event, stanox,
    place: here?.name || stanoxNames[stanox] || stanox, line: here?.line ?? next?.line, local: Boolean(here),
    planned: Number.isFinite(planned) ? planned : undefined, variation: Number.isFinite(variation) ? variation : undefined, status,
    origin: train.originName, next: next?.name, terminated: train.terminated || undefined,
    destination: train.destination, expireAt: Math.floor(at / 1000) + sightingLifetime,
  };
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined && value !== ""));
}

async function saveSightings(rows: Record<string, unknown>[]): Promise<void> {
  if (!sightingsTable || !rows.length) return;
  rows = [...new Map(rows.map((row) => [`${row.day}|${row.sk}`, row])).values()];
  for (let i = 0; i < rows.length; i += 25) {
    let pending = rows.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length && attempt < 3; attempt++) {
      const { UnprocessedItems } = await dynamo.send(new BatchWriteCommand({ RequestItems: { [sightingsTable]: pending } }));
      pending = (UnprocessedItems?.[sightingsTable] ?? []) as typeof pending;
    }
  }
}

function messages(event: KafkaEvent): Message[] {
  return Object.values(event.records ?? {}).flat().flatMap(({ value }) => {
    if (!value) return [];
    try {
      const parsed: unknown = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
      return (Array.isArray(parsed) ? parsed : [parsed]) as Message[];
    } catch {
      return [];
    }
  });
}

async function load(): Promise<FreightFile> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const data = JSON.parse(await object.Body!.transformToString()) as FreightFile;
    if (data?.version === 1 && data.trains) return { ...data, pending: data.pending ?? {} };
  } catch {
    // Start afresh when there is no file yet.
  }
  return { version: 1, updated: 0, trains: {}, pending: {} };
}

export async function handler(event: KafkaEvent) {
  if (!bucket) throw new Error("Bucket missing");
  const state = await load();
  let applied = 0;
  const sightings: Record<string, unknown>[] = [];
  for (const { header, body } of messages(event)) {
    if (!body?.train_id || !isFreight(body.train_id)) continue;
    const id = body.train_id;
    if (header?.msg_type === "0001") {
      const train = state.trains[id];
      const origin = body.sched_origin_stanox;
      const departed = number(body.origin_dep_timestamp);
      if (train) Object.assign(train, { origin, originName: stanoxNames[origin], departed });
      else state.pending[id] = [origin, departed];
      continue;
    }
    if (header?.msg_type !== "0003") continue;
    const at = number(body.actual_timestamp);
    if (!Number.isFinite(at)) continue;
    const report: Report = {
      stanox: body.loc_stanox, event: body.event_type, at, planned: number(body.planned_timestamp),
      variation: number(body.timetable_variation), status: body.variation_status,
    };
    const previous = state.trains[id];
    if (previous && previous.last.at > at) continue;
    const pending = state.pending[id];
    delete state.pending[id];
    state.trains[id] = {
      id, headcode: headcodeOf(id), toc: body.toc_id,
      origin: previous?.origin ?? pending?.[0], departed: previous?.departed ?? pending?.[1],
      originName: previous?.originName ?? (pending ? stanoxNames[pending[0]] : undefined),
      last: report, next: body.next_report_stanox || undefined, terminated: body.train_terminated === "true",
      path: [...(previous?.path ?? []), [report.stanox, at] as [string, number]].slice(-40),
      destination: previous?.destination, destinationStanox: previous?.destinationStanox,
      routeChecked: previous?.routeChecked, learned: previous?.learned,
    };
    const row = sighting(state.trains[id]);
    if (row) sightings.push(row);
    applied++;
  }
  const now = Date.now();
  if (routesTable) await learnRoutes(Object.values(state.trains), now);
  for (const [id, train] of Object.entries(state.trains)) {
    if (now - train.last.at > (train.terminated ? keepTerminated : keepFor)) delete state.trains[id];
  }
  for (const [id, [, departed]] of Object.entries(state.pending)) if (!(now - departed < keepFor)) delete state.pending[id];
  state.updated = now;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: "application/json", Body: JSON.stringify(state) }));
  await saveSightings(sightings).catch((error: unknown) => console.warn("freight: sightings not saved: %s", error instanceof Error ? error.message : "error"));
  console.log("freight: %d reports applied, %d local, %d trains tracked", applied, sightings.length, Object.keys(state.trains).length);
}

// Freight usually runs the same path under the same headcode each day. Each time a train terminates,
// count that terminus against its headcode and origin (and against the headcode alone, for trains
// whose activation we missed). New trains then show their most frequent terminus as a destination.
const routeKeys = (train: FreightTrain) => train.origin ? [`${train.headcode}#${train.origin}`, `${train.headcode}#*`] : [`${train.headcode}#*`];

async function learnRoutes(trains: FreightTrain[], now: number): Promise<void> {
  const finished = trains.filter((train) => train.terminated && !train.learned);
  await Promise.all(finished.flatMap((train) => {
    train.learned = true;
    return routeKeys(train).map((route) => dynamo.send(new UpdateCommand({
      TableName: routesTable, Key: { route, terminus: train.last.stanox },
      UpdateExpression: "ADD runs :one SET lastSeen = :now, expireAt = :expiry",
      ExpressionAttributeValues: { ":one": 1, ":now": now, ":expiry": Math.floor(now / 1000) + routeLifetime },
    })));
  })).catch((error: unknown) => console.warn("freight routes: %s", error instanceof Error ? error.message : "write failed"));

  const unchecked = trains.filter((train) => !train.terminated && train.routeChecked !== routeKeys(train)[0]).slice(0, 40);
  await Promise.all(unchecked.map(async (train) => {
    for (const route of routeKeys(train)) {
      const { Items = [] } = await dynamo.send(new QueryCommand({
        TableName: routesTable, KeyConditionExpression: "route = :route", ExpressionAttributeValues: { ":route": route },
      }));
      const best = Items.sort((a, b) => (b.runs - a.runs) || (b.lastSeen - a.lastSeen))[0];
      if (best) {
        Object.assign(train, { destinationStanox: best.terminus, destination: stanoxNames[best.terminus] });
        break;
      }
    }
    train.routeChecked = routeKeys(train)[0];
  })).catch((error: unknown) => console.warn("freight routes: %s", error instanceof Error ? error.message : "lookup failed"));
}
