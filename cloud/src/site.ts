// Public home page and privacy policy for the Google OAuth consent screen ("Waypoint Display").
// Google needs both to switch the calendar OAuth app to production so refresh tokens stop expiring weekly.
const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b1014; color: #cfe9ef; font: 16px/1.6 system-ui, sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 3rem 1rem; }
  h1 { color: #9fe3f0; font-size: 1.6rem; margin: 0 0 1rem; }
  h2 { color: #9fe3f0; font-size: 1.1rem; margin: 2rem 0 .5rem; }
  a { color: #9fe3f0; }
  .pixel { font-family: ui-monospace, monospace; letter-spacing: .15em; color: #5fbed2; }
</style></head>
<body><main>${body}</main></body></html>`;

const home = page("Waypoint Display", `
<p class="pixel">WAYPOINT</p>
<h1>Waypoint Display</h1>
<p>Waypoint is a personal, home-built 256 &times; 64 pixel desk display. It shows local buses and trains, aircraft, ships and satellites passing overhead, the weather, the electricity grid and upcoming meetings.</p>
<p>It reads its owner's Google Calendar with read-only access to show the next few meetings and a reminder before each one starts. It is not a commercial product and is not offered to other users.</p>
<p><a href="privacy">Privacy policy</a></p>`);

const privacy = page("Waypoint Display privacy policy", `
<h1>Privacy policy</h1>
<p>Waypoint Display is a personal desk display used only by its owner. This policy covers the Google Calendar access it requests.</p>
<h2>What it accesses</h2>
<p>With the owner's permission, Waypoint uses the read-only Google Calendar scope (<code>calendar.readonly</code>) to read events from the owner's chosen calendars for the next 24 hours: each event's title, start and end time, and whether it is private.</p>
<h2>How it is used</h2>
<p>Events are shown on the owner's display as a list of upcoming meetings and a countdown before each one. Private or confidential events are shown only as "BUSY". Nothing is written back to Google.</p>
<h2>Storage</h2>
<p>The OAuth refresh token is stored encrypted in the owner's own AWS account (AWS Systems Manager Parameter Store, SecureString). Upcoming events are held only in the display's current board, which is replaced every minute. No calendar data is kept beyond that.</p>
<h2>Sharing</h2>
<p>Calendar data is not sold, shared with anyone, used for advertising, or used to train any AI or machine-learning model. Waypoint's use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<h2>Removing access</h2>
<p>Access can be withdrawn at any time from <a href="https://myaccount.google.com/permissions">Google Account &rarr; Third-party connections</a>. The stored token then stops working, and the owner deletes it from AWS when disconnecting the account.</p>
<p><a href="./">Home</a></p>`);

export async function handler(event: { rawPath?: string }) {
  const body = event.rawPath?.replace(/\/+$/, "").endsWith("/privacy") ? privacy : home;
  return { statusCode: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=3600" }, body };
}
