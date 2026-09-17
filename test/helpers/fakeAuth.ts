/**
 * A fake of the device sign-in endpoints of PROTOCOL.md 1.7:
 * POST /api/pro/ci/auth/device, POST /api/pro/ci/auth/token, plus the
 * GET /api/pro/ci/whoami the CLI prints afterwards. The approval page and
 * /approve, /deny are the browser's half and are not needed here.
 */

export type PollAnswer = 'pending' | 'slow_down' | 'ok' | 'deny' | 'expired' | 'pro_required';

export const FAKE_TOKEN = 'vlxci_' + 'ab12cd34'.repeat(5);

export interface FakeAuthOptions {
  /** Seconds the device response asks the CLI to wait between polls. */
  interval?: number;
  expiresIn?: number;
  /** One per poll, in order; the last one repeats. */
  polls?: PollAnswer[];
  /** Seconds sent with a `slow_down`; omitted means the CLI decides. */
  slowDownInterval?: number;
  token?: string;
  plan?: string;
  name?: string;
  /** Status for POST /auth/device when it should not succeed. */
  deviceStatus?: number;
  /** false: /whoami answers 404 (the token is still fine). */
  whoami?: boolean;
}

export const WHOAMI_BODY = {
  user: { id: 'u1', email_masked: 's3***@moontero.com' },
  plan: 'pro',
  minutes: { cap_ms: 120_000_000, used_ms: 9_690_000, remaining_ms: 110_310_000, resets_at: '2026-10-01T00:00:00Z' },
  limits: { max_firmware_bytes: 16777216, max_blob_total_bytes: 20971520, max_bundle_bytes: 2097152, max_timeout_ms: 600000, concurrency: 2, max_steps: 200, max_screenshots: 20 },
  min_cli_version: '0.1.0',
};

export function fakeAuthServer(opts: FakeAuthOptions = {}) {
  const interval = opts.interval ?? 0.05;
  const expiresIn = opts.expiresIn ?? 600;
  const answers = opts.polls ?? ['ok'];
  const token = opts.token ?? FAKE_TOKEN;
  const deviceRequests: Array<Record<string, unknown>> = [];
  const pollRequests: Array<Record<string, unknown>> = [];
  const pollAt: number[] = [];
  const paths: string[] = [];
  const cliVersions: string[] = [];
  let polls = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      paths.push(url.pathname);
      cliVersions.push(req.headers.get('x-velxio-cli-version') ?? '');
      if (url.pathname === '/api/pro/ci/auth/device') {
        deviceRequests.push((await req.json()) as Record<string, unknown>);
        if (opts.deviceStatus) return Response.json({ detail: { error: 'nope' } }, { status: opts.deviceStatus });
        return Response.json({
          device_code: 'f'.repeat(32),
          user_code: 'K7RM-9TQX',
          verification_uri: `${url.origin}/ci/device`,
          verification_uri_complete: `${url.origin}/ci/device?code=K7RM-9TQX`,
          expires_in: expiresIn,
          interval,
        });
      }
      if (url.pathname === '/api/pro/ci/auth/token') {
        pollAt.push(Date.now());
        pollRequests.push((await req.json()) as Record<string, unknown>);
        const answer = answers[Math.min(polls, answers.length - 1)]!;
        polls++;
        switch (answer) {
          case 'pending':
            return Response.json({ error: 'authorization_pending' }, { status: 428 });
          case 'slow_down':
            return Response.json({ error: 'slow_down', ...(opts.slowDownInterval ? { interval: opts.slowDownInterval } : {}) }, { status: 429 });
          case 'deny':
            return Response.json({ error: 'access_denied' }, { status: 403 });
          case 'expired':
            return Response.json({ error: 'expired_token' }, { status: 410 });
          case 'pro_required':
            return Response.json({ detail: { error: 'pro_required' } }, { status: 402 });
          default:
            return Response.json({
              token,
              token_hint: token.slice(0, 12),
              name: opts.name ?? 'velxio-cli on testbox',
              expires_at: '2027-01-01T00:00:00Z',
              plan: opts.plan ?? 'pro',
            });
        }
      }
      if (url.pathname === '/api/pro/ci/whoami') {
        if (opts.whoami === false) return new Response('not found', { status: 404 });
        return Response.json({ ...WHOAMI_BODY, plan: opts.plan ?? WHOAMI_BODY.plan });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    deviceRequests,
    pollRequests,
    pollAt,
    paths,
    cliVersions,
    get polls() {
      return polls;
    },
    stop: () => server.stop(true),
  };
}
