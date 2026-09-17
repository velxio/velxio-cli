# Exit codes

Stable; scripts may rely on them.

| code | meaning |
|---|---|
| `0` | passed: `--expect-text` matched, the scenario completed, or (only screenshots requested) the last screenshot was taken |
| `1` | failed: `--fail-text` seen, `expect-pin` mismatch, a step failed, `compare-with` mismatch, or the guest crashed |
| `2` | usage, config or lint error, or the server rejected the run before billing (unknown board, unsupported board/part/feature, bad firmware, too large, bad scenario) |
| `3` | auth: token missing, malformed, unknown, revoked or expired; a `login` denied in the browser (`access_denied`), whose code expired (`expired_token`) or whose account has no CI entitlement (`pro_required`); plan not entitled to CI or subscription period lapsed. When the server refuses the WebSocket upgrade itself (an HTTP error instead of a close code), the CLI asks `GET /api/pro/ci/whoami` with the same token to tell auth (exit 3) from a disabled CI, a rate limit or an unreachable server (exit 5) |
| `4` | quota: CI minutes exhausted this month (the message carries `resets_at`), or the plan's concurrency limit |
| `5` | server or runner: rate limited, CI disabled, no runner within 120 s, runner lost, engine stalled, wall-clock cap, renderer crash, network drop. Billed only for the simulated time that elapsed |
| `--timeout-exit-code` (default `42`) | the simulated-time budget was reached. Use `--timeout-exit-code 0` for "run N seconds and collect serial" |
| `130` | Ctrl-C: the CLI sends `run.cancel`, waits up to 5 s for the final report, exits. During `login` it stops polling and stores nothing; the pending code is simply left to expire. Without a report in time it prints the run id and URL; the server finalises the run |

## Server reject codes

Exit 2: `unknown_board_type`, `board_not_supported_in_ci`,
`board_not_launched`, `unsupported_part`, `firmware_format_mismatch`,
`firmware_too_large`, `bundle_too_large`, `blob_missing`,
`blob_sha_mismatch`, `scenario_invalid`, `scenario_part_missing`,
`feature_unsupported`, `no_sim_clock`, `too_many_parts`, `bad_request`.

Exit 4: `quota_exhausted`, `concurrency`.

Exit 5: `rate_limited`, `ci_disabled`, `server_error`.

## Run results

The final line names the status and reason, for example `FAIL (fail_text)`,
`TIMEOUT`, `ERROR (engine_stalled)`, `LOST (heartbeat)`, `CANCELLED (user)`.
With `--json` the last object is `{"t": "end", "status": ..., "reason":
..., "exit_code": ...}`.
