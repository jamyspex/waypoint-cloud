use alloc::{format, string::String, vec::Vec};
use core::{ffi::CStr, str};

use embassy_net::{Stack, dns::DnsQueryType, tcp::TcpSocket};
use core::cell::RefCell;
use embassy_sync::{
    blocking_mutex::{Mutex, raw::CriticalSectionRawMutex},
    signal::Signal,
};
use embassy_time::{Duration, Instant, Timer, with_deadline, with_timeout};
use esp_hal::rng::Trng;
use esp_println::println;
use esp_storage::FlashStorage;
use mbedtls_rs::{
    Certificate, ClientSessionConfig, Session, SessionConfig, Tls, TlsVersion, X509, io::Write,
};
use static_cell::StaticCell;

use crate::{
    clock,
    scene::{Board, Content, ScreenIndex, ScreenRef, UPDATES, Update},
};

const HOST: &CStr = c"o29x98ki18.execute-api.eu-west-1.amazonaws.com";
const PATH: &str = "/v1/devices/waypoint/display";
const PREFETCH_MS: u64 = 16_000;
const ROOT_PEM: &str = concat!(include_str!("../certs/amazon-root-ca-1.pem"), "\0");
const MAX_SCENE: usize = 8192;
const POLL_INTERVAL: Duration = Duration::from_secs(5);
// Last sector of the Rust app0 partition on this Waypoint's partition map.
const TOKEN_OFFSET: u32 = 0x1ff000;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// Short press: the next screen.
    Screen,
    /// Long press: the first screen of the next section.
    Section,
}

pub static SKIP_SCREEN: Signal<CriticalSectionRawMutex, Skip> = Signal::new();
/// Titles of the next screen and the next section's first screen, for the button's loading card.
pub static NEXT_TITLE: Mutex<CriticalSectionRawMutex, RefCell<(String, String)>> =
    Mutex::new(RefCell::new((String::new(), String::new())));

struct ActiveScreen {
    id: String,
    started: Instant,
    ends: Instant,
}

impl ActiveScreen {
    fn end_early(&mut self) {
        self.ends = self.ends.min(Instant::now());
    }
}

pub struct DeviceToken([u8; 64]);

impl DeviceToken {
    pub fn read(flash: &mut FlashStorage<'_>) -> Option<Self> {
        let mut bytes = [0; 40];
        flash.read_nor(TOKEN_OFFSET, &mut bytes).ok()?;
        if &bytes[..8] != b"WYPTTOK1" {
            return None;
        }
        let digits = b"0123456789abcdef";
        let mut hex = [0; 64];
        for (&byte, pair) in bytes[8..].iter().zip(hex.chunks_exact_mut(2)) {
            pair[0] = digits[usize::from(byte >> 4)];
            pair[1] = digits[usize::from(byte & 15)];
        }
        Some(Self(hex))
    }

    fn as_str(&self) -> &str {
        str::from_utf8(&self.0).expect("hexadecimal token")
    }
}

#[embassy_executor::task]
pub async fn poll(stack: Stack<'static>, token: DeviceToken) {
    stack.wait_config_up().await;
    clock::install();
    static ENTROPY: StaticCell<Trng> = StaticCell::new();
    let rng = ENTROPY.init(Trng::try_new().expect("Wi-Fi entropy is enabled"));
    let tls = Tls::new(rng).expect("TLS initialization");
    let root = CStr::from_bytes_with_nul(ROOT_PEM.as_bytes()).expect("Amazon root PEM");
    let root = Certificate::new(X509::PEM(root)).expect("Amazon root certificate");
    let config = SessionConfig::Client(ClientSessionConfig {
        ca_chain: Some(root),
        server_name: Some(HOST),
        max_version: Some(TlsVersion::Tls1_2),
        ..Default::default()
    });

    let mut index: Option<ScreenIndex> = None;
    let mut index_tag = None;
    let mut legacy_tag = None;
    let mut active: Option<ActiveScreen> = None;
    let mut skip_section = false;
    let mut resume_at: Option<String> = None;
    let mut visible = Vec::<(String, u64)>::new();
    loop {
        stack.wait_config_up().await;
        if !clock::synchronize(stack).await {
            UPDATES.signal(Update::Status("TIME UNAVAILABLE"));
            Timer::after(POLL_INTERVAL).await;
            continue;
        }

        if let Some(skip) = SKIP_SCREEN.try_take() {
            skip_section |= skip == Skip::Section;
            if let Some(current) = &mut active {
                current.end_early();
            }
        }
        let until_switch = active.as_ref().map_or(0, |current| {
            current
                .ends
                .saturating_duration_since(Instant::now())
                .as_millis()
        });
        let at = clock::unix_millis().unwrap_or(0) + until_switch;
        let index_path = format!("{PATH}?view=index&at={at}");
        match with_timeout(
            Duration::from_secs(5),
            fetch(
                stack,
                &tls,
                &config,
                &token,
                &index_path,
                index_tag.as_deref(),
                ScreenIndex::parse,
            ),
        )
        .await
        {
            Ok(Ok(Some((new, tag)))) => {
                if let Some(ActiveScreen { id, .. }) = &active {
                    if new.next_after(id).is_some() {
                        resume_at = None;
                    } else if let Some(previous) = &index {
                        let anchor = resume_at.as_ref().unwrap_or(id);
                        if !new.screens.iter().any(|screen| &screen.id == anchor) {
                            resume_at =
                                previous.surviving_successor(anchor, &new).map(String::from);
                        }
                    }
                }
                visible.retain(|(id, _)| new.screens.iter().any(|screen| &screen.id == id));
                index = Some(new);
                index_tag = tag;
            }
            Ok(Ok(None)) => (),
            _ => (),
        }
        let Some(index) = &index else {
            // Continue to work against an AWS deployment that still serves the legacy board.
            let path = format!("{PATH}?view=live");
            match with_timeout(
                Duration::from_secs(10),
                fetch(
                    stack,
                    &tls,
                    &config,
                    &token,
                    &path,
                    legacy_tag.as_deref(),
                    Content::parse,
                ),
            )
            .await
            {
                Ok(Ok(Some((content, tag)))) => {
                    legacy_tag = tag;
                    UPDATES.signal(Update::Content(content));
                }
                Ok(Ok(None)) => (),
                Ok(Err(reason)) => UPDATES.signal(Update::Status(reason)),
                Err(_) => UPDATES.signal(Update::Status("API TIMEOUT")),
            }
            Timer::after(POLL_INTERVAL).await;
            continue;
        };
        let id = active
            .as_ref()
            .and_then(|current| {
                if skip_section {
                    index
                        .next_section_after_screen(&current.id)
                        .map(|screen| screen.id.as_str())
                } else {
                    index.next_after(&current.id)
                }
            })
            .or(resume_at.as_deref())
            .unwrap_or(&index.screens[0].id);
        let path = format!("{PATH}?view=screen&screen={id}&at={at}");
        let board = match with_timeout(
            Duration::from_secs(10),
            fetch(
                stack,
                &tls,
                &config,
                &token,
                &path,
                None,
                Board::parse_screen,
            ),
        )
        .await
        {
            Ok(Ok(Some((board, _)))) if board.pages[0].id.as_deref() == Some(id) => board,
            failure => {
                let reason = match failure {
                    Ok(Err(reason)) => reason,
                    Err(_) => "API TIMEOUT",
                    _ => "INVALID SCREEN",
                };
                println!("Screen request: {reason}");
                UPDATES.signal(Update::Status(reason));
                Timer::after(POLL_INTERVAL).await;
                continue;
            }
        };
        if let Some(current) = &mut active {
            if let Ok(skip) = with_deadline(current.ends, SKIP_SCREEN.wait()).await {
                current.end_early();
                if skip == Skip::Section {
                    // The prefetched screen is in the same section, so fetch the next section instead.
                    skip_section = true;
                    continue;
                }
                if board.pages[0]
                    .starts_at
                    .is_some_and(|start| clock::unix_millis().is_some_and(|now| start > now))
                {
                    // This live track was prepared for the original switch time.
                    continue;
                }
            }
        }
        let duration = board.screen_duration();
        let remaining = board.pages[0].starts_at.map_or(duration, |start| {
            duration.saturating_sub(clock::unix_millis().unwrap_or(start).saturating_sub(start))
        });
        if remaining == 0 {
            Timer::after(Duration::from_millis(500)).await;
            continue;
        }
        if let Some(current) = &active {
            if let Some((_, total)) = visible.iter_mut().find(|(key, _)| *key == current.id) {
                *total += current
                    .ends
                    .saturating_duration_since(current.started)
                    .as_millis();
            }
        }
        let previously_visible = if let Some((_, total)) = visible.iter().find(|(key, _)| key == id)
        {
            *total
        } else {
            visible.push((String::from(id), 0));
            0
        };
        let start = Instant::now();
        active = Some(ActiveScreen {
            id: String::from(id),
            started: start,
            ends: start + Duration::from_millis(remaining),
        });
        println!("Screen updated: {id}");
        let next_title = index.next_after_screen(id).map(loading_title).unwrap_or_default();
        let section_title = index
            .next_section_after_screen(id)
            .map(loading_title)
            .unwrap_or_default();
        NEXT_TITLE.lock(|title| title.replace((next_title, section_title)));
        skip_section = false;
        resume_at = None;
        UPDATES.signal(Update::Screen(board, previously_visible));
        let prefetch_at = start + Duration::from_millis(remaining.saturating_sub(PREFETCH_MS));
        if let Ok(skip) = with_deadline(prefetch_at, SKIP_SCREEN.wait()).await {
            skip_section = skip == Skip::Section;
            if let Some(current) = &mut active {
                current.end_early();
            }
        }
    }
}

/// Label for the loading card, such as `RAIL: PARTICK`. Falls back to the bare title when it would not fit.
fn loading_title(screen: &ScreenRef) -> String {
    let prefix = match screen.mode.as_str() {
        "bus" => "BUS",
        "rail" => "RAIL",
        "air" => "AIR",
        "space" => "SPACE",
        "energy" => "ENERGY",
        "calendar" => "CALENDAR",
        "marine" => "MARINE",
        _ => return screen.title.clone(),
    };
    if screen.title.starts_with(prefix) {
        return screen.title.clone();
    }
    let label = format!("{prefix}: {}", screen.title);
    if crate::display::text_width(&label) * 2 <= 248 {
        label
    } else {
        screen.title.clone()
    }
}

async fn fetch<T>(
    stack: Stack<'_>,
    tls: &Tls<'_>,
    config: &SessionConfig<'_>,
    token: &DeviceToken,
    path: &str,
    etag: Option<&str>,
    decode: fn(&[u8]) -> Option<T>,
) -> Result<Option<(T, Option<String>)>, &'static str> {
    let host = HOST.to_str().map_err(|_| "INVALID API HOST")?;
    let addresses = stack
        .dns_query(host, DnsQueryType::A)
        .await
        .map_err(|_| "API DNS FAILED")?;
    let address = *addresses.first().ok_or("API DNS FAILED")?;
    let mut rx = [0; 2048];
    let mut tx = [0; 1024];
    let mut socket = TcpSocket::new(stack, &mut rx, &mut tx);
    socket
        .connect((address, 443))
        .await
        .map_err(|_| "API TCP FAILED")?;

    let mut session =
        Session::new(tls.reference(), &mut socket, config).map_err(|_| "API TLS INIT")?;
    if let Err(error) = session.connect().await {
        println!(
            "API TLS error: {error:?}, flags: {}",
            session.tls_verification_details()
        );
        return Err("API TLS FAILED");
    }

    let conditional = etag.map_or_else(String::new, |tag| format!("If-None-Match: {tag}\r\n"));
    let authorization = token.as_str();
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {authorization}\r\nAccept: application/json\r\n{conditional}Connection: close\r\n\r\n"
    );
    session
        .write_all(request.as_bytes())
        .await
        .map_err(|_| "API WRITE FAILED")?;
    session.flush().await.map_err(|_| "API WRITE FAILED")?;

    let mut response = [0; MAX_SCENE + 2048];
    let mut received = 0;
    let (head_len, body_len, next_tag) = loop {
        if received == response.len() {
            return Err("API HEADER LIMIT");
        }
        let n = session
            .read(&mut response[received..])
            .await
            .map_err(|_| "API READ FAILED")?;
        if n == 0 {
            return Err("API RESPONSE END");
        }
        received += n;

        let mut headers = [httparse::EMPTY_HEADER; 32];
        let mut head = httparse::Response::new(&mut headers);
        let httparse::Status::Complete(length) = head
            .parse(&response[..received])
            .map_err(|_| "API BAD RESPONSE")?
        else {
            continue;
        };
        match head.code {
            Some(304) => return Ok(None),
            Some(200) => (),
            Some(401 | 403) => return Err("API AUTH FAILED"),
            _ => return Err("API ERROR"),
        }
        let body_len = header(head.headers, "content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|&length| length <= MAX_SCENE)
            .ok_or("API BODY SIZE")?;
        if length + body_len > response.len() {
            return Err("API BODY SIZE");
        }
        let tag = header(head.headers, "etag")
            .filter(|value| {
                value.len() <= 80 && value.bytes().all(|byte| (b'!'..=b'~').contains(&byte))
            })
            .map(String::from);
        break (length, body_len, tag);
    };

    let end = head_len + body_len;
    while received < end {
        let n = session
            .read(&mut response[received..end])
            .await
            .map_err(|_| "API READ FAILED")?;
        if n == 0 {
            return Err("API RESPONSE END");
        }
        received += n;
    }
    drop(session);
    let content = decode(&response[head_len..end]).ok_or("INVALID SCENE")?;
    Ok(Some((content, next_tag)))
}

fn header<'r>(headers: &[httparse::Header<'r>], name: &str) -> Option<&'r str> {
    headers
        .iter()
        .find(|item| item.name.eq_ignore_ascii_case(name))
        .and_then(|item| str::from_utf8(item.value).ok())
}
