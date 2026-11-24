import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";

const firmware = await readFile(new URL("../../src/cloud.rs", import.meta.url), "utf8");
const host = firmware.match(/const HOST: &CStr = c"([^"]+)"/)?.[1];
const path = firmware.match(/const PATH: &str = "([^"]+)"/)?.[1];
if (!host || !path) throw new Error("Could not find the live display URL in the firmware");
const displayUrl = new URL(path, `https://${host}`);
const port = Number(process.env.WAYPOINT_PORT || 4280);
const profile = process.env.AWS_PROFILE || "linespeed-root-admin";
const exec = promisify(execFile);
// Saved sample screens for cards that are rarely live. Each is served at /demo/<name>.
const demos = new Map();
for (const name of ["air", "aurora", "mix", "freight", "context"]) {
  const board = JSON.parse(await readFile(new URL(`./${name}-demo.json`, import.meta.url), "utf8"));
  const screens = board.pages.map(({ id, mode, title }) => ({ id, mode, title }));
  demos.set(name, { board, index: { version: 3, screens } });
}

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ...[...demos.keys()].map((name) => [`/demo/${name}`, ["index.html", "text/html; charset=utf-8"]]),
  ["/emulator.mjs", ["emulator.mjs", "text/javascript; charset=utf-8"]],
  ["/render.mjs", ["render.mjs", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/font.bin", ["../../assets/stock-v12.14-ascii.bin", "application/octet-stream"]],
]);
let credential;
async function token() {
  credential ??= (process.env.WAYPOINT_DEVICE_TOKEN
    ? Promise.resolve(process.env.WAYPOINT_DEVICE_TOKEN)
    : exec("aws", [
      "--profile", profile, "--region", "eu-west-1", "ssm", "get-parameter",
      "--name", "/waypoint-terminal/prod/device-token", "--with-decryption",
      "--query", "Parameter.Value", "--output", "text",
    ], { timeout: 12_000 }).then(({ stdout }) => stdout)).then((value) => {
      const result = value.trim();
      if (!/^[a-f0-9]{64}$/.test(result)) throw new Error("Invalid device credential");
      return result;
    }).catch(() => {
      credential = undefined;
      throw new Error("Could not read the device credential. Check the local AWS CLI session.");
    });
  return credential;
}

const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'");
  const address = request.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(address)) {
    response.writeHead(403).end();
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" }).end();
    return;
  }
  try {
    const incoming = new URL(request.url, "http://localhost");
    const [, demoName, demoScreen] = incoming.pathname.match(/^\/demo\/([a-z]+)\/(?:index|screen\/([A-Za-z0-9-]{1,24}))$/) ?? [];
    const sample = demos.get(demoName);
    const samplePage = demoScreen && sample?.board.pages.find(({ id }) => id === demoScreen);
    if (sample && (!demoScreen || samplePage)) {
      const value = samplePage ? { ...sample.board, pages: [samplePage] } : sample.index;
      return response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    }
    const id = incoming.pathname.match(/^\/screen\/([A-Za-z0-9-]{1,24})$/)?.[1];
    if (incoming.pathname === "/index" || id) {
      const url = new URL(displayUrl);
      url.searchParams.set("view", id ? "screen" : "index");
      if (id) url.searchParams.set("screen", id);
      const at = incoming.searchParams.get("at");
      if (at && /^\d{13}$/.test(at)) url.searchParams.set("at", at);
      const headers = { Authorization: `Bearer ${await token()}`, Accept: "application/json" };
      if (request.headers["if-none-match"]) headers["If-None-Match"] = request.headers["if-none-match"];
      const result = await fetch(url, { headers, signal: AbortSignal.timeout(8_000), redirect: "error" });
      if (result.status === 401 || result.status === 403) credential = undefined;
      const etag = result.headers.get("etag");
      if (etag) response.setHeader("ETag", etag);
      if (result.status === 304) return response.writeHead(304).end();
      if (!result.ok) return response.writeHead(502).end(`AWS display replied HTTP ${result.status}.`);
      const body = await result.text();
      if (Buffer.byteLength(body) > 8192) return response.writeHead(502).end("AWS board exceeds 8 KiB.");
      return response.writeHead(200, { "Content-Type": "application/json" }).end(body);
    }
    const asset = assets.get(incoming.pathname);
    if (!asset) return response.writeHead(404).end();
    const body = await readFile(new URL(asset[0], import.meta.url));
    response.writeHead(200, { "Content-Type": asset[1] }).end(body);
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("Could not read the device")
      ? error.message : "Could not reach the AWS display.";
    response.writeHead(502).end(message);
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Waypoint emulator · http://localhost:${port}`));
