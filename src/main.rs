#![no_std]
#![no_main]

extern crate alloc;

use core::{future::pending, panic::PanicInfo};

use embassy_executor::Spawner;
use embassy_net::{Runner, StackResources};
use embassy_time::{Duration, Instant, Timer};
use esp_hal::delay::Delay;
use esp_hal::gpio::{Level, Output, OutputConfig};
use esp_hal::rng::Rng;
use esp_hal::spi::master::{Config as SpiConfig, Spi};
use esp_hal::time::Rate;
use esp_hal::timer::timg::TimerGroup;
use esp_println::println;
use esp_radio::wifi::{
    AuthenticationMethodConfig, Config as WifiConfig, Interface, WifiController, sta::StationConfig,
};
use esp_storage::FlashStorage;
use static_cell::StaticCell;

mod clock;
mod cloud;
mod credentials;
mod display;
mod scene;

use credentials::Credentials;
use display::Display;
use scene::{Animation, Content, Mode, UPDATES, Update};

const TITLE: &str = "WAYPOINT";

esp_bootloader_esp_idf::esp_app_desc!();

#[esp_rtos::main]
async fn main(spawner: Spawner) {
    let peripherals = esp_hal::init(esp_hal::Config::default());
    let delay = Delay::new();
    println!("Waypoint display terminal");

    let chip_select = Output::new(peripherals.GPIO16, Level::High, OutputConfig::default());
    let data_command = Output::new(peripherals.GPIO4, Level::Low, OutputConfig::default());
    let mut reset = Output::new(peripherals.GPIO17, Level::Low, OutputConfig::default());
    let spi = Spi::new(
        peripherals.SPI3,
        SpiConfig::default().with_frequency(Rate::from_mhz(8)),
    )
    .expect("OLED SPI configuration")
    .with_sck(peripherals.GPIO18)
    .with_mosi(peripherals.GPIO5);
    delay.delay_millis(100);
    reset.set_high();
    delay.delay_millis(100);
    let mut display = Display::new(spi, chip_select, data_command).expect("OLED initialization");
    report(&mut display, "READING WIFI");

    let mut flash = FlashStorage::new(peripherals.FLASH);
    let Some(config) = Credentials::read(&mut flash).and_then(station_config) else {
        report(&mut display, "NO WIFI SETTINGS");
        return pending().await;
    };
    println!("Loaded saved Wi-Fi settings");
    let Some(token) = cloud::DeviceToken::read(&mut flash) else {
        report(&mut display, "NO DEVICE TOKEN");
        return pending().await;
    };

    esp_alloc::heap_allocator!(size: 120 * 1024);
    let timer_group = TimerGroup::new(peripherals.TIMG0);
    esp_rtos::start(timer_group.timer0, peripherals.FROM_CPU_INTR0);

    let mut controller = WifiController::new(peripherals.WIFI, Default::default())
        .expect("Wi-Fi controller initialization");
    controller
        .set_config(&config)
        .expect("Wi-Fi station configuration");
    let rng = Rng::new();
    let seed = (u64::from(rng.random()) << 32) | u64::from(rng.random());
    static NETWORK: StaticCell<StackResources<3>> = StaticCell::new();
    let (stack, runner) = embassy_net::new(
        Interface::station(),
        embassy_net::Config::dhcpv4(Default::default()),
        NETWORK.init(StackResources::new()),
        seed,
    );
    spawner.spawn(network_task(runner).expect("network task"));
    spawner.spawn(wifi_task(controller).expect("Wi-Fi task"));
    spawner.spawn(cloud::poll(stack, token).expect("display API task"));

    report(&mut display, "WIFI CONNECTING");
    let mut content = None;
    let mut started = Instant::now();
    let mut board_offset = 0;
    let mut last_frame = None;
    loop {
        let loop_started = Instant::now();
        let mut interval = 70;
        match UPDATES.try_take() {
            Some(Update::Content(mut next)) => {
                board_offset = match (&mut content, &mut next) {
                    (Some(Content::Board(previous)), Content::Board(board)) => {
                        board.continue_from(previous, board_offset + started.elapsed().as_millis())
                    }
                    _ => 0,
                };
                started = Instant::now();
                content = Some(next);
                last_frame = None;
            }
            Some(Update::Status(status)) if content.is_none() => report(&mut display, status),
            _ => (),
        }

        let elapsed_ms = started.elapsed().as_millis();
        match &content {
            Some(Content::Scene(scene)) => {
                let (message, offset, phase) = match scene.animation {
                    Animation::Scroll => {
                        let shift = elapsed_ms * u64::from(scene.speed) / 1000;
                        let offset =
                            (shift % display::scroll_period(&scene.message) as u64) as usize;
                        (scene.message.as_str(), Some(offset), offset)
                    }
                    Animation::Blink if (elapsed_ms / 650) % 2 == 1 => ("", None, 1),
                    _ => (scene.message.as_str(), None, 0),
                };
                let frame = (0, Some(phase));
                if last_frame != Some(frame) {
                    display
                        .show_offset(&scene.title, message, offset)
                        .expect("OLED frame");
                    last_frame = Some(frame);
                }
            }
            Some(Content::Board(board)) => {
                let (index, page, elapsed_on_page, visible_time) =
                    board.page_at(board_offset + elapsed_ms);
                if page.graphics.is_some() || page.animation.is_some() || page.marquee.is_some() {
                    let commands = page.graphics.as_deref().unwrap_or_default();
                    let (phase, time, duration) = if let Some(animation) = &page.animation {
                        let duration = u64::from(animation.phase_ms);
                        let phase = &animation.phases[(elapsed_on_page / duration) as usize];
                        (phase.as_slice(), elapsed_on_page % duration, duration)
                    } else {
                        (&[][..], 0, 1)
                    };
                    let moving = page.animation.is_some()
                        || page.marquee.as_ref().is_some_and(display::marquee_scrolls);
                    let tick = moving.then_some(elapsed_on_page as usize / 17);
                    if moving {
                        interval = 17;
                    }
                    let frame = (index, tick);
                    if last_frame != Some(frame) {
                        let draw_started = Instant::now();
                        let marquee = page
                            .marquee
                            .as_ref()
                            .map(|line| (line, visible_time.saturating_sub(600)));
                        display
                            .show_graphics(commands, phase, time, duration, marquee)
                            .expect("OLED graphics page");
                        let draw_micros = draw_started.elapsed().as_micros();
                        if last_frame.is_none_or(|(previous, _)| previous != index) {
                            let title = if page.animation.is_none()
                                && page.marquee.is_none()
                                && commands.is_empty()
                            {
                                "BLANK"
                            } else {
                                &page.title
                            };
                            println!(
                                "Showing {} / {} ({})",
                                page.mode.label(),
                                title,
                                page.state.label()
                            );
                            if moving {
                                println!("OLED animated frame: {} us", draw_micros);
                            }
                        }
                        last_frame = Some(frame);
                    }
                } else if matches!(page.mode, Mode::Air) {
                    let frame = (index, None);
                    if last_frame != Some(frame) {
                        display.show_aircraft(page).expect("OLED aircraft detail");
                        println!("Showing AIR / FULL SCREEN ({})", page.state.label());
                        last_frame = Some(frame);
                    }
                } else {
                    let shift = if display::page_scrolls(page) {
                        (elapsed_on_page.saturating_sub(900) / 50) as usize
                    } else {
                        0
                    };
                    let frame = (index, Some(shift));
                    if last_frame != Some(frame) {
                        if last_frame.is_none_or(|(previous, _)| previous != index) {
                            println!(
                                "Showing {} / {} ({})",
                                page.mode.label(),
                                page.title,
                                page.state.label()
                            );
                        }
                        display.show_page(page, shift).expect("OLED board page");
                        last_frame = Some(frame);
                    }
                }
            }
            None => (),
        }
        let next = (loop_started + Duration::from_millis(interval))
            .max(Instant::now() + Duration::from_millis(1));
        Timer::at(next).await;
    }
}

fn station_config(credentials: Credentials) -> Option<WifiConfig> {
    let ssid = credentials.ssid()?.try_into().ok()?;
    let password = credentials.password()?;
    let auth = if password.is_empty() {
        AuthenticationMethodConfig::Open
    } else {
        AuthenticationMethodConfig::Wpa2Personal(password.try_into().ok()?)
    };
    Some(WifiConfig::Station(
        StationConfig::default()
            .with_ssid(ssid)
            .with_authentication(auth),
    ))
}

#[embassy_executor::task]
async fn network_task(mut runner: Runner<'static, Interface>) {
    runner.run().await;
}

#[embassy_executor::task]
async fn wifi_task(mut controller: WifiController<'static>) {
    loop {
        match controller.connect_async().await {
            Ok(_) => {
                println!("Wi-Fi connected");
                let _ = controller.wait_for_disconnect_async().await;
                println!("Wi-Fi disconnected");
            }
            Err(error) => println!("Wi-Fi connection failed: {error:?}"),
        }
        Timer::after_secs(3).await;
    }
}

fn report(display: &mut Display<'_>, status: &str) {
    println!("{status}");
    display.show(TITLE, status).expect("OLED SPI transfer");
}

#[panic_handler]
fn panic(info: &PanicInfo<'_>) -> ! {
    println!("panic: {info}");
    loop {
        core::hint::spin_loop();
    }
}
