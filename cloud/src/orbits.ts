import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { epochOf, fetchOrbits, maxOrbitAgeDays, type Orbit, type Settings } from "./feeds.js";

// Refreshes the satellite catalogue every two hours, matching CelesTrak's update cadence, so the
// per-minute collector only reads the cache. CelesTrak serves each group once per update, so a
// failed Starlink download keeps the previous Starlinks while their elements are still current.
type OrbitCache = { version: 2; fetchedAt: number; mask: number; orbits: Orbit[] };

const s3 = new S3Client({});
const ssm = new SSMClient({});
const bucket = process.env.SCENES_BUCKET;
const key = "feeds/orbits.json";

export async function handler() {
  const parameter = process.env.FEED_SETTINGS;
  if (!bucket || !parameter) throw new Error("Orbit refresh settings missing");
  const { Parameter } = await ssm.send(new GetParameterCommand({ Name: parameter, WithDecryption: true }));
  const settings = JSON.parse(Parameter?.Value ?? "{}") as Settings;
  const mask = settings.space.mask;
  const previous = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    .then(async (object) => JSON.parse(await object.Body!.transformToString()) as OrbitCache).catch(() => undefined);
  const now = Date.now();
  const current = (orbit: Orbit) => Math.abs(now - epochOf(orbit)) <= maxOrbitAgeDays * 86_400_000;
  // Merge with the previous catalogue so a source that fails (rate limits, slow downloads) never shrinks it:
  // fresh elements replace old ones, and satellites a source did not return stay while still current.
  const fresh = await fetchOrbits(mask).catch((error: unknown) => {
    console.warn("orbits: refresh failed: %s", error instanceof Error ? error.message : "error");
    return [] as Orbit[];
  });
  const merged = new Map<string, Orbit>();
  if (previous?.mask === mask) for (const orbit of previous.orbits) if (current(orbit)) merged.set(orbit.line1.slice(2, 7), orbit);
  for (const orbit of fresh) merged.set(orbit.line1.slice(2, 7), orbit);
  const orbits = [...merged.values()];
  if (!orbits.length) throw new Error("No current orbital elements");
  console.log("orbits: %d fetched, %d kept from before", fresh.length, orbits.length - fresh.length);
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, ContentType: "application/json",
    Body: JSON.stringify({ version: 2, fetchedAt: now, mask, orbits } satisfies OrbitCache),
  }));
  console.log("orbits: %d satellites cached", orbits.length);
}
