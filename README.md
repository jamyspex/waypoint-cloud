# Waypoint display terminal

The Rust firmware renders compact JSON scenes from a read-only HTTPS endpoint. API Gateway checks a shared bearer credential before invoking the scene Lambda. The device uses its saved ESP-IDF Wi-Fi settings, obtains an IPv4 lease, synchronizes time, and verifies the API hostname, certificate chain, and certificate validity dates against Amazon Root CA 1.

The firmware fetches the rotation index from `GET /v1/devices/waypoint/display?view=index`. It then requests each screen as `?view=screen&screen=<id>`. Each response carries one screen and can use up to 8 KiB. The board prefetches the next screen and keeps displaying the current one if the fetch fails. The `?view=live` snapshot remains available for older firmware.

Press the side button (GPIO13, active high, debounced) to advance to the next screen in the rotation. If the next screen has not been prefetched yet, the display shows a loading card with the next screen's title (for example `MOON / LOADING...`) until it arrives, or the API error if the fetch fails. It falls back to the current screen after 30 seconds. Presses are ignored while a skip is loading. Hold the button for 0.6 seconds to skip the rest of the current section. For example, a long press on `RAIL: PARTICK` skips the other rail boards and jumps to the next screen of a different type. The loading card names that screen.

The display uses the bitmap font from the stock v12.14 image and rotates through bus, rail, air, space and energy. Regular screens last 60 seconds. Individual aircraft, satellite passes and electricity summaries each get 30 seconds. Air shows airborne aircraft within 10 nautical miles, and military aircraft within 50 nautical miles. Each gets a card with a side-profile drawing, altitude, ground speed and range. Waypoint polls [adsb.fi](https://adsb.fi/) every minute for personal use. If that request fails, [adsb.lol](https://www.adsb.lol/) is available as a fallback with a shared four-minute cooldown. The rotation skips Air when the feed reports no nearby aircraft. Airline and airport details come from the [adsbdb callsign lookup](https://github.com/FugginOld/adsb-db#api). adsbdb keeps stale routes for reused callsigns, so the card drops a route when the aircraft's position is well outside the corridor between the listed airports. For example, Loganair LOG78LC was listed as Manchester to Newquay while flying Stornoway to Inverness. The card then shows `ROUTE UNAVAILABLE`.

Clock labels use the board's locally maintained, NTP-synchronised clock and follow London summer time. Departure, meeting and meter reading timestamps come from their feeds.

The AWS collector runs every minute through EventBridge Scheduler. It merges departures from the two saved St Andrew's Walk stops (drawn from AWS with a fixed route column so destinations line up), reads the saved Partick, Inverness and Golspie rail boards with the next train’s calling stops on a single scrolling line and Darwin statuses, queries ADS-B for aircraft near the saved observer, and predicts upcoming satellite passes from cached orbital elements. Space shows satellites whose estimated current ground tracks are within 20 statute miles of the saved location. The ISS stays in the rotation wherever it is and gets a 30-second live track. Nearby satellites appear only while in range when the rotation reaches Space. Those tracks end when the satellite leaves the radius. The globe masks the spacecraft on the far side. A second satellite marker follows the local ground track across the right-hand look-down map, using [Natural Earth 1:50m land polygons](https://www.naturalearthdata.com/downloads/50m-physical-vectors/50m-land/) to draw a smoothed coastline. The ISS card shows the approximate country, sea, or ocean below its starting ground position using [Natural Earth](https://www.naturalearthdata.com/downloads/) regions. Space cards also show altitude. The globe and orbit distances are scaled for the display. The collector marks failed feeds stale when it has a previous snapshot. It marks them offline when it has no prior data. The `/waypoint-terminal/prod/feed-settings` and `/waypoint-terminal/prod/rail-api-key` SecureStrings store the imported settings and existing rail credential on AWS.

When the stage's `octopus-api-key` SecureString is configured, the collector adds the current Octopus electricity unit rate, daily standing charge, and today, yesterday, this week and last week usage charts, and live net power when smart-meter telemetry is available. Daily totals show kWh and estimate VAT-inclusive spend for the available completed half-hour readings, with the standing charge shown separately. Daily charts use two-hour London-time blocks. Weekly charts cover Monday to Sunday. Each electricity view gets 30 seconds and displays the lightning bolt. The collector polls live power every minute and refreshes daily totals every five minutes or when a rate expires.

The Moray Firth and Cromarty Firth each have a marine card. The collector polls [Open Waters AIS](https://openwaters.io/ais/) every minute and plots vessel reports from the preceding 30 minutes. The chart keeps all vessel positions visible while the left panel cycles through one vessel at a time for 15 seconds each, with a ring around that vessel on the chart. On crowded charts, the vessels shown in detail rotate across snapshots. The Moray chart includes Fortrose and the Black Isle and runs south past the Kessock Bridge to Inverness harbour. At this scale the 1:10m coastline closes just north of the harbour, so vessels berthed there plot on the shore edge. The cards divide vessel reports along an approximate line along the peninsula, with Cromarty Firth contacts assigned to the zoomed-in card. Positions use the feed's last reported coordinates. The charts use [Natural Earth 1:10m land polygons](https://www.naturalearthdata.com/downloads/10m-physical-vectors/), and AIS sources include [AISHub](https://www.aishub.net/) and [AISStream](https://aisstream.io/).

Vessel details show the AIS ship class and the reported destination or route. The panel shows a reported origin when present. Otherwise, `LAST PORT` is inferred from recent AIS fixes near ports in a regional extract of the [NGA World Port Index](https://msi.nga.mil/Publications/WPI). Missing fields are shown as unknown.

Three sky screens follow the marine cards, each for 20 seconds with a live clock:

- **Tides** plots 24 hours of sea level, from 4 hours ago to 20 hours ahead, with high and low water times and a marker for now. The left panel shows whether the tide is rising or falling, the next high or low water, and the time until it. Sea levels come from the [Open-Meteo Marine API](https://open-meteo.com/en/docs/marine-weather-api) at 15-minute resolution. They are modelled, not official tide tables. The collector merges small wobbles near low water into one turning point. The series is cached in Lambda memory and in `feeds/tides.json` in the scene bucket. It refreshes every 6 hours and is reused while stale for as long as it covers the next 20 hours.
- **Sun** draws today's solar path in London time, scaled so the arc fills the panel, with sunrise, sunset, solar noon, daylight length and civil dusk.
- **Moon** draws the current phase with the percentage illuminated, the next full and new moon, and the next moonrise and moonset. Full moons use their traditional names. The Harvest Moon is the full moon nearest the September equinox, the Hunter's Moon follows it, and a second full moon in a calendar month is a Blue Moon. Within a day and a half of a full moon the card names it.

- **Weather** leads the sky screens with an icon for the current conditions, the temperature, feels-like temperature and wind, and a 12-hour chart of rain chance (bars, brighter when at least 0.5 mm is expected) and temperature (line). It uses the [Open-Meteo forecast API](https://open-meteo.com/en/docs) for the `space` coordinates and refreshes every 15 minutes.

A **Highland freight** screen follows the rail boards whenever freight is moving at Inverness, on the Far North line or on the Kyle line, including trains approaching from Aviemore. Each train gets its own 20-second card, up to six. The card shows the operator and headcode, where the train is now in large type, the arrival or departure time, and its lateness. A scrolling line gives where it set off from, its usual destination, the next reporting point and its earlier sightings. The footer shows which line it is on. The data comes from the Rail Data Marketplace **NWR Train Movements** Kafka topic (`TRAIN_MVT_ALL_TOC`). A Lambda self-managed Kafka trigger reads it with the login in the `waypoint-terminal/prod/rdm-train-movements` Secrets Manager secret and RDM's fixed consumer group, and hands batches to the `FreightMovements` Lambda. That Lambda keeps the latest position and origin of every freight train in Britain in `feeds/freight-trains.json`. Location and origin names come from Network Rail CORPUS reference data (`cloud/src/freight-locations.ts` and `cloud/src/stanox-names.ts`), and operator names from TRUST sector codes. Movement reports do not include destinations, so the Lambda learns them. Each time a freight train terminates, it counts that terminus in the `FreightRoutes` DynamoDB table against the headcode and origin, and against the headcode alone. New trains then show their most frequent terminus. Routes expire after 60 days without a run. Booked destinations and times need the NWR Schedule file, and the London `RailFiles` bucket and its upload user are kept for RDM's S3 file transfer once its destination validation works.

Two grid screens follow the electricity screens. They use the [National Grid ESO Carbon Intensity API](https://carbonintensity.org.uk/) and refresh every 15 minutes:

- **Grid carbon** shows GB carbon intensity now and a 24-hour half-hourly forecast, with the greenest two-hour window highlighted and named.
- **N Scotland mix** shows the North Scotland region's generation mix as a ring chart, with its carbon intensity in the middle, plus icons, share bars and percentages for the main sources.

When [AuroraWatch UK](https://aurorawatch.lancs.ac.uk/) reports a yellow, amber or red alert, an aurora card goes to the front of the rotation. It shows the alert level, what it means for Scotland, whether the sky is dark yet, and the last 24 hours of magnetic activity against the alert thresholds. The collector polls AuroraWatch UK at most every five minutes.

Sun positions, rise and set times use [SunCalc](https://github.com/mourner/suncalc). Full and new moon times use Meeus, *Astronomical Algorithms*, chapter 49, to within a few minutes. The sky screens use the `space` coordinates from the feed settings. To read tides from a coastal point instead, add `"tide": {"lat": 57.68, "lon": -4.03, "label": "CROMARTY"}` to `/waypoint-terminal/prod/feed-settings`.

Each live page can also supply up to 32 drawing commands for the 256×64 display. The collector defines the energy layouts and bolt artwork in `cloud/src/graphics.ts`. Commands are drawn in order and use grayscale levels from 0 to 15. The supported tuples are `[x, y, width, height, shade]` for filled rectangles, `[x, y, scale, shade, text]` for stock-font text, and `[x, y, scale, shade, bitmapRows]` for sprites up to 16×32 pixels. In each bitmap row, bit zero is the leftmost pixel. An empty command list clears the display. A page can also provide up to five timed animation phases. A moving sprite uses `[scale, shade, bitmapRows, path]` with up to 24 points, interpolated over its phase. A page can supply a single-line marquee with its viewport, speed and text. A long line continues on the next visit to its page. Packed bitmaps use hexadecimal, low-bit-first rows. Depth-masked sprites carry packed x, y and depth samples plus the circle that obscures the far side. Artwork, motion and timing come from AWS.

## Publish a scene

Edit [cloud/scenes/waypoint.json](cloud/scenes/waypoint.json), then upload it to the private scene bucket using the Linespeed deployment profile.

```sh
cd cloud
AWS_PROFILE=linespeed-root-admin aws s3 cp scenes/waypoint.json \
  s3://waypoint-terminal-prod-scenesbucket-bcsecdaa/scenes/waypoint.json \
  --content-type application/json
```

The API accepts version 1. Use 1–16 printable ASCII characters for the title, 1–128 for the message, and choose `scroll`, `blink`, or `none` for the animation. Set `speed` to an integer between 8 and 80. It sets pixels per second for scrolling. Static and blinking scenes display as much of the message as fits across the screen.

This updates the original static scene at the base display route. The live board uses the collector's separate snapshot. Uploading the source JSON requires AWS permissions. Reading either view requires the shared device credential.

## Deploy on AWS

```sh
cd cloud
npm ci
npm run check
AWS_PROFILE=linespeed-root-admin npm run deploy
```

The SST v4 app uses an HTTP API, three TypeScript Lambdas, EventBridge Scheduler and a private S3 bucket in `eu-west-1`. The scene Lambda reads the static scene and live snapshot. The authorizer reads the credential from the `/waypoint-terminal/prod/device-token` SecureString in AWS Systems Manager Parameter Store. API Gateway caches authorization results for 30 seconds.

For a fresh deployment, provision a 32-byte random credential as 64 lowercase hex characters in the stage's SecureString, publish the initial scene to the output bucket, and set the API hostname in `src/cloud.rs`. Provision the same raw 32 bytes on the board at flash offset `0x1ff000`, following the eight-byte `WYPTTOK1` marker. Use a separate sector image padded to 4 KiB with `0xff`. Keep application images below the reserved sector. Use USB to provision the credential or rotate it, and use the application image alone for regular firmware updates.

## Preview the live board in a browser

Run `npm run emulate` from `cloud` and open <http://localhost:4280>. The emulator loads individual screens from AWS and renders them with the stock font at 256×64. Pause the rotation, select a screen, or refresh the active screen to see cloud-only changes. It uses the `linespeed-root-admin` AWS CLI profile by default. The local server reads the device credential from SSM and keeps it outside the browser.

Links under the title switch between the live board and saved demos of cards that are rarely live: the [aircraft demo](http://localhost:4280/demo/air) (one card for each aircraft drawing, from narrowbodies and the A380 to a tanker, fighter, light aircraft and helicopter), the [aurora alert demo](http://localhost:4280/demo/aurora) (an amber alert) and the [power mix demo](http://localhost:4280/demo/mix) (a mixed North Scotland generation day). The demos are saved boards in `cloud/emulator/*-demo.json`, served by the same emulator server. **‹ Prev** and **Next ›**, or the left and right arrow keys, step through the rotation like the device's side button.

## Connect Google Calendar

Enable the Google Calendar API in a Google Cloud project and create a Google OAuth **Web application** client. For accounts in different Google organisations, use **External** with the publishing status set to **In production**. Add `http://localhost:4281/oauth2callback` as an authorised redirect URI, then download the client JSON. External Calendar refresh tokens issued in Testing mode expire after seven days. [Google OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server) · [Token expiry](https://developers.google.com/identity/protocols/oauth2/#expiration)

From `cloud`, run a connection command and open <http://localhost:4281>. Select the correct Google account and grant read-only calendar access. Use a unique label for each account. The first connection needs the client file. Later connections use the client stored in AWS.

```sh
npm run calendar:connect -- Work --client /path/to/google-oauth-client.json
npm run calendar:connect -- Personal
npm run calendar:connect -- SideProject
```

Each connection reads that account's primary calendar by default. Add `--calendar <id>` one or more times when connecting an account to choose specific calendars. Running the command again with the same label updates that account. The connector stores the OAuth client and refresh tokens in encrypted SSM parameters under `/waypoint-terminal/prod/calendar/`. To disconnect an account, revoke access in Google and delete its parameter under `/waypoint-terminal/prod/calendar/accounts/`.

The upcoming meetings screen shows up to four timed events starting within the next 24 hours in London time. It deduplicates shared invitations and shows private or confidential meetings as `BUSY`. Other calendars keep updating if one account needs to reconnect.

The rotation includes a 60-second meeting notification when a meeting is about to start or is in progress. It shows an animated countdown during the final 15 minutes before the meeting and a progress bar once it starts. If meetings overlap, the next countdown takes priority on the notification screen so back-to-back meetings still get a reminder. The `/waypoint-terminal/prod/calendar/settings` SSM parameter accepts `{"showInProgress":true,"maxInProgressMinutes":60}`. Set `showInProgress` to `false` to turn off in-progress cards or set `maxInProgressMinutes` to `null` to allow any duration. The 15-minute countdown applies to meetings of any length.

## Build and test the firmware

Install the original ESP32 target with [espup](https://github.com/esp-rs/espup) and source its environment file. CMake and Ninja must be available on PATH for the TLS library's certificate time support.

```sh
cargo +esp build --release --locked
espflash save-image --chip esp32 --flash-mode dio --flash-size 4mb --flash-freq 40mhz \
  target/xtensa-esp32-none-elf/release/waypoint-bringup target/waypoint-live-board.bin
```

To flash from WSL, use the Windows esptool build because the board's USB serial port is only visible to Windows. Write the application image to the custom app slot at `0x10000`:

```sh
source .tools/export-esp.sh
cargo +esp build --release --offline --locked
.tools/espflash save-image --chip esp32 --flash-mode dio --flash-size 4mb --flash-freq 40mhz \
  target/xtensa-esp32-none-elf/release/waypoint-bringup target/waypoint-side-button.bin
.tools/windows/esptool/esptool-windows-amd64/esptool.exe --chip esp32 --port COM4 --baud 460800 \
  write-flash 0x10000 '\\wsl.localhost\Ubuntu\home\james\waypoint-rust\target\waypoint-side-button.bin'
```

The image must end below the credential sector at `0x1ff000`. The default stable toolchain cannot build the firmware, so always use `+esp`.

The Waypoint OLED uses GPIO18 for clock, GPIO5 for MOSI, GPIO4 for data/command, GPIO16 for chip select, and GPIO17 for panel reset. The renderer rotates the frame for the installed panel. On boot, look for `Live board updated` and the mode transitions over UART0. The stock firmware is in the other application slot on the development board.
