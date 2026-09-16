import fs from 'node:fs';
import path from 'node:path';
import { configError, type Warning } from '../errors.ts';
import { LIMITS, type BoardCapability } from '../capabilities/index.ts';
import { resolveProject, resolvePath, type ResolvedProject, type ResolveFlags } from '../config/resolve.ts';
import { analyseDiagram, parseDiagram } from '../diagram/wokwi.ts';
import { analyseVlx, parseVlx } from '../vlx/vlx.ts';
import { appendFlagSteps, EMPTY_PLAN, parseScenarioText, type ScenarioPlan } from '../scenario/scenario.ts';
import { formatSize, prepareFirmware, prepareFirmwareForUnknownBoard } from '../firmware/detect.ts';
import { BLOB_NAME_RE, type PlanStep, type ProjectBundle, type RunCreate } from '../protocol/messages.ts';
import type { ProjectSummary } from '../ui/types.ts';
import type { Blob, RunRequest } from './ws.ts';

export interface RunFlags extends ResolveFlags {
  expectText?: string;
  failText?: string;
  timeout: number;
  interactive: boolean;
  screenshotPart?: string;
  screenshotTime?: number;
  screenshotFile?: string;
  screenshotTolerance?: number;
  allowUnsupported: boolean;
  source: 'cli' | 'action';
  /** lint may pass without firmware; run may not. */
  requireFirmware: boolean;
}

export interface PreparedRun {
  project: ResolvedProject;
  request: RunRequest;
  summary: ProjectSummary;
  warnings: Warning[];
  boardKind: string;
  /** Lint lines: what was checked and found good. */
  checks: string[];
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function fileSize(p: string, cap: number, what: string): number {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw configError(`${what} not found: ${p}`);
  }
  if (st.size > cap) throw configError(`${what} ${p} is ${st.size} bytes, over the ${cap} byte cap`);
  return st.size;
}

function blobName(prefix: string, id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_');
  const name = `${prefix}${safe}`.slice(0, 64);
  if (!BLOB_NAME_RE.test(name)) throw configError(`cannot derive a blob name from board id "${id}"`);
  return name;
}

export function describeStep(s: PlanStep, screenshotTarget?: string | null): string {
  switch (s.kind) {
    case 'delay':
      return `delay ${s.us >= 1000 ? `${s.us / 1000} ms` : `${s.us} us`}`;
    case 'wait-serial':
      return `wait-serial ${JSON.stringify(s.text)}`;
    case 'write-serial':
      return `write-serial ${Buffer.from(s.data_b64, 'base64').length} bytes`;
    case 'expect-pin':
      return `expect-pin ${s.part_id}:${s.pin} expected ${s.expected}`;
    case 'set-control':
      return `set-control ${s.part_id}.${s.control} = ${JSON.stringify(s.value)}`;
    case 'take-screenshot':
      return `take-screenshot ${s.part_id}${screenshotTarget ? ` -> ${screenshotTarget}` : ''}${s.compare_blob ? ' (compare)' : ''}`;
  }
}

/**
 * Everything `run` needs before the socket opens, which is also everything
 * `lint` checks: config, circuit, board, scenario, firmware, sizes.
 */
export function prepareRun(dirArg: string, flags: RunFlags): PreparedRun {
  const project = resolveProject(dirArg, flags);
  const warnings: Warning[] = [...project.warnings];
  const checks: string[] = [];
  const rel = (p: string) => path.relative(project.dir, p) || path.basename(p);
  checks.push(project.configPath ? `config ${rel(project.configPath)}` : `config ${rel(project.circuit.path)} (single .vlx)`);

  // Circuit.
  let bundle: ProjectBundle;
  let boards: Array<{ id: string; kind: string; capability: BoardCapability | undefined }>;
  let primaryId: string;
  let partIds: string[];
  const circuitFile = rel(project.circuit.path);
  fileSize(project.circuit.path, LIMITS.max_diagram_bytes, 'circuit');
  if (project.circuit.kind === 'diagram') {
    const diagram = parseDiagram(fs.readFileSync(project.circuit.path, 'utf8'), circuitFile);
    const a = analyseDiagram(diagram, circuitFile);
    warnings.push(...a.warnings);
    boards = a.boards;
    partIds = a.partIds;
    bundle = { kind: 'wokwi', diagram };
    if (project.board) {
      const match = boards.find((b) => b.kind === project.board);
      if (!match) {
        throw configError(`velxio.toml says board = "${project.board}" but ${circuitFile} has ${boards.map((b) => `${b.id} (${b.kind})`).join(', ')}`);
      }
      primaryId = match.id;
    } else {
      primaryId = boards[0]!.id;
    }
  } else {
    const payload = parseVlx(fs.readFileSync(project.circuit.path, 'utf8'), circuitFile);
    const a = analyseVlx(payload, circuitFile);
    warnings.push(...a.warnings);
    boards = a.boards;
    partIds = a.partIds;
    primaryId = a.primaryBoardId;
    bundle = { kind: 'vlx', payload };
    if (project.board) {
      const primary = boards.find((b) => b.id === primaryId)!;
      if (primary.kind !== project.board) {
        throw configError(`velxio.toml says board = "${project.board}" but the .vlx active board "${primary.id}" is ${primary.kind}`);
      }
    }
  }
  // A primary board without a capability only gets here once the snapshot is
  // stale (analyse* refuse it while fresh): its firmware goes unconverted.
  const primary = boards.find((b) => b.id === primaryId)!;
  if (boards.length > 1) {
    warnings.push({ code: 'multi_board', message: `${boards.length} boards in the circuit; firmware loads on "${primary.id}" (${primary.kind}) only` });
  }
  checks.push(`circuit ${circuitFile} (${primary.kind}, ${partIds.length} part${partIds.length === 1 ? '' : 's'})`);

  // Scenario + flags.
  const partSet = new Set(partIds);
  let plan: ScenarioPlan = EMPTY_PLAN;
  if (project.scenario) {
    const scenarioFile = rel(project.scenario);
    fileSize(project.scenario, LIMITS.max_scenario_bytes, 'scenario');
    plan = parseScenarioText(fs.readFileSync(project.scenario, 'utf8'), { partIds: partSet, tolerancePct: flags.screenshotTolerance ?? 0.5, file: scenarioFile });
    warnings.push(...plan.warnings);
  }
  plan = appendFlagSteps(plan, flags, partSet);
  if (project.scenario) checks.push(`scenario ${rel(project.scenario)} (${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'})`);
  if (flags.failText !== undefined && !flags.failText) throw configError('--fail-text must not be empty');
  if (flags.failText !== undefined && Buffer.byteLength(flags.failText) > LIMITS.max_text_bytes) {
    throw configError(`--fail-text is ${Buffer.byteLength(flags.failText)} bytes, over the ${LIMITS.max_text_bytes} byte limit`, [], 'scenario_invalid');
  }
  if (!Number.isInteger(flags.timeout) || flags.timeout <= 0) throw configError('--timeout must be a positive number of simulated milliseconds');

  // Blobs: compare-with PNGs and the firmware.
  const blobs: Blob[] = [];
  for (const shot of plan.screenshots) {
    if (!shot.compareWith || !shot.compareBlob) continue;
    let p = resolvePath(project.dir, shot.compareWith);
    if (!fs.existsSync(p) && project.scenario) p = resolvePath(path.dirname(project.scenario), shot.compareWith);
    fileSize(p, LIMITS.max_png_bytes, 'compare-with PNG');
    const bytes = new Uint8Array(fs.readFileSync(p));
    if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) throw configError(`compare-with ${shot.compareWith} is not a PNG`);
    blobs.push({ name: shot.compareBlob, bytes });
  }

  let firmwareLabel: string | null = null;
  const firmwareManifest: RunCreate['firmware'] = [];
  if (project.firmware) {
    const fw = primary.capability ? prepareFirmware(project.firmware, primary.capability) : prepareFirmwareForUnknownBoard(project.firmware, primary.kind);
    warnings.push(...fw.warnings);
    const name = blobName('fw-', primary.id);
    blobs.push({ name, bytes: fw.bytes });
    firmwareManifest.push({ board_id: primary.id, blob: name, format: fw.format });
    firmwareLabel = `${rel(project.firmware.path)} (${fw.description}, ${formatSize(fw.bytes.length)})`;
    checks.push(`firmware ${firmwareLabel} -> ${fw.format}`);
  } else if (flags.requireFirmware) {
    throw configError('no firmware: pass --firmware or --elf, or set [velxio] firmware / flasher_args in velxio.toml');
  } else {
    warnings.push({ code: 'no_firmware', message: 'no firmware configured; `run` needs --firmware, --elf or [velxio] firmware' });
  }

  const total = blobs.reduce((n, b) => n + b.bytes.length, 0);
  if (total > LIMITS.max_blob_total_bytes) {
    throw configError(`blobs total ${total} bytes, over the ${LIMITS.max_blob_total_bytes} byte cap`, [], 'bundle_too_large');
  }

  const create: RunCreate = {
    t: 'run.create',
    project: bundle,
    boards: boards.map((b) => ({ id: b.id, kind: b.kind })),
    primary_board_id: primaryId,
    firmware: firmwareManifest,
    plan: plan.steps,
    options: {
      timeout_ms: flags.timeout,
      fail_text: flags.failText ?? null,
      interactive: flags.interactive,
      project_name: project.name,
      source: flags.source,
      allow_unsupported: flags.allowUnsupported,
    },
  };
  const bundleBytes = Buffer.byteLength(JSON.stringify(create));
  if (bundleBytes > LIMITS.max_bundle_bytes) {
    throw configError(`run.create bundle is ${bundleBytes} bytes, over the ${LIMITS.max_bundle_bytes} byte cap`, [], 'bundle_too_large');
  }

  const shotByIndex = new Map(plan.screenshots.map((s) => [s.index, s]));
  const stepDescriptions = plan.steps.map((s, i) => describeStep(s, shotByIndex.get(i)?.saveTo ?? null));

  return {
    project,
    request: { create, blobs, screenshots: plan.screenshots, stepDescriptions },
    summary: { name: project.name, boardKind: primary.kind, partCount: partIds.length, firmwareLabel, steps: plan.steps.length },
    warnings,
    boardKind: primary.kind,
    checks,
  };
}
