import { CliError, EXIT } from '../errors.ts';

const HTTP_TIMEOUT_MS = 15_000;

/** FastAPI puts the reason in `detail` (a string, or the 402 body's object). */
function errorDetail(body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  const d = b.detail ?? b.error;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && typeof (d as Record<string, unknown>).error === 'string') return (d as Record<string, string>).error!;
  return '';
}

/**
 * Bearer GET against the API (whoami, capabilities, the handshake
 * diagnosis); maps HTTP status to exit codes: 401/402 exit 3, anything else
 * and the network exit 5. `code` tells the cases apart for the caller.
 */
export async function apiGet(server: string, pathname: string, token: string | null, cliVersion: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Velxio-Cli-Version': cliVersion };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${server}${pathname}`, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    throw new CliError(`cannot reach ${server}: ${(err as Error).message}`, {
      exitCode: EXIT.SERVER,
      code: 'connect',
      hints: [`is ${server} reachable? (--server, VELXIO_CLI_SERVER)`],
    });
  }
  if (res.status === 401 || res.status === 402) {
    let detail = '';
    try {
      detail = errorDetail(await res.json());
    } catch {
      // no body
    }
    const suffix = detail ? ` (${detail})` : '';
    throw new CliError(res.status === 401 ? `authentication failed${suffix}` : `plan not entitled to CI${suffix}`, {
      exitCode: EXIT.AUTH,
      code: 'auth',
      hints: res.status === 402 ? ['CI minutes need the Maker plan or above: /pricing?from=ci'] : ['check VELXIO_CLI_TOKEN, or mint a new token at /account/ci'],
    });
  }
  if (!res.ok) {
    const retry = res.headers.get('retry-after');
    const code = res.status === 429 ? 'rate_limited' : res.status === 404 ? 'not_found' : 'server';
    const hints = res.status === 404 ? [`does ${server} run Velxio CI? (--server, VELXIO_CLI_SERVER)`] : [];
    throw new CliError(`${server}${pathname} answered ${res.status}${retry ? ` (retry after ${retry} s)` : ''}`, { exitCode: EXIT.SERVER, code, hints });
  }
  try {
    return await res.json();
  } catch {
    throw new CliError(`${server}${pathname} did not return JSON`, { exitCode: EXIT.SERVER, code: 'server' });
  }
}

export interface ApiReply {
  status: number;
  /** Parsed JSON, or null when the body was empty or not JSON. */
  body: unknown;
}

/**
 * Unauthenticated POST used by the device sign-in flow (1.7). It does NOT
 * map the status to an error: the flow branches on 200/402/403/410/428/429
 * itself. Only the network and a broken URL throw.
 */
export async function apiPost(server: string, pathname: string, payload: unknown, cliVersion: string, signal?: AbortSignal): Promise<ApiReply> {
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(`${server}${pathname}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Velxio-Cli-Version': cliVersion },
      body: JSON.stringify(payload),
      signal: sig,
    });
  } catch (err) {
    if (signal?.aborted) throw new CliError('cancelled', { exitCode: EXIT.INTERRUPT, code: 'interrupted' });
    throw new CliError(`cannot reach ${server}: ${(err as Error).message}`, {
      exitCode: EXIT.SERVER,
      code: 'connect',
      hints: [`is ${server} reachable? (--server, VELXIO_CLI_SERVER)`],
    });
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** `{error}`, FastAPI's `{detail: {error}}` or `{detail: "..."}`. */
export function errorCode(body: unknown): string {
  return errorDetail(body);
}

/** A number carried either at the top level or inside FastAPI's `detail`. */
export function errorField(body: unknown, key: string): unknown {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b[key] !== undefined) return b[key];
  const d = b.detail;
  if (d && typeof d === 'object') return (d as Record<string, unknown>)[key];
  return undefined;
}
