import { describe, expect, setSystemTime, test } from 'bun:test';
import { prepareRun, type RunFlags } from '../src/client/request.ts';
import { snapshot } from '../src/capabilities/index.ts';
import { sampleHex } from './helpers/binaries.ts';
import { rmTmp, tmpProject } from './helpers/tmp.ts';
import { thrown } from './helpers/thrown.ts';

const FLAGS: RunFlags = { timeout: 30000, interactive: false, allowUnsupported: false, source: 'cli', requireFirmware: true };

function futureBoardProject(): string {
  return tmpProject({
    'velxio.toml': '[velxio]\nversion = 1\nfirmware = "fw.hex"\n',
    'diagram.json': JSON.stringify({ version: 1, parts: [{ id: 'b', type: 'board-velxio-future-board' }], connections: [] }),
    'fw.hex': sampleHex(),
  });
}

describe('prepareRun', () => {
  test('a fresh snapshot refuses a board kind it does not know', () => {
    const dir = futureBoardProject();
    try {
      expect(thrown(() => prepareRun(dir, FLAGS)).code).toBe('unknown_board_type');
    } finally {
      rmTmp(dir);
    }
  });

  test('a stale snapshot sends the unknown board and its firmware unconverted: the server decides', () => {
    const dir = futureBoardProject();
    setSystemTime(new Date(Date.parse(snapshot.generated_at) + 31 * 86_400_000));
    try {
      const prepared = prepareRun(dir, FLAGS);
      expect(prepared.request.create.boards).toEqual([{ id: 'b', kind: 'future-board' }]);
      expect(prepared.request.create.firmware).toEqual([{ board_id: 'b', blob: 'fw-b', format: 'hex' }]);
      expect(prepared.warnings.map((w) => w.code)).toEqual(['unknown_board_type', 'unknown_board_firmware']);
    } finally {
      setSystemTime();
      rmTmp(dir);
    }
  });
});
