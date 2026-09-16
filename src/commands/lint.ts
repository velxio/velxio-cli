import { EXIT } from '../errors.ts';
import { prepareRun } from '../client/request.ts';
import type { Output } from '../ui/types.ts';
import { makeRenderer, reportError, type CommonOptions } from './common.ts';

export interface LintOptions extends CommonOptions {
  diagramFile?: string;
  projectFile?: string;
  firmware?: string;
  elf?: string;
  scenario?: string;
  expectText?: string;
  failText?: string;
  screenshotPart?: string;
  screenshotTime?: number;
  screenshotFile?: string;
  screenshotTolerance?: number;
}

/** Local checks only: no network, no token. Exit 0 or 2. */
export function lintCommand(dirArg: string, opts: LintOptions, out: Output): number {
  const r = makeRenderer(opts, out);
  try {
    const prepared = prepareRun(dirArg, {
      diagramFile: opts.diagramFile,
      projectFile: opts.projectFile,
      firmware: opts.firmware,
      elf: opts.elf,
      scenario: opts.scenario,
      expectText: opts.expectText,
      failText: opts.failText,
      timeout: 30000,
      interactive: false,
      screenshotPart: opts.screenshotPart,
      screenshotTime: opts.screenshotTime,
      screenshotFile: opts.screenshotFile,
      screenshotTolerance: opts.screenshotTolerance,
      allowUnsupported: false,
      source: 'cli',
      requireFirmware: false,
    });
    for (const w of prepared.warnings) r.warning(w, 'cli');
    if (r.json) {
      r.info('', { t: 'lint', ok: true, board: prepared.boardKind, checks: prepared.checks, warnings: prepared.warnings, blobs: prepared.request.blobs.map((b) => ({ name: b.name, size: b.bytes.length })), plan: prepared.request.create.plan });
    } else {
      for (const c of prepared.checks) r.info(`ok   ${c}`);
      r.info(`lint passed (${prepared.warnings.length} warning${prepared.warnings.length === 1 ? '' : 's'})`);
    }
    return EXIT.PASS;
  } catch (err) {
    return reportError(err, r);
  }
}
