import { EXIT } from '../errors.ts';
import type { RunEnd } from './messages.ts';

/** `run.rejected.code` -> process exit code (PROTOCOL.md 1.3). */
const REJECT_EXIT: Record<string, number> = {
  unknown_board_type: EXIT.CONFIG,
  board_not_supported_in_ci: EXIT.CONFIG,
  board_not_launched: EXIT.CONFIG,
  unsupported_part: EXIT.CONFIG,
  firmware_format_mismatch: EXIT.CONFIG,
  firmware_too_large: EXIT.CONFIG,
  bundle_too_large: EXIT.CONFIG,
  blob_missing: EXIT.CONFIG,
  blob_sha_mismatch: EXIT.CONFIG,
  scenario_invalid: EXIT.CONFIG,
  scenario_part_missing: EXIT.CONFIG,
  feature_unsupported: EXIT.CONFIG,
  no_sim_clock: EXIT.CONFIG,
  too_many_parts: EXIT.CONFIG,
  bad_request: EXIT.CONFIG,
  quota_exhausted: EXIT.QUOTA,
  concurrency: EXIT.QUOTA,
  rate_limited: EXIT.SERVER,
  ci_disabled: EXIT.SERVER,
  server_error: EXIT.SERVER,
};

export function exitCodeForReject(code: string): number {
  return REJECT_EXIT[code] ?? EXIT.SERVER;
}

/** Close codes the API uses before `hello` (PROTOCOL.md 1.1). */
export function exitCodeForClose(code: number): number {
  switch (code) {
    case 4401:
    case 4402:
      return EXIT.AUTH;
    case 4429:
    case 4503:
    case 4400:
    case 1001:
    case 1006:
    case 1011:
    default:
      return EXIT.SERVER;
  }
}

export function describeClose(code: number, reason: string): string {
  const r = reason ? ` (${reason})` : '';
  switch (code) {
    case 4401:
      return `authentication failed: token missing, malformed, unknown, revoked or expired${r}`;
    case 4402:
      return `your plan does not include CI minutes, or the subscription period lapsed${r}`;
    case 4429:
      return `rate limited by the server${r}`;
    case 4503:
      return `CI is disabled on this server${r}`;
    case 4400:
      return `protocol error: the server closed the socket${r}`;
    case 1001:
      return `the server dropped the connection (missed pings)${r}`;
    case 1006:
      return `connection closed abnormally${r}`;
    case 1011:
      return `server error${r}`;
    default:
      return `connection closed with code ${code}${r}`;
  }
}

/**
 * The exit code a finished run gets. The server sends 42 for a timeout and
 * the CLI substitutes its own --timeout-exit-code; a cancel the user asked
 * for is 130 whatever the row says.
 */
export function exitCodeForEnd(end: Pick<RunEnd, 'status' | 'reason' | 'exit_code'>, opts: { timeoutExitCode: number; cancelledByUser: boolean }): number {
  if (end.status === 'timeout') return opts.timeoutExitCode;
  if (end.status === 'cancelled' && opts.cancelledByUser) return EXIT.INTERRUPT;
  switch (end.status) {
    case 'passed':
      return EXIT.PASS;
    case 'failed':
      return EXIT.FAIL;
    case 'cancelled':
      return end.reason === 'user' ? EXIT.INTERRUPT : EXIT.SERVER;
    case 'error':
    case 'lost':
      return EXIT.SERVER;
    default:
      return Number.isInteger(end.exit_code) ? end.exit_code : EXIT.SERVER;
  }
}
