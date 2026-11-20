import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { stanoxNames } from "./stanox-names.js";

// Lambda reads TRUST train movements from the RDM Kafka topic (TRAIN_MVT_ALL_TOC) through a
// self-managed Kafka event source and keeps the latest position of every freight train.
type KafkaEvent = { records?: Record<string, { value?: string }[]> };
type Message = { header?: { msg_type?: string }; body?: Record<string, string> };
export type Report = { stanox: string; event: string; at: number; planned: number; variation: number; status: string };
export type FreightTrain = {
  id: string; headcode: string; toc: string; origin?: string; originName?: string; departed?: number;
  last: Report; next?: string; terminated: boolean; path: [stanox: string, at: number][];
};
export type FreightFile = {
  version: 1; updated: number; trains: Record<string, FreightTrain>;
  // Activations seen before a train's first movement report: origin STANOX and departure time.
  pending: Record<string, [origin: string, departed: number]>;
};

const s3 = new S3Client({});
const bucket = process.env.SCENES_BUCKET;
const key = "feeds/freight-trains.json";
const keepFor = 6 * 3_600_000;
const keepTerminated = 3_600_000;

// The headcode is characters 3-6 of the TRUST train ID; classes 4, 6, 7 and 8 are freight and 0 is a light locomotive.
const headcodeOf = (trainId: string) => trainId.slice(2, 6);
const isFreight = (trainId: string) => /^[04678][A-Z0-9][0-9]{2}$/.test(headcodeOf(trainId));
const number = (value: string | undefined) => Number(value ?? NaN);

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
    };
    applied++;
  }
  const now = Date.now();
  for (const [id, train] of Object.entries(state.trains)) {
    if (now - train.last.at > (train.terminated ? keepTerminated : keepFor)) delete state.trains[id];
  }
  for (const [id, [, departed]] of Object.entries(state.pending)) if (!(now - departed < keepFor)) delete state.pending[id];
  state.updated = now;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: "application/json", Body: JSON.stringify(state) }));
  console.log("freight: %d reports applied, %d trains tracked", applied, Object.keys(state.trains).length);
}
