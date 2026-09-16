# Scenarios

A scenario is a YAML file with the steps the runner executes on the
simulated clock of the primary board. The field names are Wokwi's, so an
existing Wokwi scenario runs unchanged.

```yaml
name: button test
version: 1
author: you
steps:
  - wait-serial: "READY"
  - set-control:
      part-id: btn1
      control: pressed
      value: 1
  - delay: 50ms
  - set-control:
      part-id: btn1
      control: pressed
      value: 0
  - wait-serial: "pressed"
  - expect-pin:
      part-id: led1
      pin: A
      value: 1
  - write-serial: "hi\n"
  - wait-serial: "hi"
  - take-screenshot:
      part-id: oled1
      save-to: shots/oled.png
      compare-with: golden/oled.png
```

## Steps

| step | fields | semantics |
|---|---|---|
| `delay: <n>ms\|<n>s\|<n>us` | duration with units (a bare number is ms) | wait until the simulated clock reaches `t0 + n` |
| `wait-serial: <text>` | string, at most 512 bytes | substring match over serial received since the previous `wait-serial`; byte-exact; if the budget elapses first the run ends `timeout` |
| `write-serial: <string> \| [bytes]` | UTF-8 string or a list of 0..255 | bytes to the primary board's UART |
| `expect-pin: {part-id, pin, value}` | `value` (or `expected`): `0`/`1`, `high`/`low`, `true`/`false` | read once, immediately; a mismatch ends the run `failed` with the actual level; an unconnected pin is `pin_not_connected` |
| `set-control: {part-id, control, value}` | number, string or boolean | `pressed` on a button presses/releases; other controls are the part's sensor controls or attributes; unknown controls fail the run listing the known ones |
| `take-screenshot: {part-id, save-to?, compare-with?, tolerance?}` | at least one of the two paths | PNG of the part; `compare-with` is uploaded and compared in the runner; a mismatch above the tolerance (default `--screenshot-tolerance`, 0.5 %) ends the run `failed` and writes `<name>.diff.png` |
| `touch`, `touch-press`, `touch-move`, `touch-release` | | arrive in phase 3; rejected until then |

Every step may carry a `name:` for readability. Limits: 200 steps, 20
screenshots. `--expect-text X` appends a final `wait-serial X`;
`--fail-text Y` watches every serial chunk of every board for the whole run;
`--screenshot-part P --screenshot-time T` becomes `delay T` +
`take-screenshot P`.

Paths in `save-to` and `compare-with` resolve against the project directory
(then the scenario's directory).

## Interactive input

`--interactive` forwards stdin to the primary board's serial, coalesced
every 20 ms. It combines with a scenario: both sources write to the same
UART in arrival order. Closing stdin ends the input, not the run.
