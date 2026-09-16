import path from 'node:path';
import { CliError, EXIT } from '../errors.ts';
import { resolveServer, resolveToken } from '../credentials.ts';
import { prepareRun } from '../client/request.ts';
import { startSession, type Session } from '../client/ws.ts';
import { VERSION } from '../version.ts';
import type { Output } from '../ui/types.ts';
import { makeRenderer, reportError, type CommonOptions } from './common.ts';

export interface RunOptions extends CommonOptions {
  elf?: string;
  firmware?: string;
  diagramFile?: string;
  projectFile?: string;
  scenario?: string;
  expectText?: string;
  failText?: string;
  timeout: number;
  timeoutExitCode: number;
  interactive?: boolean;
  serialLogFile?: string;
  screenshotPart?: string;
  screenshotTime?: number;
  screenshotFile?: string;
  screenshotTolerance?: number;
  vcdFile?: string;
  allowUnsupported?: boolean;
}

export interface RunIo {
  out: Output;
  stdin?: AsyncIterable<Uint8Array> | null;
  stdinIsTTY: boolean;
  env?: NodeJS.ProcessEnv;
  /** cli.ts binds Ctrl-C to the session it gets here. */
  onSession?: (s: Session) => void;
}

export async function runCommand(dirArg: string, opts: RunOptions, io: RunIo): Promise<number> {
  const r = makeRenderer(opts, io.out);
  const env = io.env ?? process.env;
  try {
    if (opts.vcdFile) {
      throw new CliError('--vcd-file is not supported yet (arrives in phase 4)', { exitCode: EXIT.CONFIG, code: 'feature_unsupported', hints: ['drop --vcd-file to run without a VCD trace'] });
    }
    const token = resolveToken(opts.token, env);
    const server = resolveServer(opts.server, env);
    const prepared = prepareRun(dirArg, {
      diagramFile: opts.diagramFile,
      projectFile: opts.projectFile,
      firmware: opts.firmware,
      elf: opts.elf,
      scenario: opts.scenario,
      expectText: opts.expectText,
      failText: opts.failText,
      timeout: opts.timeout,
      interactive: !!opts.interactive,
      screenshotPart: opts.screenshotPart,
      screenshotTime: opts.screenshotTime,
      screenshotFile: opts.screenshotFile,
      screenshotTolerance: opts.screenshotTolerance,
      allowUnsupported: !!opts.allowUnsupported,
      source: env.VELXIO_CLI_SOURCE === 'action' ? 'action' : 'cli',
      requireFirmware: true,
    });
    for (const w of prepared.warnings) r.warning(w, 'cli');
    if (opts.interactive && !io.stdinIsTTY) r.warning({ code: 'interactive_no_tty', message: '--interactive without a terminal: stdin is forwarded until it closes' }, 'cli');
    if (opts.interactive && prepared.request.create.plan.some((s) => s.kind === 'write-serial')) {
      r.note('interactive input and scenario write-serial steps share the primary UART in arrival order');
    }
    const serialLogFile = opts.serialLogFile ? path.resolve(prepared.project.dir, opts.serialLogFile) : null;
    const session = startSession(prepared.request, {
      server,
      token,
      cliVersion: VERSION,
      timeoutExitCode: opts.timeoutExitCode,
      interactive: !!opts.interactive,
      serialLogFile,
      outputDir: prepared.project.dir,
      renderer: r,
      projectSummary: prepared.summary,
      stdin: opts.interactive ? io.stdin ?? null : null,
    });
    io.onSession?.(session);
    return await session.done;
  } catch (err) {
    return reportError(err, r);
  }
}
