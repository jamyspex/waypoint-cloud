import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { createHash } from "node:crypto";
import { detailedBoardKey, isBoard, isDetailedBoard, maxBoardBytes, maxDetailedBoardBytes, screenId, screenIndex, screensOf } from "./board.js";
import { meetingFocusPage } from "./calendar.js";
import { liveSatellitePage, liveTargets } from "./live-space.js";

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
    const view = event.queryStringParameters?.view;
    const id = event.queryStringParameters?.screen;
    const detailed = view === "index" || view === "screen";
    if (view === "screen" && (!id || !screenId.test(id))) return { statusCode: 400, body: "Invalid screen ID" };
    const object = await s3.send(new GetObjectCommand({
      Bucket: process.env.SCENES_BUCKET,
      Key: detailed ? detailedBoardKey : view === "live" ? "feeds/waypoint.json" : "scenes/waypoint.json",
    }));
    if (!object.Body || object.ContentLength === undefined
      || object.ContentLength > (detailed ? maxDetailedBoardBytes : maxBoardBytes)) {
      if (object.Body && "destroy" in object.Body) object.Body.destroy();
      throw new Error("Invalid scene size");
    }
    const decoded: unknown = JSON.parse(await object.Body.transformToString());
    let value: unknown;
    if (detailed) {
      if (!isDetailedBoard(decoded)) throw new Error("Invalid feed board");
      const now = Date.now();
      const expected = Number(event.queryStringParameters?.at);
      const time = Number.isSafeInteger(expected) && expected >= now - 2000 && expected <= now + 30_000 ? expected : now;
      const catalog = decoded.liveSpace;
      const targets = catalog && (view === "index" || id?.startsWith("space-")) ? liveTargets(catalog, time) : undefined;
      const screens = screensOf(decoded, meetingFocusPage(decoded.meetingFocus, new Date(now)), targets?.map(({ page }) => page));
      if (view === "index") {
        value = screenIndex(screens);
      } else {
        const satellite = targets?.find(({ page }) => page.id === id);
        const page = satellite && catalog ? liveSatellitePage(satellite, catalog, time) : screens.find((screen) => screen.id === id);
        if (!page) return { statusCode: 404, body: "Screen unavailable" };
        value = { version: 2, rotation: decoded.rotation, pages: [page] };
      }
    } else if (view === "live") {
      if (!isBoard(decoded)) throw new Error("Invalid feed board");
      value = decoded;
    } else value = parseScene(decoded);
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > maxBoardBytes) throw new Error("Screen exceeds response limit");
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
