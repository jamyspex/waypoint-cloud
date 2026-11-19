import { londonClock, row, type Page, type Row } from "./board.js";

const base = "https://api.octopus.energy/v1/";
export const day = 86_400_000;
const halfHour = 1_800_000;
const londonDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/London" });
const dayLabel = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" });

type Dates = { valid_from: string; valid_to: string | null };
type Agreement = Dates & { tariff_code: string };
type Rate = Dates & { value_inc_vat: number; payment_method: "DIRECT_DEBIT" | "NON_DIRECT_DEBIT" | null };
type Reading = { interval_start: string; interval_end: string; consumption: number };
type Point = { mpan: string; is_export: boolean; meters: { serial_number: string }[]; agreements: Agreement[] };
type Account = { properties: { electricity_meter_points: Point[] }[] };
type List<T> = { next: string | null; results: T[] };
type Identity = { token: string; number: string; device?: { id: string; mpan: string } };
type Telemetry = { readAt: string; demand: string | null };
type LiveDemand = { watts: number; at: number };

export const energyScreens = [
  ["energy-now", "ELECTRICITY NOW"],
  ["energy-today", "TODAY ELECTRICITY"],
  ["energy-yesterday", "YESTERDAY ELECTRICITY"],
] as const;

export function energyDay(now: Date): number {
  return Date.parse(londonDate.format(now) + "T00:00:00Z");
}

function midnight(localDay: number): number {
  // British Summer Time changes after local midnight.
  return localDay - (londonClock.format(new Date(localDay)) === "01:00" ? 3_600_000 : 0);
}

function contains(dates: Dates, when: number): boolean {
  return Date.parse(dates.valid_from) <= when && (!dates.valid_to || when < Date.parse(dates.valid_to));
}

function rateAt(rates: Rate[], when: number, directDebit: boolean): Rate | undefined {
  const applicable = rates.filter((rate) => contains(rate, when) && Number.isFinite(rate.value_inc_vat));
  const payment = directDebit ? "DIRECT_DEBIT" : "NON_DIRECT_DEBIT";
  return applicable.find((rate) => rate.payment_method === payment)
    ?? applicable.find((rate) => rate.payment_method == null);
}

function numeric(value: string | null | undefined): number | undefined {
  if (value == null || value.trim() === "") return;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
}

function dailyRows(
  start: number,
  end: number,
  fullDay: boolean,
  readings: Map<number, number>,
  tariffAt: (when: number, standing: boolean) => Rate | undefined,
): { rows: Row[]; usage_blocks?: (number | null)[] } {
  const usage_blocks: (number | null)[] = Array(12).fill(null);
  let units = 0;
  let usagePence = 0;
  let count = 0;
  let priced = 0;
  let last = start;
  for (let slot = start; slot < end; slot += halfHour) {
    const reading = readings.get(slot);
    if (reading === undefined) continue;
    count++;
    last = slot + halfHour;
    units += reading;
    const localHour = Number(londonClock.format(new Date(slot)).slice(0, 2));
    const bucket = Math.floor(localHour / 2);
    usage_blocks[bucket] = (usage_blocks[bucket] ?? 0) + Math.round(reading * 1000);
    const rate = tariffAt(slot, false);
    if (rate) {
      priced++;
      usagePence += reading * rate.value_inc_vat;
    }
  }
  if (!count) return { rows: [row("", "WAITING FOR METER READINGS", "")] };
  const expected = (end - start) / halfHour;
  const complete = count === expected;
  const coverage = complete ? (fullDay ? "FULL DAY" : `TO ${londonClock.format(new Date(last))}`)
    : `PARTIAL ${count}/${expected}`;
  const standing = tariffAt(start, true)?.value_inc_vat;
  const pounds = (pence: number) => (pence / 100).toFixed(2);
  return {
    usage_blocks,
    rows: [
      row("", "EST TOTAL GBP INC VAT", standing !== undefined && priced === count ? pounds(usagePence + standing) : ""),
      row("", "ELECTRICITY USED KWH", units.toFixed(2)),
      row("", "STANDING CHARGE GBP", standing === undefined ? "" : pounds(standing)),
      row("", coverage, ""),
    ],
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin) throw new Error("Unexpected Octopus API hostname");
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(7000), redirect: "error" });
  if (!response.ok) throw new Error(`Octopus HTTP ${response.status}`);
  return await response.json() as T;
}

async function graphql<T>(query: string, variables = {}, token?: string): Promise<T> {
  const result = await request<{ data?: T; errors?: unknown[] }>("graphql/", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  if (result.errors?.length || !result.data) throw new Error("Octopus GraphQL error");
  return result.data;
}

async function identify(key: string): Promise<Identity> {
  const { obtainKrakenToken } = await graphql<{ obtainKrakenToken: { token: string } }>(
    "mutation ($input:ObtainJSONWebTokenInput!) { obtainKrakenToken(input:$input) { token } }",
    { input: { APIKey: key } },
  );
  const token = obtainKrakenToken.token;
  const { viewer } = await graphql<{ viewer: { accounts: { number: string }[] } }>(
    "{ viewer { accounts { number } } }", {}, token,
  );
  if (viewer.accounts.length !== 1) throw new Error("Expected one Octopus account");
  const { number } = viewer.accounts[0];
  type Meter = { smartImportElectricityMeter: { deviceId: string | null } | null };
  type Supply = { meterPoint: { mpan: string; direction: string; meters: Meter[] | null } };
  const result = await graphql<{ account: { electricityAgreements: Supply[] } }>(
    `query ($number:String!) { account(accountNumber:$number) { electricityAgreements(active:true) {
      meterPoint { mpan direction meters(includeInactive:false) { smartImportElectricityMeter { deviceId } } }
    } } }`, { number }, token,
  ).catch(() => null);
  const devices = new Map<string, { id: string; mpan: string }>();
  for (const { meterPoint } of result?.account.electricityAgreements ?? []) {
    if (meterPoint.direction !== "IMPORT") continue;
    for (const meter of meterPoint.meters ?? []) {
      const id = meter.smartImportElectricityMeter?.deviceId;
      if (id) devices.set(id, { id, mpan: meterPoint.mpan });
    }
  }
  return { token, number, device: devices.size === 1 ? devices.values().next().value : undefined };
}

let identityCache: { key: string; expiresAt: number; value: Promise<Identity> } | undefined;

function identity(key: string): Promise<Identity> {
  const now = Date.now();
  if (identityCache?.key === key && identityCache.expiresAt > now) return identityCache.value;
  const value = identify(key).catch((error) => {
    if (identityCache?.value === value) identityCache = undefined;
    throw error;
  });
  identityCache = { key, expiresAt: now + 50 * 60_000, value };
  return value;
}

export async function fetchDemand(key: string, now: Date): Promise<LiveDemand | undefined> {
  try {
    const { token, device } = await identity(key);
    if (!device) return;
    const { smartMeterTelemetry } = await graphql<{ smartMeterTelemetry: Telemetry[] }>(
      "query ($id:String!) { smartMeterTelemetry(deviceId:$id) { demand readAt } }", { id: device.id }, token,
    );
    return smartMeterTelemetry.flatMap(({ demand, readAt }) => {
      const at = Date.parse(readAt);
      const watts = numeric(demand);
      const age = now.getTime() - at;
      return watts !== undefined && age >= -60_000 && age <= 150_000 ? [{ watts, at }] : [];
    }).sort((a, b) => b.at - a.at)[0];
  } catch {
    return;
  }
}

export function withDemand(page: Page, demand: LiveDemand | undefined): Page {
  const [previous, rate, standing] = page.rows;
  if (page.id !== "energy-now" || !demand || !previous || !rate || !standing) return page;
  return { ...page, updated: londonClock.format(new Date(demand.at)), rows: [
    row("", "LIVE NET POWER", `${Math.round(demand.watts)}W`),
    rate,
    standing,
    row("", `READ AT ${londonClock.format(new Date(demand.at))}`, ""),
  ] };
}

async function miniReadings(id: string, token: string, since: number, end: number): Promise<Map<number, number>> {
  type Sample = { readAt: string; consumptionDelta: string | null };
  if (end <= since) return new Map();
  const result = await graphql<{ smartMeterTelemetry: Sample[] }>(
    `query ($id:String!, $start:DateTime!, $end:DateTime!) {
      smartMeterTelemetry(deviceId:$id,start:$start,end:$end,grouping:HALF_HOURLY) { readAt consumptionDelta }
    }`, { id, start: new Date(since).toISOString(), end: new Date(end).toISOString() }, token,
  ).catch(() => null);
  const readings = new Map<number, number>();
  for (const { readAt, consumptionDelta } of result?.smartMeterTelemetry ?? []) {
    const at = Date.parse(readAt);
    const wattHours = numeric(consumptionDelta);
    if (at >= since && at < end && at % halfHour === 0 && wattHours !== undefined && wattHours >= 0) {
      readings.set(at, wattHours / 1000);
    }
  }
  return readings;
}

export async function fetchEnergyPages(key: string, now: Date): Promise<{ pages: Page[]; expiresAt: number }> {
  const basic = "Basic " + Buffer.from(key + ":").toString("base64");
  async function list<T>(path: string, auth = false): Promise<T[]> {
    const results: T[] = [];
    for (let next: string | null = path; next;) {
      const page: List<T> = await request(next, auth ? { headers: { Authorization: basic } } : undefined);
      results.push(...page.results);
      next = page.next;
    }
    return results;
  }

  const { token, number, device } = await identity(key);
  type Schedule = { node: { scheduleType: string } };
  const [account, payment] = await Promise.all([
    request<Account>(`accounts/${encodeURIComponent(number)}/`, { headers: { Authorization: basic } }),
    graphql<{ account: { paymentSchedules: { edges: Schedule[] } } }>(
      `query ($number:String!) { account(accountNumber:$number) {
        paymentSchedules(active:true,first:10,reason:GENERAL_ACCOUNT_PAYMENT) { edges { node { scheduleType } } }
      } }`, { number }, token,
    ),
  ]);
  const directDebit = payment.account.paymentSchedules.edges.some(({ node }) => node.scheduleType === "DIRECT_DEBIT");

  const instant = now.getTime();
  const today = energyDay(now);
  const startToday = midnight(today);
  const since = midnight(today - day);
  const lastFullSlot = Math.floor(instant / halfHour) * halfHour;
  const points = account.properties.flatMap((property) => property.electricity_meter_points)
    .filter((point) => !point.is_export && point.agreements.some((agreement) => contains(agreement, instant)));
  if (points.length !== 1) throw new Error("Expected one active electricity import supply");
  const point = points[0];
  const agreements = point.agreements.filter((a) => !a.valid_to || Date.parse(a.valid_to) > since);
  const period = new URLSearchParams({
    period_from: new Date(since).toISOString(), period_to: now.toISOString(), page_size: "1000",
  });
  const [rates, meters, readings] = await Promise.all([
    Promise.all([...new Set(agreements.map((a) => a.tariff_code))].map(async (code) => {
      const product = /^E-1R-(.+)-[A-Z]$/.exec(code)?.[1];
      if (!product) return { code, units: [], standing: [] };
      const path = `products/${encodeURIComponent(product)}/electricity-tariffs/${encodeURIComponent(code)}`;
      const [units, standing] = await Promise.all([
        list<Rate>(`${path}/standard-unit-rates/?${period}`),
        list<Rate>(`${path}/standing-charges/?${period}`),
      ]);
      return { code, units, standing };
    })),
    Promise.all(point.meters.map(({ serial_number }) => list<Reading>(
      `electricity-meter-points/${encodeURIComponent(point.mpan)}/meters/${encodeURIComponent(serial_number)}/consumption/?${period}`, true,
    ))),
    device?.mpan === point.mpan ? miniReadings(device.id, token, since, lastFullSlot) : new Map<number, number>(),
  ]);
  function tariffAt(when: number, standing: boolean): Rate | undefined {
    const agreement = agreements.find((a) => contains(a, when));
    const tariff = rates.find((r) => r.code === agreement?.tariff_code);
    return tariff && rateAt(standing ? tariff.standing : tariff.units, when, directDebit);
  }
  const current = tariffAt(instant, false);
  const daily = tariffAt(instant, true);
  if (!current || !daily) throw new Error("Current electricity price unavailable");

  const reported = new Map<number, number>();
  const overlaps = new Set<number>();
  for (const { interval_start, interval_end, consumption } of meters.flat()) {
    const from = Date.parse(interval_start);
    if (from < since || from >= lastFullSlot || from % halfHour !== 0
      || Date.parse(interval_end) - from !== halfHour || !Number.isFinite(consumption) || consumption < 0) continue;
    const prior = reported.get(from);
    if (prior !== undefined && prior !== consumption) overlaps.add(from);
    reported.set(from, consumption);
  }
  for (const [from, quantity] of reported) if (!overlaps.has(from)) readings.set(from, quantity);

  const latest = readings.size ? Math.max(...readings.keys()) : undefined;
  const latestAt = latest === undefined ? undefined : new Date(latest + halfHour);
  const content = [
    { rows: [
      row("", latest === undefined ? "POWER UNAVAILABLE" : "LAST 30 MIN AVG",
        latest === undefined ? "" : `${Math.round(readings.get(latest)! * 2000)}W`),
      row("", "UNIT RATE INC VAT / KWH", current.value_inc_vat.toFixed(2) + "P"),
      row("", "STANDING CHARGE / DAY", daily.value_inc_vat.toFixed(2) + "P"),
      row("", latestAt ? `TO ${dayLabel.format(latestAt)} ${londonClock.format(latestAt)}` : "", ""),
    ] },
    dailyRows(startToday, lastFullSlot, false, readings, tariffAt),
    dailyRows(since, startToday, true, readings, tariffAt),
  ];
  const expiryDates = [current.valid_to, daily.valid_to, ...agreements.map((a) => a.valid_from)]
    .flatMap((value) => value && Date.parse(value) > instant ? [Date.parse(value)] : []);
  return {
    expiresAt: Math.min(instant + 5 * 60_000, midnight(today + day), ...expiryDates),
    pages: energyScreens.map(([id, title], i) => ({
      id, title, mode: "energy", updated: londonClock.format(now), state: "live", ...content[i],
    })),
  };
}
