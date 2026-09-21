#!/usr/bin/env bun
/**
 * Refresh src/capabilities/snapshot.json from the server's
 * GET /api/pro/ci/capabilities. The endpoint's document is copied verbatim;
 * the CLI-only keys are restamped (`generated_at`, `source`) or kept from the
 * current snapshot (`parts`, the catalogue part ids the endpoint does not
 * list).
 *
 *   bun run scripts/update-snapshot.ts [url-or-file] [--source <label>] [--no-regress]
 *
 * Default source: https://velxio.dev/api/pro/ci/capabilities. A file path
 * reads a saved copy of the endpoint's JSON instead.
 *
 * --no-regress keeps the committed snapshot when the server would take a
 * board away from it: one that is `ready` here and missing or not ready
 * there. The release job refreshes from production, and production can be
 * behind main -- the v0.2.0 release job did exactly that, replaced a
 * 36-board snapshot with the 10 production still ran, and failed its own
 * tests. A server that is merely behind is not news worth shipping; the
 * committed snapshot was taken from the server that is ahead.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_URL = 'https://velxio.dev/api/pro/ci/capabilities';
const SNAPSHOT = path.join(import.meta.dir, '..', 'src', 'capabilities', 'snapshot.json');

function fail(message: string): never {
  process.stderr.write(`update-snapshot: ${message}\n`);
  process.exit(1);
}

async function load(from: string): Promise<Record<string, unknown>> {
  let text: string;
  if (/^https?:\/\//.test(from)) {
    const res = await fetch(from, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) fail(`${from} answered ${res.status}`);
    text = await res.text();
  } else {
    text = fs.readFileSync(from, 'utf8');
  }
  const doc = JSON.parse(text) as unknown;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail(`${from}: not a JSON object`);
  return doc as Record<string, unknown>;
}

/** The shape capabilities/index.ts reads; anything else is refused, not written. */
function check(doc: Record<string, unknown>, from: string): void {
  if (doc.version !== 1) fail(`${from}: version must be 1 (got ${JSON.stringify(doc.version)})`);
  if (!Array.isArray(doc.boards) || !doc.boards.length) fail(`${from}: boards must be a non-empty list`);
  for (const b of doc.boards as Array<Record<string, unknown>>) {
    for (const key of ['kind', 'label', 'family', 'engine', 'status', 'clock']) {
      if (typeof b[key] !== 'string') fail(`${from}: board ${JSON.stringify(b.kind)} has no string ${key}`);
    }
    for (const key of ['wokwi_types', 'formats', 'warnings']) {
      if (!Array.isArray(b[key])) fail(`${from}: board ${JSON.stringify(b.kind)} has no ${key} list`);
    }
  }
  for (const key of ['unsupported_wokwi_types', 'limits']) {
    const v = doc[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${from}: ${key} must be an object`);
  }
  if (!Array.isArray(doc.steps)) fail(`${from}: steps must be a list`);
}

/** Scalar arrays on one line, object rows one per line: small diffs on refresh. */
function render(value: unknown, indent = ''): string {
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) return JSON.stringify(value);
    return `[\n${value.map((v) => inner + JSON.stringify(v)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${render(v, inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

const args = process.argv.slice(2);
const sourceFlag = args.indexOf('--source');
let label: string | null = null;
if (sourceFlag >= 0) {
  label = args[sourceFlag + 1] ?? fail('--source needs a value');
  args.splice(sourceFlag, 2);
}
const noRegressFlag = args.indexOf('--no-regress');
const noRegress = noRegressFlag >= 0;
if (noRegress) args.splice(noRegressFlag, 1);
const from = args[0] ?? DEFAULT_URL;
const doc = await load(from);
check(doc, from);
const current = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as Record<string, unknown>;
if (noRegress) {
  type Row = { kind: string; status: string };
  const readyThere = new Set(
    (doc.boards as Row[]).filter((b) => b.status === 'ready').map((b) => b.kind),
  );
  const lost = ((current.boards as Row[] | undefined) ?? [])
    .filter((b) => b.status === 'ready' && !readyThere.has(b.kind))
    .map((b) => b.kind);
  if (lost.length) {
    process.stdout.write(
      `::warning::${label ?? from} is behind the committed snapshot (${lost.length} ready board(s) it does not run: ` +
        `${lost.slice(0, 5).join(', ')}${lost.length > 5 ? ', ...' : ''}); keeping src/capabilities/snapshot.json\n`,
    );
    process.exit(0);
  }
}
const { generated_at: _g, source: _s, parts: _p, ...endpoint } = doc;
const out = {
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  source: label ?? from,
  ...endpoint,
  parts: Array.isArray(current.parts) ? current.parts : [],
};
fs.writeFileSync(SNAPSHOT, render(out) + '\n');
process.stdout.write(`wrote ${path.relative(process.cwd(), SNAPSHOT)}: ${(doc.boards as unknown[]).length} boards from ${label ?? from}\n`);
