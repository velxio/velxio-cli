import { resolveServer, resolveToken, tokenHint } from '../credentials.ts';
import { VERSION } from '../version.ts';
import { fmtMinutes, type Output } from '../ui/types.ts';
import { apiGet, makeRenderer, reportError, type CommonOptions } from './common.ts';

interface WhoamiBody {
  user?: { id?: string; email_masked?: string };
  plan?: string;
  minutes?: { cap_ms?: number; used_ms?: number; remaining_ms?: number; resets_at?: string };
  limits?: Record<string, number>;
  min_cli_version?: string;
}

/** GET /api/pro/ci/whoami with the Bearer token. */
export async function whoamiCommand(opts: CommonOptions, out: Output, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const r = makeRenderer(opts, out);
  try {
    const token = resolveToken(opts.token, env);
    const server = resolveServer(opts.server, env);
    const body = (await apiGet(server, '/api/pro/ci/whoami', token, VERSION)) as WhoamiBody;
    if (r.json) {
      r.info('', { t: 'whoami', server, token_hint: tokenHint(token), ...body });
      return 0;
    }
    const m = body.minutes ?? {};
    r.info(`server   ${server}`);
    r.info(`token    ${tokenHint(token)}...`);
    if (body.user?.email_masked) r.info(`user     ${body.user.email_masked}`);
    r.info(`plan     ${body.plan ?? '?'}`);
    r.info(`minutes  ${fmtMinutes(m.used_ms ?? 0)} used of ${fmtMinutes(m.cap_ms ?? 0)} · ${fmtMinutes(m.remaining_ms ?? 0)} left${m.resets_at ? ` · resets ${m.resets_at}` : ''}`);
    if (body.limits) {
      const l = body.limits;
      const parts: string[] = [];
      if (l.max_timeout_ms) parts.push(`max run ${fmtMinutes(l.max_timeout_ms)} min`);
      if (l.concurrency !== undefined) parts.push(`concurrency ${l.concurrency}`);
      if (l.max_firmware_bytes) parts.push(`firmware <= ${Math.round(l.max_firmware_bytes / 1048576)} MiB`);
      if (parts.length) r.info(`limits   ${parts.join(' · ')}`);
    }
    if (body.min_cli_version) r.info(`min cli  ${body.min_cli_version} (this is ${VERSION})`);
    return 0;
  } catch (err) {
    return reportError(err, r);
  }
}
