import { CliError, EXIT } from '../errors.ts';
import { credentialsPath, readCredentials, resolveServer, TOKEN_RE, tokenHint, writeCredentials } from '../credentials.ts';
import type { Output } from '../ui/types.ts';
import { makeRenderer, reportError, type CommonOptions } from './common.ts';

export interface LoginIo {
  out: Output;
  readLine: () => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
}

/** Store a vlxci_ token (prompted, or --token) at $XDG_CONFIG_HOME/velxio/credentials. */
export async function loginCommand(opts: CommonOptions, io: LoginIo): Promise<number> {
  const r = makeRenderer(opts, io.out);
  const env = io.env ?? process.env;
  try {
    let token = opts.token;
    if (!token) {
      io.out.stderr('Paste a Velxio CI token (from /account/ci; it is stored, not echoed back): ');
      token = (await io.readLine())?.trim() ?? '';
    }
    if (!TOKEN_RE.test(token)) throw new CliError('malformed token: expected vlxci_ followed by 40 hex characters', { exitCode: EXIT.AUTH, code: 'token_malformed' });
    const creds = readCredentials(env);
    const server = opts.server ? resolveServer(opts.server, env) : creds.server;
    const p = writeCredentials({ token, server }, env);
    if (r.json) r.info('', { t: 'login', path: p, token_hint: tokenHint(token), server: server ?? null });
    else r.info(`saved ${tokenHint(token)}... to ${p}${server ? ` (server ${server})` : ''}`);
    r.note(`env VELXIO_CLI_TOKEN and --token win over ${credentialsPath(env)}`);
    return EXIT.PASS;
  } catch (err) {
    return reportError(err, r);
  }
}
