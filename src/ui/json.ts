import type { LogMsg, RunAccepted, RunEnd, RunRejected, RunStateMsg, ScreenshotMsg, StepMsg, Welcome } from '../protocol/messages.ts';
import type { Warning } from '../errors.ts';
import type { Output, ProjectSummary, Renderer } from './types.ts';

/** `--json`: one object per line on stdout for every event, nothing else. */
export class JsonRenderer implements Renderer {
  readonly json = true;

  constructor(private readonly out: Output) {}

  private emit(obj: Record<string, unknown>): void {
    this.out.stdout(JSON.stringify(obj) + '\n');
  }

  welcome(w: Welcome, cliVersion: string): void {
    this.emit({ t: 'welcome', cli_version: cliVersion, plan: w.plan, user: w.user, minutes: w.minutes, limits: w.limits, min_cli_version: w.min_cli_version, warnings: w.warnings });
  }

  project(p: ProjectSummary): void {
    this.emit({ t: 'project', name: p.name, board: p.boardKind, parts: p.partCount, firmware: p.firmwareLabel, steps: p.steps });
  }

  accepted(a: RunAccepted): void {
    this.emit({ t: 'accepted', run_id: a.run_id, budget_ms: a.budget_ms, reserved_ms: a.reserved_ms, queue_position: a.queue_position, run_url: a.run_url });
  }

  state(s: RunStateMsg): void {
    this.emit({ t: 'state', state: s.state, sim_ms: s.sim_ms, wall_ms: s.wall_ms, ...(s.queue_position !== undefined ? { queue_position: s.queue_position } : {}) });
  }

  serial(boardId: string, bytes: Uint8Array, simUs: number): void {
    this.emit({ t: 'serial', board_id: boardId, data_b64: Buffer.from(bytes).toString('base64'), sim_us: simUs });
  }

  step(s: StepMsg, description: string): void {
    this.emit({ t: 'step', index: s.index, kind: s.kind, ok: s.ok, sim_us: s.sim_us, description, ...(s.detail !== undefined ? { detail: s.detail } : {}) });
  }

  screenshot(s: ScreenshotMsg, savedTo: string | null): void {
    this.emit({ t: 'screenshot', name: s.name, part_id: s.part_id, sim_us: s.sim_us, size: s.size, kind: s.kind, file: savedTo });
  }

  warning(w: Warning, source: 'cli' | 'server'): void {
    this.emit({ t: 'warning', code: w.code, message: w.message, source, ...(w.detail !== undefined ? { detail: w.detail } : {}) });
  }

  log(l: LogMsg): void {
    this.emit({ t: 'log', level: l.level, message: l.message });
  }

  end(e: RunEnd, exitCode: number): void {
    this.emit({
      t: 'end',
      status: e.status,
      reason: e.reason,
      ...(e.reason_detail !== undefined ? { reason_detail: e.reason_detail } : {}),
      exit_code: exitCode,
      sim_ms: e.sim_ms,
      wall_ms: e.wall_ms,
      billed_ms: e.billed_ms,
      minutes_used_month_ms: e.minutes_used_month_ms,
      minutes_cap_ms: e.minutes_cap_ms,
      run_url: e.run_url,
    });
  }

  rejected(r: RunRejected, exitCode: number): void {
    this.emit({ t: 'rejected', code: r.code, message: r.message, hints: r.hints ?? [], detail: r.detail ?? null, exit_code: exitCode });
  }

  error(message: string, hints: string[], code: string, exitCode: number): void {
    this.emit({ t: 'error', code, message, hints, exit_code: exitCode });
  }

  note(text: string): void {
    this.emit({ t: 'note', message: text });
  }

  info(text: string, jsonValue?: unknown): void {
    if (jsonValue !== undefined) this.out.stdout(JSON.stringify(jsonValue) + '\n');
    else this.emit({ t: 'info', message: text });
  }
}
