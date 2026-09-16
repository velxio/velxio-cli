import type { LogMsg, RunAccepted, RunEnd, RunRejected, RunStateMsg, ScreenshotMsg, StepMsg, Welcome } from '../protocol/messages.ts';
import type { Warning } from '../errors.ts';

/** Where bytes go; the tests swap in buffers. */
export interface Output {
  stdout(data: Uint8Array | string): void;
  stderr(text: string): void;
}

export interface ProjectSummary {
  name: string;
  boardKind: string;
  partCount: number;
  firmwareLabel: string | null;
  steps: number;
}

/** One method per event; tty.ts and json.ts implement it. */
export interface Renderer {
  readonly json: boolean;
  welcome(w: Welcome, cliVersion: string): void;
  project(p: ProjectSummary): void;
  accepted(a: RunAccepted): void;
  state(s: RunStateMsg): void;
  serial(boardId: string, bytes: Uint8Array, simUs: number): void;
  step(s: StepMsg, description: string): void;
  screenshot(s: ScreenshotMsg, savedTo: string | null): void;
  warning(w: Warning, source: 'cli' | 'server'): void;
  log(l: LogMsg): void;
  end(e: RunEnd, exitCode: number): void;
  rejected(r: RunRejected, exitCode: number): void;
  error(message: string, hints: string[], code: string, exitCode: number): void;
  /** A status line (stderr in tty mode, a `note` object in json mode). */
  note(text: string): void;
  /** A plain result line for the non-run commands (whoami, boards, lint). */
  info(text: string, jsonValue?: unknown): void;
}

export const realOutput: Output = {
  stdout(data) {
    process.stdout.write(data);
  },
  stderr(text) {
    process.stderr.write(text);
  },
};

export function fmtSimUs(us: number): string {
  return `${(us / 1_000_000).toFixed(3)} s`;
}

export function fmtSimMs(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtMinutes(ms: number): string {
  const min = ms / 60_000;
  return Number.isInteger(min) ? String(min) : min.toFixed(1);
}
