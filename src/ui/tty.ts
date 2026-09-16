import type { LogMsg, RunAccepted, RunEnd, RunRejected, RunStateMsg, ScreenshotMsg, StepMsg, Welcome } from '../protocol/messages.ts';
import type { Warning } from '../errors.ts';
import { fmtMinutes, fmtSimMs, fmtSimUs, type Output, type ProjectSummary, type Renderer } from './types.ts';

/**
 * Human transcript. Serial bytes go to stdout untouched; everything else is
 * a status line on stderr. `quiet` keeps only serial and errors.
 */
export class TtyRenderer implements Renderer {
  readonly json = false;
  private lastState: string | null = null;
  private lastQueuePos: number | null = null;

  constructor(
    private readonly out: Output,
    private readonly quiet = false,
  ) {}

  private line(text: string): void {
    if (!this.quiet) this.out.stderr(text + '\n');
  }

  welcome(w: Welcome, cliVersion: string): void {
    const resets = w.minutes.resets_at ? ` (resets ${w.minutes.resets_at.slice(0, 10)})` : '';
    this.line(`velxio-cli ${cliVersion} · plan ${w.plan} · ${fmtMinutes(w.minutes.remaining_ms)} of ${fmtMinutes(w.minutes.cap_ms)} min left${resets}`);
  }

  project(p: ProjectSummary): void {
    const fw = p.firmwareLabel ? ` · firmware ${p.firmwareLabel}` : '';
    const steps = p.steps ? ` · ${p.steps} step${p.steps === 1 ? '' : 's'}` : '';
    this.line(`project ${p.name} (${p.boardKind}, ${p.partCount} part${p.partCount === 1 ? '' : 's'})${fw}${steps}`);
  }

  accepted(a: RunAccepted): void {
    this.lastState = 'queued';
    this.lastQueuePos = a.queue_position;
    this.line(`run ${a.run_id} queued (position ${a.queue_position}) · budget ${fmtSimMs(a.budget_ms).replace(/\.(\d)0 s$/, '.$1 s')} simulated`);
  }

  state(s: RunStateMsg): void {
    if (s.state === this.lastState && (s.queue_position ?? null) === this.lastQueuePos) return;
    this.lastState = s.state;
    this.lastQueuePos = s.queue_position ?? null;
    if (s.state === 'queued') this.line(`queued (position ${s.queue_position ?? '?'})`);
    else if (s.state === 'loading') this.line('loading');
    else if (s.state === 'running') this.line('running');
  }

  serial(_boardId: string, bytes: Uint8Array): void {
    this.out.stdout(bytes);
  }

  step(s: StepMsg, description: string): void {
    const tag = s.ok ? 'ok  ' : 'FAIL';
    const detail = s.detail ? `: ${s.detail}` : '';
    this.line(`${tag} ${description} at ${fmtSimUs(s.sim_us)}${detail}`);
  }

  screenshot(s: ScreenshotMsg, savedTo: string | null): void {
    const where = savedTo ?? '(not saved)';
    const kind = s.kind === 'diff' ? 'diff ' : 'shot ';
    this.line(`${kind}${s.part_id} -> ${where} (${fmtSimUs(s.sim_us)})`);
  }

  warning(w: Warning): void {
    this.line(`warning: ${w.message}${w.code && !w.message.includes(w.code) ? ` [${w.code}]` : ''}`);
  }

  log(l: LogMsg): void {
    this.line(`[${l.level}] ${l.message}`);
  }

  end(e: RunEnd, exitCode: number): void {
    const head =
      e.status === 'passed' ? 'PASS' :
      e.status === 'failed' ? `FAIL (${e.reason})` :
      e.status === 'timeout' ? 'TIMEOUT' :
      e.status === 'cancelled' ? `CANCELLED (${e.reason})` :
      e.status === 'lost' ? `LOST (${e.reason})` :
      `ERROR (${e.reason})`;
    const detail = e.reason_detail ? ` ${e.reason_detail} ·` : '';
    const when = e.status === 'timeout' ? `after ${fmtSimMs(e.sim_ms)} simulated` : `in ${fmtSimMs(e.sim_ms)} simulated`;
    const billed = `billed ${Math.round(e.billed_ms / 1000)} s`;
    const url = e.run_url ? ` · ${e.run_url}` : '';
    this.line(`${head}${detail} ${when} (${(e.wall_ms / 1000).toFixed(1)} s wall) · ${billed}${url} · exit ${exitCode}`);
  }

  rejected(r: RunRejected, exitCode: number): void {
    this.out.stderr(`rejected (${r.code}): ${r.message}\n`);
    for (const h of r.hints ?? []) this.out.stderr(`  hint: ${h}\n`);
    if (r.detail && Object.keys(r.detail).length) this.out.stderr(`  detail: ${JSON.stringify(r.detail)}\n`);
    this.out.stderr(`exit ${exitCode}\n`);
  }

  error(message: string, hints: string[], code: string, exitCode: number): void {
    this.out.stderr(`error${code && code !== 'config' ? ` (${code})` : ''}: ${message}\n`);
    for (const h of hints) this.out.stderr(`  hint: ${h}\n`);
    this.out.stderr(`exit ${exitCode}\n`);
  }

  note(text: string): void {
    this.line(text);
  }

  info(text: string): void {
    this.out.stdout(text + '\n');
  }
}
