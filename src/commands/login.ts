import os from 'node:os';
import { CliError, configError, EXIT } from '../errors.ts';
import { credentialsPath, readCredentials, resolveServer, TOKEN_RE, tokenHint, writeCredentials } from '../credentials.ts';
import { VERSION } from '../version.ts';
import { pollDeviceToken, startDeviceAuth, type DeviceToken } from '../client/device.ts';
import { openBrowser as realOpenBrowser } from '../ui/browser.ts';
import type { Output, Renderer } from '../ui/types.ts';
import { apiGet, makeRenderer, reportError, type CommonOptions } from './common.ts';
import { renderIdentity, WHOAMI_PATH, type WhoamiBody } from './whoami.ts';

export interface LoginOptions extends CommonOptions {
  /** Mint a token for a CI job: printed, never stored. */
  ci?: boolean;
  /** The label the CI token carries (usually the repository). */
  name?: string;
  /** `--no-browser` leaves opts.browser false. */
  browser?: boolean;
}

export interface LoginIo {
  out: Output;
  readLine: () => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  /** False means "a pasted token may arrive on stdin". */
  stdinIsTTY?: boolean;
  openBrowser?: (url: string) => boolean;
  hostname?: string;
  /** Aborted on Ctrl-C: the poll stops and nothing is written. */
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

function fmtExpiry(seconds: number): string {
  return seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`;
}

/** Store the token and print the identity it belongs to, as `whoami` does. */
async function storeAndReport(r: Renderer, token: string, server: string, storedServer: string | undefined, env: NodeJS.ProcessEnv, how: string): Promise<number> {
  const p = writeCredentials({ token, server: storedServer }, env);
  if (r.json) r.info('', { t: 'login', how, path: p, token_hint: tokenHint(token), server, stored: true });
  else r.note(`${how}: ${tokenHint(token)}... saved to ${p}`);
  try {
    const body = (await apiGet(server, WHOAMI_PATH, token, VERSION)) as WhoamiBody;
    renderIdentity(r, server, token, body);
  } catch (err) {
    r.note(`the token is stored, but ${server}${WHOAMI_PATH} could not confirm it: ${(err as Error).message}`);
  }
  r.note(`env VELXIO_CLI_TOKEN and --token win over ${credentialsPath(env)}`);
  return EXIT.PASS;
}

/** Print a CI token once, with the two lines a job needs. */
function reportCiToken(r: Renderer, tok: DeviceToken, server: string): number {
  if (r.json) {
    r.info('', {
      t: 'login',
      how: 'device',
      purpose: 'ci',
      stored: false,
      server,
      token: tok.token,
      token_hint: tok.token_hint ?? tokenHint(tok.token),
      name: tok.name ?? null,
      expires_at: tok.expires_at ?? null,
      plan: tok.plan ?? null,
    });
    return EXIT.PASS;
  }
  r.info(`token    ${tok.token}`);
  if (tok.name) r.info(`name     ${tok.name}`);
  if (tok.plan) r.info(`plan     ${tok.plan}`);
  r.info(`expires  ${tok.expires_at ?? 'when you revoke it at /account/ci'}`);
  r.info('');
  r.info('This token is shown once and is not stored anywhere on this machine.');
  r.info('Copy it now; if you lose it, run `velxio-cli login --ci` again and revoke the old one.');
  r.info('');
  r.info(`  export VELXIO_CLI_TOKEN=${tok.token}`);
  r.info('');
  r.info('GitHub Actions - store it as the repository secret VELXIO_CLI_TOKEN:');
  r.info(`  gh secret set VELXIO_CLI_TOKEN --body '${tok.token}'`);
  r.info('and use it in the job:');
  r.info('  - uses: velxio/velxio-ci-action@v1');
  r.info('    with:');
  r.info('      token: ' + '${{ secrets.VELXIO_CLI_TOKEN }}');
  r.info('  # or, running the binary directly:');
  r.info('  #   env:');
  r.info('  #     VELXIO_CLI_TOKEN: ' + '${{ secrets.VELXIO_CLI_TOKEN }}');
  return EXIT.PASS;
}

/**
 * Sign in without ever handling a token: `login` asks the server for a user
 * code, opens the browser, polls until the approval and stores what it is
 * given (PROTOCOL.md 1.7). `--ci` mints the same kind of token for a job and
 * prints it instead. `--token` (or a token on stdin) still stores one by hand.
 */
export async function loginCommand(opts: LoginOptions, io: LoginIo): Promise<number> {
  const r = makeRenderer(opts, io.out);
  const env = io.env ?? process.env;
  try {
    if (opts.name && !opts.ci) throw configError('--name labels a CI token; use it with --ci');
    if (opts.token && opts.ci) throw configError('--ci mints a new token; it cannot print the one passed with --token');

    const creds = readCredentials(env);
    const server = resolveServer(opts.server, env);
    // Only an explicit --server is remembered; otherwise the file keeps what it had.
    const storedServer = opts.server ? server : creds.server;

    // 1. The paste path, for a machine with no browser and no session.
    let pasted = opts.token?.trim();
    if (!pasted && !opts.ci && io.stdinIsTTY === false) pasted = (await io.readLine())?.trim() || undefined;
    if (pasted) {
      if (!TOKEN_RE.test(pasted)) throw new CliError('malformed token: expected vlxci_ followed by 40 hex characters', { exitCode: EXIT.AUTH, code: 'token_malformed' });
      return await storeAndReport(r, pasted, server, storedServer, env, 'stored the token you supplied');
    }

    // 2. The device flow.
    const purpose = opts.ci ? 'ci' : 'local';
    const hostname = io.hostname ?? os.hostname();
    const auth = await startDeviceAuth(server, { cliVersion: VERSION, hostname, purpose, name: opts.name }, io.signal);
    if (r.json) {
      r.info('', {
        t: 'login.device',
        purpose,
        server,
        user_code: auth.user_code,
        verification_uri: auth.verification_uri,
        verification_uri_complete: auth.verification_uri_complete,
        expires_in: auth.expires_in,
        interval: auth.interval,
      });
    } else {
      r.info(`code     ${auth.user_code}`);
      r.info(`approve  ${auth.verification_uri_complete}`);
    }
    let opened = false;
    if (opts.browser === false) {
      r.note('not opening a browser (--no-browser): approve the sign-in at the URL above');
    } else {
      opened = (io.openBrowser ?? realOpenBrowser)(auth.verification_uri_complete);
      if (opened) r.note('opened your browser; if nothing came up, open the URL above yourself');
      else r.note('no browser could be opened here: open the URL above on any machine and approve it');
    }
    r.note(`waiting for approval of ${auth.user_code} (the code expires in ${fmtExpiry(auth.expires_in)}); Ctrl-C cancels and stores nothing`);

    const tok = await pollDeviceToken(server, auth.device_code, {
      cliVersion: VERSION,
      interval: auth.interval,
      expiresIn: auth.expires_in,
      signal: io.signal,
      sleep: io.sleep,
      now: io.now,
      onSlowDown: (next) => r.note(`the server asked to slow down; polling every ${next} s`),
    });

    if (opts.ci) return reportCiToken(r, tok, server);
    return await storeAndReport(r, tok.token, server, storedServer, env, `signed in as ${tok.name ?? `velxio-cli on ${hostname}`}`);
  } catch (err) {
    return reportError(err, r);
  }
}
