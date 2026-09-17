import { CliError, EXIT } from '../errors.ts';
import { TOKEN_RE } from '../credentials.ts';
import { apiPost, errorCode, errorField } from './http.ts';

/**
 * The device sign-in flow of PROTOCOL.md 1.7 (RFC 8628, trimmed): the CLI
 * asks for a code, the person approves it in a browser, the CLI polls until
 * the token is minted. Both purposes mint an ordinary `vlxci_` token; only
 * what the CLI does with it differs.
 */

export const DEVICE_PATH = '/api/pro/ci/auth/device';
export const TOKEN_PATH = '/api/pro/ci/auth/token';

/** Bounds on what the server may ask of us, in seconds. */
const MIN_INTERVAL_S = 0.05;
const MAX_INTERVAL_S = 60;
const MAX_EXPIRES_S = 3600;
const DEFAULT_INTERVAL_S = 5;
const DEFAULT_EXPIRES_S = 600;
/** RFC 8628: a `slow_down` with no interval of its own raises it by 5 s. */
const SLOW_DOWN_BUMP_S = 5;

export type DevicePurpose = 'local' | 'ci';

export interface DeviceAuth {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceToken {
  token: string;
  token_hint?: string;
  name?: string;
  expires_at?: string;
  plan?: string;
}

export interface DeviceAsk {
  cliVersion: string;
  hostname: string;
  purpose: DevicePurpose;
  name?: string;
}

function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v ? v : undefined;
}

function seconds(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, MIN_INTERVAL_S), max);
}

function badServer(server: string, pathname: string, status: number, body: unknown): CliError {
  const code = errorCode(body);
  const hints = status === 404 ? [`does ${server} run Velxio CI sign-in? (--server, VELXIO_CLI_SERVER)`] : [];
  return new CliError(`${server}${pathname} answered ${status}${code ? ` (${code})` : ''}`, { exitCode: EXIT.SERVER, code: 'server', hints });
}

function proRequired(): CliError {
  return new CliError('this account has no CI entitlement', {
    exitCode: EXIT.AUTH,
    code: 'pro_required',
    hints: ['CI minutes need the Maker plan or above: /pricing?from=ci'],
  });
}

/** Step 1: ask for a user code. */
export async function startDeviceAuth(server: string, ask: DeviceAsk, signal?: AbortSignal): Promise<DeviceAuth> {
  const payload: Record<string, unknown> = { cli_version: ask.cliVersion, hostname: ask.hostname, purpose: ask.purpose };
  if (ask.name) payload.name = ask.name;
  const { status, body } = await apiPost(server, DEVICE_PATH, payload, ask.cliVersion, signal);
  if (status === 402) throw proRequired();
  if (status === 429) {
    throw new CliError(`${server} is rate limiting sign-in requests`, { exitCode: EXIT.SERVER, code: 'rate_limited', hints: ['wait a minute and run `velxio-cli login` again'] });
  }
  if (status !== 200) throw badServer(server, DEVICE_PATH, status, body);
  const o = (body ?? {}) as Record<string, unknown>;
  const deviceCode = str(o, 'device_code');
  const userCode = str(o, 'user_code');
  const uri = str(o, 'verification_uri');
  if (!deviceCode || !userCode || !uri) {
    throw new CliError(`${server}${DEVICE_PATH} did not return a device code`, { exitCode: EXIT.SERVER, code: 'server' });
  }
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: uri,
    verification_uri_complete: str(o, 'verification_uri_complete') ?? uri,
    expires_in: seconds(o.expires_in, DEFAULT_EXPIRES_S, MAX_EXPIRES_S),
    interval: seconds(o.interval, DEFAULT_INTERVAL_S, MAX_INTERVAL_S),
  };
}

export interface PollOptions {
  cliVersion: string;
  /** Seconds between polls, from the device response. */
  interval: number;
  /** Seconds the code lives, from the device response. */
  expiresIn: number;
  signal?: AbortSignal;
  /** Injected by the tests; the default is a plain abortable timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Told about a `slow_down`, with the new interval in seconds. */
  onSlowDown?: (interval: number) => void;
}

export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function interrupted(): CliError {
  return new CliError('cancelled; no token was stored', { exitCode: EXIT.INTERRUPT, code: 'interrupted' });
}

function expired(): CliError {
  return new CliError('the sign-in code expired before it was approved', {
    exitCode: EXIT.AUTH,
    code: 'expired_token',
    hints: ['run `velxio-cli login` again (an API restart also loses pending codes)'],
  });
}

/**
 * Step 4: poll until the token, a denial or the expiry. `slow_down` raises
 * the interval; nothing here writes anything, so an abort leaves no trace.
 */
export async function pollDeviceToken(server: string, deviceCode: string, opts: PollOptions): Promise<DeviceToken> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepMs;
  const deadline = now() + opts.expiresIn * 1000;
  let interval = opts.interval;
  for (;;) {
    await sleep(interval * 1000, opts.signal);
    if (opts.signal?.aborted) throw interrupted();
    if (now() >= deadline) throw expired();
    const { status, body } = await apiPost(server, TOKEN_PATH, { device_code: deviceCode }, opts.cliVersion, opts.signal);
    if (status === 200) {
      const o = (body ?? {}) as Record<string, unknown>;
      const token = str(o, 'token');
      if (!token) throw new CliError(`${server}${TOKEN_PATH} approved the sign-in but returned no token`, { exitCode: EXIT.SERVER, code: 'server' });
      if (!TOKEN_RE.test(token)) {
        throw new CliError('the server returned a token that is not vlxci_ followed by 40 hex characters', { exitCode: EXIT.SERVER, code: 'token_malformed' });
      }
      return { token, token_hint: str(o, 'token_hint'), name: str(o, 'name'), expires_at: str(o, 'expires_at'), plan: str(o, 'plan') };
    }
    if (status === 428) continue;
    if (status === 429) {
      interval = seconds(errorField(body, 'interval'), Math.min(interval + SLOW_DOWN_BUMP_S, MAX_INTERVAL_S), MAX_INTERVAL_S);
      opts.onSlowDown?.(interval);
      continue;
    }
    if (status === 403) {
      throw new CliError('the sign-in was denied in the browser', { exitCode: EXIT.AUTH, code: 'access_denied', hints: ['run `velxio-cli login` again to ask for a new code'] });
    }
    if (status === 410) throw expired();
    if (status === 402) throw proRequired();
    throw badServer(server, TOKEN_PATH, status, body);
  }
}
