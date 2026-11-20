use core::ops::Range;

use esp_hal::Blocking;
use esp_hal::gpio::Output;
use esp_hal::spi::{Error, master::Spi};

use crate::scene::{ClockLabel, Marquee, Page, Primitive, State};

const WIDTH: usize = 256;
const HEIGHT: usize = 64;
const SCALE: usize = 2;
const FONT_HEIGHT: usize = 9;
const GLYPH_SIZE: usize = 1 + FONT_HEIGHT;
// Stock v12.14 U8g2 font at image offset 0x42c55, decoded in printable ASCII order.
// Each glyph stores its advance followed by nine row masks, leftmost pixel in bit zero.
const STOCK_FONT: &[u8; 95 * GLYPH_SIZE] = include_bytes!("../assets/stock-v12.14-ascii.bin");
const SCROLL_GAP: usize = 48;

pub struct Display<'d> {
    spi: Spi<'d, Blocking>,
    chip_select: Output<'d>,
    data_command: Output<'d>,
    animation_rows: u64,
}

impl<'d> Display<'d> {
    pub fn new(
        spi: Spi<'d, Blocking>,
        chip_select: Output<'d>,
        data_command: Output<'d>,
    ) -> Result<Self, Error> {
        let mut display = Self {
            spi,
            chip_select,
            data_command,
            animation_rows: 0,
        };
        // Panel settings recovered from the stock SSD1322 initialization sequence.
        let commands: &[(u8, &[u8])] = &[
            (0xfd, &[0x12]),
            (0xae, &[]),
            (0xb3, &[0x91]),
            (0xca, &[0x3f]),
            (0xa2, &[0x00]),
            (0xa1, &[0x00]),
            (0xa0, &[0x06, 0x11]),
            (0xab, &[0x01]),
            (0xb4, &[0xa0, 0xfd]),
            (0xc1, &[0x40]),
            (0xc7, &[0x0f]),
            (0xb9, &[]),
            (0xb1, &[0xe2]),
            (0xd1, &[0xa2, 0x20]),
            (0xbb, &[0x1f]),
            (0xb6, &[0x08]),
            (0xbe, &[0x07]),
            (0xa6, &[]),
            (0xa9, &[]),
        ];

        display.chip_select.set_low();
        for &(command, parameters) in commands {
            display.command(command, parameters)?;
        }
        display.chip_select.set_high();
        Ok(display)
    }

    pub fn show(&mut self, title: &str, status: &str) -> Result<(), Error> {
        self.show_offset(title, status, None)
    }

    pub fn show_offset(
        &mut self,
        title: &str,
        status: &str,
        scroll: Option<usize>,
    ) -> Result<(), Error> {
        self.draw(|x, y| brightness(title, status, scroll, x, y))
    }

    pub fn show_page(&mut self, page: &Page, shift: usize, clock: &str) -> Result<(), Error> {
        self.draw(|x, y| page_pixel(page, shift, clock, x, y))
    }

    pub fn show_aircraft(&mut self, page: &Page) -> Result<(), Error> {
        let first = page.rows.first();
        if matches!(page.state, State::Live | State::Stale)
            && first.is_none_or(|[distance, _, _]| distance.is_empty())
        {
            return self.draw(|_, _| 0);
        }

        let (aircraft, distance, status, scale) = match first {
            Some([distance, label, status]) if !distance.is_empty() => {
                (label.as_str(), distance.as_str(), status.as_str(), 2)
            }
            Some([_, label, _]) => (label.as_str(), "", page.state.label(), 1),
            None => ("FEED UNAVAILABLE", "", page.state.label(), 1),
        };
        let top = (60 - FONT_HEIGHT * scale) / 2;
        let right = WIDTH - 8 - text_width(status);
        self.draw(|x, y| match y {
            4..=12 => centered_text("NEAREST AIRCRAFT", x, y - 4, 1) * 9,
            43 if (8..WIDTH - 8).contains(&x) => 4,
            51..=59 if x >= right => text_pixel(status, x - right, y - 51) * 13,
            51..=59 if x >= 8 => text_pixel(distance, x - 8, y - 51) * 13,
            y if (top..top + FONT_HEIGHT * scale).contains(&y) => {
                centered_text(aircraft, x, y - top, scale) * 15
            }
            _ => 0,
        })
    }

    pub fn show_graphics(
        &mut self,
        commands: &[Primitive],
        phase: &[Primitive],
        elapsed: u64,
        duration: u64,
        marquee: Option<(&Marquee, u64)>,
        clock: Option<(&ClockLabel, &str, bool)>,
        full: bool,
    ) -> Result<(), Error> {
        let layers = commands.iter().chain(phase);
        let mut poses = [None; 48];
        let mut active = 0;
        for (index, command) in layers.clone().enumerate() {
            match command {
                Primitive::Motion(scale, _, rows, path) => {
                    let sample = MotionSample::new(path.len(), elapsed, duration);
                    let position = sample.position(|i, axis| path[i][axis]).map(i32::from);
                    poses[index] = Some((position, None));
                    active |= row_mask(sprite_rows(position, *scale, rows.len()));
                }
                Primitive::OccludedMotion(scale, _, rows, circle, points) => {
                    let sample = MotionSample::new(points.0.len() / 3, elapsed, duration);
                    let point = |i, axis| points.0[i * 3 + axis];
                    let position = sample.position(point).map(i32::from);
                    let occlusion = (sample.axis(|i| point(i, 2)) < 128 * 256).then_some(*circle);
                    poses[index] = Some((position, occlusion));
                    active |= row_mask(sprite_rows(position, *scale, rows.len()));
                }
                Primitive::ViewportMotion(scale, _, rows, [x, y, width, height, samples], path) => {
                    let count = path.0.len() / 2;
                    let sample = MotionSample::new(usize::from(*samples), elapsed, duration);
                    // The path only contains the part of the orbit near this view.
                    if sample.points[1] < count - 1
                        || (sample.points[1] == count - 1 && sample.fraction == 0)
                    {
                        let [px, py] =
                            sample.position(|i, axis| path.0[i.min(count - 1) * 2 + axis]);
                        let position = [px, py].map(i32::from);
                        let position = [
                            position[0] + (i32::from(*x) - 64) * 256,
                            position[1] + (i32::from(*y) - 64) * 256,
                        ];
                        let left = position[0] >> 8;
                        if left < i32::from(*x) + i32::from(*width)
                            && left + 16 * i32::from(*scale) >= i32::from(*x)
                        {
                            poses[index] = Some((position, None));
                            let sprite = sprite_rows(position, *scale, rows.len());
                            let top = usize::from(*y);
                            active |= row_mask(
                                sprite.start.max(top)..sprite.end.min(top + usize::from(*height)),
                            );
                        }
                    }
                }
                _ => {}
            }
        }
        let marquee = marquee.map(|(line, time)| {
            let width = text_width(&line.text);
            let period = width + SCROLL_GAP;
            let offset = if width > usize::from(line.width) {
                let top = usize::from(line.top);
                active |= row_mask(top..top + FONT_HEIGHT);
                ((time * u64::from(line.speed) / 1000) % period as u64) as usize
            } else {
                0
            };
            (line, offset, period)
        });
        let mut dirty = if full {
            u64::MAX
        } else {
            self.animation_rows | active
        };
        if clock.is_some_and(|(_, _, changed)| changed) {
            dirty |= row_mask(0..FONT_HEIGHT);
        }

        // Redraw both sprite footprints to erase the previous frame without touching static rows.
        let mut fill = |y, row: &mut Scanline| {
            row.fill(0);
            for (index, command) in layers.clone().enumerate() {
                paint_graphic(row, y, command, poses[index]);
            }
            if let Some((label, text, _)) = clock
                && y < FONT_HEIGHT
            {
                let right = usize::from(label.right);
                let left = right - text_width("00:00");
                for x in left..right {
                    set_pixel(row, x, 0);
                }
                paint_text(
                    row,
                    text,
                    y,
                    1,
                    label.shade,
                    right - text_width(text)..right,
                    0,
                );
            }
            if let Some((line, offset, period)) = marquee
                && (usize::from(line.top)..usize::from(line.top) + FONT_HEIGHT).contains(&y)
            {
                let left = usize::from(line.left);
                let right = left + usize::from(line.width);
                let glyph_row = y - usize::from(line.top);
                paint_text(
                    row,
                    &line.text,
                    glyph_row,
                    1,
                    line.shade,
                    left..right,
                    offset,
                );
                let wrap = left + period - offset;
                if wrap < right && offset != 0 {
                    paint_text(row, &line.text, glyph_row, 1, line.shade, wrap..right, 0);
                }
            }
        };
        while dirty != 0 {
            let start = dirty.trailing_zeros() as usize;
            let end = start + (dirty >> start).trailing_ones() as usize;
            self.draw_rows(start..end, &mut fill)?;
            dirty &= !row_mask(start..end);
        }
        self.animation_rows = active;
        Ok(())
    }

    fn draw(&mut self, pixel: impl Fn(usize, usize) -> u8) -> Result<(), Error> {
        self.draw_rows(0..HEIGHT, |y, row| {
            for (pair, byte) in row.iter_mut().enumerate() {
                let x = WIDTH - 1 - pair * 2;
                *byte = pixel(x, y) << 4 | pixel(x - 1, y);
            }
        })
    }

    fn draw_rows(
        &mut self,
        rows: Range<usize>,
        fill: impl FnMut(usize, &mut Scanline),
    ) -> Result<(), Error> {
        self.chip_select.set_low();
        let result = self.write_screen(rows, fill);
        self.chip_select.set_high();
        result
    }

    fn write_screen(
        &mut self,
        rows: Range<usize>,
        mut fill: impl FnMut(usize, &mut Scanline),
    ) -> Result<(), Error> {
        self.command(0x15, &[0x1c, 0x5b])?; // Four pixels per column address.
        self.command(
            0x75,
            &[(HEIGHT - rows.end) as u8, (HEIGHT - 1 - rows.start) as u8],
        )?;
        self.command(0x5c, &[])?;
        self.data_command.set_high();

        let mut row = [0; WIDTH / 2];
        // Rotate 180 degrees for the panel's orientation in the case.
        for y in rows.rev() {
            fill(y, &mut row);
            self.spi.write(&row)?;
        }
        self.command(0xaf, &[])
    }

    fn command(&mut self, command: u8, parameters: &[u8]) -> Result<(), Error> {
        self.data_command.set_low();
        self.spi.write(&[command])?;
        if !parameters.is_empty() {
            self.data_command.set_high();
            self.spi.write(parameters)?;
        }
        Ok(())
    }
}

fn row_mask(rows: Range<usize>) -> u64 {
    if rows.is_empty() {
        return 0;
    }
    (u64::MAX << rows.start) & (u64::MAX >> (HEIGHT - rows.end))
}

fn sprite_rows([_, y]: [i32; 2], scale: u8, height: usize) -> Range<usize> {
    let top = y >> 8;
    let edge = i32::from(y & 255 != 0);
    let bottom = top + height as i32 * i32::from(scale) + edge;
    top.clamp(0, HEIGHT as i32) as usize..bottom.clamp(0, HEIGHT as i32) as usize
}

pub fn marquee_scrolls(line: &Marquee) -> bool {
    text_width(&line.text) > usize::from(line.width)
}

pub fn scroll_period(message: &str) -> usize {
    (text_width(message) * SCALE + SCROLL_GAP).max(WIDTH)
}

const LABEL_LEFT: usize = 44;
const LABEL_WIDTH: usize = 146;

pub fn page_scrolls(page: &Page) -> bool {
    page.rows
        .iter()
        .any(|row| text_width(&row[1]) > LABEL_WIDTH)
}

fn page_pixel(page: &Page, shift: usize, clock: &str, x: usize, y: usize) -> u8 {
    match y {
        0..=8 => {
            let state = page.state.label();
            let state_left = WIDTH - 2 - text_width(state);
            let clock_width = text_width(clock);
            let clock_left = (WIDTH - clock_width) / 2;
            if (2..49).contains(&x) {
                text_pixel(page.mode.label(), x - 2, y) * 15
            } else if (clock_left..clock_left + clock_width).contains(&x) {
                text_pixel(clock, x - clock_left, y) * 8
            } else if x >= state_left {
                text_pixel(state, x - state_left, y) * 11
            } else {
                0
            }
        }
        9..=17 if x >= 2 => text_pixel(&page.title, x - 2, y - 9) * 15,
        18 => 5,
        21..61 => {
            if let [[lead, notice, detail]] = page.rows.as_slice()
                && lead.is_empty()
                && detail.is_empty()
            {
                let top = (21 + 61 - FONT_HEIGHT) / 2;
                return if (top..top + FONT_HEIGHT).contains(&y) {
                    centered_text(notice, x, y - top, 1) * 15
                } else {
                    0
                };
            }
            let line = (y - 21) / 10;
            let py = (y - 21) % 10;
            if py >= FONT_HEIGHT {
                return 0;
            }
            let Some([lead, label, detail]) = page.rows.get(line) else {
                return 0;
            };
            if (2..LABEL_LEFT - 2).contains(&x) {
                text_pixel(lead, x - 2, py) * 12
            } else if (LABEL_LEFT..LABEL_LEFT + LABEL_WIDTH).contains(&x) {
                let px = x - LABEL_LEFT;
                let width = text_width(label);
                let pos = if width > LABEL_WIDTH {
                    (px + shift) % (width + 24)
                } else {
                    px
                };
                text_pixel(label, pos, py) * 15
            } else {
                let left = WIDTH - 2 - text_width(detail);
                if x >= left {
                    text_pixel(detail, x - left, py) * 10
                } else {
                    0
                }
            }
        }
        63 => 3,
        _ => 0,
    }
}

type Scanline = [u8; WIDTH / 2];

fn set_pixel(row: &mut Scanline, x: usize, shade: u8) {
    let x = WIDTH - 1 - x;
    let shift = if x & 1 == 0 { 4 } else { 0 };
    let byte = &mut row[x / 2];
    *byte = (*byte & !(15 << shift)) | (shade << shift);
}

fn paint_text(
    row: &mut Scanline,
    text: &str,
    glyph_row: usize,
    scale: usize,
    shade: u8,
    viewport: core::ops::Range<usize>,
    offset: usize,
) {
    let mut pen = 0;
    let end = offset + viewport.len();
    for code in text.bytes() {
        if pen >= end {
            break;
        }
        let glyph = glyph(code);
        let next = pen + usize::from(glyph[0]) * scale;
        if next > offset {
            let bits = u16::from(glyph[1 + glyph_row]);
            for pixel in pen.max(offset)..next.min(end) {
                if (bits >> ((pixel - pen) / scale)) & 1 != 0 {
                    set_pixel(row, viewport.start + pixel - offset, shade);
                }
            }
        }
        pen = next;
    }
}

fn paint_graphic(
    row: &mut Scanline,
    y: usize,
    command: &Primitive,
    pose: Option<([i32; 2], Option<[u8; 3]>)>,
) {
    match command {
        Primitive::Rectangle(left, top, width, height, shade) => {
            let left = usize::from(*left);
            let top = usize::from(*top);
            if (top..top + usize::from(*height)).contains(&y) {
                for x in left..(left + usize::from(*width)).min(WIDTH) {
                    set_pixel(row, x, *shade);
                }
            }
        }
        Primitive::Text(left, top, scale, shade, text) => {
            let scale = usize::from(*scale);
            if let Some(py) = y.checked_sub(usize::from(*top))
                && py < FONT_HEIGHT * scale
            {
                paint_text(
                    row,
                    text,
                    py / scale,
                    scale,
                    *shade,
                    usize::from(*left)..WIDTH,
                    0,
                );
            }
        }
        Primitive::Bitmap(left, top, scale, shade, rows) => {
            if let Some(py) = y.checked_sub(usize::from(*top))
                && let Some(bits) = rows.get(py / usize::from(*scale))
            {
                let start = usize::from(*left);
                let scale = usize::from(*scale);
                for x in start..(start + 16 * scale).min(WIDTH) {
                    if (bits >> ((x - start) / scale)) & 1 != 0 {
                        set_pixel(row, x, *shade);
                    }
                }
            }
        }
        Primitive::PackedBitmap(left, top, width, height, scale, shade, pixels) => {
            let scale = usize::from(*scale);
            if let Some(py) = y.checked_sub(usize::from(*top))
                && py < usize::from(*height) * scale
            {
                let stride = usize::from(*width).div_ceil(8);
                let start = (py / scale) * stride;
                for px in 0..usize::from(*width) {
                    if pixels.0[start + px / 8] & (1 << (px % 8)) != 0 {
                        let x = usize::from(*left) + px * scale;
                        for offset in 0..scale {
                            set_pixel(row, x + offset, *shade);
                        }
                    }
                }
            }
        }
        Primitive::Motion(scale, shade, rows, _)
        | Primitive::OccludedMotion(scale, shade, rows, _, _)
        | Primitive::ViewportMotion(scale, shade, rows, _, _) => {
            if let Some((position, occlusion)) = pose {
                let span =
                    if let Primitive::ViewportMotion(_, _, _, [x, top, width, height, _], _) =
                        command
                    {
                        if !(usize::from(*top)..usize::from(*top) + usize::from(*height))
                            .contains(&y)
                        {
                            return;
                        }
                        i32::from(*x)..i32::from(*x) + i32::from(*width)
                    } else {
                        0..WIDTH as i32
                    };
                paint_moving_bitmap(
                    row,
                    y,
                    position,
                    i32::from(*scale),
                    *shade,
                    rows,
                    occlusion,
                    span,
                );
            }
        }
    }
}

fn paint_moving_bitmap(
    row: &mut Scanline,
    y: usize,
    [left, top]: [i32; 2],
    scale: i32,
    shade: u8,
    rows: &[u16],
    occlusion: Option<[u8; 3]>,
    span: Range<i32>,
) {
    let dy = y as i32 * 256 - top;
    let sy = dy >> 8;
    if sy < -1 || sy >= rows.len() as i32 * scale {
        return;
    }
    let fy = dy & 255;
    let bits_at = |source_y: i32| {
        if source_y < 0 {
            return 0;
        }
        rows.get((source_y / scale) as usize).copied().unwrap_or(0)
    };
    let upper = bits_at(sy);
    let lower = bits_at(sy + 1);
    let start = left >> 8;
    let edge = i32::from(left & 255 != 0);
    for x in start.max(span.start)..(start + 16 * scale + edge).min(span.end) {
        if let Some([cx, cy, radius]) = occlusion {
            let dx = x - i32::from(cx);
            let dy = y as i32 - i32::from(cy);
            if dx * dx + dy * dy <= i32::from(radius).pow(2) {
                continue;
            }
        }
        let dx = x * 256 - left;
        let sx = dx >> 8;
        let fx = dx & 255;
        let mask = |source_x: i32| {
            if (0..16 * scale).contains(&source_x) {
                1 << (source_x / scale)
            } else {
                0
            }
        };
        let a = mask(sx);
        let b = mask(sx + 1);
        let upper_weight = i32::from(upper & a != 0) * (256 - fx) + i32::from(upper & b != 0) * fx;
        let lower_weight = i32::from(lower & a != 0) * (256 - fx) + i32::from(lower & b != 0) * fx;
        let alpha = upper_weight * (256 - fy) + lower_weight * fy;
        if alpha != 0 {
            let x = x as usize;
            let panel_x = WIDTH - 1 - x;
            let shift = if panel_x & 1 == 0 { 4 } else { 0 };
            let background = i32::from((row[panel_x / 2] >> shift) & 15);
            let brightness =
                (i32::from(shade) * alpha + background * (65_536 - alpha) + 32_768) >> 16;
            set_pixel(row, x, brightness as u8);
        }
    }
}

struct MotionSample {
    points: [usize; 4],
    fraction: i32,
}

impl MotionSample {
    fn new(count: usize, elapsed: u64, duration: u64) -> Self {
        let end = duration.saturating_sub(1).max(1);
        let travel = elapsed.min(end) * (count - 1) as u64;
        let index = (travel / end) as usize;
        Self {
            points: [
                index.saturating_sub(1),
                index,
                (index + 1).min(count - 1),
                (index + 2).min(count - 1),
            ],
            fraction: ((travel % end) * 256 / end) as i32,
        }
    }

    fn position(&self, point: impl Fn(usize, usize) -> u8) -> [u16; 2] {
        core::array::from_fn(|axis| self.axis(|index| point(index, axis)))
    }

    fn axis(&self, point: impl Fn(usize) -> u8) -> u16 {
        let [a, b, c, d] = self.points.map(|index| i32::from(point(index)));
        let fraction = self.fraction;
        // Bounded Catmull–Rom interpolation in 8-bit fixed-point pixel coordinates.
        let cubic = (-a + 3 * b - 3 * c + d) * fraction + (2 * a - 5 * b + 4 * c - d) * 256;
        let slope = cubic * fraction / 256 + (c - a) * 256;
        (b * 256 + slope * fraction / 512).clamp(b.min(c) * 256, b.max(c) * 256) as u16
    }
}

fn glyph(code: u8) -> &'static [u8] {
    let code = if (b' '..=b'~').contains(&code) {
        code
    } else {
        b'?'
    };
    let start = usize::from(code - b' ') * GLYPH_SIZE;
    &STOCK_FONT[start..start + GLYPH_SIZE]
}

pub fn text_width(text: &str) -> usize {
    text.bytes().map(|code| usize::from(glyph(code)[0])).sum()
}

fn text_pixel(text: &str, mut x: usize, y: usize) -> u8 {
    for code in text.bytes() {
        let glyph = glyph(code);
        let advance = usize::from(glyph[0]);
        if x < advance {
            return ((u16::from(glyph[1 + y]) >> x) & 1) as u8;
        }
        x -= advance;
    }
    0
}

fn centered_text(text: &str, x: usize, y: usize, scale: usize) -> u8 {
    let width = (text_width(text) * scale).min(WIDTH);
    let left = (WIDTH - width) / 2;
    if (left..left + width).contains(&x) {
        text_pixel(text, (x - left) / scale, y / scale)
    } else {
        0
    }
}

fn brightness(title: &str, status: &str, scroll: Option<usize>, x: usize, y: usize) -> u8 {
    match y {
        7..25 => centered_text(title, x, y - 7, SCALE) * 15,
        37..55 => {
            if let Some(offset) = scroll {
                let position = (x + offset) % scroll_period(status);
                text_pixel(status, position / SCALE, (y - 37) / SCALE) * 15
            } else {
                centered_text(status, x, y - 37, SCALE) * 15
            }
        }
        31 if (8..WIDTH - 8).contains(&x) => 4,
        _ => 0,
    }
}
