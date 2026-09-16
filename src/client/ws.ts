import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT } from '../errors.ts';
import { wsUrl } from '../credentials.ts';
import { BLOB_CHUNK_BYTES, SUBPROTOCOL, WS_PATH, type ClientMessage, type RunCreate, type ScreenshotMsg, type ServerMessage } from '../protocol/messages.ts';
import { describeClose, exitCodeForClose, exitCodeForEnd, exitCodeForReject } from '../protocol/exitCodes.ts';
import { diagnoseRefusedSocket } from './handshake.ts';
import type { ScreenshotSpec } from '../scenario/scenario.ts';
import type { ProjectSummary, Renderer } from '../ui/types.ts';

export interface Blob {
  name: string;
  bytes: Uint8Array;
}

export interface RunRequest {
  create: RunCreate;
  blobs: Blob[];
  screenshots: ScreenshotSpec[];
  /** Human description per plan step index, for the transcript. */
  stepDescriptions: string[];
}

export interface SessionOptions {
  server: string;
  token: string;
  cliVersion: string;
  timeoutExitCode: number;
  interactive: boolean;
  serialLogFile: string | null;
  /** Relative screenshot paths resolve against this directory. */
  outputDir: string;
  renderer: Renderer;
  /** Rendered right after the welcome banner, so the transcript reads top-down. */
  projectSummary?: ProjectSummary;
  /** Interactive input; chunks are coalesced per 20 ms into serial.write. */
  stdin?: AsyncIterable<Uint8Array> | null;
  welcomeTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** How long Ctrl-C waits for the cancelled run.end (default 5 s). */
  cancelWaitMs?: number;
}

export interface Session {
  done: Promise<number>;
  /** Ctrl-C: run.cancel, wait up to 5 s for run.end, exit 130. */
  cancel(): void;
}

type Phase = 'connecting' | 'hello' | 'welcomed' | 'accepted' | 'uploading' | 'running' | 'ended';

export function sha256Hex(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher('sha256');
  h.update(bytes);
  return h.digest('hex');
}

function semverLess(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false;
  }
  return false;
}

/**
 * One WebSocket per run: hello -> welcome -> run.create -> run.accepted ->
 * blobs (4 MiB chunks, blob.ack each) -> blobs.done -> events -> run.end.
 * Resolves with the process exit code; never throws after connect.
 */
export function startSession(req: RunRequest, opts: SessionOptions): Session {
  const r = opts.renderer;
  let phase: Phase = 'connecting';
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => (resolveDone = resolve));
  let finished = false;
  let cancelledByUser = false;
  let expectBinary: ScreenshotMsg | null = null;
  let pendingAck: string | null = null;
  let blobIndex = 0;
  let serialLog: fs.WriteStream | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelTimer: ReturnType<typeof setTimeout> | null = null;
  let runId: string | null = null;
  let runUrl: string | null = null;
  const shotByName = new Map(req.screenshots.map((s) => [s.name, s]));

  const url = wsUrl(opts.server, WS_PATH);
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, {
      protocols: [SUBPROTOCOL],
      headers: { Authorization: `Bearer ${opts.token}`, 'X-Velxio-Cli-Version': opts.cliVersion },
    } as unknown as string[]);
  } catch (err) {
    r.error(`cannot open ${url}: ${(err as Error).message}`, [], 'connect', EXIT.SERVER);
    queueMicrotask(() => resolveDone(EXIT.SERVER));
    return { done, cancel() {} };
  }
  ws.binaryType = 'arraybuffer';

  function finish(code: number): void {
    if (finished) return;
    finished = true;
    phase = 'ended';
    if (idleTimer) clearTimeout(idleTimer);
    if (welcomeTimer) clearTimeout(welcomeTimer);
    if (cancelTimer) clearTimeout(cancelTimer);
    if (serialLog) {
      const log = serialLog;
      serialLog = null;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolveDone(code);
      };
      log.once('error', settle);
      log.end(settle);
    } else {
      resolveDone(code);
    }
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
    } catch {
      // already closed
    }
  }

  /** The API sends run_url relative to the site ("/account/ci#r_..."). */
  function absoluteUrl(u: string): string {
    if (!u) return u;
    try {
      return new URL(u, opts.server).toString();
    } catch {
      return u;
    }
  }

  function send(msg: ClientMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  function touchIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    const ms = opts.idleTimeoutMs ?? 60_000;
    idleTimer = setTimeout(() => {
      if (finished) return;
      r.error(`no frames from the server for ${Math.round(ms / 1000)} s; giving up`, [], 'runner_lost', EXIT.SERVER);
      finish(EXIT.SERVER);
    }, ms);
  }

  function sendNextBlob(): void {
    if (blobIndex >= req.blobs.length) {
      pendingAck = null;
      send({ t: 'blobs.done' });
      phase = 'running';
      startInteractive();
      return;
    }
    const blob = req.blobs[blobIndex++]!;
    const chunks = Math.max(1, Math.ceil(blob.bytes.length / BLOB_CHUNK_BYTES));
    pendingAck = blob.name;
    send({ t: 'blob', name: blob.name, size: blob.bytes.length, sha256: sha256Hex(blob.bytes), chunks });
    for (let i = 0; i < chunks; i++) {
      const start = i * BLOB_CHUNK_BYTES;
      ws.send(blob.bytes.subarray(start, Math.min(blob.bytes.length, start + BLOB_CHUNK_BYTES)));
    }
  }

  function screenshotPath(name: string, kind: 'png' | 'diff'): string | null {
    const spec = shotByName.get(name);
    let target: string | null = spec?.saveTo ?? null;
    if (!target && kind === 'diff' && spec?.compareWith) target = spec.compareWith;
    if (!target) return null;
    if (kind === 'diff') target = target.replace(/\.png$/i, '') + '.diff.png';
    return path.resolve(opts.outputDir, target);
  }

  // stdin -> serial.write, coalesced per 20 ms; a closed stdin ends input only.
  let interactiveStarted = false;
  function startInteractive(): void {
    if (!opts.interactive || !opts.stdin || interactiveStarted) return;
    interactiveStarted = true;
    const stdin = opts.stdin;
    let pending: Uint8Array[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (!pending.length || phase !== 'running') return;
      const total = pending.reduce((n, c) => n + c.length, 0);
      const all = new Uint8Array(total);
      let off = 0;
      for (const c of pending) {
        all.set(c, off);
        off += c.length;
      }
      pending = [];
      send({ t: 'serial.write', data_b64: Buffer.from(all).toString('base64') });
    };
    (async () => {
      try {
        for await (const chunk of stdin) {
          if (finished) break;
          pending.push(chunk);
          if (!flushTimer) flushTimer = setTimeout(flush, 20);
        }
      } catch {
        // stdin closed or unreadable: interactive input ends, the run does not.
      }
    })();
  }

  function onServerMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome': {
        if (welcomeTimer) clearTimeout(welcomeTimer);
        phase = 'welcomed';
        r.welcome(msg, opts.cliVersion);
        if (opts.projectSummary) r.project(opts.projectSummary);
        for (const w of msg.warnings ?? []) r.warning(w, 'server');
        const serverSaidOutdated = (msg.warnings ?? []).some((w) => w.code === 'cli_outdated');
        if (!serverSaidOutdated && msg.min_cli_version && semverLess(opts.cliVersion, msg.min_cli_version)) {
          r.warning({ code: 'cli_outdated', message: `this CLI is ${opts.cliVersion}; the server wants at least ${msg.min_cli_version}` }, 'cli');
        }
        send(req.create);
        break;
      }
      case 'ping':
        send({ t: 'pong' });
        break;
      case 'run.rejected': {
        const code = exitCodeForReject(msg.code);
        r.rejected(msg, code);
        finish(code);
        break;
      }
      case 'run.accepted':
        phase = 'accepted';
        runId = msg.run_id;
        runUrl = absoluteUrl(msg.run_url);
        r.accepted({ ...msg, run_url: runUrl });
        phase = 'uploading';
        sendNextBlob();
        break;
      case 'blob.ack':
        if (pendingAck && msg.name === pendingAck) sendNextBlob();
        break;
      case 'run.state':
        r.state(msg);
        break;
      case 'serial': {
        const bytes = new Uint8Array(Buffer.from(msg.data_b64, 'base64'));
        if (serialLog) serialLog.write(bytes);
        r.serial(msg.board_id, bytes, msg.sim_us);
        break;
      }
      case 'step':
        r.step(msg, req.stepDescriptions[msg.index] ?? msg.kind);
        break;
      case 'screenshot':
        expectBinary = msg;
        break;
      case 'warning':
        r.warning({ code: msg.code, message: msg.message, detail: msg.detail }, 'server');
        if (opts.serialLogFile && (msg.code === 'serial_truncated' || msg.code === 'serial_dropped')) {
          const what = msg.code === 'serial_truncated' ? 'stops at the same point' : 'misses the dropped chunks too';
          r.warning({ code: 'serial_log', message: `${path.basename(opts.serialLogFile)} holds the serial the server relays, so it ${what}` }, 'cli');
        }
        break;
      case 'log':
        r.log(msg);
        break;
      case 'run.end': {
        const code = exitCodeForEnd(msg, { timeoutExitCode: opts.timeoutExitCode, cancelledByUser });
        r.end({ ...msg, run_url: absoluteUrl(msg.run_url) }, code);
        finish(code);
        break;
      }
      case 'error':
        r.error(`${msg.message}`, [], msg.code, EXIT.SERVER);
        finish(EXIT.SERVER);
        break;
      default:
        r.warning({ code: 'unknown_frame', message: `unknown frame from the server: ${(msg as { t: string }).t}` }, 'cli');
    }
  }

  function onBinary(data: Uint8Array): void {
    const msg = expectBinary;
    expectBinary = null;
    if (!msg) {
      r.warning({ code: 'unexpected_binary', message: `unexpected binary frame of ${data.length} bytes` }, 'cli');
      return;
    }
    if (data.length !== msg.size) {
      r.warning({ code: 'screenshot_size', message: `screenshot ${msg.name}: expected ${msg.size} bytes, got ${data.length}` }, 'cli');
    }
    const target = screenshotPath(msg.name, msg.kind);
    let saved: string | null = null;
    if (target) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
        saved = path.relative(opts.outputDir, target) || target;
      } catch (err) {
        r.warning({ code: 'screenshot_write', message: `cannot write ${target}: ${(err as Error).message}` }, 'cli');
      }
    }
    r.screenshot(msg, saved);
  }

  ws.onopen = () => {
    phase = 'hello';
    if (opts.serialLogFile) {
      const file = opts.serialLogFile;
      try {
        // Opened synchronously so EACCES / EISDIR land in this catch, not in
        // an unhandled stream error after the run has started.
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const stream = fs.createWriteStream(file, { fd: fs.openSync(file, 'w') });
        stream.on('error', (err) => {
          if (serialLog !== stream) return;
          serialLog = null;
          r.warning({ code: 'serial_log', message: `cannot write ${file}: ${err.message}; the serial log stops here` }, 'cli');
        });
        serialLog = stream;
      } catch (err) {
        r.warning({ code: 'serial_log', message: `cannot open ${opts.serialLogFile}: ${(err as Error).message}` }, 'cli');
      }
    }
    send({ t: 'hello', proto: 1, cli_version: opts.cliVersion, os: os.platform(), arch: os.arch() });
    touchIdle();
    welcomeTimer = setTimeout(() => {
      if (phase === 'hello' && !finished) {
        r.error('no welcome from the server', [], 'no_welcome', EXIT.SERVER);
        finish(EXIT.SERVER);
      }
    }, opts.welcomeTimeoutMs ?? 15_000);
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (finished) return;
    touchIdle();
    const data = ev.data as unknown;
    if (typeof data === 'string') {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(data) as ServerMessage;
      } catch {
        r.warning({ code: 'bad_frame', message: 'unparseable text frame from the server' }, 'cli');
        return;
      }
      onServerMessage(msg);
    } else if (data instanceof ArrayBuffer) {
      onBinary(new Uint8Array(data));
    } else if (ArrayBuffer.isView(data)) {
      onBinary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  };

  ws.onerror = () => {
    // The close event that follows carries the code; nothing to do here.
  };

  ws.onclose = (ev: CloseEvent) => {
    if (finished) return;
    const refusedCode = ev.code === 4401 || ev.code === 4402 || ev.code === 4429 || ev.code === 4503;
    if (phase === 'connecting' && !refusedCode) {
      // Never opened: an HTTP refusal of the upgrade (uvicorn turns the
      // pre-accept 44xx close into a 403) or an unreachable server.
      void diagnoseRefusedSocket(opts.server, opts.token, opts.cliVersion, ev.code, ev.reason).then((f) => {
        if (finished) return;
        r.error(f.message, f.hints, f.code, f.exitCode);
        finish(f.exitCode);
      });
      return;
    }
    if (phase === 'connecting' || phase === 'hello' || phase === 'welcomed') {
      const code = exitCodeForClose(ev.code);
      const hints: string[] = [];
      if (ev.code === 4401) hints.push('check VELXIO_CLI_TOKEN, or mint a new token at /account/ci');
      if (ev.code === 4402) hints.push('CI minutes need the Maker plan or above: /pricing?from=ci');
      r.error(describeClose(ev.code, ev.reason), hints, ev.code === 4401 || ev.code === 4402 ? 'auth' : 'connect', code);
      finish(code);
      return;
    }
    if (cancelledByUser) {
      finish(EXIT.INTERRUPT);
      return;
    }
    r.error(`connection lost before run.end: ${describeClose(ev.code, ev.reason)}`, [], 'runner_lost', EXIT.SERVER);
    finish(EXIT.SERVER);
  };

  return {
    done,
    cancel() {
      if (finished) return;
      if (cancelledByUser) {
        finish(EXIT.INTERRUPT);
        return;
      }
      cancelledByUser = true;
      r.note('cancelling (Ctrl-C again to force)');
      if (phase === 'uploading' || phase === 'running' || phase === 'accepted') {
        send({ t: 'run.cancel' });
        const waitMs = opts.cancelWaitMs ?? 5_000;
        cancelTimer = setTimeout(() => {
          const where = runId ? `run ${runId} is finalised server-side${runUrl ? `: ${runUrl}` : ''}` : 'the server finalises the run';
          r.note(`cancel sent; no final report within ${Math.round(waitMs / 1000)} s, ${where}`);
          finish(EXIT.INTERRUPT);
        }, waitMs);
      } else {
        finish(EXIT.INTERRUPT);
      }
    },
  };
}
