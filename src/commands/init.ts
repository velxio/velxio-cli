import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT } from '../errors.ts';
import { boardByKind, isReady, notRunnableHints, readyBoards } from '../capabilities/index.ts';
import type { Output } from '../ui/types.ts';
import { makeRenderer, reportError, type CommonOptions } from './common.ts';

export interface InitOptions extends CommonOptions {
  board?: string;
  force?: boolean;
}

const PART_ID: Record<string, string> = {
  'arduino-uno': 'uno',
  'arduino-nano': 'nano',
  'arduino-mega': 'mega',
  attiny85: 'tiny',
  'raspberry-pi-pico': 'pico',
  'pi-pico-w': 'pico',
};

const FIRMWARE_HINT: Record<string, string> = {
  avr: 'build/firmware.hex',
  rp2040: 'build/firmware.uf2',
  rp2350: 'build/firmware.uf2',
  'xiao-arm': 'build/firmware.hex',
  esp32: 'build/firmware.merged.bin',
};

/** Write a minimal velxio.toml + diagram.json with one board. */
export function initCommand(dirArg: string, opts: InitOptions, out: Output): number {
  const r = makeRenderer(opts, out);
  try {
    const kind = opts.board ?? 'arduino-uno';
    const board = boardByKind(kind);
    if (!board) {
      throw new CliError(`unknown board kind "${kind}"`, { exitCode: EXIT.CONFIG, hints: [`kinds CI runs today: ${readyBoards().map((b) => b.kind).join(', ')}`] });
    }
    if (!isReady(board)) {
      throw new CliError(`board kind "${kind}" is not available in Velxio CI yet`, { exitCode: EXIT.CONFIG, code: 'board_not_supported_in_ci', hints: notRunnableHints(board) });
    }
    const dir = path.resolve(dirArg);
    fs.mkdirSync(dir, { recursive: true });
    const tomlPath = path.join(dir, 'velxio.toml');
    const diagramPath = path.join(dir, 'diagram.json');
    for (const p of [tomlPath, diagramPath]) {
      if (fs.existsSync(p) && !opts.force) throw new CliError(`${path.relative(process.cwd(), p) || p} already exists (use --force to overwrite)`, { exitCode: EXIT.CONFIG });
    }
    const type = board.wokwi_types[0] ?? `board-velxio-${kind}`;
    const id = PART_ID[kind] ?? (type.startsWith('board-velxio-') ? kind : kind.split('-')[0]!);
    const diagram = {
      version: 1,
      author: '',
      editor: 'velxio',
      parts: [{ type, id, top: 0, left: 0, attrs: {} }],
      connections: [],
    };
    const firmware = FIRMWARE_HINT[board.family] ?? 'build/firmware.bin';
    const toml = [
      '[velxio]',
      'version = 1',
      `board = "${kind}"`,
      `firmware = "${firmware}"   # .hex | .elf | .uf2 | .bin | merged ESP32 image, relative to this file`,
      'diagram = "diagram.json"',
      '# scenario = "test.yaml"',
      '',
    ].join('\n');
    fs.writeFileSync(tomlPath, toml);
    fs.writeFileSync(diagramPath, JSON.stringify(diagram, null, 2) + '\n');
    if (r.json) r.info('', { t: 'init', dir, files: ['velxio.toml', 'diagram.json'], board: kind });
    else {
      r.info(`wrote ${path.relative(process.cwd(), tomlPath) || tomlPath} and ${path.relative(process.cwd(), diagramPath) || diagramPath} (${kind})`);
      r.info(`next: build your firmware to ${firmware}, then run \`velxio-cli --expect-text READY ${dirArg}\``);
    }
    return EXIT.PASS;
  } catch (err) {
    return reportError(err, r);
  }
}
