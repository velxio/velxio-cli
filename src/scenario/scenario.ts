import { parse as parseYaml } from 'yaml';
import { configError, type Warning } from '../errors.ts';
import { LIMITS } from '../capabilities/index.ts';
import type { PlanStep } from '../protocol/messages.ts';

/** Where a screenshot step's PNG goes and what it is compared against. */
export interface ScreenshotSpec {
  index: number;
  /** Wire name (`shot-<index>.png`); the `screenshot` event echoes it. */
  name: string;
  partId: string;
  saveTo: string | null;
  compareWith: string | null;
  /** Blob name for the compare-with PNG, or null. */
  compareBlob: string | null;
}

export interface ScenarioPlan {
  name: string | null;
  steps: PlanStep[];
  screenshots: ScreenshotSpec[];
  warnings: Warning[];
}

export interface NormalizeOptions {
  /** Part ids of the circuit; null skips the existence check. */
  partIds?: Set<string> | null;
  /** compare-with tolerance when the step does not say (percent). */
  tolerancePct?: number;
  file?: string;
}

const STEP_KINDS = new Set(['delay', 'wait-serial', 'write-serial', 'expect-pin', 'set-control', 'take-screenshot']);
const TOUCH_KINDS = new Set(['touch', 'touch-press', 'touch-move', 'touch-release']);
const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s)?\s*$/i;

const MAX_STEPS = LIMITS.max_steps;
const MAX_SCREENSHOTS = LIMITS.max_screenshots;
const MAX_TEXT_BYTES = LIMITS.max_text_bytes;

function invalid(message: string, hints: string[] = []): never {
  throw configError(message, hints, 'scenario_invalid');
}

/** `500ms`, `2s`, `100us`, `1.5s`; a bare number is milliseconds. Returns microseconds. */
export function parseDuration(value: unknown, where = 'delay'): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) invalid(`${where}: duration must be a non-negative number`);
    return Math.round(value * 1000);
  }
  if (typeof value !== 'string') invalid(`${where}: duration must be a string like "500ms", "2s" or "100us"`);
  const m = DURATION_RE.exec(value);
  if (!m) invalid(`${where}: cannot parse duration "${value}" (use 500ms, 2s or 100us)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const us = unit === 's' ? n * 1_000_000 : unit === 'ms' ? n * 1000 : n;
  return Math.round(us);
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function asText(value: unknown, where: string): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') invalid(`${where}: expected a string`);
  if (value.length === 0) invalid(`${where}: text must not be empty`);
  if (utf8Bytes(value) > MAX_TEXT_BYTES) invalid(`${where}: text exceeds ${MAX_TEXT_BYTES} bytes`);
  return value;
}

function asPartId(value: unknown, where: string, partIds: Set<string> | null | undefined): string {
  if (typeof value !== 'string' || !value) invalid(`${where}: part-id is required`);
  if (partIds && !partIds.has(value)) invalid(`${where}: part "${value}" is not in the diagram`, [`known ids: ${[...partIds].join(', ')}`]);
  return value;
}

function asLevel(value: unknown, where: string): 0 | 1 {
  if (value === 1 || value === true) return 1;
  if (value === 0 || value === false) return 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === '1' || v === 'high' || v === 'true') return 1;
    if (v === '0' || v === 'low' || v === 'false') return 0;
  }
  invalid(`${where}: expected 0/1, high/low or true/false (got ${JSON.stringify(value)})`);
}

function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${where}: expected a mapping`);
  return value as Record<string, unknown>;
}

/**
 * Turn a parsed scenario document into the normalised plan of PROTOCOL 1.5.
 * Wokwi's field names are accepted (`part-id`, `save-to`, `compare-with`,
 * `value`); underscore spellings are tolerated.
 */
export function normalizeScenario(doc: unknown, opts: NormalizeOptions = {}): ScenarioPlan {
  const file = opts.file ?? 'scenario';
  const root = asObject(doc, file);
  if (root.version !== undefined && root.version !== 1) invalid(`${file}: version must be 1`);
  if (!Array.isArray(root.steps)) invalid(`${file}: steps must be a list`);
  if (root.steps.length > MAX_STEPS) invalid(`${file}: ${root.steps.length} steps exceeds the limit of ${MAX_STEPS}`);
  const name = typeof root.name === 'string' ? root.name : null;
  const steps: PlanStep[] = [];
  const screenshots: ScreenshotSpec[] = [];
  const warnings: Warning[] = [];
  const tolerance = opts.tolerancePct ?? 0.5;

  root.steps.forEach((raw, index) => {
    const where = `${file}: step ${index + 1}`;
    const step = asObject(raw, where);
    const keys = Object.keys(step).filter((k) => k !== 'name');
    if (keys.length !== 1) invalid(`${where}: expected exactly one step key (got ${keys.length ? keys.join(', ') : 'none'})`);
    const kind = keys[0]!;
    const body = step[kind];
    const field = (o: Record<string, unknown>, dash: string): unknown => o[dash] ?? o[dash.replace(/-/g, '_')];

    if (TOUCH_KINDS.has(kind)) invalid(`${where}: ${kind} steps arrive in phase 3`);
    if (!STEP_KINDS.has(kind)) invalid(`${where}: unknown step "${kind}"`, [`known steps: ${[...STEP_KINDS].join(', ')}`]);

    switch (kind) {
      case 'delay':
        steps.push({ kind: 'delay', us: parseDuration(body, `${where} (delay)`) });
        break;
      case 'wait-serial':
        steps.push({ kind: 'wait-serial', text: asText(body, `${where} (wait-serial)`) });
        break;
      case 'write-serial': {
        let bytes: Uint8Array;
        if (typeof body === 'string') {
          if (!body.length) invalid(`${where} (write-serial): text must not be empty`);
          bytes = new TextEncoder().encode(body);
        } else if (Array.isArray(body)) {
          if (!body.length) invalid(`${where} (write-serial): byte list must not be empty`);
          bytes = new Uint8Array(
            body.map((b) => {
              if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) invalid(`${where} (write-serial): bytes must be integers 0..255`);
              return b;
            }),
          );
        } else if (typeof body === 'number') {
          bytes = new TextEncoder().encode(String(body));
        } else {
          invalid(`${where} (write-serial): expected a string or a list of bytes`);
        }
        if (bytes.length > MAX_TEXT_BYTES) invalid(`${where} (write-serial): exceeds ${MAX_TEXT_BYTES} bytes`);
        steps.push({ kind: 'write-serial', data_b64: bytesToB64(bytes) });
        break;
      }
      case 'expect-pin': {
        const o = asObject(body, `${where} (expect-pin)`);
        const partId = asPartId(field(o, 'part-id'), `${where} (expect-pin)`, opts.partIds);
        const pin = field(o, 'pin');
        if ((typeof pin !== 'string' && typeof pin !== 'number') || pin === '') invalid(`${where} (expect-pin): pin is required`);
        const expectedRaw = field(o, 'expected') ?? field(o, 'value');
        if (expectedRaw === undefined) invalid(`${where} (expect-pin): expected (or value) is required`);
        steps.push({ kind: 'expect-pin', part_id: partId, pin: String(pin), expected: asLevel(expectedRaw, `${where} (expect-pin)`) });
        break;
      }
      case 'set-control': {
        const o = asObject(body, `${where} (set-control)`);
        const partId = asPartId(field(o, 'part-id'), `${where} (set-control)`, opts.partIds);
        const control = field(o, 'control');
        if (typeof control !== 'string' || !control) invalid(`${where} (set-control): control is required`);
        const value = field(o, 'value');
        if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
          invalid(`${where} (set-control): value must be a number, string or boolean`);
        }
        steps.push({ kind: 'set-control', part_id: partId, control, value });
        break;
      }
      case 'take-screenshot': {
        const o = asObject(body, `${where} (take-screenshot)`);
        const partId = asPartId(field(o, 'part-id'), `${where} (take-screenshot)`, opts.partIds);
        const saveTo = field(o, 'save-to');
        const compareWith = field(o, 'compare-with');
        if (saveTo !== undefined && (typeof saveTo !== 'string' || !saveTo)) invalid(`${where} (take-screenshot): save-to must be a path`);
        if (compareWith !== undefined && (typeof compareWith !== 'string' || !compareWith)) invalid(`${where} (take-screenshot): compare-with must be a path`);
        if (!saveTo && !compareWith) invalid(`${where} (take-screenshot): needs save-to and/or compare-with`);
        const tol = field(o, 'tolerance');
        const tolerancePct = tol === undefined ? tolerance : Number(tol);
        if (!Number.isFinite(tolerancePct) || tolerancePct < 0 || tolerancePct > 100) invalid(`${where} (take-screenshot): tolerance must be 0..100`);
        if (screenshots.length >= MAX_SCREENSHOTS) invalid(`${where}: more than ${MAX_SCREENSHOTS} screenshots`);
        const shotName = `shot-${index}.png`;
        const compareBlob = compareWith ? `cmp-${index}` : null;
        screenshots.push({ index, name: shotName, partId, saveTo: (saveTo as string | undefined) ?? null, compareWith: (compareWith as string | undefined) ?? null, compareBlob });
        steps.push({ kind: 'take-screenshot', part_id: partId, name: shotName, compare_blob: compareBlob, tolerance_pct: tolerancePct });
        break;
      }
    }
  });
  return { name, steps, screenshots, warnings };
}

export function parseScenarioText(text: string, opts: NormalizeOptions = {}): ScenarioPlan {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    invalid(`${opts.file ?? 'scenario'}: ${(err as Error).message}`);
  }
  return normalizeScenario(doc, opts);
}

export interface FlagSteps {
  expectText?: string;
  screenshotPart?: string;
  screenshotTime?: number;
  screenshotFile?: string;
  screenshotTolerance?: number;
}

/**
 * `--expect-text X` becomes a final `wait-serial X`; `--screenshot-part P
 * --screenshot-time T` becomes `delay T` + `take-screenshot P` (the flag
 * screenshot goes before the expect-text so both can be requested).
 */
export function appendFlagSteps(plan: ScenarioPlan, flags: FlagSteps, partIds?: Set<string> | null): ScenarioPlan {
  const steps = [...plan.steps];
  const screenshots = [...plan.screenshots];
  if (flags.screenshotPart) {
    const partId = asPartId(flags.screenshotPart, '--screenshot-part', partIds);
    if (screenshots.length >= MAX_SCREENSHOTS) invalid(`--screenshot-part: more than ${MAX_SCREENSHOTS} screenshots`);
    const at = flags.screenshotTime ?? 0;
    if (!Number.isFinite(at) || at < 0) invalid('--screenshot-time must be a non-negative number of milliseconds');
    if (at > 0) steps.push({ kind: 'delay', us: Math.round(at * 1000) });
    const index = steps.length;
    const name = `shot-${index}.png`;
    screenshots.push({ index, name, partId, saveTo: flags.screenshotFile ?? 'screenshot.png', compareWith: null, compareBlob: null });
    steps.push({ kind: 'take-screenshot', part_id: partId, name, compare_blob: null, tolerance_pct: flags.screenshotTolerance ?? 0.5 });
  }
  if (flags.expectText !== undefined) {
    steps.push({ kind: 'wait-serial', text: asText(flags.expectText, '--expect-text') });
  }
  if (steps.length > MAX_STEPS) invalid(`${steps.length} steps exceeds the limit of ${MAX_STEPS}`);
  return { ...plan, steps, screenshots };
}

export const EMPTY_PLAN: ScenarioPlan = { name: null, steps: [], screenshots: [], warnings: [] };
