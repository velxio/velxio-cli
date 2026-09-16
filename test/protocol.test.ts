import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSession, sha256Hex, type RunRequest } from '../src/client/ws.ts';
import { TtyRenderer } from '../src/ui/tty.ts';
import { JsonRenderer } from '../src/ui/json.ts';
import type { Output } from '../src/ui/types.ts';
import type { RunCreate } from '../src/protocol/messages.ts';
import { b64, fakeServer, WELCOME } from './helpers/fakeServer.ts';

const TOKEN = 'vlxci_' + '0123456789abcdef0123456789abcdef01234567';

function capture(): Output & { stdoutText: () => string; stderrText: () => string } {
  const out: Uint8Array[] = [];
  let err = '';
  return {
    stdout(d) {
      out.push(typeof d === 'string' ? new TextEncoder().encode(d) : d);
    },
    stderr(t) {
      err += t;
    },
    stdoutText: () => Buffer.concat(out.map((c) => Buffer.from(c))).toString('utf8'),
    stderrText: () => err,
  };
}

const firmware = new Uint8Array(5 * 1024 * 1024 + 123).fill(0x41); // two chunks: 4 MiB + rest
const create: RunCreate = {
  t: 'run.create',
  project: { kind: 'wokwi', diagram: { version: 1, parts: [], connections: [] } },
  boards: [{ id: 'uno', kind: 'arduino-uno' }],
  primary_board_id: 'uno',
  firmware: [{ board_id: 'uno', blob: 'fw-uno', format: 'hex' }],
  plan: [{ kind: 'wait-serial', text: 'READY' }, { kind: 'take-screenshot', part_id: 'led1', name: 'shot-1.png', compare_blob: null, tolerance_pct: 0.5 }],
  options: { timeout_ms: 5000, fail_text: null, interactive: false, project_name: 'blink', source: 'cli', allow_unsupported: false },
};

function request(): RunRequest {
  return {
    create,
    blobs: [{ name: 'fw-uno', bytes: firmware }],
    screenshots: [{ index: 1, name: 'shot-1.png', partId: 'led1', saveTo: 'shots/led.png', compareWith: null, compareBlob: null }],
    stepDescriptions: ['wait-serial "READY"', 'take-screenshot led1 -> shots/led.png'],
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);

describe('protocol walk against a fake server', () => {
  test('hello -> welcome -> run.create -> accepted -> blob/ack -> blobs.done -> serial/step/screenshot -> run.end', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velxio-cli-run-'));
    const srv = fakeServer((ws, msg, state, send) => {
      if (msg.t === 'hello') {
        expect(msg.proto).toBe(1);
        expect(typeof msg.cli_version).toBe('string');
        send(WELCOME);
      } else if (msg.t === 'run.create') {
        expect(msg.primary_board_id).toBe('uno');
        send({ t: 'run.accepted', run_id: 'r_9f3c2a1b7e4d', budget_ms: 5000, reserved_ms: 5000, queue_position: 0, run_url: 'https://velxio.dev/account/ci#r_9f3c2a1b7e4d' });
      } else if (msg.t === 'blobs.done') {
        const blob = state.blobs.get('fw-uno')!;
        expect(blob.chunks).toBe(2);
        expect(blob.bytes).toBe(firmware.length);
        expect((state.received.find((m) => m.t === 'blob') as { sha256: string }).sha256).toBe(sha256Hex(firmware));
        send({ t: 'run.state', state: 'loading', sim_ms: 0, wall_ms: 10 });
        send({ t: 'run.state', state: 'running', sim_ms: 0, wall_ms: 900 });
        send({ t: 'serial', board_id: 'uno', data_b64: b64('Hello from '), sim_us: 400_000 });
        send({ t: 'serial', board_id: 'uno', data_b64: b64('Velxio\nREADY\n'), sim_us: 412_000 });
        send({ t: 'step', index: 0, kind: 'wait-serial', ok: true, sim_us: 412_000 });
        send({ t: 'warning', code: 'no_network', message: 'WiFi has no gateway in CI' });
        send({ t: 'log', level: 'info', message: 'engine avr8js' });
        send({ t: 'screenshot', name: 'shot-1.png', part_id: 'led1', sim_us: 1_500_000, size: PNG.length, kind: 'png' });
        ws.send(PNG);
        send({ t: 'step', index: 1, kind: 'take-screenshot', ok: true, sim_us: 1_500_000 });
        send({ t: 'ping' });
      } else if (msg.t === 'pong') {
        // The API sends run_url relative to the site; the CLI resolves it against --server.
        send({ t: 'run.end', status: 'passed', reason: 'screenshots_done', exit_code: 0, sim_ms: 1500, wall_ms: 2100, billed_ms: 2000, minutes_used_month_ms: 9_692_000, minutes_cap_ms: 120_000_000, run_url: '/account/ci#r_9f3c2a1b7e4d' });
        ws.close(1000, 'done');
      }
    });
    const out = capture();
    try {
      const session = startSession(request(), {
        server: srv.url,
        token: TOKEN,
        cliVersion: '0.1.0',
        timeoutExitCode: 42,
        interactive: false,
        serialLogFile: path.join(outDir, 'serial.log'),
        outputDir: outDir,
        renderer: new TtyRenderer(out),
      });
      const code = await session.done;
      expect(code).toBe(0);
      expect(out.stdoutText()).toBe('Hello from Velxio\nREADY\n');
      const err = out.stderrText();
      expect(err).toContain('velxio-cli 0.1.0 · plan pro · 1838.5 of 2000 min left (resets 2026-10-01)');
      expect(err).toContain('run r_9f3c2a1b7e4d queued (position 0) · budget 5.0 s simulated');
      expect(err).toContain('ok   wait-serial "READY" at 0.412 s');
      expect(err).toContain('shot led1 -> shots/led.png (1.500 s)');
      expect(err).toContain('warning: WiFi has no gateway in CI [no_network]');
      expect(err).toContain(`PASS in 1.50 s simulated (2.1 s wall) · billed 2 s · ${srv.url}/account/ci#r_9f3c2a1b7e4d · exit 0`);
      expect(srv.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(srv.headers['x-velxio-cli-version']).toBe('0.1.0');
      expect(srv.headers['sec-websocket-protocol']).toBe('velxio-ci.v1');
      expect(srv.state.received.map((m) => m.t)).toEqual(['hello', 'run.create', 'blob', 'blobs.done', 'pong']);
      expect(srv.state.binaryBytes).toEqual([4 * 1024 * 1024, 1024 * 1024 + 123]);
      expect(fs.readFileSync(path.join(outDir, 'serial.log'), 'utf8')).toBe('Hello from Velxio\nREADY\n');
      expect([...fs.readFileSync(path.join(outDir, 'shots/led.png'))]).toEqual([...PNG]);
    } finally {
      srv.stop();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('--json emits one object per event and no raw serial', async () => {
    const srv = fakeServer((ws, msg, _state, send) => {
      if (msg.t === 'hello') send(WELCOME);
      else if (msg.t === 'run.create') send({ t: 'run.accepted', run_id: 'r_1', budget_ms: 5000, reserved_ms: 5000, queue_position: 1, run_url: 'u' });
      else if (msg.t === 'blobs.done') {
        send({ t: 'serial', board_id: 'uno', data_b64: b64('hi\n'), sim_us: 10 });
        send({ t: 'run.end', status: 'failed', reason: 'fail_text', reason_detail: 'saw "PANIC"', exit_code: 1, sim_ms: 300, wall_ms: 500, billed_ms: 1000, minutes_used_month_ms: 1, minutes_cap_ms: 2, run_url: 'u' });
        ws.close(1000);
      }
    });
    const out = capture();
    try {
      const code = await startSession({ ...request(), blobs: [] }, { server: srv.url, token: TOKEN, cliVersion: '0.1.0', timeoutExitCode: 42, interactive: false, serialLogFile: null, outputDir: os.tmpdir(), renderer: new JsonRenderer(out) }).done;
      expect(code).toBe(1);
      const lines = out.stdoutText().trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.map((l) => l.t)).toEqual(['welcome', 'accepted', 'serial', 'end']);
      expect(lines[1]?.run_url).toBe(`${srv.url}/u`);
      expect(lines[3]?.run_url).toBe(`${srv.url}/u`);
      expect(lines[2]).toMatchObject({ board_id: 'uno', data_b64: b64('hi\n'), sim_us: 10 });
      expect(lines[3]).toMatchObject({ status: 'failed', reason: 'fail_text', reason_detail: 'saw "PANIC"', exit_code: 1, billed_ms: 1000 });
      expect(out.stderrText()).toBe('');
    } finally {
      srv.stop();
    }
  });

  test('timeout takes --timeout-exit-code; run.rejected quota is exit 4', async () => {
    const srv = fakeServer((ws, msg, _state, send) => {
      if (msg.t === 'hello') send(WELCOME);
      else if (msg.t === 'run.create') send({ t: 'run.accepted', run_id: 'r_2', budget_ms: 3000, reserved_ms: 3000, queue_position: 0, run_url: 'u' });
      else if (msg.t === 'blobs.done') {
        send({ t: 'run.end', status: 'timeout', reason: 'budget_reached', exit_code: 42, sim_ms: 3000, wall_ms: 3100, billed_ms: 3000, minutes_used_month_ms: 1, minutes_cap_ms: 2, run_url: 'u' });
        ws.close(1000);
      }
    });
    const out = capture();
    try {
      const opts = { server: srv.url, token: TOKEN, cliVersion: '0.1.0', interactive: false, serialLogFile: null, outputDir: os.tmpdir() };
      expect(await startSession({ ...request(), blobs: [] }, { ...opts, timeoutExitCode: 42, renderer: new TtyRenderer(out) }).done).toBe(42);
      expect(out.stderrText()).toContain('TIMEOUT after 3.00 s simulated');
      expect(await startSession({ ...request(), blobs: [] }, { ...opts, timeoutExitCode: 0, renderer: new TtyRenderer(capture()) }).done).toBe(0);
    } finally {
      srv.stop();
    }
    const rej = fakeServer((ws, msg, _state, send) => {
      if (msg.t === 'hello') send(WELCOME);
      else if (msg.t === 'run.create') {
        send({ t: 'run.rejected', code: 'quota_exhausted', message: 'no minutes left', hints: ['upgrade'], detail: { resets_at: '2026-10-01', remaining_ms: 0 } });
        ws.close(1008, 'rejected');
      }
    });
    const out2 = capture();
    try {
      const code = await startSession(request(), { server: rej.url, token: TOKEN, cliVersion: '0.1.0', timeoutExitCode: 42, interactive: false, serialLogFile: null, outputDir: os.tmpdir(), renderer: new TtyRenderer(out2) }).done;
      expect(code).toBe(4);
      expect(out2.stderrText()).toContain('rejected (quota_exhausted): no minutes left');
      expect(out2.stderrText()).toContain('hint: upgrade');
    } finally {
      rej.stop();
    }
  });

  test('a socket accepted and then closed 4401 is exit 3; a dead port is exit 5', async () => {
    const srv = fakeServer(() => {}, { closeOnOpen: [4401, 'token revoked'] });
    const out = capture();
    try {
      const code = await startSession(request(), { server: srv.url, token: TOKEN, cliVersion: '0.1.0', timeoutExitCode: 42, interactive: false, serialLogFile: null, outputDir: os.tmpdir(), renderer: new TtyRenderer(out) }).done;
      expect(code).toBe(3);
      expect(out.stderrText()).toContain('authentication failed');
      expect(out.stderrText()).toContain('token revoked');
    } finally {
      srv.stop();
    }
    const out2 = capture();
    const code2 = await startSession(request(), { server: 'http://127.0.0.1:1', token: TOKEN, cliVersion: '0.1.0', timeoutExitCode: 42, interactive: false, serialLogFile: null, outputDir: os.tmpdir(), renderer: new TtyRenderer(out2) }).done;
    expect(code2).toBe(5);
    expect(out2.stderrText()).toContain('cannot connect to http://127.0.0.1:1');
  });

  test('an upgrade refused with HTTP 403 (uvicorn close before accept) is diagnosed through GET /whoami', async () => {
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => Response.json(body, { status, headers });
    const cases: Array<[string, () => Response, number, string]> = [
      ['revoked token', json(401, { detail: 'Invalid or revoked Velxio CI token' }), 3, 'error (auth): authentication failed (Invalid or revoked Velxio CI token)'],
      ['plan not entitled', json(402, { detail: { error: 'pro_required', feature: 'ci', required_plan: 'maker' } }), 3, 'plan not entitled to CI (pro_required)'],
      ['CI disabled', json(200, { plan: 'pro', ci_enabled: false }), 5, 'error (ci_disabled): CI is disabled on'],
      ['valid token, socket refused', json(200, { plan: 'pro', ci_enabled: true }), 5, 'refused the CI socket although the token is valid'],
      ['rate limited', json(429, { detail: 'slow down' }, { 'Retry-After': '60' }), 5, 'error (rate_limited): rate limited by the server'],
    ];
    for (const [label, whoami, exit, text] of cases) {
      const srv = fakeServer(() => {}, { rejectUpgrade: 403, http: (_req, url) => (url.pathname === '/api/pro/ci/whoami' ? whoami() : new Response('', { status: 404 })) });
      const out = capture();
      try {
        const code = await startSession(request(), { server: srv.url, token: TOKEN, cliVersion: '0.1.0', timeoutExitCode: 42, interactive: false, serialLogFile: null, outputDir: os.tmpdir(), renderer: new TtyRenderer(out) }).done;
        expect({ label, code }).toEqual({ label, code: exit });
        expect(out.stderrText()).toContain(text);
        expect(srv.httpRequests).toEqual([{ path: '/api/pro/ci/whoami', authorization: `Bearer ${TOKEN}` }]);
      } finally {
        srv.stop();
      }
    }
  });

  test('cli_outdated is shown once: the server warning wins over the local check', async () => {
    const outdated = { code: 'cli_outdated', message: 'velxio-cli 0.1.0 is older than 1.0.0.', detail: { min_version: '1.0.0' } };
    for (const warnings of [[outdated], []]) {
      const srv = fakeServer((ws, msg, _state, send) => {
        if (msg.t === 'hello') send({ ...WELCOME, min_cli_version: '1.0.0', warnings });
        else if (msg.t === 'run.create') {
          send({ t: 'run.rejected', code: 'bad_request', message: 'stop here', hints: [] });
          ws.close(1008);
        }
      });
      const out = capture();
      try {
        expect(await startSession(request(), { server: srv.url, token: TOKEN, cliVersion: '0.1.0', timeoutExitCode: 42, interactive: false, serialLogFile: null, outputDir: os.tmpdir(), renderer: new JsonRenderer(out) }).done).toBe(2);
        const codes = out.stdoutText().trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.t === 'warning').map((l) => `${l.code}/${l.source}`);
        expect(codes).toEqual([warnings.length ? 'cli_outdated/server' : 'cli_outdated/cli']);
      } finally {
        srv.stop();
      }
    }
  });

  test('serial log: an unopenable path is a warning, not a crash; truncation is called out', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velxio-cli-log-'));
    const srv = fakeServer((ws, msg, _state, send) => {
      if (msg.t === 'hello') send(WELCOME);
      else if (msg.t === 'run.create') send({ t: 'run.accepted', run_id: 'r_6', budget_ms: 3000, reserved_ms: 3000, queue_position: 0, run_url: '/account/ci#r_6' });
      else if (msg.t === 'blobs.done') {
        send({ t: 'serial', board_id: 'uno', data_b64: b64('abc'), sim_us: 10 });
        send({ t: 'warning', code: 'serial_truncated', message: 'serial relay capped at 4 MiB' });
        send({ t: 'run.end', status: 'passed', reason: 'plan_complete', exit_code: 0, sim_ms: 100, wall_ms: 100, billed_ms: 1000, minutes_used_month_ms: 1, minutes_cap_ms: 2, run_url: '/account/ci#r_6' });
        ws.close(1000);
      }
    });
    try {
      const opts = { server: srv.url, token: TOKEN, cliVersion: '0.1.0', timeoutExitCode: 42, interactive: false, outputDir: outDir };
      // A directory where the log file should be: EISDIR at open.
      const out = capture();
      expect(await startSession({ ...request(), blobs: [] }, { ...opts, serialLogFile: outDir, renderer: new TtyRenderer(out) }).done).toBe(0);
      expect(out.stderrText()).toContain(`warning: cannot open ${outDir}`);
      expect(out.stdoutText()).toBe('abc');
      const out2 = capture();
      const log = path.join(outDir, 'serial.log');
      expect(await startSession({ ...request(), blobs: [] }, { ...opts, serialLogFile: log, renderer: new TtyRenderer(out2) }).done).toBe(0);
      expect(fs.readFileSync(log, 'utf8')).toBe('abc');
      expect(out2.stderrText()).toContain('serial.log holds the serial the server relays, so it stops at the same point');
    } finally {
      srv.stop();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('cancel with no run.end in time says where the run is finalised', async () => {
    const srv = fakeServer((_ws, msg, _state, send) => {
      if (msg.t === 'hello') send(WELCOME);
      else if (msg.t === 'run.create') send({ t: 'run.accepted', run_id: 'r_5', budget_ms: 3000, reserved_ms: 3000, queue_position: 0, run_url: '/account/ci#r_5' });
      else if (msg.t === 'blobs.done') send({ t: 'run.state', state: 'running', sim_ms: 0, wall_ms: 1 });
      // run.cancel is never answered.
    });
    const out = capture();
    try {
      const session = startSession({ ...request(), blobs: [] }, { server: srv.url, token: TOKEN, cliVersion: '0.1.0', timeoutExitCode: 42, interactive: false, serialLogFile: null, outputDir: os.tmpdir(), renderer: new TtyRenderer(out), cancelWaitMs: 300 });
      await new Promise((r) => setTimeout(r, 200));
      session.cancel();
      expect(await session.done).toBe(130);
      expect(srv.state.received.some((m) => m.t === 'run.cancel')).toBe(true);
      expect(out.stderrText()).toContain(`run r_5 is finalised server-side: ${srv.url}/account/ci#r_5`);
    } finally {
      srv.stop();
    }
  });

  test('cancel sends run.cancel and exits 130 on the cancelled run.end', async () => {
    const srv = fakeServer((ws, msg, _state, send) => {
      if (msg.t === 'hello') send(WELCOME);
      else if (msg.t === 'run.create') send({ t: 'run.accepted', run_id: 'r_3', budget_ms: 3000, reserved_ms: 3000, queue_position: 0, run_url: 'u' });
      else if (msg.t === 'blobs.done') send({ t: 'run.state', state: 'running', sim_ms: 0, wall_ms: 1 });
      else if (msg.t === 'run.cancel') {
        send({ t: 'run.end', status: 'cancelled', reason: 'user', exit_code: 130, sim_ms: 700, wall_ms: 900, billed_ms: 1000, minutes_used_month_ms: 1, minutes_cap_ms: 2, run_url: 'u' });
        ws.close(1000);
      }
    });
    const out = capture();
    try {
      const session = startSession({ ...request(), blobs: [] }, { server: srv.url, token: TOKEN, cliVersion: '0.1.0', timeoutExitCode: 42, interactive: false, serialLogFile: null, outputDir: os.tmpdir(), renderer: new TtyRenderer(out) });
      await new Promise((r) => setTimeout(r, 200));
      session.cancel();
      expect(await session.done).toBe(130);
      expect(srv.state.received.some((m) => m.t === 'run.cancel')).toBe(true);
      expect(out.stderrText()).toContain('CANCELLED (user)');
    } finally {
      srv.stop();
    }
  });

  test('interactive stdin is coalesced into serial.write frames', async () => {
    const writes: string[] = [];
    const srv = fakeServer((ws, msg, _state, send) => {
      if (msg.t === 'hello') send(WELCOME);
      else if (msg.t === 'run.create') send({ t: 'run.accepted', run_id: 'r_4', budget_ms: 3000, reserved_ms: 3000, queue_position: 0, run_url: 'u' });
      else if (msg.t === 'serial.write') {
        writes.push(Buffer.from(msg.data_b64 as string, 'base64').toString());
        send({ t: 'run.end', status: 'passed', reason: 'plan_complete', exit_code: 0, sim_ms: 100, wall_ms: 100, billed_ms: 1000, minutes_used_month_ms: 1, minutes_cap_ms: 2, run_url: 'u' });
        ws.close(1000);
      }
    });
    async function* stdin(): AsyncIterable<Uint8Array> {
      await new Promise((r) => setTimeout(r, 300));
      yield new TextEncoder().encode('h');
      yield new TextEncoder().encode('i\n');
    }
    try {
      const code = await startSession({ ...request(), blobs: [] }, { server: srv.url, token: TOKEN, cliVersion: '0.1.0', timeoutExitCode: 42, interactive: true, stdin: stdin(), serialLogFile: null, outputDir: os.tmpdir(), renderer: new TtyRenderer(capture()) }).done;
      expect(code).toBe(0);
      expect(writes).toEqual(['hi\n']);
    } finally {
      srv.stop();
    }
  });
});
