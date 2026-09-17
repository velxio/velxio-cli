# Migrating from Wokwi CI

Velxio CI reads the files a Wokwi CI project already has. Nothing from
wokwi-cli is used; the formats are parsed by our own code.

## GitHub Actions

```diff
-      - uses: wokwi/wokwi-ci-action@v1
+      - uses: velxio/velxio-ci-action@v1
         with:
-          token: ${{ secrets.WOKWI_CLI_TOKEN }}
+          token: ${{ secrets.VELXIO_CLI_TOKEN }}
           path: /
           timeout: 10000
           expect_text: 'Hello, World!'
           fail_text: 'Error'
           scenario: 'test.scenario.yaml'
```

The action inputs keep their names (`path`, `timeout`, `expect_text`,
`fail_text`, `scenario`, `serial_log_file`, `diagram_file`, `elf`). A job
cannot approve a browser sign-in, so it still carries one secret. Mint it
from your own machine with

```sh
velxio-cli login --ci --name acme/blinker
```

which prints the token once plus the `gh secret set VELXIO_CLI_TOKEN` line
(the token also appears, revocable, at https://velxio.dev/account/ci). On
your own machine you never handle a token at all: `velxio-cli login` opens
the browser and stores what it is given. Any other CI runs the binary
directly:

```yaml
      - run: curl -fsSL https://velxio.dev/ci/install.sh | sh
      - run: ~/.velxio/bin/velxio-cli run --timeout 10000 --expect-text 'Hello, World!' .
        env:
          VELXIO_CLI_TOKEN: ${{ secrets.VELXIO_CLI_TOKEN }}
```

## Command line

`wokwi-cli` flags exist under the same names: `--elf`, `--diagram-file`,
`--scenario`, `--expect-text`, `--fail-text`, `--timeout`,
`--timeout-exit-code`, `--interactive`, `--serial-log-file`,
`--screenshot-part`, `--screenshot-time`, `--screenshot-file`, `--quiet`.
`--timeout` is simulated milliseconds. `WOKWI_CLI_TOKEN` is never read; set
`VELXIO_CLI_TOKEN` (or `VELXIO_CI_TOKEN`).

## wokwi.toml

Read as-is:

```toml
[wokwi]
version = 1
firmware = "build/firmware.bin"   # used
elf = "build/firmware.elf"        # used when firmware is absent (AVR, RP2040, XIAO); ESP32 ELF in phase 3
gdbServerPort = 3333              # warning: not supported
rfc2217ServerPort = 4000          # warning: not supported
vcdFile = "trace.vcd"             # warning: not supported (phase 4)

[[net.forward]]                   # warning: not supported (no gateway in CI)
from = "localhost:8080"
to = "target:80"

[[chip]]                          # exit 2 until custom chips arrive (phase 3); then ship inverter.chip.c, .wasm never loads
name = "inverter"
binary = "chips/inverter.chip.wasm"
```

## diagram.json and boards

Wokwi element types map 1:1. Board types:

| Wokwi | Velxio kind |
|---|---|
| `wokwi-arduino-uno`, `-nano`, `-mega` | `arduino-uno`, `arduino-nano`, `arduino-mega` |
| `wokwi-attiny85` | `attiny85` |
| `wokwi-pi-pico`, `board-pi-pico` | `raspberry-pi-pico` |
| `board-pi-pico-w` | `pi-pico-w` (WiFi has no gateway in CI: warning) |
| `wokwi-esp32-devkit-v1`, `board-esp32-devkit-v1` | `esp32` |
| `board-esp32-s3-devkitc-1` | `esp32-s3` |
| `board-esp32-c3-devkitm-1` | `esp32-c3` |
| `board-esp32-c6-devkitc-1` | `esp32-c6` |
| `board-velxio-<kind>` | any Velxio board |

The other ESP32 devkits of Wokwi's templates (`board-esp32-devkit-c-v4`,
`board-esp32-cam`, `board-wemos-lolin32-lite`, the XIAO ESP32 boards,
`board-arduino-nano-esp32`, the C3 SuperMini, the P4 boards) are planned:
lint fails with `board_not_supported_in_ci` naming the type and the phase.
STM32 boards fail the same way until phase 4. Boards Velxio has no
simulation for (`board-pi-pico-2`, the Nucleos, ESP32-S2/H2,
`board-esp32-s3-box`, ...) fail too; a nearby Velxio kind is suggested only
when it runs today. `velxio-cli boards` prints the live list with each
board's status.

## Scenarios

Wokwi's scenario YAML runs unchanged (`delay`, `wait-serial`,
`write-serial`, `expect-pin`, `set-control`, `take-screenshot`). Touch
steps arrive in phase 3. All timing is simulated time. See
[scenarios.md](scenarios.md).

## Firmware

- Arduino ESP32 "Export compiled binary" folders work: the CLI merges
  `<sketch>.ino.bin` with `<sketch>.ino.bootloader.bin` and
  `<sketch>.ino.partitions.bin` (plus `boot_app0.bin` when present).
- PlatformIO `firmware.bin` + `bootloader.bin` + `partitions.bin` work the
  same way; ESP-IDF projects can point `flasher_args` at
  `build/flasher_args.json`.
- A lone `app.bin` is refused with the `esptool.py merge_bin` hint.
- Pico `.uf2` and `.elf` are flattened to a flash image; AVR `.elf` becomes
  Intel HEX.
- The bootloader's chip id must match the board (an ESP32-C3 image on an
  `esp32-s3` board is `firmware_format_mismatch`).

## Billing

Minutes are simulated time rounded up to whole seconds, per calendar month
(UTC). A stalled engine or a wall-clock cap costs you nothing beyond the
simulated seconds that elapsed.
