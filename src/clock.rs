use core::cell::Cell;

use critical_section::Mutex;
use embassy_net::{
    IpEndpoint, Stack,
    dns::DnsQueryType,
    udp::{PacketMetadata, UdpSocket},
};
use embassy_time::{Duration, Instant, with_timeout};
use esp_hal::rng::Rng;
use mbedtls_rs::sys::{
    hook::{
        backend::embassy::timer::EmbassyTimer,
        timer::hook_timer,
        wall_clock::{MbedtlsWallClock, hook_wall_clock},
    },
    tm,
};
use time::OffsetDateTime;

struct WallClock(Mutex<Cell<Option<(i64, Instant)>>>);
static CLOCK: WallClock = WallClock(Mutex::new(Cell::new(None)));
static TIMER: EmbassyTimer = EmbassyTimer;

pub fn install() {
    // The sole TLS task installs static hooks before initializing MbedTLS.
    unsafe {
        hook_timer(Some(&TIMER));
        hook_wall_clock(Some(&CLOCK));
    }
}

pub async fn synchronize(stack: Stack<'_>) -> bool {
    if critical_section::with(|cs| {
        CLOCK
            .0
            .borrow(cs)
            .get()
            .is_some_and(|(_, at)| at.elapsed().as_secs() < 3600)
    }) {
        return true;
    }

    for host in ["time.aws.com", "time.google.com"] {
        if let Ok(Some(seconds)) = with_timeout(Duration::from_secs(4), query(stack, host)).await {
            critical_section::with(|cs| CLOCK.0.borrow(cs).set(Some((seconds, Instant::now()))));
            return true;
        }
    }
    false
}

async fn query(stack: Stack<'_>, host: &str) -> Option<i64> {
    let addresses = stack.dns_query(host, DnsQueryType::A).await.ok()?;
    let endpoint: IpEndpoint = (*addresses.first()?, 123).into();

    let mut rx_meta = [PacketMetadata::EMPTY; 1];
    let mut tx_meta = [PacketMetadata::EMPTY; 1];
    let mut rx_buf = [0; 128];
    let mut tx_buf = [0; 48];
    let mut socket = UdpSocket::new(stack, &mut rx_meta, &mut rx_buf, &mut tx_meta, &mut tx_buf);
    let rng = Rng::new();
    socket.bind(49152 + (rng.random() % 16384) as u16).ok()?;
    let mut request = [0; 48];
    request[0] = 0x23; // NTPv4 client.
    rng.read(&mut request[40..48]);
    socket.send_to(&request, endpoint).await.ok()?;

    let mut response = [0; 128];
    let (length, remote) = socket.recv_from(&mut response).await.ok()?;
    if length < 48
        || remote.endpoint != endpoint
        || response[0] & 7 != 4
        || response[0] >> 6 == 3
        || !(1..=15).contains(&response[1])
        || response[24..32] != request[40..48]
    {
        return None;
    }
    let ntp = i64::from(u32::from_be_bytes(response[40..44].try_into().ok()?));
    let mut unix = ntp - 2_208_988_800;
    if unix < 0 {
        unix += 1_i64 << 32;
    }
    (1_704_067_200..4_102_444_800)
        .contains(&unix)
        .then_some(unix)
}

impl MbedtlsWallClock for WallClock {
    fn instant(&self) -> Option<tm> {
        let (unix, synced_at) = critical_section::with(|cs| self.0.borrow(cs).get())?;
        let utc = OffsetDateTime::from_unix_timestamp(unix + synced_at.elapsed().as_secs() as i64)
            .ok()?;
        Some(tm {
            tm_sec: i32::from(utc.second()),
            tm_min: i32::from(utc.minute()),
            tm_hour: i32::from(utc.hour()),
            tm_mday: i32::from(utc.day()),
            tm_mon: i32::from(utc.month() as u8) - 1,
            tm_year: utc.year() - 1900,
            tm_wday: i32::from(utc.weekday().number_days_from_sunday()),
            tm_yday: i32::from(utc.ordinal()) - 1,
            tm_isdst: 0,
            ..Default::default()
        })
    }
}
