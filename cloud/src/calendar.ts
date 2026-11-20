import { GetParameterCommand, GetParametersByPathCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { londonClock, printableText, row, type Graphic, type MeetingFocus, type Page } from "./board.js";
import { textWidth } from "./font.js";

type Client = { client_id: string; client_secret: string };
type Account = { label: string; refresh_token: string; calendars: string[] };
type Event = {
  iCalUID?: string; summary?: string; status?: string; visibility?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
};
type Meeting = Omit<MeetingFocus, "showInProgress"> & { key: string; private: boolean };
type Settings = { showInProgress: boolean; maxInProgressMinutes: number | null };

const day = 86_400_000;
const minute = 60_000;
const notice = 15 * minute;
const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", dateStyle: "short" });
const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" });
const access = new Map<string, { refresh: string; token: string; expires: number }>();

function decode<T>(raw?: string): Partial<T> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) ?? {};
  } catch {
    return {};
  }
}

async function token(client: Client, id: string, refresh: string, deadline: AbortSignal): Promise<string> {
  const cached = access.get(id);
  if (cached?.refresh === refresh && cached.expires > Date.now()) return cached.token;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", signal: deadline,
    body: new URLSearchParams({ ...client, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  if (!response.ok) throw new Error("Calendar authorisation unavailable");
  const data = await response.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Calendar authorisation unavailable");
  access.set(id, { refresh, token: data.access_token, expires: Date.now() + (data.expires_in ?? 60) * 1000 - 30_000 });
  return data.access_token;
}

async function events(calendar: string, bearer: string, now: Date, label: string, deadline: AbortSignal): Promise<Meeting[]> {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`);
  url.search = new URLSearchParams({
    timeMin: now.toISOString(), timeMax: new Date(now.getTime() + day).toISOString(),
    singleEvents: "true", orderBy: "startTime", maxResults: "40",
    fields: "nextPageToken,items(iCalUID,summary,status,visibility,start(dateTime),end(dateTime),attendees(self,responseStatus))",
  }).toString();
  const meetings: Meeting[] = [];
  do {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` }, signal: deadline });
    if (!response.ok) throw new Error("Calendar events unavailable");
    const data = await response.json() as { items?: Event[]; nextPageToken?: string };
    for (const event of data.items ?? []) {
      if (!event?.start?.dateTime || !event.end?.dateTime || event.status === "cancelled"
        || event.attendees?.some(({ self, responseStatus }) => self && responseStatus === "declined")) continue;
      const starts = Date.parse(event.start.dateTime);
      const ends = Date.parse(event.end.dateTime);
      if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= now.getTime() || starts >= now.getTime() + day || starts >= ends) continue;
      const hidden = event.visibility === "private" || event.visibility === "confidential";
      const title = hidden ? "BUSY" : printableText(event.summary ?? "").toUpperCase() || "BUSY";
      meetings.push({ key: JSON.stringify([event.iCalUID || title, starts]), label, starts, ends, title, private: hidden });
    }
    if (!data.nextPageToken) break;
    url.searchParams.set("pageToken", data.nextPageToken);
  } while (meetings.filter((meeting) => meeting.starts > now.getTime() + 2 * notice).length < 4);
  return meetings;
}

function fit(text: string, pixels: number): string {
  let result = text.slice(0, 48);
  if (result.length === text.length && textWidth(result) <= pixels) return result;
  while (textWidth(result + "...") > pixels || result.length > 45) result = result.slice(0, -1);
  return result.trimEnd() + "...";
}

function agendaPage(now: Date, meetings: Meeting[], failures: number, total: number): Page {
  const title = "UPCOMING MEETINGS";
  const updated = londonClock.format(now);
  const state = failures === total ? "offline" : failures ? "stale" : "live";
  const status = failures === total ? "UNAVAILABLE" : failures ? "PARTIAL" : "";
  const graphics: Graphic[] = [
    [3, 0, 1, 13, [0x144, 0x3ff, 0x201, 0x3ff, 0x201, 0x249, 0x201, 0x3ff]],
    [19, 0, 1, 15, title], [253 - textWidth(updated), 0, 1, 10, updated], [0, 9, 256, 1, 5],
  ];
  if (status) graphics.push([216 - textWidth(status), 0, 1, 10, status]);
  if (!meetings.length) {
    const label = state === "offline" ? "CALENDAR UNAVAILABLE" : "NO UPCOMING MEETINGS";
    graphics.push([Math.floor((256 - textWidth(label)) / 2), 29, 1, 14, label]);
  }
  const rows = meetings.slice(0, 4).map((meeting, i) => {
    const start = new Date(meeting.starts);
    const time = londonClock.format(start);
    const when = date.format(start) === date.format(now) ? time : `${weekday.format(start).toUpperCase()} ${time}`;
    const top = 12 + i * 13;
    const label = fit(meeting.label, 46);
    graphics.push(
      [3, top, 1, 12, when], [60, top, 1, 15, fit(meeting.title, 145)],
      [252 - textWidth(label), top, 1, 8, label], [0, top + 10, 256, 1, 3],
    );
    return row(time, meeting.title, meeting.label);
  });
  return { id: "calendar", mode: "calendar", title, updated, state, rows, graphics, clock: { right: 253, shade: 10 } };
}

function center(text: string, top: number, scale: number, shade: number): Graphic {
  return [Math.floor((256 - textWidth(text) * scale) / 2), top, scale, shade, text];
}

export function meetingFocusPage(meetings: MeetingFocus[] | undefined, now: Date): Page | undefined {
  const time = now.getTime();
  const meeting = meetings?.find((item) => time < item.starts && item.starts - time <= notice)
    ?? meetings?.reduce<MeetingFocus | undefined>((current, item) =>
      item.starts <= time && time < item.ends && item.showInProgress ? item : current, undefined);
  if (!meeting) return;
  const upcoming = time < meeting.starts;
  const title = upcoming ? "MEETING STARTING SOON" : "MEETING IN PROGRESS";
  const countdown = upcoming ? `STARTS IN ${Math.ceil((meeting.starts - time) / minute)} MIN` : "IN PROGRESS";
  const times = `${londonClock.format(meeting.starts)} - ${londonClock.format(meeting.ends)}`;
  const duration = `${Math.round((meeting.ends - meeting.starts) / minute)} MIN`;
  const label = fit(`${duration}  ${meeting.label}`, 155);
  const words = meeting.title.split(" ");
  let first = words.shift() || "BUSY";
  while (words.length && textWidth(`${first} ${words[0]}`) <= 121) first += ` ${words.shift()}`;
  const graphics: Graphic[] = [
    center(countdown, 1, 1, 15), [0, 11, 256, 1, 6],
    center(fit(first, 121), words.length ? 14 : 22, 2, 15),
    [0, 51, 256, 1, 5], [4, 54, 1, 13, times], [252 - textWidth(label), 54, 1, 10, label],
  ];
  if (words.length) graphics.push(center(fit(words.join(" "), 121), 32, 2, 15));
  const page: Page = { id: "calendar-focus", mode: "calendar", title, updated: londonClock.format(now), state: "live", rows: [], graphics, dwell_seconds: 60 };
  if (upcoming) {
    const positions = Array.from({ length: 24 }, (_, i) => 5 + ([0, 1, 2, 1][i % 4] * 20));
    const marker = [4, 14, 31, 14, 4];
    const motion: Graphic[] = [
      [1, 15, marker, positions.map((x) => [x, 3])],
      [1, 15, marker, positions.map((x) => [250 - x, 3])],
    ];
    page.animation = { phase_ms: 20_000, phases: [motion, motion, motion] };
  } else {
    const progress = Math.floor(256 * (time - meeting.starts) / (meeting.ends - meeting.starts));
    graphics.push([0, 11, Math.max(1, progress), 1, 15]);
  }
  return page;
}

export async function calendarPage(ssm: SSMClient, prefix: string, now: Date): Promise<{ agenda: Page; meetingFocus: MeetingFocus[] } | undefined> {
  const deadline = AbortSignal.timeout(12_000);
  const read = (name: string) => ssm.send(new GetParameterCommand({ Name: `${prefix}/${name}`, WithDecryption: true }),
    { abortSignal: deadline }).catch((error: unknown) => {
    if ((error as { name?: string }).name === "ParameterNotFound") return undefined;
    throw error;
  });
  const [setup, policy] = await Promise.all([read("client"), read("settings")]);
  if (!setup) return;
  const settings = decode<Settings>(policy?.Parameter?.Value);
  const maxMinutes = settings.maxInProgressMinutes === null ? Infinity
    : typeof settings.maxInProgressMinutes === "number" && settings.maxInProgressMinutes >= 0 ? settings.maxInProgressMinutes : 60;
  const { client_id, client_secret } = decode<Client>(setup.Parameter?.Value);
  if (!client_id || !client_secret) throw new Error("Invalid calendar client config");
  const path = `${prefix}/accounts`;
  const accounts = new Map<string, Partial<Account>>();
  let next: string | undefined;
  do {
    const page = await ssm.send(new GetParametersByPathCommand({ Path: path, WithDecryption: true, NextToken: next }),
      { abortSignal: deadline });
    for (const p of page.Parameters ?? []) {
      if (p.Name?.startsWith(path + "/")) accounts.set(p.Name, decode<Account>(p.Value));
    }
    next = page.NextToken;
  } while (next);
  for (const id of access.keys()) if (!accounts.has(id)) access.delete(id);
  if (!accounts.size) return;

  const results = await Promise.allSettled([...accounts].map(async ([id, account]) => {
    if (!account.refresh_token) throw new Error("Missing calendar authorisation");
    const bearer = await token({ client_id, client_secret }, id, account.refresh_token, deadline);
    const label = printableText(account.label || id.slice(path.length + 1)).toUpperCase();
    const calendars = Array.isArray(account.calendars) && account.calendars.length ? account.calendars : ["primary"];
    return Promise.allSettled(calendars.map((calendar) => events(calendar, bearer, now, label, deadline)));
  }));
  let failures = 0;
  let successes = 0;
  const merged = new Map<string, Meeting>();
  for (const account of results) {
    if (account.status === "rejected") { failures++; continue; }
    for (const calendar of account.value) {
      if (calendar.status === "rejected") { failures++; continue; }
      successes++;
      for (const meeting of calendar.value) {
        const old = merged.get(meeting.key);
        if (!old || (!old.private && meeting.private)) merged.set(meeting.key, meeting);
      }
    }
  }
  const meetings = [...merged.values()].sort((a, b) => a.starts - b.starts);
  return {
    agenda: agendaPage(now, meetings.filter((meeting) => meeting.starts > now.getTime()), failures, successes + failures),
    meetingFocus: meetings.filter((meeting) => meeting.starts <= now.getTime() + 2 * notice)
      .map(({ title, label, starts, ends }) => ({
        title: title.slice(0, 100), label: label.slice(0, 24), starts, ends,
        showInProgress: settings.showInProgress !== false && ends - starts <= maxMinutes * minute,
      })),
  };
}
