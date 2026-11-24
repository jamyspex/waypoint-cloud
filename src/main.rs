#![no_std]
#![no_main]

extern crate alloc;

use core::{future::pending, panic::PanicInfo};

use embassy_executor::Spawner;
use embassy_net::{Runner, StackResources};
use embassy_sync::{blocking_mutex::raw::CriticalSectionRawMutex, signal::Signal};
use embassy_time::{Duration, Instant, Timer, with_timeout};
use esp_hal::delay::Delay;
use esp_hal::gpio::{Input, InputConfig, Level, Output, OutputConfig, Pull};
use esp_hal::rng::Rng;
use esp_hal::spi::master::{Config as SpiConfig, Spi};
use esp_hal::time::Rate;
use esp_hal::timer::timg::TimerGroup;
use esp_println::println;
use esp_radio::wifi::{
    AuthenticationMethodConfig, Config as WifiConfig, Interface, WifiController, sta::StationConfig,
};
use esp_storage::FlashStorage;
use esp_hal::system::Stack;
use static_cell::StaticCell;

mod clock;
mod cloud;
mod credentials;
mod display;
mod scene;

use credentials::Credentials;
use display::Display;
use scene::{Animation, Content, Mode, Primitive, UPDATES, Update};

const TITLE: &str = "WAYPOINT";
const LOADING_DELAY_MS: u64 = 150;
const LOADING_GIVE_UP_MS: u64 = 30_000;
#[derive(Clone, Copy)]
enum Press {
    Short,
    Long,
}

static BUTTON_PRESS: Signal<CriticalSectionRawMutex, Press> = Signal::new();
const LONG_PRESS: Duration = Duration::from_millis(600);

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
    // The stock v12.14 firmware treats a high level on GPIO13 as a press.
    let button = Input::new(
        peripherals.GPIO13,
        InputConfig::default().with_pull(Pull::Down),
    );
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
    spawner.spawn(button_task(button).expect("scene button task"));

    report(&mut display, "WIFI CONNECTING");

    // Run the display on the second core so blocking TLS work on this core cannot stall animations.
    // Main DRAM is nearly full, so the second core's stack lives in the memory reclaimed from the ROM.
    #[unsafe(link_section = ".dram2_uninit")]
    static mut APP_CORE_STACK: core::mem::MaybeUninit<Stack<16384>> = core::mem::MaybeUninit::uninit();
    // SAFETY: taken once, here; a stack's contents are themselves uninitialised words.
    let app_core_stack =
        unsafe { &mut *(core::ptr::addr_of_mut!(APP_CORE_STACK) as *mut Stack<16384>) };
    esp_rtos::start_second_core(
        peripherals.CPU_CTRL,
        peripherals.FROM_CPU_INTR1,
        app_core_stack,
        move || {
            static EXECUTOR: StaticCell<esp_rtos::embassy::Executor> = StaticCell::new();
            EXECUTOR
                .init(esp_rtos::embassy::Executor::new())
                .run(|spawner| spawner.spawn(display_task(display).expect("display task")));
        },
    );
}

#[embassy_executor::task]
async fn display_task(mut display: Display<'static>) {
    let mut content = None;
    let mut started = Instant::now();
    let mut board_offset = 0;
    let mut marquee_offset = 0;
    let mut last_frame: Option<(usize, usize, Option<usize>)> = None;
    let mut last_clock = None;
    let mut last_progress: Option<usize> = None;
    // Set while the cloud task fetches a screen the button skipped to.
    // (started, API error, skipping a whole section)
    let mut loading: Option<(Instant, Option<&'static str>, bool)> = None;
    loop {
        let loop_started = Instant::now();
        let mut interval = 70;
        match UPDATES.try_take() {
            Some(Update::Screen(board, previously_visible)) => {
                loading = None;
                board_offset = 0;
                marquee_offset = previously_visible;
                started = Instant::now();
                content = Some(Content::Board(board));
                last_frame = None;
            }
            Some(Update::Content(mut next)) => {
                let (offset, kept_page) = match (&mut content, &mut next) {
                    (Some(Content::Board(previous)), Content::Board(board)) => {
                        board.continue_from(previous, board_offset + started.elapsed().as_millis())
                    }
                    _ => (0, None),
                };
                loading = None;
                board_offset = offset;
                marquee_offset = 0;
                started = Instant::now();
                content = Some(next);
                last_frame = kept_page.and_then(|(old, new)| {
                    last_frame.and_then(|(index, phase, tick)| {
                        (index == old).then_some((new, phase, tick))
                    })
                });
            }
            Some(Update::Status(status)) if loading.is_some() => {
                println!("{status}");
                loading = loading.map(|(since, _, section)| (since, Some(status), section));
            }
            Some(Update::Status(status)) if content.is_none() => report(&mut display, status),
            _ => (),
        }

        if let Some(press) = BUTTON_PRESS.try_take() {
            match (&content, press) {
                (Some(Content::Board(board)), Press::Short) if board.pages.len() > 1 => {
                    board_offset =
                        board.next_page_offset(board_offset + started.elapsed().as_millis());
                    started = Instant::now();
                    last_frame = None;
                }
                // Ignore presses until the requested screen arrives.
                (Some(Content::Board(_)), press) if loading.is_none() => {
                    let section = matches!(press, Press::Long);
                    cloud::SKIP_SCREEN.signal(if section {
                        cloud::Skip::Section
                    } else {
                        cloud::Skip::Screen
                    });
                    loading = Some((Instant::now(), None, section));
                }
                _ => (),
            }
        }
        if let Some((since, status, section)) = loading {
            let waited = since.elapsed().as_millis();
            if waited >= LOADING_GIVE_UP_MS {
                // Fall back to the current screen if the fetch never completes.
                loading = None;
                last_frame = None;
            } else {
                // A prefetched screen arrives almost at once, so wait briefly before drawing.
                if waited >= LOADING_DELAY_MS {
                    let dots = (waited / 400 % 4) as usize;
                    let frame = (usize::MAX - 1, dots, None);
                    if last_frame != Some(frame) {
                        let message = status.unwrap_or(
                            ["LOADING   ", "LOADING.  ", "LOADING.. ", "LOADING..."][dots],
                        );
                        let next = cloud::NEXT_TITLE.lock(|titles| {
                            let titles = titles.borrow();
                            if section { titles.1.clone() } else { titles.0.clone() }
                        });
                        let title = if next.is_empty() { "NEXT SCREEN" } else { next.as_str() };
                        display.show(title, message).expect("OLED loading screen");
                        last_frame = Some(frame);
                    }
                }
                Timer::after(Duration::from_millis(interval)).await;
                continue;
            }
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
                let frame = (0, 0, Some(phase));
                if last_frame != Some(frame) {
                    display
                        .show_offset(&scene.title, message, offset)
                        .expect("OLED frame");
                    last_frame = Some(frame);
                }
            }
            Some(Content::Board(board)) => {
                let minute = clock::london_minute();
                let clock_changed = last_clock != minute;
                last_clock = minute;
                let label = clock::time_label(minute);
                let clock_text = core::str::from_utf8(&label).expect("ASCII clock label");
                let timeline_elapsed = board.pages[0]
                    .starts_at
                    .map(|start| clock::unix_millis().unwrap_or(start).saturating_sub(start));
                if timeline_elapsed.is_some_and(|elapsed| elapsed >= board.screen_duration()) {
                    let expired = (usize::MAX, 0, None);
                    if last_frame != Some(expired) {
                        report(&mut display, "AWAITING LIVE TRACK");
                        last_frame = Some(expired);
                    }
                    Timer::after(Duration::from_millis(interval)).await;
                    continue;
                }
                let (index, page, elapsed_on_page, visible_time) =
                    board.page_at(timeline_elapsed.unwrap_or(board_offset + elapsed_ms));
                // Time-left bar: pixels filled so far on this screen.
                let filled = page
                    .progress
                    .as_ref()
                    .map_or(0, |bar| bar.filled(elapsed_on_page, board.page_duration(page)));
                let progress_changed = last_progress != Some(filled) || last_frame.is_none();
                if page.graphics.is_some() || page.animation.is_some() || page.marquee.is_some() {
                    let commands = page.graphics.as_deref().unwrap_or_default();
                    let (phase, phase_index, time, duration) =
                        if let Some(animation) = &page.animation {
                            let duration = u64::from(animation.phase_ms);
                            let index = (elapsed_on_page / duration) as usize;
                            (
                                animation.phases[index].as_slice(),
                                index,
                                elapsed_on_page % duration,
                                duration,
                            )
                        } else {
                            (&[][..], 0, 0, 1)
                        };
                    let moving = commands.iter().chain(phase).any(|command| {
                        matches!(
                            command,
                            Primitive::Motion(..)
                                | Primitive::OccludedMotion(..)
                                | Primitive::ViewportMotion(..)
                                | Primitive::Frames(..)
                                | Primitive::MotionFrames(..)
                        )
                    }) || page.marquee.as_ref().is_some_and(display::marquee_scrolls);
                    let tick = moving.then_some((elapsed_on_page / 17) as usize);
                    if moving {
                        interval = 17 - elapsed_on_page % 17;
                    }
                    let frame = (index, phase_index, tick);
                    let full = last_frame.is_none_or(|(previous, previous_phase, _)| {
                        previous != index || previous_phase != phase_index
                    });
                    if last_frame != Some(frame)
                        || (page.clock.is_some() && clock_changed)
                        || (page.progress.is_some() && progress_changed)
                    {
                        let draw_started = Instant::now();
                        let marquee = page.marquee.as_ref().map(|line| {
                            (line, (marquee_offset + visible_time).saturating_sub(600))
                        });
                        display
                            .show_graphics(
                                commands,
                                phase,
                                time,
                                duration,
                                marquee,
                                page.clock
                                    .as_ref()
                                    .map(|layout| (layout, clock_text, clock_changed)),
                                page.progress.as_ref().map(|bar| (bar, filled, progress_changed)),
                                full,
                            )
                            .expect("OLED graphics page");
                        let draw_micros = draw_started.elapsed().as_micros();
                        if last_frame.is_none_or(|(previous, _, _)| previous != index) {
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
                        last_progress = Some(filled);
                    }
                } else if matches!(page.mode, Mode::Air) {
                    let frame = (index, 0, None);
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
                    let frame = (index, 0, Some(shift));
                    if last_frame != Some(frame) || clock_changed || (page.progress.is_some() && progress_changed) {
                        if last_frame.is_none_or(|(previous, _, _)| previous != index) {
                            println!(
                                "Showing {} / {} ({})",
                                page.mode.label(),
                                page.title,
                                page.state.label()
                            );
                        }
                        display
                            .show_page(page, shift, clock_text, filled)
                            .expect("OLED board page");
                        last_frame = Some(frame);
                        last_progress = Some(filled);
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
async fn button_task(mut button: Input<'static>) {
    let debounce = Duration::from_millis(25);
    loop {
        button.wait_for_low().await;
        Timer::after(debounce).await;
        if button.is_high() {
            continue;
        }
        button.wait_for_high().await;
        Timer::after(debounce).await;
        if button.is_high() {
            // Holding past the threshold skips a section without waiting for release.
            let press = match with_timeout(LONG_PRESS, button.wait_for_low()).await {
                Ok(()) => Press::Short,
                Err(_) => Press::Long,
            };
            BUTTON_PRESS.signal(press);
        }
    }
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
