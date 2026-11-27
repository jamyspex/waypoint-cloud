// Rebuild one night's highlights in AWS and save the screen as the emulator's overnight demo.
// Usage: npm run overnight:replay -- [YYYY-MM-DD]   (defaults to today; uses AWS_PROFILE)
import { writeFile } from "node:fs/promises";
import { InvokeCommand, LambdaClient, paginateListFunctions } from "@aws-sdk/client-lambda";
import { DynamoDBClient, paginateListTables } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const region = "eu-west-1";
const day = process.argv[2] ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Day must be YYYY-MM-DD");

const lambda = new LambdaClient({ region });
let digestFunction;
for await (const page of paginateListFunctions({ client: lambda }, {})) {
  digestFunction ??= page.Functions?.find(({ FunctionName }) => /^waypoint-terminal-prod-OvernightDigest/.test(FunctionName ?? ""))?.FunctionName;
}
if (!digestFunction) throw new Error("OvernightDigest function not found");
const result = await lambda.send(new InvokeCommand({ FunctionName: digestFunction, Payload: JSON.stringify({ day, force: true }) }));
const summary = JSON.parse(Buffer.from(result.Payload ?? []).toString() || "{}");
if (result.FunctionError) throw new Error(`Digest failed: ${JSON.stringify(summary)}`);
console.log(summary.headline);
for (const line of summary.exhibits ?? []) console.log(`  ${line}`);

const client = new DynamoDBClient({ region });
let table;
for await (const page of paginateListTables({ client }, {})) table ??= page.TableNames?.find((name) => name.startsWith("waypoint-terminal-prod-ContextFactsTable"));
const { Item } = await DynamoDBDocumentClient.from(client).send(new GetCommand({ TableName: table, Key: { subject: `digest#${day}` } }));
if (!Item?.pages) throw new Error("Digest not stored");
await writeFile(new URL("../emulator/overnight-demo.json", import.meta.url), JSON.stringify({ version: 2, rotation: 60, pages: Item.pages }));
console.log("Saved emulator/overnight-demo.json; open /demo/overnight");
