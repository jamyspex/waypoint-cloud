import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Page } from "./board.js";
import { dayOf } from "./sightings.js";

// The collector's side of the overnight highlights: today's stored screens, from 08:00 to 12:00 London time.
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = process.env.CONTEXT_TABLE;
const londonHour = (time: number) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/London" }).format(time));

export async function overnightScreens(now: Date): Promise<Page[] | undefined> {
  const hour = londonHour(now.getTime());
  if (!table || hour < 8 || hour >= 12) return;
  const subject = `digest#${dayOf(now.getTime())}`;
  const { Responses } = await dynamo.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: [{ subject }] } } }));
  const item = Responses?.[table]?.[0];
  return item?.pages as Page[] | undefined;
}
