import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const port = 4281;
const origin = `http://localhost:${port}`;
const callback = origin + "/oauth2callback";
const scope = "https://www.googleapis.com/auth/calendar.events.readonly";
const usage = "Usage: npm run calendar:connect -- <label> [--client <google-oauth-json>] [--calendar <id> ...]";
const [label, ...args] = process.argv.slice(2);
let clientFile;
const calendars = [];
if (!label || !/^[A-Za-z0-9_-]{1,24}$/.test(label)) {
  console.error(usage);
  process.exit(1);
}
for (let i = 0; i < args.length; i += 2) {
  const option = args[i];
  const value = args[i + 1];
  if (value && option === "--client" && !clientFile) clientFile = value;
  else if (value && option === "--calendar") calendars.push(value);
  else {
    console.error(usage);
    process.exit(1);
  }
}

process.env.AWS_PROFILE ||= "linespeed-root-admin";
const stage = process.env.WAYPOINT_STAGE || "prod";
if (!/^[a-zA-Z0-9-]+$/.test(stage)) throw new Error("Invalid Waypoint stage");
const root = `/waypoint-terminal/${stage}/calendar`;
const ssm = new SSMClient({ region: "eu-west-1" });
const existing = await ssm.send(new GetParameterCommand({ Name: root + "/client", WithDecryption: true }))
  .then(({ Parameter }) => Parameter?.Value ? JSON.parse(Parameter.Value) : undefined)
  .catch((error) => {
    if (error.name === "ParameterNotFound") return undefined;
    throw new Error("Unable to read the Waypoint OAuth client from AWS. Check your AWS CLI session.");
  });
const fromFile = clientFile ? await readFile(clientFile, "utf8").then((text) => JSON.parse(text).web).catch(() => {
  throw new Error("Unable to read the Google OAuth client JSON.");
}) : undefined;
if (clientFile && (!fromFile?.client_id || !fromFile?.client_secret)) {
  throw new Error("Choose a Google OAuth client JSON downloaded for a Web application.");
}
if (fromFile?.redirect_uris && !fromFile.redirect_uris.includes(callback)) {
  throw new Error(`Add ${callback} as an authorised redirect URI in Google Cloud, then download the client JSON again.`);
}
if (existing && fromFile && existing.client_id !== fromFile.client_id) {
  throw new Error("The AWS stage already uses a different Google OAuth client. Use that client to keep all linked accounts working.");
}
const config = fromFile || existing;
if (!config?.client_id || !config?.client_secret) {
  throw new Error("Pass --client with the Google OAuth Web application JSON on the first connection.");
}
const client = { client_id: config.client_id, client_secret: config.client_secret };
const verifier = randomBytes(32).toString("base64url");
const state = randomBytes(32).toString("base64url");
const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
google.search = new URLSearchParams({
  client_id: client.client_id, redirect_uri: callback, response_type: "code",
  scope, access_type: "offline", prompt: "consent select_account", state,
  code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
}).toString();

function html(title, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body><main><h1>${title}</h1>${body}</main></body></html>`;
}
let used = false;
const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  const host = request.headers.host;
  if (request.method !== "GET" || ![`localhost:${port}`, `127.0.0.1:${port}`].includes(host)) {
    return response.writeHead(403).end();
  }
  const url = new URL(request.url, origin);
  if (url.pathname === "/") {
    return response.end(html("Connect Google Calendar", `<p>Account label: <strong>${label}</strong></p><p><a href="/authorise">Connect Google Calendar</a></p>`));
  }
  if (url.pathname === "/authorise" && !used) return response.writeHead(302, { Location: google.href }).end();
  if (url.pathname !== "/oauth2callback") return response.writeHead(404).end();
  const code = url.searchParams.get("code");
  if (used || url.searchParams.get("state") !== state || !code) {
    return response.writeHead(400).end(html("Connection incomplete", '<p><a href="/">Return to setup</a></p>'));
  }
  used = true;
  try {
    const result = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({ ...client, code, redirect_uri: callback, code_verifier: verifier, grant_type: "authorization_code" }),
    });
    if (!result.ok) throw new Error("Google token exchange failed");
    const data = await result.json();
    if (typeof data.refresh_token !== "string" || !data.refresh_token || !data.scope?.split(" ").includes(scope)) {
      throw new Error("Google Calendar consent incomplete");
    }
    if (fromFile || !existing) {
      await ssm.send(new PutParameterCommand({ Name: root + "/client", Type: "SecureString", Value: JSON.stringify(client), Overwrite: true }));
    }
    await ssm.send(new PutParameterCommand({
      Name: root + "/accounts/" + label.toLowerCase(), Type: "SecureString", Overwrite: true,
      Value: JSON.stringify({ label, refresh_token: data.refresh_token, calendars: calendars.length ? calendars : ["primary"] }),
    }));
    response.end(html("Calendar connected", `<p>${label} is ready for the Waypoint collector. You can close this tab.</p>`));
    console.log(`Connected ${label} to Waypoint stage ${stage}.`);
  } catch {
    process.exitCode = 1;
    response.writeHead(502).end(html("Calendar connection failed", "<p>Check the Google OAuth client, approved scope and AWS access, then run the connection command again.</p>"));
    console.error("Calendar connection failed before enrolment completed.");
  } finally {
    clearTimeout(expiry);
    server.close();
  }
});

const expiry = setTimeout(() => {
  console.error("The calendar connection timed out.");
  process.exitCode = 1;
  server.close();
}, 300_000);
server.listen(port, "127.0.0.1", () => console.log(`Open ${origin} and connect the Google account for ${label}.`));
