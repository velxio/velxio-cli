# velxio.toml

The project file the CLI (and the Velxio VS Code extension) read. Every path
is relative to this file; forward slashes work on every OS.

```toml
[velxio]
version = 1                       # required
board = "esp32-s3"                # Velxio board kind; optional when the diagram/.vlx names the board
firmware = "build/app.bin"        # .hex | .elf | .uf2 | .bin | merged ESP32 image
flasher_args = "build/flasher_args.json"   # ESP-IDF alternative to firmware (mutually exclusive)
elf = "build/app.elf"             # optional; converted when firmware is absent (AVR, RP2, XIAO)
diagram = "diagram.json"          # Wokwi-format circuit (default when present)
project = "circuit.vlx"           # Velxio project; wins over diagram
scenario = "test.yaml"            # default scenario (the --scenario flag overrides)
language = "arduino"              # arduino; "micropython" is refused (exit 2) until phase 4

[[chip]]                          # refused (exit 2, feature_unsupported) until phase 3
name = "inverter"
source = "chips/inverter.chip.c"  # compiled server-side; .wasm binaries are refused
```

Nothing is ignored in silence: a key the CLI does not know is a warning, and
a feature that arrives in a later phase (`language = "micropython"`,
`[[chip]]`) fails with `feature_unsupported` instead of running a different
project than the one you wrote.

## Resolution order

- Config file: `velxio.toml` > `wokwi.toml` > exactly one `*.vlx` in the
  directory > exit 2.
- Circuit: `--project-file` > `[velxio] project` > `--diagram-file` >
  `[velxio] diagram` > `diagram.json` next to the toml.
- Firmware: `--firmware` > `--elf` > `[velxio] firmware` | `flasher_args` >
  `[velxio] elf` > `[wokwi] firmware` > `[wokwi] elf`.
- Board: `[velxio] board` > the board part of the diagram (or the active
  board of the `.vlx`). When both exist they must agree.

## diagram.json

Wokwi's format, read as-is: `version: 1`, `parts[{id, type, left, top,
attrs, rotate, hide}]`, `connections[[from, to, color, path]]`. Board
part types come from `velxio-cli boards`; any Velxio board also works as
`board-velxio-<kind>`. Parts are the `wokwi-*` elements (`wokwi-led`,
`wokwi-pushbutton`, `wokwi-dht22`, ...) and `chip-<name>` for custom chips.

Unknown part types are a warning (the server decides). Board types Velxio
has no simulation for, and boards planned for a later phase, fail with
`board_not_supported_in_ci`, naming the type and the phase. A board kind
this CLI build does not know is an error while its board list is younger
than 30 days, and a "the server decides" warning after that.

## .vlx

A Velxio project export (`format: "velxio-project"`, `version: 1`). The CLI
validates the envelope and sends it verbatim; the active board is the
primary one.

## Local lint

`velxio-cli lint` (also run before every `run`) checks: the toml parses and
has `version = 1`; every referenced file exists and is under the caps
(firmware 16 MiB, diagram/.vlx 2 MiB, scenario 256 KB, compare-with PNGs
2 MiB); the diagram has unique part ids and connections that name existing
parts; the board is one this build can run; the firmware format is
detectable and matches the board family; scenario steps are known, have
their fields, name existing parts and parse their durations.
