import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Subject } from "./context.js";

// Everything that passed by, kept for the overnight highlights. One row per aircraft, vessel, satellite or aurora
// alert per London day (sk = kind#subject), updated as it is seen again; the freight Lambda adds one row per
// movement report (sk = freight#time#train#...). Rows expire after 180 days.
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const table = process.env.SIGHTINGS_TABLE;
const lifetime = 180 * 86_400;
const londonDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });

export const dayOf = (time: number) => londonDay.format(time);

export type Kind = "aircraft" | "vessel" | "satellite" | "aurora" | "freight";
export type Sighting = {
  day: string; sk: string; subject: string; kind: Kind; label: string; anchor?: Record<string, string>;
  firstSeen: number; lastSeen: number; closest?: number; altitude?: number; elevation?: number; area?: string;
  // Freight report fields (see freight.ts).
  at?: number; headcode?: string; operator?: string; event?: string; place?: string; line?: string; local?: boolean;
  variation?: number; status?: string; origin?: string; next?: string; terminated?: boolean; destination?: string;
};
export type Seen = { kind: Exclude<Kind, "freight">; subject: Pick<Subject, "key" | "label" | "anchor">; area?: string;
  // Aircraft: nautical miles and feet; satellites: degrees above the horizon.
  distance?: number; altitude?: number; elevation?: number };

/**
 * Record what is in view. New contacts are written straight away; ones already seen are refreshed every
 * five minutes, keeping the closest distance (or highest elevation) of the day.
 */
export async function recordSightings(seen: Seen[], now: number, alreadySeen: (key: string) => boolean): Promise<void> {
  if (!table) return;
  const refresh = new Date(now).getUTCMinutes() % 5 === 0;
  const day = dayOf(now);
  const unique = [...new Map(seen.map((entry) => [`${entry.kind}#${entry.subject.key}`, entry])).values()];
  await Promise.all(unique.filter((entry) => refresh || !alreadySeen(entry.subject.key)).map(async (entry) => {
    const key = { day, sk: `${entry.kind}#${entry.subject.key}` };
    const values: Record<string, unknown> = {
      ":subject": entry.subject.key, ":kind": entry.kind, ":label": entry.subject.label, ":anchor": entry.subject.anchor,
      ":now": now, ":expiry": Math.floor(now / 1000) + lifetime,
    };
    const base = "SET subject = :subject, kind = :kind, label = :label, anchor = :anchor, firstSeen = if_not_exists(firstSeen, :now), lastSeen = :now, expireAt = :expiry"
      + (entry.area ? ", area = :area" : "");
    if (entry.area) values[":area"] = entry.area;
    // The best value of the day: smallest distance, or highest elevation.
    const best = entry.distance !== undefined ? { field: "closest", value: Math.round(entry.distance * 10) / 10, closer: ">" }
      : entry.elevation !== undefined ? { field: "elevation", value: Math.round(entry.elevation), closer: "<" } : undefined;
    try {
      if (!best) {
        await dynamo.send(new UpdateCommand({ TableName: table, Key: key, UpdateExpression: base, ExpressionAttributeValues: values }));
        return;
      }
      try {
        await dynamo.send(new UpdateCommand({
          TableName: table, Key: key,
          UpdateExpression: `${base}, ${best.field} = :best${entry.altitude !== undefined ? ", altitude = :altitude" : ""}`,
          ConditionExpression: `attribute_not_exists(${best.field}) OR ${best.field} ${best.closer} :best`,
          ExpressionAttributeValues: { ...values, ":best": best.value, ...(entry.altitude !== undefined ? { ":altitude": Math.round(entry.altitude) } : {}) },
        }));
      } catch (error) {
        if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
        await dynamo.send(new UpdateCommand({ TableName: table, Key: key, UpdateExpression: base, ExpressionAttributeValues: values }));
      }
    } catch (error) {
      console.warn("sightings: %s", error instanceof Error ? error.message : "write failed");
    }
  }));
}

/** Every row for the given London days. */
export async function sightingsOn(days: string[]): Promise<Sighting[]> {
  if (!table) return [];
  const rows: Sighting[] = [];
  for (const day of days) {
    let start: Record<string, unknown> | undefined;
    do {
      const page = await dynamo.send(new QueryCommand({
        TableName: table, KeyConditionExpression: "#day = :day", ExpressionAttributeNames: { "#day": "day" },
        ExpressionAttributeValues: { ":day": day }, ExclusiveStartKey: start,
      }));
      rows.push(...(page.Items ?? []) as Sighting[]);
      start = page.LastEvaluatedKey;
    } while (start);
  }
  return rows;
}
