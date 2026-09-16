import { parse as parseToml } from 'smol-toml';
import { configError, type Warning } from '../errors.ts';

/**
 * `[velxio]` table. The key names are the VS Code extension's
 * (`version`, `board`, `firmware`, `language`) plus the CI additions.
 */
export interface VelxioConfig {
  version: number;
  board?: string;
  firmware?: string;
  flasher_args?: string;
  elf?: string;
  diagram?: string;
  project?: string;
  scenario?: string;
  language?: string;
  chips: Array<{ name: string; source?: string; binary?: string }>;
}

const STRING_KEYS = ['board', 'firmware', 'flasher_args', 'elf', 'diagram', 'project', 'scenario', 'language'] as const;

export function parseVelxioToml(text: string, file = 'velxio.toml'): { config: VelxioConfig; warnings: Warning[] } {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (err) {
    throw configError(`${file}: ${(err as Error).message}`);
  }
  const table = doc.velxio;
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw configError(`${file}: missing [velxio] table`);
  }
  const t = table as Record<string, unknown>;
  if (t.version !== 1) {
    throw configError(`${file}: [velxio] version must be 1 (got ${JSON.stringify(t.version ?? null)})`);
  }
  const warnings: Warning[] = [];
  const config: VelxioConfig = { version: 1, chips: [] };
  for (const key of STRING_KEYS) {
    const v = t[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v) throw configError(`${file}: [velxio] ${key} must be a non-empty string`);
    config[key] = v;
  }
  for (const key of Object.keys(t)) {
    if (key !== 'version' && !(STRING_KEYS as readonly string[]).includes(key)) {
      warnings.push({ code: 'unknown_key', message: `${file}: [velxio] ${key} is not a known key; ignored` });
    }
  }
  if (config.firmware && config.flasher_args) {
    throw configError(`${file}: [velxio] firmware and flasher_args are mutually exclusive`);
  }
  if (config.language && config.language !== 'arduino' && config.language !== 'micropython') {
    throw configError(`${file}: [velxio] language must be "arduino" or "micropython"`);
  }
  if (doc.chip !== undefined) {
    if (!Array.isArray(doc.chip)) throw configError(`${file}: [[chip]] must be an array of tables`);
    for (const c of doc.chip as unknown[]) {
      const row = (c ?? {}) as Record<string, unknown>;
      if (typeof row.name !== 'string' || !row.name) throw configError(`${file}: every [[chip]] needs a name`);
      config.chips.push({
        name: row.name,
        source: typeof row.source === 'string' ? row.source : undefined,
        binary: typeof row.binary === 'string' ? row.binary : undefined,
      });
    }
  }
  return { config, warnings };
}
