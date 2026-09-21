# velxio-cli

Run [Velxio](https://velxio.dev) simulations from a terminal or a CI job.
The CLI sends your circuit, firmware and test scenario to Velxio's runners,
streams the serial output back, executes the scenario on the simulated
clock and exits pass/fail. Minutes are billed by simulated time.

It reads `velxio.toml` + `diagram.json` / `.vlx`, and also Wokwi's
`wokwi.toml` + `diagram.json` + scenario YAML, so a Wokwi CI job migrates by
changing one line. No Wokwi code is used: the formats are read by our own
parsers.

## Quick start

```sh
curl -fsSL https://velxio.dev/ci/install.sh | sh        # Linux, macOS
irm https://velxio.dev/ci/install.ps1 | iex             # Windows (PowerShell)

velxio-cli login                     # opens a browser; you approve, it stores the token
velxio-cli init --board arduino-uno  # writes velxio.toml + diagram.json
# build your firmware, point [velxio] firmware at it, then:
velxio-cli --expect-text "READY" --timeout 5000 .
```

You never copy a token for your own machine: `login` asks the server for a
code, opens the approval page and stores what it is handed. A CI job is the
one place that still carries a secret; `velxio-cli login --ci` mints it.

A run looks like this:

```
velxio-cli 0.2.1 · plan pro · 1838.5 of 2000 min left (resets 2026-10-01)
project blink (arduino-uno, 3 parts) · firmware build/blink.hex (Intel HEX, 2.1 KB)
run r_9f3c2a1b7e4d queued (position 0) · budget 5.0 s simulated
Hello from Velxio
READY
ok   wait-serial "READY" at 0.412 s
PASS in 0.41 s simulated (1.2 s wall) · billed 1 s · https://velxio.dev/account/ci#r_9f3c2a1b7e4d · exit 0
```

Serial bytes go to stdout untouched; status lines go to stderr. `--json`
prints one object per line instead; `-q` keeps only serial and errors.

## Commands

| command | what it does |
|---|---|
| `velxio-cli [run] [dir]` | run the project in `dir` (default `.`) |
| `velxio-cli lint [dir]` | local checks only: config, circuit, board, scenario, firmware. No network, no token |
| `velxio-cli init [--board kind]` | write a `velxio.toml` and a `diagram.json` with one board |
| `velxio-cli login` | sign in through the browser and store the token in `$XDG_CONFIG_HOME/velxio/credentials` (env and `--token` win) |
| `velxio-cli login --ci --name <repo>` | mint a CI token the same way and print it once, for a repository secret |
| `velxio-cli whoami` | plan, minutes used and left, limits |
| `velxio-cli boards` | supported boards, their Wokwi types, firmware formats and status (`--offline` for the built-in list) |
| `velxio-cli version` | print the version |

### `run` flags

Names match wokwi-cli's so a migrating job changes one line.

| flag | meaning |
|---|---|
| `--firmware <file>` | `.hex`, `.bin`, `.uf2`, a merged ESP32 image, or ESP-IDF `flasher_args.json` |
| `--elf <file>` | ELF to convert (AVR, RP2040/RP2350, XIAO ARM; ESP32 ELF arrives in phase 3) |
| `--diagram-file <file>` | Wokwi-format circuit (default `diagram.json`) |
| `--project-file <file>` | Velxio `.vlx` project (wins over the diagram) |
| `--scenario <yaml>` | scenario file (see [docs/scenarios.md](docs/scenarios.md)) |
| `--expect-text <s>` | pass when this text appears on serial (a final `wait-serial`) |
| `--fail-text <s>` | fail as soon as this text appears on any board's serial |
| `--timeout <ms>` | simulated-time budget, default 30000 |
| `--timeout-exit-code <n>` | exit code when the budget is reached, default 42 (`0` = "run N seconds and collect serial") |
| `--interactive` | forward stdin to the primary board's serial |
| `--serial-log-file <file>` | the serial bytes the server relays, as printed on stdout. The relay stops at 4 MiB per run (`serial_truncated`), and the log stops with it; matching in the runner continues |
| `--screenshot-part <id>`, `--screenshot-time <ms>`, `--screenshot-file <f>` | one screenshot of a part at a simulated time (default `screenshot.png`) |
| `--screenshot-tolerance <pct>` | `compare-with` tolerance, default 0.5 |
| `--json`, `-q` | NDJSON output; quiet |
| `--token`, `--server` | token (else `VELXIO_CLI_TOKEN` / `VELXIO_CI_TOKEN` / `login`); server (default `https://velxio.dev`, else `VELXIO_CLI_SERVER`) |
| `--allow-unsupported` | turn degradable `feature_unsupported` rejections into warnings |

Relative paths in flags and in the toml resolve against the project directory.

## Signing in

```sh
velxio-cli login                      # this machine: browser, approve, stored
velxio-cli login --ci --name acme/blinker   # a CI secret, printed once
velxio-cli login --server https://velxio.example.com      # a self-hosted server
```

`login` posts to `/api/pro/ci/auth/device`, prints the user code and the
approval URL, opens your browser at it and polls
`/api/pro/ci/auth/token` until you approve (or deny, or the code expires
after 10 minutes). Ctrl-C cancels and leaves nothing behind. The token it is
handed is an ordinary `vlxci_` token: it shows up in the list at
`/account/ci`, and you can revoke it there.

| flag | meaning |
|---|---|
| `--ci` | mint the token for a CI job: the CLI PRINTS it (once) instead of storing it, with the `export` line and the GitHub-secret snippet |
| `--name <name>` | the label the CI token carries, usually the repository (with `--ci`) |
| `--no-browser` | never launch a browser; print the URL and wait. The approval can happen on any machine |
| `--token <vlxci_...>` | skip the flow and store a token you already have. With stdin not a terminal, a token piped in is read the same way (`echo $TOK \| velxio-cli login`) |
| `--server <url>` | which server to sign in to; an explicit `--server` is remembered in the credentials file |

The credentials file is `$XDG_CONFIG_HOME/velxio/credentials`
(`%APPDATA%\velxio\credentials` on Windows), written 0600 through a fresh
file and a rename. `VELXIO_CLI_TOKEN` / `VELXIO_CI_TOKEN` and `--token`
always win over it, so a CI job never reads it.

A machine with no browser and no way to approve anything (an old build box,
a container) can still be fed a token by hand:

```sh
velxio-cli login --token vlxci_...          # or: pbpaste | velxio-cli login
```

### CI

A job cannot open a browser, so it needs one secret. Mint it from any
machine that can:

```sh
velxio-cli login --ci --name acme/blinker
```

It prints the token once, together with

```sh
gh secret set VELXIO_CLI_TOKEN --body 'vlxci_...'
```

and the workflow lines that read it. Nothing on the CI runner ever calls
`login`; the runner just sets `VELXIO_CLI_TOKEN`.

## Config resolution

`velxio.toml` > `wokwi.toml` > exactly one `*.vlx` in the directory > exit 2.
See [docs/velxio-toml.md](docs/velxio-toml.md) for the keys and
[docs/migrating-from-wokwi.md](docs/migrating-from-wokwi.md) for the Wokwi
side.

## Firmware

The CLI converts what you have into what the board's engine loads:

| board family | accepted | sent as |
|---|---|---|
| AVR (`arduino-uno`, `arduino-nano`, `arduino-mega`, `attiny85`) | `.hex`, `.elf` | Intel HEX |
| RP2040 (`raspberry-pi-pico`, `pi-pico-w`) | `.uf2`, `.bin`, `.elf` | flash image |
| ESP32 family (`esp32`, `esp32-s3`, `esp32-c3`, `esp32-c6`) | merged image, `flasher_args.json`, `app.bin` with its bootloader/partition siblings | merged flash image |

`velxio-cli boards` prints the live list, including the boards that are
planned for a later phase (they fail lint with `board_not_supported_in_ci`
and the phase). A bare ESP32 `app.bin` without siblings is refused with the
`esptool.py merge_bin` hint. The converted image is held to the same 16 MiB
per-board cap as the input.

## Exit codes

`0` pass · `1` fail · `2` config/lint error or rejected before billing ·
`3` auth · `4` quota or concurrency · `5` server/runner · `42`
(`--timeout-exit-code`) budget reached · `130` Ctrl-C. Details in
[docs/exit-codes.md](docs/exit-codes.md).

## Wokwi CI migration

```diff
-      - uses: wokwi/wokwi-ci-action@v1
+      - uses: velxio/velxio-ci-action@v1
         with:
-          token: ${{ secrets.WOKWI_CLI_TOKEN }}
+          token: ${{ secrets.VELXIO_CLI_TOKEN }}
           path: /
           timeout: 10000
           expect_text: 'Hello, World!'
```

Your `wokwi.toml`, `diagram.json` and scenario files stay as they are. The
CLI warns about `gdbServerPort`, `rfc2217ServerPort`, `vcdFile` and
`[[net.forward]]` (not supported) and refuses custom chips until phase 3
(`.wasm` chips never load; Velxio compiles the `.chip.c` source). See [docs/migrating-from-wokwi.md](docs/migrating-from-wokwi.md).

## Development

```sh
bun install
bun test
bun run tsc --noEmit
bun build --compile --target=bun-linux-x64 ./src/cli.ts --outfile dist/velxio-cli
```

The board list `lint` checks against is `src/capabilities/snapshot.json`, a
copy of the server's `GET /api/pro/ci/capabilities`:

```sh
bun run snapshot                      # from https://velxio.dev
bun run snapshot https://velxio.example.com/api/pro/ci/capabilities   # another server
```

A board kind the snapshot does not list is an error while the snapshot is
younger than 30 days; after that the CLI sends it with its firmware
unconverted and the server decides.

Releases: push a `v*` tag; `.github/workflows/release.yml` builds
Linux/macOS/Windows binaries with `bun build --compile`, zips them as
`velxio-cli_v<ver>_<OS>_<arch>.zip`, writes `SHA256SUMS` and attaches
everything to the GitHub release. `install.sh` / `install.ps1` download and
verify exactly those assets.

## License

MIT. Copyright (c) 2026 Velxio.
