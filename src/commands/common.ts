import { CliError, EXIT } from '../errors.ts';
import { JsonRenderer } from '../ui/json.ts';
import { TtyRenderer } from '../ui/tty.ts';
import type { Output, Renderer } from '../ui/types.ts';

export { apiGet } from '../client/http.ts';

export interface CommonOptions {
  json?: boolean;
  quiet?: boolean;
  token?: string;
  server?: string;
}

export function makeRenderer(opts: CommonOptions, out: Output): Renderer {
  return opts.json ? new JsonRenderer(out) : new TtyRenderer(out, !!opts.quiet);
}

/** Render a CliError (or anything thrown) and return the exit code. */
export function reportError(err: unknown, r: Renderer): number {
  if (err instanceof CliError) {
    r.error(err.message, err.hints, err.code, err.exitCode);
    return err.exitCode;
  }
  const e = err as Error;
  r.error(e?.message ?? String(err), [], 'internal', EXIT.SERVER);
  return EXIT.SERVER;
}
