import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { CliError, EXIT } from './errors.ts';

export const DEFAULT_SERVER = 'https://velxio.dev';
export const TOKEN_RE = /^vlxci_[0-9a-f]{40}$/;

export interface Credentials {
  token?: string;
  server?: string;
}

/** `$XDG_CONFIG_HOME/velxio/credentials` (`%APPDATA%\velxio\credentials` on Windows). */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VELXIO_CLI_CREDENTIALS) return env.VELXIO_CLI_CREDENTIALS;
  const base =
    env.XDG_CONFIG_HOME ||
    (process.platform === 'win32' && env.APPDATA ? env.APPDATA : path.join(os.homedir(), '.config'));
  return path.join(base, 'velxio', 'credentials');
}

export function readCredentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  const p = credentialsPath(env);
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return {};
  }
  try {
    const doc = parseToml(text) as Record<string, unknown>;
    return {
      token: typeof doc.token === 'string' ? doc.token : undefined,
      server: typeof doc.server === 'string' ? doc.server : undefined,
    };
  } catch {
    return {};
  }
}

export function writeCredentials(creds: Credentials, env: NodeJS.ProcessEnv = process.env): string {
  const p = credentialsPath(env);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const doc: Record<string, string> = {};
  if (creds.token) doc.token = creds.token;
  if (creds.server) doc.server = creds.server;
  // A fresh 0600 file renamed over the target: an existing file with wider
  // bits never holds the token, not even between a write and a chmod.
  const tmp = `${p}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, stringifyToml(doc) + '\n', { mode: 0o600, flag: 'wx' });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // Windows has no mode bits; the directory ACL is the user's.
    }
    fs.renameSync(tmp, p);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return p;
}

export function tokenHint(token: string): string {
  return token.slice(0, 12);
}

/**
 * `--token` > VELXIO_CLI_TOKEN > VELXIO_CI_TOKEN > the credentials file.
 * WOKWI_CLI_TOKEN is never read; its presence only earns a hint.
 */
export function resolveToken(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const token = flag || env.VELXIO_CLI_TOKEN || env.VELXIO_CI_TOKEN || readCredentials(env).token;
  if (!token) {
    const hints = ['set VELXIO_CLI_TOKEN (or VELXIO_CI_TOKEN), run `velxio-cli login`, or pass --token'];
    if (env.WOKWI_CLI_TOKEN) hints.push('WOKWI_CLI_TOKEN is set but Velxio never reads it; mint a vlxci_ token at /account/ci');
    throw new CliError('no API token', { exitCode: EXIT.AUTH, code: 'token_missing', hints });
  }
  if (!TOKEN_RE.test(token)) {
    throw new CliError('malformed token: expected vlxci_ followed by 40 hex characters', { exitCode: EXIT.AUTH, code: 'token_malformed' });
  }
  return token;
}

/** `--server` > VELXIO_CLI_SERVER > the credentials file > https://velxio.dev. Plain http only for localhost. */
export function resolveServer(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const raw = flag || env.VELXIO_CLI_SERVER || readCredentials(env).server || DEFAULT_SERVER;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`invalid server URL: ${raw}`, { exitCode: EXIT.CONFIG });
  }
  if (url.protocol === 'http:') {
    const host = url.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
      throw new CliError(`refusing plain http:// for ${host}; use https://`, { exitCode: EXIT.CONFIG });
    }
  } else if (url.protocol !== 'https:') {
    throw new CliError(`server URL must be https:// (got ${url.protocol})`, { exitCode: EXIT.CONFIG });
  }
  return url.origin;
}

export function wsUrl(server: string, wsPath: string): string {
  const url = new URL(server);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = wsPath;
  url.search = '';
  return url.toString();
}
