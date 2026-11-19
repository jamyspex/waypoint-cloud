import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { createHash } from "node:crypto";
import { isBoard, maxBoardBytes } from "./board.js";

type Scene = {
  version: 1;
  title: string;
  message: string;
  animation: "scroll" | "blink" | "none";
  speed: number;
};

const s3 = new S3Client({});
const printable = /^[\x20-\x7e]+$/;

function parseScene(value: unknown): Scene {
  if (!value || typeof value !== "object") throw new Error("Invalid scene");
  const { version, title, message, animation, speed } = value as Record<string, unknown>;
  if (
    version !== 1 ||
    typeof title !== "string" || title.length > 16 || !printable.test(title) ||
    typeof message !== "string" || message.length > 128 || !printable.test(message) ||
    (animation !== "scroll" && animation !== "blink" && animation !== "none") ||
    typeof speed !== "number" || !Number.isInteger(speed) || speed < 8 || speed > 80
  ) {
    throw new Error("Invalid scene");
  }
  return { version, title, message, animation, speed };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const live = event.queryStringParameters?.view === "live";
    const object = await s3.send(new GetObjectCommand({
      Bucket: process.env.SCENES_BUCKET,
      Key: live ? "feeds/waypoint.json" : "scenes/waypoint.json",
    }));
    if (!object.Body || object.ContentLength === undefined || object.ContentLength > maxBoardBytes) {
      if (object.Body && "destroy" in object.Body) object.Body.destroy();
      throw new Error("Invalid scene size");
    }
    const decoded: unknown = JSON.parse(await object.Body.transformToString());
    if (live && !isBoard(decoded)) throw new Error("Invalid feed board");
    const body = JSON.stringify(live ? decoded : parseScene(decoded));
    const etag = '"' + createHash("sha256").update(body).digest("hex").slice(0, 32) + '"';
    const headers = { "cache-control": "no-cache", etag };
    const matches = event.headers["if-none-match"]?.split(",")
      .some((tag) => tag.trim().replace(/^W\//, "") === etag || tag.trim() === "*");
    if (matches) return { statusCode: 304, headers };
    return { statusCode: 200, headers: { ...headers, "content-type": "application/json" }, body };
  } catch (error) {
    console.error("Scene unavailable", error instanceof Error ? error.name : "UnknownError");
    return { statusCode: 503, headers: { "cache-control": "no-store" }, body: "Scene unavailable" };
  }
};
