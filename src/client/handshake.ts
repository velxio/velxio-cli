import { CliError, EXIT } from '../errors.ts';
import { describeClose } from '../protocol/exitCodes.ts';
import { apiGet } from './http.ts';

export interface HandshakeFailure {
  message: string;
  hints: string[];
  code: string;
  exitCode: number;
}

/**
 * Why the CI socket never opened. The API refuses a socket before accept()
 * (PROTOCOL.md 1.1: 4401 token, 4402 plan, 4429 rate limit, 4503 CI
 * disabled), but behind uvicorn that close never reaches a client: the
 * upgrade is answered with HTTP 403 and the WebSocket only reports 1002 or
 * 1006. The same Bearer on GET /api/pro/ci/whoami tells the cases apart:
 * 401/402 are exit 3 like 4401/4402, a disabled CI or a refusal with a valid
 * token (rate limit, too many open sockets) exit 5, and so does a server
 * that cannot be reached at all.
 */
export async function diagnoseRefusedSocket(server: string, token: string, cliVersion: string, closeCode: number, reason: string): Promise<HandshakeFailure> {
  const closed = describeClose(closeCode, reason);
  let body: Record<string, unknown>;
  try {
    body = ((await apiGet(server, '/api/pro/ci/whoami', token, cliVersion)) ?? {}) as Record<string, unknown>;
  } catch (err) {
    if (!(err instanceof CliError)) {
      return { message: `the server refused the CI socket: ${closed}`, hints: [], code: 'connect', exitCode: EXIT.SERVER };
    }
    if (err.exitCode === EXIT.AUTH) return { message: err.message, hints: err.hints, code: 'auth', exitCode: EXIT.AUTH };
    if (err.code === 'connect') return { message: `cannot connect to ${server}: ${closed}`, hints: err.hints, code: 'connect', exitCode: EXIT.SERVER };
    if (err.code === 'rate_limited') return { message: `rate limited by the server: ${err.message}`, hints: ['wait and retry'], code: 'rate_limited', exitCode: EXIT.SERVER };
    return { message: `the server refused the CI socket (${closed}) and ${err.message}`, hints: err.hints, code: err.code, exitCode: EXIT.SERVER };
  }
  if (body.ci_enabled === false) {
    return { message: `CI is disabled on ${server}`, hints: [], code: 'ci_disabled', exitCode: EXIT.SERVER };
  }
  return {
    message: `the server refused the CI socket although the token is valid: ${closed}`,
    hints: [
      'too many open runs for this token, or rate limited: wait and retry',
      'a proxy that does not pass WebSocket upgrades fails the same way',
    ],
    code: 'connect',
    exitCode: EXIT.SERVER,
  };
}
