import { HeadObjectCommand, PutObjectCommand, type S3Client, type S3ServiceException } from "@aws-sdk/client-s3";

const key = "feeds/air-fallback";
const cooldownMs = 4 * 60_000;

export async function reserveAircraftFallback(s3: S3Client, bucket: string | undefined): Promise<boolean> {
  const options = { abortSignal: AbortSignal.timeout(3000) };
  const location = { Bucket: bucket, Key: key };
  const previous = await s3.send(new HeadObjectCommand(location), options).catch((error: S3ServiceException) => {
    const status = error.$metadata?.httpStatusCode;
    // S3 can report a missing object as 403 when the caller lacks ListBucket.
    if (status !== 403 && status !== 404) throw error;
    return undefined;
  });
  const now = Date.now();
  if (previous && (!previous.ETag || !previous.LastModified || now - previous.LastModified.getTime() < cooldownMs)) return false;
  try {
    // The conditional write gives only one invocation permission to try the fallback.
    await s3.send(new PutObjectCommand({
      ...location, Body: new Date(now).toISOString(), ContentType: "text/plain",
      ...(previous ? { IfMatch: previous.ETag } : { IfNoneMatch: "*" }),
    }), options);
    return true;
  } catch (error) {
    const status = (error as S3ServiceException).$metadata?.httpStatusCode;
    if (status === 409 || status === 412) return false;
    throw error;
  }
}
