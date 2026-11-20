import { createRenderer } from "./render.mjs";

const screen = document.querySelector("#screen");
const pageMenu = document.querySelector("#page");
const play = document.querySelector("#play");
const restart = document.querySelector("#restart");
const refresh = document.querySelector("#refresh");
const status = document.querySelector("#status");
const clock = document.querySelector("#time");
const demo = location.pathname === "/demo/air";
const feedPath = demo ? location.pathname : "";
if (demo) {
  refresh.textContent = "Reload demo";
  status.textContent = "Loading demo";
}
const font = new Uint8Array(await fetch("/font.bin").then((response) => response.arrayBuffer()));
const draw = createRenderer(screen.getContext("2d"), font);

let index = [];
let indexTag;
let active;
let resumeAt;
let prefetch;
let request = 0;
let selecting = false;
let refreshing = false;
let playing = true;
let elapsed = 0;
let last = performance.now();
let lastFrame;
let retryAt = 0;
const seen = new Map();
const motion = (command) => Array.isArray(command[3]);
const london = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function nextScreen() {
  const i = index.findIndex(({ id }) => id === active?.page.id);
  return (i < 0 && index.find(({ id }) => id === resumeAt)) || index[(i + 1) % index.length];
}

async function readIndex() {
  const untilSwitch = active && playing ? Math.max(0, active.duration - elapsed) : 0;
  const path = feedPath + (untilSwitch <= 16_000 ? "/index?at=" + Math.round(Date.now() + untilSwitch) : "/index");
  const response = await fetch(path, { cache: "no-store", headers: indexTag ? { "If-None-Match": indexTag } : {} });
  if (response.status === 304) return;
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  if (data?.version !== 3 || !Array.isArray(data.screens) || !data.screens.length) throw new Error("Unexpected AWS screen index.");
  if (active && !data.screens.some(({ id }) => id === active.page.id)) {
    const anchor = resumeAt || active.page.id;
    if (!data.screens.some(({ id }) => id === anchor)) {
      const position = index.findIndex(({ id }) => id === anchor);
      const remaining = [...index.slice(position + 1), ...index.slice(0, position)];
      resumeAt = remaining.find(({ id }) => data.screens.some((screen) => screen.id === id))?.id;
    }
  } else resumeAt = undefined;
  index = data.screens;
  indexTag = response.headers.get("etag");
  for (const id of seen.keys()) if (!index.some((item) => item.id === id)) seen.delete(id);
  pageMenu.replaceChildren(...index.map(({ id, mode, title }) => new Option(mode.toUpperCase() + " · " + title, id)));
  if (active) pageMenu.value = active.page.id;
}

async function readScreen(id, previous, at) {
  const path = feedPath + "/screen/" + encodeURIComponent(id) + (at ? "?at=" + Math.round(at) : "");
  const response = await fetch(path, {
    cache: "no-store", headers: previous?.tag ? { "If-None-Match": previous.tag } : {},
  });
  if (response.status === 304 && previous) return previous;
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const page = data?.pages?.[0];
  if (data?.version !== 2 || data.pages.length !== 1 || page?.id !== id) throw new Error("Unexpected AWS screen.");
  const duration = page.animation ? page.animation.phase_ms * page.animation.phases.length
    : (page.dwell_seconds ?? data.rotation) * 1000;
  return { page, duration, tag: response.headers.get("etag") };
}

function showError(error) {
  status.textContent = (active ? "Showing last screen · " : "") + error.message;
}

async function select(id, keepTime = false, usePrefetch = true) {
  const sequence = ++request;
  selecting = true;
  const previous = active;
  try {
    const pending = prefetch?.id === id && usePrefetch ? prefetch.result : undefined;
    prefetch = undefined;
    const screen = (await pending) ?? await readScreen(id, previous?.page.id === id ? previous : undefined);
    if (sequence !== request) return;
    if (screen.page.starts_at !== undefined) {
      const offset = Math.max(0, Date.now() - screen.page.starts_at);
      if (offset >= screen.duration) throw new Error("Satellite just left the tracking window.");
      elapsed = offset;
    } else if (keepTime && active?.page.id === id) {
      elapsed = Math.min(elapsed, screen.duration - 1);
    } else {
      if (active) seen.set(active.page.id, (seen.get(active.page.id) ?? 0) + Math.min(elapsed, active.duration));
      elapsed = 0;
    }
    active = screen;
    resumeAt = undefined;
    lastFrame = undefined;
    pageMenu.value = id;
    status.textContent = demo ? "Demo aircraft · sample readings" : "Live from AWS · " + screen.page.updated;
  } catch (error) {
    if (sequence !== request) return;
    if (active) pageMenu.value = active.page.id;
    retryAt = performance.now() + 5000;
    showError(error);
  } finally {
    if (sequence === request) selecting = false;
  }
}

async function loadIndex(updateActive = false) {
  if (refreshing) return;
  refreshing = true;
  refresh.disabled = true;
  try {
    await readIndex();
    if (!selecting && (updateActive || !active)) {
      const id = index.some(({ id }) => id === active?.page.id) ? active.page.id : nextScreen().id;
      await select(id, updateActive, false);
    }
  } catch (error) {
    showError(error);
  } finally {
    refreshing = false;
    refresh.disabled = false;
  }
}

play.addEventListener("click", () => {
  playing = !playing;
  play.textContent = playing ? "Pause" : "Play";
  play.setAttribute("aria-pressed", playing);
});
pageMenu.addEventListener("change", () => select(pageMenu.value));
restart.addEventListener("click", () => {
  if (active) {
    elapsed = 0;
    lastFrame = undefined;
  }
});
refresh.addEventListener("click", () => loadIndex(true));

function frame(now) {
  if (active) {
    const { page, duration } = active;
    if (playing) elapsed += now - last;
    if (playing && !selecting && now >= retryAt && elapsed >= duration - 16_000) {
      const next = nextScreen();
      if (elapsed >= duration) select(next.id);
      else if (prefetch?.id !== next.id) {
        prefetch = { id: next.id, result: readScreen(next.id, undefined, Date.now() + duration - elapsed).catch(() => undefined) };
      }
    }
    const within = page.starts_at === undefined ? elapsed % duration : Math.min(elapsed, duration - 1);
    const phase = page.animation ? Math.floor(within / page.animation.phase_ms) : 0;
    const moving = page.marquee || page.graphics?.some(motion) || page.animation?.phases[phase]?.some(motion)
      || (!page.graphics && !page.animation && page.mode !== "air" && page.rows.some((row) => row[1].length > 16));
    const tick = moving ? Math.floor(within / 17) : 0;
    const cachedClock = page.clock || (!page.graphics && !page.animation && page.mode !== "air")
      ? Math.floor(Date.now() / 60_000) : undefined;
    if (lastFrame?.phase !== phase || lastFrame.tick !== tick || lastFrame.cachedClock !== cachedClock) {
      const time = cachedClock === undefined ? page.updated : london.format(cachedClock * 60_000);
      draw(page, within, (seen.get(page.id) ?? 0) + elapsed, time);
      lastFrame = { phase, tick, cachedClock };
    }
    const label = Math.floor(within / 1000) + "s / " + duration / 1000 + "s";
    if (clock.textContent !== label) clock.textContent = label;
  }
  last = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
loadIndex();
setInterval(loadIndex, 15_000);
