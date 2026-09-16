/** Process exit codes. Stable: documented in docs/exit-codes.md. */
export const EXIT = {
  PASS: 0,
  FAIL: 1,
  CONFIG: 2,
  AUTH: 3,
  QUOTA: 4,
  SERVER: 5,
  TIMEOUT_DEFAULT: 42,
  INTERRUPT: 130,
} as const;

/** A warning the run continues through (rendered to stderr or as --json). */
export interface Warning {
  code: string;
  message: string;
  detail?: unknown;
}

/**
 * Anything that stops the CLI before the run ends. `exitCode` is the process
 * exit code; `code` is a short machine-readable tag (mirrors the server's
 * reject codes where one applies); `hints` are printed one per line.
 */
export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly hints: string[];

  constructor(message: string, opts: { exitCode?: number; code?: string; hints?: string[] } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = opts.exitCode ?? EXIT.CONFIG;
    this.code = opts.code ?? 'config';
    this.hints = opts.hints ?? [];
  }
}

export function configError(message: string, hints: string[] = [], code = 'config'): CliError {
  return new CliError(message, { exitCode: EXIT.CONFIG, code, hints });
}
