import { parse as parseToml } from 'smol-toml';
import { configError } from '../errors.ts';

/**
 * The documented `wokwi.toml` key set. We read Wokwi's file format with our
 * own parser; nothing from wokwi-cli is used.
 */
export interface WokwiConfig {
  version: number;
  firmware?: string;
  elf?: string;
  vcdFile?: string;
  gdbServerPort?: number;
  rfc2217ServerPort?: number;
  netForward: Array<{ from: string; to: string }>;
  chips: Array<{ name: string; binary: string }>;
}

export function parseWokwiToml(text: string, file = 'wokwi.toml'): WokwiConfig {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (err) {
    throw configError(`${file}: ${(err as Error).message}`);
  }
  const table = doc.wokwi;
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw configError(`${file}: missing [wokwi] table`);
  }
  const t = table as Record<string, unknown>;
  if (t.version !== 1) {
    throw configError(`${file}: [wokwi] version must be 1 (got ${JSON.stringify(t.version ?? null)})`);
  }
  const str = (key: string): string | undefined => {
    const v = t[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !v) throw configError(`${file}: [wokwi] ${key} must be a non-empty string`);
    return v;
  };
  const num = (key: string): number | undefined => {
    const v = t[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'number') throw configError(`${file}: [wokwi] ${key} must be a number`);
    return v;
  };
  const config: WokwiConfig = {
    version: 1,
    firmware: str('firmware'),
    elf: str('elf'),
    vcdFile: str('vcdFile'),
    gdbServerPort: num('gdbServerPort'),
    rfc2217ServerPort: num('rfc2217ServerPort'),
    netForward: [],
    chips: [],
  };
  const net = doc.net as Record<string, unknown> | undefined;
  if (net && typeof net === 'object' && Array.isArray(net.forward)) {
    for (const f of net.forward as unknown[]) {
      const row = (f ?? {}) as Record<string, unknown>;
      config.netForward.push({ from: String(row.from ?? ''), to: String(row.to ?? '') });
    }
  }
  if (doc.chip !== undefined) {
    if (!Array.isArray(doc.chip)) throw configError(`${file}: [[chip]] must be an array of tables`);
    for (const c of doc.chip as unknown[]) {
      const row = (c ?? {}) as Record<string, unknown>;
      if (typeof row.name !== 'string' || !row.name) throw configError(`${file}: every [[chip]] needs a name`);
      config.chips.push({ name: row.name, binary: typeof row.binary === 'string' ? row.binary : '' });
    }
  }
  return config;
}
