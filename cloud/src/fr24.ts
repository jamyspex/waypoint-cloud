import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Lookup } from "./air.js";

// Flightradar24 API: flight number, aircraft, operator and origin/destination for the aircraft that get
// a card. Each flight costs credits, so results are cached in DynamoDB and spending is capped per day.
// Anything not resolved here falls back to the adsbdb lookups in air.ts.
const api = "https://fr24api.flightradar24.com/api";
const creditsPerFlight = 8;
const dailyCredits = 1500;
const flightHours = 6;
const missingMinutes = 30;
const referenceDays = 90;

type Fr24Flight = {
  callsign?: string; flight?: string; type?: string; reg?: string; painted_as?: string; operating_as?: string;
  orig_iata?: string; orig_icao?: string; dest_iata?: string; dest_icao?: string;
};
type CachedFlight = Pick<Fr24Flight, "flight" | "operating_as" | "painted_as" | "orig_iata" | "orig_icao" | "dest_iata" | "dest_icao">;
type Airport = { name?: string; city?: string; iata?: string; icao?: string };

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = process.env.FR24_CACHE_TABLE;

async function get<T>(token: string, path: string, deadline: AbortSignal): Promise<T> {
  const response = await fetch(`${api}${path}`, {
    headers: { Accept: "application/json", "Accept-Version": "v1", Authorization: `Bearer ${token}` }, signal: deadline,
  });
  if (!response.ok) throw new Error(`FR24 HTTP ${response.status}`);
  return await response.json() as T;
}

async function cached(keys: string[]): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < keys.length; i += 100) {
    const { Responses } = await dynamo.send(new BatchGetCommand({
      RequestItems: { [table!]: { Keys: keys.slice(i, i + 100).map((key) => ({ key })) } },
    }));
    const now = Math.floor(Date.now() / 1000);
    for (const item of Responses?.[table!] ?? []) if (Number(item.expireAt) > now) found.set(String(item.key), item);
  }
  return found;
}

const remember = (key: string, value: Record<string, unknown>, seconds: number) => dynamo.send(new PutCommand({
  TableName: table, Item: { key, ...value, expireAt: Math.floor(Date.now() / 1000) + seconds },
}));

// Reserve credits for today, refusing once the daily cap would be passed.
async function reserve(credits: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    await dynamo.send(new UpdateCommand({
      TableName: table, Key: { key: `budget#${day}` },
      UpdateExpression: "ADD spent :credits SET expireAt = :expiry",
      ConditionExpression: "attribute_not_exists(spent) OR spent <= :limit",
      ExpressionAttributeValues: { ":credits": credits, ":limit": dailyCredits - credits, ":expiry": Math.floor(Date.now() / 1000) + 3 * 86_400 },
    }));
    return true;
  } catch {
    return false;
  }
}

const clean = (value: unknown) => typeof value === "string" ? value.trim().toUpperCase() : "";

/** Routes and airlines from Flightradar24 for the given callsigns, keyed by callsign. */
export async function fr24Lookups(token: string | undefined, callsigns: string[], deadline: AbortSignal): Promise<Map<string, Lookup>> {
  const results = new Map<string, Lookup>();
  if (!token || !table) return results;
  const wanted = [...new Set(callsigns.map(clean).filter((callsign) => /^[A-Z0-9]{2,8}$/.test(callsign)))].slice(0, 15);
  if (!wanted.length) return results;
  try {
    const known = await cached(wanted.map((callsign) => `flight#${callsign}`));
    const flights = new Map<string, CachedFlight | null>();
    for (const callsign of wanted) {
      const item = known.get(`flight#${callsign}`);
      if (item) flights.set(callsign, item.missing ? null : item as CachedFlight);
    }
    const missing = wanted.filter((callsign) => !flights.has(callsign));
    if (missing.length && await reserve(missing.length * creditsPerFlight)) {
      const { data = [] } = await get<{ data?: Fr24Flight[] }>(token, `/live/flight-positions/full?callsigns=${missing.join(",")}`, deadline);
      for (const callsign of missing) {
        const flight = data.find((entry) => clean(entry.callsign) === callsign);
        const summary: CachedFlight | null = flight ? {
          flight: flight.flight, operating_as: flight.operating_as, painted_as: flight.painted_as,
          orig_iata: flight.orig_iata, orig_icao: flight.orig_icao, dest_iata: flight.dest_iata, dest_icao: flight.dest_icao,
        } : null;
        flights.set(callsign, summary);
        await remember(`flight#${callsign}`, summary ?? { missing: true }, summary ? flightHours * 3600 : missingMinutes * 60);
      }
    }

    // Airport and airline names change rarely, so look up only a couple of new ones per run.
    const airportCodes = [...new Set([...flights.values()].flatMap((flight) => flight ? [flight.orig_icao, flight.dest_icao] : []).filter(Boolean) as string[])];
    const airlineCodes = [...new Set([...flights.values()].flatMap((flight) => flight?.operating_as ?? flight?.painted_as ?? []))];
    const names = await cached([...airportCodes.map((code) => `airport#${code}`), ...airlineCodes.map((code) => `airline#${code}`)]);
    let airportBudget = 1;
    let airlineBudget = 1;
    for (const code of airportCodes) {
      if (names.has(`airport#${code}`) || airportBudget-- <= 0) continue;
      // This plan allows the light airport record (name and codes); the name stands in for the city.
      const airport = await get<Airport>(token, `/static/airports/${code}/light`, deadline).catch(() => undefined);
      if (airport?.name) {
        const city = airport.name.replace(/\b(International|Intl|Airport|Aerodrome|Airfield|Regional)\b/gi, "").replace(/\s+/g, " ").trim();
        const entry = { name: airport.name, city, iata: airport.iata, icao: airport.icao };
        names.set(`airport#${code}`, entry);
        await remember(`airport#${code}`, entry, referenceDays * 86_400);
      }
    }
    for (const code of airlineCodes) {
      if (names.has(`airline#${code}`) || airlineBudget-- <= 0) continue;
      const airline = await get<{ name?: string }>(token, `/static/airlines/${code}/light`, deadline).catch(() => undefined);
      if (airline?.name) {
        names.set(`airline#${code}`, { name: airline.name });
        await remember(`airline#${code}`, { name: airline.name }, referenceDays * 86_400);
      }
    }

    for (const [callsign, flight] of flights) {
      if (!flight) continue;
      const airport = (icao?: string, iata?: string) => {
        const entry = icao ? names.get(`airport#${icao}`) : undefined;
        return { iata_code: iata ?? (entry?.iata as string | undefined), icao_code: icao, municipality: entry?.city as string | undefined, name: entry?.name as string | undefined };
      };
      const operator = flight.operating_as ?? flight.painted_as;
      const airline = clean(operator ? names.get(`airline#${operator}`)?.name : "");
      results.set(callsign, {
        airline,
        route: (flight.orig_iata || flight.orig_icao || flight.dest_iata || flight.dest_icao) ? {
          callsign_iata: flight.flight, airline: airline ? { name: airline } : null,
          origin: airport(flight.orig_icao, flight.orig_iata), destination: airport(flight.dest_icao, flight.dest_iata),
        } : undefined,
      });
    }
  } catch (error) {
    console.warn("fr24: %s", error instanceof Error ? error.message : "lookup failed");
  }
  return results;
}
