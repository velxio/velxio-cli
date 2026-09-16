import fs from 'node:fs';
import path from 'node:path';
import { configError, type Warning } from '../errors.ts';
import { parseVelxioToml, type VelxioConfig } from './velxioToml.ts';
import { parseWokwiToml, type WokwiConfig } from './wokwiToml.ts';

export type ConfigKind = 'velxio' | 'wokwi' | 'vlx';

export interface ResolveFlags {
  diagramFile?: string;
  projectFile?: string;
  firmware?: string;
  elf?: string;
  scenario?: string;
}

export interface FirmwareRef {
  path: string;
  /** How the file was named: a firmware image, an ELF to convert, or ESP-IDF flasher_args.json. */
  role: 'firmware' | 'elf' | 'flasher_args';
  /** Where the reference came from, for the transcript. */
  origin: string;
}

export interface ResolvedProject {
  dir: string;
  name: string;
  configKind: ConfigKind;
  configPath: string | null;
  circuit: { kind: 'diagram'; path: string } | { kind: 'vlx'; path: string };
  firmware: FirmwareRef | null;
  scenario: string | null;
  board: string | null;
  language: 'arduino' | 'micropython';
  chips: Array<{ name: string; source?: string }>;
  warnings: Warning[];
}

/** Flags and toml values are relative to the project dir; forward slashes on every OS. */
export function resolvePath(dir: string, p: string): string {
  return path.resolve(dir, p.replace(/\\/g, '/'));
}

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Config precedence: `velxio.toml` > `wokwi.toml` > exactly one `*.vlx` in
 * the directory > exit 2. Circuit: `--project-file` > `[velxio] project` >
 * `--diagram-file` > `[velxio] diagram` > `diagram.json`. Firmware:
 * `--firmware` > `--elf` > `[velxio] firmware|flasher_args` > `[wokwi]
 * firmware` > `[wokwi] elf`.
 */
export function resolveProject(dirArg: string, flags: ResolveFlags = {}): ResolvedProject {
  const dir = path.resolve(dirArg);
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    throw configError(`project directory not found: ${dir}`);
  }
  if (!st.isDirectory()) throw configError(`not a directory: ${dir}`);

  const warnings: Warning[] = [];
  const velxioPath = path.join(dir, 'velxio.toml');
  const wokwiPath = path.join(dir, 'wokwi.toml');

  let configKind: ConfigKind;
  let configPath: string | null = null;
  let velxio: VelxioConfig | null = null;
  let wokwi: WokwiConfig | null = null;
  let vlxFromDir: string | null = null;

  if (exists(velxioPath)) {
    configKind = 'velxio';
    configPath = velxioPath;
    const parsed = parseVelxioToml(fs.readFileSync(velxioPath, 'utf8'), 'velxio.toml');
    velxio = parsed.config;
    warnings.push(...parsed.warnings);
  } else if (exists(wokwiPath)) {
    configKind = 'wokwi';
    configPath = wokwiPath;
    wokwi = parseWokwiToml(fs.readFileSync(wokwiPath, 'utf8'), 'wokwi.toml');
  } else {
    const vlxFiles = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.vlx') && exists(path.join(dir, f)));
    if (vlxFiles.length === 1) {
      configKind = 'vlx';
      vlxFromDir = path.join(dir, vlxFiles[0]!);
    } else if (vlxFiles.length > 1) {
      throw configError(`several .vlx files in ${dir}: ${vlxFiles.join(', ')}`, [
        'pass one with --project-file, or add a velxio.toml with `project = "..."`',
      ]);
    } else {
      throw configError(`no config found in ${dir} (velxio.toml, wokwi.toml or a .vlx)`, [
        'run `velxio-cli init` to create velxio.toml and diagram.json',
      ]);
    }
  }

  // Wokwi-only knobs we do not implement: say so, keep going.
  if (wokwi) {
    const ignored: string[] = [];
    if (wokwi.gdbServerPort !== undefined) ignored.push('gdbServerPort');
    if (wokwi.rfc2217ServerPort !== undefined) ignored.push('rfc2217ServerPort');
    if (wokwi.vcdFile !== undefined) ignored.push('vcdFile');
    if (wokwi.netForward.length) ignored.push('[[net.forward]]');
    for (const key of ignored) {
      warnings.push({ code: 'feature_ignored', message: `wokwi.toml: ${key} is not supported by Velxio CI; ignored` });
    }
    for (const chip of wokwi.chips) {
      if (chip.binary.toLowerCase().endsWith('.wasm')) {
        throw configError(`wokwi.toml: [[chip]] "${chip.name}" points at a .wasm binary, which Velxio cannot load`, [
          `ship ${chip.name}.chip.c next to diagram.json; Velxio compiles it (custom chips arrive in phase 3)`,
        ]);
      }
      throw configError(`wokwi.toml: [[chip]] "${chip.name}": custom chips arrive in Velxio CI in phase 3`, [], 'feature_unsupported');
    }
  }
  // Nothing is ignored in silence: what a later phase brings is refused now.
  if (velxio) {
    for (const chip of velxio.chips) {
      if (chip.binary) {
        throw configError(`velxio.toml: [[chip]] "${chip.name}" has a binary; Velxio compiles chips from source`, [
          `use source = "${chip.name}.chip.c" instead (custom chips arrive in phase 3)`,
        ]);
      }
      throw configError(`velxio.toml: [[chip]] "${chip.name}": custom chips arrive in Velxio CI in phase 3`, [], 'feature_unsupported');
    }
    if (velxio.language === 'micropython') {
      throw configError('velxio.toml: language = "micropython": MicroPython projects arrive in Velxio CI in phase 4', ['build an Arduino / ESP-IDF / Pico SDK firmware and set `firmware`'], 'feature_unsupported');
    }
  }

  // Circuit.
  let circuit: ResolvedProject['circuit'];
  if (flags.projectFile) circuit = { kind: 'vlx', path: resolvePath(dir, flags.projectFile) };
  else if (velxio?.project) circuit = { kind: 'vlx', path: resolvePath(dir, velxio.project) };
  else if (flags.diagramFile) circuit = { kind: 'diagram', path: resolvePath(dir, flags.diagramFile) };
  else if (velxio?.diagram) circuit = { kind: 'diagram', path: resolvePath(dir, velxio.diagram) };
  else if (vlxFromDir) circuit = { kind: 'vlx', path: vlxFromDir };
  else circuit = { kind: 'diagram', path: path.join(dir, 'diagram.json') };
  if (!exists(circuit.path)) {
    throw configError(`circuit file not found: ${circuit.path}`, [
      circuit.kind === 'diagram' ? 'expected a Wokwi-format diagram.json (see docs/velxio-toml.md)' : 'expected a Velxio .vlx project',
    ]);
  }

  // Firmware.
  let firmware: FirmwareRef | null = null;
  if (flags.firmware) firmware = { path: resolvePath(dir, flags.firmware), role: 'firmware', origin: '--firmware' };
  else if (flags.elf) firmware = { path: resolvePath(dir, flags.elf), role: 'elf', origin: '--elf' };
  else if (velxio?.firmware) firmware = { path: resolvePath(dir, velxio.firmware), role: 'firmware', origin: '[velxio] firmware' };
  else if (velxio?.flasher_args) firmware = { path: resolvePath(dir, velxio.flasher_args), role: 'flasher_args', origin: '[velxio] flasher_args' };
  else if (velxio?.elf) firmware = { path: resolvePath(dir, velxio.elf), role: 'elf', origin: '[velxio] elf' };
  else if (wokwi?.firmware) firmware = { path: resolvePath(dir, wokwi.firmware), role: 'firmware', origin: '[wokwi] firmware' };
  else if (wokwi?.elf) firmware = { path: resolvePath(dir, wokwi.elf), role: 'elf', origin: '[wokwi] elf' };

  // Scenario.
  let scenario: string | null = null;
  if (flags.scenario) scenario = resolvePath(dir, flags.scenario);
  else if (velxio?.scenario) scenario = resolvePath(dir, velxio.scenario);

  const language = velxio?.language === 'micropython' ? 'micropython' : 'arduino';

  return {
    dir,
    name: path.basename(dir).slice(0, 120) || 'project',
    configKind,
    configPath,
    circuit,
    firmware,
    scenario,
    board: velxio?.board ?? null,
    language,
    chips: velxio?.chips.map((c) => ({ name: c.name, source: c.source })) ?? [],
    warnings,
  };
}
