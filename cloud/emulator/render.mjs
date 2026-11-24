const width = 256;
const height = 64;
const glyphHeight = 9;
const advanceAndGlyph = 10;
const gap = 48;

export function createRenderer(context, font) {
  const image = context.createImageData(width, height);
  const rgba = image.data;
  rgba.fill(255);

  function pixel(x, y, shade) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 4;
    rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = shade * 17;
  }

  function rect(left, top, w, h, shade) {
    for (let y = Math.max(0, top); y < Math.min(height, top + h); y++) {
      for (let x = Math.max(0, left); x < Math.min(width, left + w); x++) pixel(x, y, shade);
    }
  }

  const glyph = (code) => ((code >= 32 && code <= 126 ? code : 63) - 32) * advanceAndGlyph;
  const textWidth = (value) => [...value].reduce((sum, char) => sum + font[glyph(char.charCodeAt(0))], 0);
  function text(left, top, scale, shade, value, clipLeft = 0, clipRight = width) {
    for (const char of value) {
      if (left >= clipRight) break;
      const start = glyph(char.charCodeAt(0));
      for (let y = 0; y < glyphHeight; y++) {
        for (let x = 0; x < 8; x++) {
          if (!(font[start + y + 1] & (1 << x))) continue;
          const x0 = Math.max(clipLeft, left + x * scale);
          rect(x0, top + y * scale, Math.min(clipRight, left + (x + 1) * scale) - x0, scale, shade);
        }
      }
      left += font[start] * scale;
    }
  }

  function stationaryBitmap(left, top, scale, shade, rows) {
    rows.forEach((bits, y) => {
      for (let x = 0; x < 16; x++) {
        if (bits & (1 << x)) rect(left + x * scale, top + y * scale, scale, scale, shade);
      }
    });
  }

  const packed = new Map();
  function hexBytes(hex) {
    if (!packed.has(hex)) {
      if (packed.size >= 256) packed.delete(packed.keys().next().value);
      packed.set(hex, Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16)));
    }
    return packed.get(hex);
  }

  function drawPacked(left, top, w, h, scale, shade, hex) {
    const data = hexBytes(hex);
    const stride = Math.ceil(w / 8);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[y * stride + (x >> 3)] & (1 << (x & 7))) rect(left + x * scale, top + y * scale, scale, scale, shade);
      }
    }
  }

  function drawMotion(command, time, duration) {
    const [scale, shade, bitmap, position, hex] = command;
    const viewport = hex && position.length === 5 ? position : undefined;
    const data = hex ? hexBytes(hex) : undefined;
    const stride = viewport ? 2 : 3;
    const available = data ? data.length / stride : position.length;
    const count = viewport ? viewport[4] : available;
    const span = Math.max(1, duration - 1);
    const travel = Math.min(Math.floor(time), span) * (count - 1);
    const index = Math.floor(travel / span);
    const frac = Math.floor(travel % span * 256 / span);
    if (viewport && (index >= available || (index === available - 1 && frac !== 0))) return;
    const read = (i, axis) => data ? data[Math.min(i, available - 1) * stride + axis] : position[i][axis];
    const axis = (dimension) => {
      const [a, b, c, d] = [Math.max(0, index - 1), index, Math.min(index + 1, count - 1), Math.min(index + 2, count - 1)]
        .map((i) => read(i, dimension));
      const cubic = (-a + 3 * b - 3 * c + d) * frac + (2 * a - 5 * b + 4 * c - d) * 256;
      const slope = Math.trunc(cubic * frac / 256) + (c - a) * 256;
      return Math.max(Math.min(b, c) * 256, Math.min(Math.max(b, c) * 256, b * 256 + Math.trunc(slope * frac / 512)));
    };
    const left = axis(0) + (viewport ? (viewport[0] - 64) * 256 : 0);
    const top = axis(1) + (viewport ? (viewport[1] - 64) * 256 : 0);
    const occluder = data && !viewport && axis(2) < 128 * 256 ? position : undefined;
    const [x0, y0, w, h] = viewport || [0, 0, width, height];
    function bit(x, y) {
      if (x < 0 || x >= 16 * scale || y < 0) return 0;
      return ((bitmap[Math.floor(y / scale)] || 0) >> Math.floor(x / scale)) & 1;
    }
    for (let y = Math.max(y0, top >> 8); y < Math.min(y0 + h, (top >> 8) + bitmap.length * scale + Number((top & 255) !== 0)); y++) {
      const dy = y * 256 - top;
      const fy = dy & 255;
      const sy = dy >> 8;
      for (let x = Math.max(x0, left >> 8); x < Math.min(x0 + w, (left >> 8) + 16 * scale + Number((left & 255) !== 0)); x++) {
        if (occluder && (x - occluder[0]) ** 2 + (y - occluder[1]) ** 2 <= occluder[2] ** 2) continue;
        const dx = x * 256 - left;
        const fx = dx & 255;
        const sx = dx >> 8;
        const upper = bit(sx, sy) * (256 - fx) + bit(sx + 1, sy) * fx;
        const lower = bit(sx, sy + 1) * (256 - fx) + bit(sx + 1, sy + 1) * fx;
        const alpha = upper * (256 - fy) + lower * fy;
        const background = rgba[(y * width + x) * 4] / 17;
        pixel(x, y, (shade * alpha + background * (65536 - alpha) + 32768) >> 16);
      }
    }
  }

  function drawCommand(command, time, duration) {
    const [x, y, a, b, c] = command;
    if (command.length === 7) drawPacked(...command);
    else if (command.length === 6) {
      // Looping sprite frames, as in the firmware's Frames primitive.
      const frames = command[4];
      stationaryBitmap(x, y, a, b, frames[Math.floor(time / command[5]) % frames.length]);
    }
    else if (Array.isArray(a) && Array.isArray(a[0])) {
      // Looping sprite on a path (firmware MotionFrames); path coordinates are offset by 32.
      const frames = a;
      const path = b.map(([px, py]) => [px - 32, py - 32]);
      drawMotion([x, y, frames[Math.floor(time / c) % frames.length], path], time, duration);
    }
    else if (Array.isArray(b)) drawMotion(command, time, duration);
    else if (typeof c === "number") rect(x, y, a, b, c);
    else if (typeof c === "string") text(x, y, a, b, c);
    else stationaryBitmap(x, y, a, b, c);
  }

  function marquee(line, elapsed) {
    if (!line) return;
    const { left, top, shade, text: value } = line;
    const right = left + line.width;
    const pixels = textWidth(value);
    const period = pixels + gap;
    const offset = pixels > line.width ? Math.floor(Math.max(0, elapsed - 600) * line.speed / 1000) % period : 0;
    text(left - offset, top, 1, shade, value, left, right);
    if (offset) text(left + period - offset, top, 1, shade, value, left, right);
  }

  const centered = (value, top, scale, shade) => text(Math.floor((width - Math.min(width, textWidth(value) * scale)) / 2), top, scale, shade, value);
  function fallback(page, elapsed, time) {
    const [lead, label, detail] = page.rows[0] ?? ["", "FEED UNAVAILABLE", ""];
    if (page.mode === "air") {
      if (!lead && page.state !== "offline") return;
      centered("NEAREST AIRCRAFT", 4, 1, 9);
      rect(8, 43, 240, 1, 4);
      centered(label, lead ? 21 : 25, lead ? 2 : 1, 15);
      text(8, 51, 1, 13, lead);
      const status = lead ? detail : "OFFLINE";
      text(248 - textWidth(status), 51, 1, 13, status);
      return;
    }
    text(2, 0, 1, 15, page.mode.toUpperCase(), 2, 49);
    centered(time, 0, 1, 8);
    const status = page.state.toUpperCase();
    text(254 - textWidth(status), 0, 1, 11, status);
    text(2, 9, 1, 15, page.title);
    rect(0, 18, width, 1, 5);
    if (page.rows.length === 1 && !lead && !detail) centered(label, 36, 1, 15);
    else page.rows.forEach(([a, b, c], index) => {
      const top = 21 + index * 10;
      text(2, top, 1, 12, a, 2, 42);
      const pixels = textWidth(b);
      const period = pixels + 24;
      const shift = pixels <= 146 ? 0 : Math.floor(Math.max(0, elapsed - 900) / 50) % period;
      text(44 - shift, top, 1, 15, b, 44, 190);
      if (shift) text(44 + period - shift, top, 1, 15, b, 44, 190);
      text(254 - textWidth(c), top, 1, 10, c);
    });
    rect(0, 63, width, 1, 3);
  }

  return (page, elapsed, visibleTime, time = page.updated) => {
    rect(0, 0, width, height, 0);
    if (page.graphics || page.animation || page.marquee) {
      const duration = page.animation?.phase_ms ?? 1;
      const phase = page.animation?.phases[Math.floor(elapsed / duration)];
      for (const command of page.graphics ?? []) drawCommand(command, elapsed % duration, duration);
      for (const command of phase ?? []) drawCommand(command, elapsed % duration, duration);
      if (page.clock) {
        const { right, shade } = page.clock;
        const w = textWidth("00:00");
        rect(right - w, 0, w, glyphHeight, 0);
        text(right - textWidth(time), 0, 1, shade, time);
      }
      marquee(page.marquee, visibleTime);
    } else fallback(page, elapsed, time);
    if (page.progress) {
      // Time-left bar on the title line, as drawn by the firmware: a bright two-pixel head.
      const total = page.animation ? page.animation.phase_ms * page.animation.phases.length : (page.dwell_seconds ?? 60) * 1000;
      const { top, left, width: span, shade } = page.progress;
      const filled = Math.min(span, Math.floor(span * elapsed / total));
      rect(left, top, Math.max(0, filled - 2), 1, shade);
      if (filled) rect(left + Math.max(0, filled - 2), top, Math.min(2, filled), 1, 15);
    }
    context.putImageData(image, 0, 0);
  };
}
