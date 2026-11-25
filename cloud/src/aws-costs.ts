import { CostExplorerClient, GetCostAndUsageCommand, type ResultByTime } from "@aws-sdk/client-cost-explorer";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { londonClock, row, type Graphic, type Page } from "./board.js";
import { textWidth } from "./font.js";
import { header } from "./sky.js";

// Waypoint's AWS spending this month by service, from Cost Explorer filtered on the SST app tag (only costs
// incurred since the tag was activated are tagged). One request every 6 hours ($0.01 each), cached in ContextFacts.
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const costExplorer = new CostExplorerClient({ region: "us-east-1" });
const table = process.env.CONTEXT_TABLE;
const refreshMs = 6 * 3_600_000;
const cacheKey = "costs#aws-services";

export type AwsCosts = { month: string; total: number; services: { name: string; cost: number }[]; daily: Record<string, number> };

const fit = (text: string, pixels: number) => {
  while (text && textWidth(text) > pixels) text = text.slice(0, -1);
  return text.trimEnd();
};
const dollars = (value: number) => value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;

// Short display names for the services Waypoint uses; anything else drops its "Amazon"/"AWS" prefix.
const shortNames: Record<string, string> = {
  "AWS Lambda": "LAMBDA", "Amazon DynamoDB": "DYNAMODB", "Amazon Simple Storage Service": "S3", "AmazonCloudWatch": "CLOUDWATCH",
  "Amazon API Gateway": "API GATEWAY", "AWS Secrets Manager": "SECRETS MANAGER", "AWS Key Management Service": "KMS",
  "AWS Systems Manager": "SYSTEMS MANAGER", "Amazon EventBridge": "EVENTBRIDGE", "EC2 - Other": "EC2 OTHER",
  "Amazon Elastic Compute Cloud - Compute": "EC2", "AWS Cost Explorer": "COST EXPLORER", "Amazon Simple Queue Service": "SQS",
  "Amazon Simple Notification Service": "SNS", "AWS CloudTrail": "CLOUDTRAIL", "AWS Step Functions": "STEP FUNCTIONS",
};
const shortName = (name: string) => shortNames[name] ?? name.replace(/^(Amazon|AWS)\s*/, "").toUpperCase();

function summarise(month: string, results: ResultByTime[]): AwsCosts {
  const byService = new Map<string, number>();
  const daily: Record<string, number> = {};
  for (const result of results) {
    const day = result.TimePeriod?.Start ?? "";
    for (const group of result.Groups ?? []) {
      const cost = Number(group.Metrics?.UnblendedCost?.Amount ?? 0);
      const name = shortName(group.Keys?.[0] ?? "OTHER");
      byService.set(name, (byService.get(name) ?? 0) + cost);
      if (day) daily[day] = (daily[day] ?? 0) + cost;
    }
  }
  const services = [...byService].map(([name, cost]) => ({ name, cost })).filter(({ cost }) => cost > 0.000_5).sort((a, b) => b.cost - a.cost);
  return { month, total: services.reduce((sum, { cost }) => sum + cost, 0), services, daily };
}

/** This month's tagged AWS costs, refreshed from Cost Explorer at most every 6 hours. */
export async function awsCosts(nowDate: Date): Promise<AwsCosts | undefined> {
  if (!table) return;
  const now = nowDate.getTime();
  const month = nowDate.toISOString().slice(0, 7);
  const { Responses } = await dynamo.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: [{ subject: cacheKey }] } } }));
  const Item = Responses?.[table]?.[0];
  if (Item?.month === month && now - Number(Item.fetchedAt) < refreshMs) return Item.costs as AwsCosts;
  const results: ResultByTime[] = [];
  let token: string | undefined;
  do {
    const page = await costExplorer.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: `${month}-01`, End: new Date(now + 86_400_000).toISOString().slice(0, 10) },
      Granularity: "DAILY", Metrics: ["UnblendedCost"], GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
      Filter: { Tags: { Key: "sst:app", Values: ["waypoint-terminal"] } }, NextPageToken: token,
    }));
    results.push(...page.ResultsByTime ?? []);
    token = page.NextPageToken;
  } while (token);
  const costs = summarise(month, results);
  await dynamo.send(new PutCommand({
    TableName: table, Item: { subject: cacheKey, month, costs, fetchedAt: now, expireAt: Math.floor(now / 1000) + 40 * 86_400 },
  }));
  return costs;
}

/** The AWS costs screen: month total on the left, one line per service on the right. Hidden until tagged costs exist. */
export function awsCostsPage(costs: AwsCosts | undefined, nowDate: Date): Page | undefined {
  if (!costs || costs.total <= 0) return;
  const now = nowDate.getTime();
  const today = costs.daily[nowDate.toISOString().slice(0, 10)] ?? 0;
  const days = Object.values(costs.daily).filter((cost) => cost > 0).length;
  const graphics: Graphic[] = [
    ...header("AWS COSTS", now),
    [3, 13, 1, 8, "THIS MONTH (EST)"],
    [3, 22, 2, 15, dollars(costs.total)],
    [3, 41, 1, 11, `TODAY ${dollars(today)}`],
    [3, 52, 1, 9, `${costs.services.length} SERVICES, ${days} ${days === 1 ? "DAY" : "DAYS"}`],
    [116, 13, 1, 50, 3],
  ];

  // Up to five lines, largest first, each with a bar for its share of the month; the rest are folded together.
  const lines = costs.services.length > 5
    ? [...costs.services.slice(0, 4), { name: `${costs.services.length - 4} OTHERS`, cost: costs.services.slice(4).reduce((sum, { cost }) => sum + cost, 0) }]
    : costs.services;
  const peak = Math.max(...lines.map(({ cost }) => cost));
  lines.forEach(({ name, cost }, i) => {
    const top = 13 + i * 10;
    const amount = cost < 0.01 ? "<$0.01" : dollars(cost);
    const width = Math.max(1, Math.round(cost / peak * 132));
    graphics.push([121, top + 8, width, 1, 2], [121, top, 1, 12, fit(name, 128 - textWidth(amount) - 4)], [254 - textWidth(amount), top, 1, 15, amount]);
  });
  return {
    id: "aws-costs", mode: "costs", title: "AWS COSTS", updated: londonClock.format(now), state: "live",
    rows: [row("", `AWS ${dollars(costs.total)} THIS MONTH`, "")], graphics, clock: { right: 254, shade: 11 }, dwell_seconds: 20,
  };
}
