import type { ServerWebSocket } from 'bun';

export interface FakeState {
  received: Array<Record<string, unknown>>;
  binaryBytes: number[];
  blobs: Map<string, { size: number; chunks: number; got: number; bytes: number }>;
}

export type Script = (ws: ServerWebSocket<unknown>, msg: Record<string, unknown>, state: FakeState, send: (o: Record<string, unknown>) => void) => void;

export interface FakeServerOptions {
  /** Close right after the upgrade (a server that accepts, then refuses). */
  closeOnOpen?: [number, string];
  /** Answer the upgrade with this HTTP status, as uvicorn does for a close before accept(). */
  rejectUpgrade?: number;
  /** Plain HTTP routes (e.g. GET /api/pro/ci/whoami). */
  http?: (req: Request, url: URL) => Response;
}

/**
 * A fake Velxio CI API on a random port. `script` is called for every text
 * frame from the CLI; the default walks the happy path. Headers of the
 * upgrade are kept for assertions, and every plain HTTP request is logged.
 */
export function fakeServer(script: Script, opts: FakeServerOptions = {}) {
  const state: FakeState = { received: [], binaryBytes: [], blobs: new Map() };
  let seq = 0;
  const headers: Record<string, string> = {};
  const httpRequests: Array<{ path: string; authorization: string | null }> = [];
  let pendingBlob: string | null = null;
  const server = Bun.serve<unknown>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== '/api/pro/ci/ws') {
        httpRequests.push({ path: url.pathname, authorization: req.headers.get('authorization') });
        return opts.http?.(req, url) ?? new Response('not found', { status: 404 });
      }
      for (const [k, v] of req.headers) headers[k.toLowerCase()] = v;
      if (opts.rejectUpgrade) return new Response('forbidden', { status: opts.rejectUpgrade });
      if (srv.upgrade(req, { data: null, headers: { 'Sec-WebSocket-Protocol': 'velxio-ci.v1' } })) return;
      return new Response('expected websocket', { status: 400 });
    },
    websocket: {
      open(ws) {
        if (opts.closeOnOpen) ws.close(opts.closeOnOpen[0], opts.closeOnOpen[1]);
      },
      message(ws, raw) {
        const send = (o: Record<string, unknown>) => ws.send(JSON.stringify({ seq: ++seq, ...o }));
        if (typeof raw !== 'string') {
          const n = (raw as Uint8Array).byteLength;
          state.binaryBytes.push(n);
          if (pendingBlob) {
            const b = state.blobs.get(pendingBlob)!;
            b.got++;
            b.bytes += n;
            if (b.got === b.chunks) {
              const name = pendingBlob;
              pendingBlob = null;
              send({ t: 'blob.ack', name });
            }
          }
          return;
        }
        const msg = JSON.parse(raw) as Record<string, unknown>;
        state.received.push(msg);
        if (msg.t === 'blob') {
          state.blobs.set(msg.name as string, { size: msg.size as number, chunks: msg.chunks as number, got: 0, bytes: 0 });
          pendingBlob = msg.name as string;
          return;
        }
        script(ws, msg, state, send);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    state,
    headers,
    httpRequests,
    stop: () => server.stop(true),
  };
}

export const WELCOME = {
  t: 'welcome',
  user: { id: 'u1', email_masked: 's3***@moontero.com' },
  plan: 'pro',
  minutes: { cap_ms: 120_000_000, used_ms: 9_690_000, remaining_ms: 110_310_000, resets_at: '2026-10-01T00:00:00Z' },
  limits: { max_firmware_bytes: 16777216, max_blob_total_bytes: 20971520, max_bundle_bytes: 2097152, max_timeout_ms: 600000, concurrency: 2, max_steps: 200, max_screenshots: 20 },
  min_cli_version: '0.1.0',
  warnings: [],
};

export function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}
