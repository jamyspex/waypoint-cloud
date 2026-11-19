use alloc::{format, string::String};
use core::{ffi::CStr, str};

use embassy_net::{Stack, dns::DnsQueryType, tcp::TcpSocket};
use embassy_time::{Duration, Timer, with_timeout};
use esp_hal::rng::Trng;
use esp_println::println;
use esp_storage::FlashStorage;
use mbedtls_rs::{
    Certificate, ClientSessionConfig, Session, SessionConfig, Tls, TlsVersion, X509, io::Write,
};
use static_cell::StaticCell;

use crate::{
    clock,
    scene::{Content, UPDATES, Update},
};

const HOST: &CStr = c"o29x98ki18.execute-api.eu-west-1.amazonaws.com";
const PATH: &str = "/v1/devices/waypoint/display?view=live";
const ROOT_PEM: &str = concat!(include_str!("../certs/amazon-root-ca-1.pem"), "\0");
const MAX_SCENE: usize = 8192;
const POLL_INTERVAL: Duration = Duration::from_secs(5);
// Last sector of the Rust app0 partition on this Waypoint's partition map.
const TOKEN_OFFSET: u32 = 0x1ff000;

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

    let mut etag = None;
    loop {
        stack.wait_config_up().await;
        if clock::synchronize(stack).await {
            match with_timeout(
                Duration::from_secs(15),
                fetch(stack, &tls, &config, &token, etag.as_deref()),
            )
            .await
            {
                Ok(Ok(Some((content, next_tag)))) => {
                    match &content {
                        Content::Scene(scene) => {
                            println!("Scene updated: {} / {}", scene.title, scene.message)
                        }
                        Content::Board(board) => {
                            println!("Live board updated: {} pages", board.pages.len())
                        }
                    }
                    etag = next_tag;
                    UPDATES.signal(Update::Content(content));
                }
                Ok(Ok(None)) => println!("Scene unchanged (304)"),
                Ok(Err(message)) => {
                    println!("Scene request: {message}");
                    UPDATES.signal(Update::Status(message));
                }
                Err(_) => UPDATES.signal(Update::Status("API TIMEOUT")),
            }
        } else {
            println!("Waiting for network time");
            UPDATES.signal(Update::Status("TIME UNAVAILABLE"));
        }
        Timer::after(POLL_INTERVAL).await;
    }
}

async fn fetch(
    stack: Stack<'_>,
    tls: &Tls<'_>,
    config: &SessionConfig<'_>,
    token: &DeviceToken,
    etag: Option<&str>,
) -> Result<Option<(Content, Option<String>)>, &'static str> {
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
        "GET {PATH} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {authorization}\r\nAccept: application/json\r\n{conditional}Connection: close\r\n\r\n"
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
    let content = Content::parse(&response[head_len..end]).ok_or("INVALID SCENE")?;
    Ok(Some((content, next_tag)))
}

fn header<'r>(headers: &[httparse::Header<'r>], name: &str) -> Option<&'r str> {
    headers
        .iter()
        .find(|item| item.name.eq_ignore_ascii_case(name))
        .and_then(|item| str::from_utf8(item.value).ok())
}
