# Waypoint display terminal

The Rust firmware renders compact JSON scenes from a read-only HTTPS endpoint. API Gateway checks a shared bearer credential before invoking the scene Lambda. The device uses its saved ESP-IDF Wi-Fi settings, obtains an IPv4 lease, synchronizes time, and verifies the API hostname, certificate chain, and certificate validity dates against Amazon Root CA 1.

The live firmware polls `GET /v1/devices/waypoint/display?view=live`. It uses the bitmap font from the stock v12.14 image for four compact rows with a mode, heading, collection time and feed status. It rotates through bus, rail, air, space and energy pages with 60 seconds per regular page and scrolls long destinations locally. Air shows the nearest aircraft for 30 seconds and leaves the regular slot blank when the feed reports none nearby. The board keeps displaying the last response in RAM during a network outage and reuses the returned ETag.

The AWS collector runs every minute through EventBridge Scheduler. It merges departures from the two saved St Andrew's Walk stops, reads the saved Partick, Inverness and Golspie rail boards with the next train’s calling stops on a single scrolling line and Darwin statuses, queries ADS-B for aircraft near the saved observer, and predicts upcoming satellite passes from cached orbital elements. Space plays up to five 30-second previews for the next 24 hours, showing the predicted rise time, compass directions and peak elevation. Each animation traces one predicted revolution around a small illustrated Earth, with the planet masking the spacecraft on the far side. The right-hand look-down map shows the ground track during the local pass, using [Natural Earth country boundaries](https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-boundary-lines/) and coastlines. The rest of the screen shows orbital inclination, pass altitude, and directions at rise and set. The globe and orbit distances are scaled for the display. The collector marks failed feeds stale when it has a previous snapshot. It marks them offline when it has no prior data. The `/waypoint-terminal/prod/feed-settings` and `/waypoint-terminal/prod/rail-api-key` SecureStrings store the imported settings and existing rail credential on AWS.

When the stage's `octopus-api-key` SecureString is configured, the collector adds the current Octopus electricity unit rate, daily standing charge, and today and yesterday usage charts, and live net power when smart-meter telemetry is available. Daily totals show kWh and estimate VAT-inclusive spend for the available completed half-hour readings, with the standing charge shown separately. The chart uses two-hour London-time blocks. The collector polls live power every minute and refreshes daily totals every five minutes or when a rate expires.

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

## Build and test the firmware

Install the original ESP32 target with [espup](https://github.com/esp-rs/espup) and source its environment file. CMake and Ninja must be available on PATH for the TLS library's certificate time support.

```sh
cargo +esp build --release --locked
espflash save-image --chip esp32 --flash-mode dio --flash-size 4mb --flash-freq 40mhz \
  target/xtensa-esp32-none-elf/release/waypoint-bringup target/waypoint-live-board.bin
```

The Waypoint OLED uses GPIO18 for clock, GPIO5 for MOSI, GPIO4 for data/command, GPIO16 for chip select, and GPIO17 for panel reset. The renderer rotates the frame for the installed panel. On boot, look for `Live board updated` and the mode transitions over UART0. The stock firmware is in the other application slot on the development board.
