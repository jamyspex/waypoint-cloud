use alloc::{string::String, vec::Vec};

use embassy_sync::{blocking_mutex::raw::CriticalSectionRawMutex, signal::Signal};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Animation {
    Scroll,
    Blink,
    None,
}

#[derive(Debug, Deserialize)]
pub struct Scene {
    pub version: u8,
    pub title: String,
    pub message: String,
    pub animation: Animation,
    pub speed: u8,
}

pub enum Update {
    Screen(Board, u64),
    Content(Content),
    Status(&'static str),
}

pub static UPDATES: Signal<CriticalSectionRawMutex, Update> = Signal::new();

#[derive(Debug)]
pub enum Content {
    Scene(Scene),
    Board(Board),
}

#[derive(Deserialize)]
pub struct ScreenIndex {
    version: u8,
    pub screens: Vec<ScreenRef>,
}

#[derive(Deserialize)]
pub struct ScreenRef {
    pub id: String,
    // Kept as text so an unfamiliar mode never breaks the whole index.
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub title: String,
}

impl ScreenIndex {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let index: Self = serde_json::from_slice(bytes).ok()?;
        (index.version == 3
            && (1..=256).contains(&index.screens.len())
            && index.screens.iter().enumerate().all(|(i, screen)| {
                (1..=24).contains(&screen.id.len())
                    && screen
                        .id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    && index.screens[..i].iter().all(|prior| prior.id != screen.id)
            }))
        .then_some(index)
    }

    pub fn next_after(&self, id: &str) -> Option<&str> {
        let position = self.screens.iter().position(|screen| screen.id == id)?;
        Some(&self.screens[(position + 1) % self.screens.len()].id)
    }

    pub fn next_after_screen(&self, id: &str) -> Option<&ScreenRef> {
        let position = self.screens.iter().position(|screen| screen.id == id)?;
        Some(&self.screens[(position + 1) % self.screens.len()])
    }

    /// First screen after `id` in a different section (mode), such as the screen after the last rail board.
    pub fn next_section_after_screen(&self, id: &str) -> Option<&ScreenRef> {
        let position = self.screens.iter().position(|screen| screen.id == id)?;
        let mode = &self.screens[position].mode;
        (1..self.screens.len())
            .map(|step| &self.screens[(position + step) % self.screens.len()])
            .find(|screen| &screen.mode != mode)
            .or_else(|| self.next_after_screen(id))
    }

    pub fn surviving_successor<'a>(&self, id: &str, updated: &'a Self) -> Option<&'a str> {
        let position = self.screens.iter().position(|screen| screen.id == id)?;
        let (before, after) = self.screens.split_at(position);
        after[1..].iter().chain(before).find_map(|candidate| {
            updated
                .screens
                .iter()
                .find(|screen| screen.id == candidate.id)
                .map(|screen| screen.id.as_str())
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct Board {
    pub version: u8,
    pub rotation: u8,
    pub pages: Vec<Page>,
}

impl Board {
    pub fn parse_screen(bytes: &[u8]) -> Option<Self> {
        match Content::parse(bytes)? {
            Content::Board(board) if board.pages.len() == 1 => Some(board),
            _ => None,
        }
    }

    pub fn screen_duration(&self) -> u64 {
        self.dwell(&self.pages[0])
    }

    pub fn next_page_offset(&self, elapsed: u64) -> u64 {
        let (_, page, within, _) = self.page_at(elapsed);
        elapsed - within + self.dwell(page)
    }

    fn dwell(&self, page: &Page) -> u64 {
        page.animation.as_ref().map_or(
            u64::from(page.dwell_seconds.unwrap_or(self.rotation)) * 1000,
            |animation| u64::from(animation.phase_ms) * animation.phases.len() as u64,
        )
    }

    fn period(&self) -> u64 {
        self.pages.iter().map(|page| self.dwell(page)).sum()
    }

    pub fn page_at(&self, elapsed: u64) -> (usize, &Page, u64, u64) {
        let total = self.period();
        let mut remaining = elapsed % total;
        for (index, page) in self.pages.iter().enumerate() {
            let duration = self.dwell(page);
            if remaining < duration {
                return (
                    index,
                    page,
                    remaining,
                    elapsed / total * duration + remaining,
                );
            }
            remaining -= duration;
        }
        unreachable!()
    }

    pub fn continue_from(
        &mut self,
        previous: &mut Board,
        elapsed: u64,
    ) -> (u64, Option<(usize, usize)>) {
        let (old_index, old, within, _) = previous.page_at(elapsed);
        let Some(index) = self
            .pages
            .iter()
            .position(|page| match (&page.id, &old.id) {
                (Some(id), Some(old_id)) => id == old_id,
                _ => page.mode == old.mode && page.title == old.title,
            })
        else {
            return (0, None);
        };
        let turns = elapsed / previous.period();
        let incoming = &self.pages[index];
        let new_aircraft = incoming.has_aircraft() && !old.has_aircraft();
        // Keep the objects on an active preview stable until its slot ends.
        let keep_preview = (old.mode == Mode::Space && old.animation.is_some())
            || (old.has_aircraft() && incoming.has_aircraft());
        if keep_preview {
            core::mem::swap(&mut self.pages[index], &mut previous.pages[old_index]);
        }
        let before: u64 = self.pages[..index]
            .iter()
            .map(|page| self.dwell(page))
            .sum();
        let within = if new_aircraft {
            0
        } else {
            within.min(self.dwell(&self.pages[index]) - 1)
        };
        (
            turns * self.period() + before + within,
            keep_preview.then_some((old_index, index)),
        )
    }
}

#[derive(Debug, Deserialize)]
pub struct Page {
    pub id: Option<String>,
    pub mode: Mode,
    pub title: String,
    pub updated: String,
    pub state: State,
    pub rows: Vec<[String; 3]>,
    pub graphics: Option<Vec<Primitive>>,
    pub animation: Option<GraphicAnimation>,
    pub marquee: Option<Marquee>,
    pub clock: Option<ClockLabel>,
    pub starts_at: Option<u64>,
    pub dwell_seconds: Option<u8>,
}

#[derive(Debug, Deserialize)]
pub struct ClockLabel {
    pub right: u8,
    pub shade: u8,
}

impl Page {
    fn has_aircraft(&self) -> bool {
        self.mode == Mode::Air
            && self.state != State::Offline
            && self
                .rows
                .first()
                .is_some_and(|[distance, _, _]| !distance.is_empty())
    }
}

#[derive(Debug, Deserialize)]
pub struct Marquee {
    pub left: u8,
    pub top: u8,
    pub width: u16,
    pub shade: u8,
    pub speed: u8,
    pub text: String,
}

impl Marquee {
    fn valid(&self) -> bool {
        self.top <= 55
            && self.width != 0
            && self.width <= 256 - u16::from(self.left)
            && self.shade <= 15
            && (10..=100).contains(&self.speed)
            && !self.text.is_empty()
            && ascii(&self.text, 768)
    }
}

#[derive(Debug, Deserialize)]
pub struct GraphicAnimation {
    pub phase_ms: u32,
    pub phases: Vec<Vec<Primitive>>,
}

// Compact display commands expressed as arrays in the board response.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Primitive {
    Rectangle(u8, u8, u16, u8, u8),
    Text(u8, u8, u8, u8, String),
    Bitmap(u8, u8, u8, u8, Vec<u16>),
    Motion(u8, u8, Vec<u16>, Vec<[u8; 2]>),
    PackedBitmap(u8, u8, u8, u8, u8, u8, HexBytes),
    OccludedMotion(u8, u8, Vec<u16>, [u8; 3], HexBytes),
    ViewportMotion(u8, u8, Vec<u16>, [u8; 5], HexBytes),
}

#[derive(Debug, Deserialize)]
#[serde(try_from = "String")]
pub struct HexBytes(pub Vec<u8>);

impl TryFrom<String> for HexBytes {
    type Error = &'static str;

    fn try_from(text: String) -> Result<Self, Self::Error> {
        if text.len() > 2048 || text.len() % 2 != 0 {
            return Err("invalid hex length");
        }
        let nibble = |digit| match digit {
            b'0'..=b'9' => Ok(digit - b'0'),
            b'a'..=b'f' => Ok(digit - b'a' + 10),
            _ => Err("invalid hex digit"),
        };
        let bytes = text
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| Ok(nibble(pair[0])? << 4 | nibble(pair[1])?))
            .collect::<Result<Vec<u8>, _>>()?;
        Ok(Self(bytes))
    }
}

impl Primitive {
    fn valid(&self) -> bool {
        match self {
            Self::Rectangle(_, y, width, height, shade) => {
                *y < 64 && (1..=256).contains(width) && (1..=64).contains(height) && *shade <= 15
            }
            Self::Text(_, y, scale, shade, text) => {
                *y < 64 && (1..=4).contains(scale) && *shade <= 15 && ascii(text, 48)
            }
            Self::Bitmap(_, y, scale, shade, rows) => {
                *y < 64 && (1..=4).contains(scale) && *shade <= 15 && (1..=32).contains(&rows.len())
            }
            Self::Motion(scale, shade, rows, path) => {
                (1..=4).contains(scale)
                    && *shade <= 15
                    && (1..=32).contains(&rows.len())
                    && (2..=24).contains(&path.len())
                    && path.iter().all(|[_, y]| *y < 64)
            }
            Self::PackedBitmap(x, y, width, height, scale, shade, pixels) => {
                *width != 0
                    && *height != 0
                    && (1..=4).contains(scale)
                    && *shade <= 15
                    && u16::from(*x) + u16::from(*width) * u16::from(*scale) <= 256
                    && u16::from(*y) + u16::from(*height) * u16::from(*scale) <= 64
                    && pixels.0.len() == usize::from(*width).div_ceil(8) * usize::from(*height)
            }
            Self::OccludedMotion(scale, shade, rows, [_, y, radius], path) => {
                (1..=4).contains(scale)
                    && *shade <= 15
                    && (1..=32).contains(&rows.len())
                    && *y < 64
                    && (1..=64).contains(radius)
                    && path.0.len() % 3 == 0
                    && (6..=72).contains(&path.0.len())
                    && path.0.chunks_exact(3).all(|point| point[1] < 64)
            }
            Self::ViewportMotion(scale, shade, rows, [x, y, width, height, samples], path) => {
                (1..=4).contains(scale)
                    && *shade <= 15
                    && (1..=32).contains(&rows.len())
                    && *width > 0
                    && u16::from(*x) + u16::from(*width) <= 256
                    && *height > 0
                    && u16::from(*y) + u16::from(*height) <= 64
                    && (2..=24).contains(samples)
                    && path.0.len() % 2 == 0
                    && (2..=usize::from(*samples)).contains(&(path.0.len() / 2))
            }
        }
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Bus,
    Rail,
    Air,
    Space,
    Energy,
    Calendar,
    Marine,
    Sky,
}

impl Mode {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Bus => "BUS",
            Self::Rail => "RAIL",
            Self::Air => "AIR",
            Self::Space => "SPACE",
            Self::Energy => "ENERGY",
            Self::Calendar => "CALENDAR",
            Self::Marine => "MARINE",
            Self::Sky => "SKY",
        }
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Live,
    Stale,
    Offline,
}

impl State {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Live => "LIVE",
            Self::Stale => "STALE",
            Self::Offline => "OFFLINE",
        }
    }
}

impl Content {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        #[derive(Deserialize)]
        struct Version {
            version: u8,
        }
        // Select the schema before deserializing so Serde need not buffer the whole board.
        let content = match serde_json::from_slice::<Version>(bytes).ok()?.version {
            1 => Self::Scene(serde_json::from_slice(bytes).ok()?),
            2 => Self::Board(serde_json::from_slice(bytes).ok()?),
            _ => return None,
        };
        let valid = match &content {
            Self::Scene(scene) => {
                scene.version == 1
                    && !scene.title.is_empty()
                    && ascii(&scene.title, 16)
                    && !scene.message.is_empty()
                    && ascii(&scene.message, 128)
                    && (8..=80).contains(&scene.speed)
            }
            Self::Board(board) => {
                board.version == 2
                    && (5..=60).contains(&board.rotation)
                    && (1..=10).contains(&board.pages.len())
                    && board.pages.iter().all(|page| {
                        !page.title.is_empty()
                            && ascii(&page.title, 26)
                            && ascii(&page.updated, 5)
                            && page.id.as_ref().is_none_or(|id| ascii(id, 24))
                            && page.rows.len() <= 4
                            && page
                                .dwell_seconds
                                .is_none_or(|seconds| (5..=120).contains(&seconds))
                            && page.marquee.as_ref().is_none_or(Marquee::valid)
                            && page
                                .clock
                                .as_ref()
                                .is_none_or(|clock| clock.right >= 32 && clock.shade <= 15)
                            && page.starts_at.is_none_or(|ms| {
                                (1_704_067_200_000..=4_102_444_800_000).contains(&ms)
                            })
                            && page.graphics.as_ref().is_none_or(|commands| {
                                commands.len() <= 32 && commands.iter().all(Primitive::valid)
                            })
                            && page.animation.as_ref().is_none_or(|animation| {
                                let max_phases = if page.mode == Mode::Marine { 40 } else { 5 };
                                (500..=120_000).contains(&animation.phase_ms)
                                    && (1..=max_phases).contains(&animation.phases.len())
                                    && animation.phases.iter().all(|commands| {
                                        commands.len() <= 16
                                            && commands.iter().all(Primitive::valid)
                                    })
                            })
                            && page.rows.iter().all(|[lead, label, detail]| {
                                ascii(lead, 5) && ascii(label, 48) && ascii(detail, 8)
                            })
                    })
            }
        };
        valid.then_some(content)
    }
}

fn ascii(text: &str, limit: usize) -> bool {
    text.len() <= limit && text.bytes().all(|byte| (b' '..=b'~').contains(&byte))
}
