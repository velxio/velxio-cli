import { describe, expect, test } from 'bun:test';
import { analyseDiagram, parseDiagram } from '../src/diagram/wokwi.ts';
import { analyseVlx, parseVlx } from '../src/vlx/vlx.ts';
import { UNO_DIAGRAM } from './helpers/tmp.ts';
import { thrown } from './helpers/thrown.ts';

function diagram(parts: unknown[], connections: unknown[] = []): string {
  return JSON.stringify({ version: 1, parts, connections });
}

describe('diagram.json', () => {
  test('parses and finds the board and parts', () => {
    const d = parseDiagram(UNO_DIAGRAM);
    const a = analyseDiagram(d);
    expect(a.boards).toHaveLength(1);
    expect(a.boards[0]).toMatchObject({ id: 'uno', kind: 'arduino-uno', type: 'wokwi-arduino-uno' });
    expect(a.partIds).toEqual(['uno', 'led1']);
    expect(a.warnings).toEqual([]);
  });

  test('rejects duplicate ids, dangling connections and bad shapes', () => {
    expect(() => parseDiagram(diagram([{ id: 'a', type: 'wokwi-led' }, { id: 'a', type: 'wokwi-led' }]))).toThrow(/duplicate part id/);
    expect(() => parseDiagram(diagram([{ id: 'a', type: 'wokwi-led' }], [['a:A', 'b:C', 'red', []]]))).toThrow(/unknown part "b"/);
    expect(() => parseDiagram(diagram([{ id: 'a' }]))).toThrow(/has no type/);
    expect(() => parseDiagram('{"version": 2, "parts": [], "connections": []}')).toThrow(/version must be 1/);
    expect(() => parseDiagram('nope')).toThrow(/not valid JSON/);
    expect(() => parseDiagram(diagram([{ id: 'a', type: 'wokwi-led' }], [['a:A']]))).toThrow(/must be \[from, to/);
  });

  test('$serialMonitor pseudo parts are allowed in connections', () => {
    const d = parseDiagram(diagram([{ id: 'esp', type: 'board-esp32-s3-devkitc-1' }], [['$serialMonitor:RX', 'esp:TX', '', []]]));
    expect(analyseDiagram(d).boards[0]?.kind).toBe('esp32-s3');
  });

  test('every Wokwi board type of the snapshot resolves; velxio prefix too', () => {
    for (const [type, kind] of [
      ['wokwi-arduino-nano', 'arduino-nano'],
      ['wokwi-attiny85', 'attiny85'],
      ['wokwi-pi-pico', 'raspberry-pi-pico'],
      ['board-pi-pico-w', 'pi-pico-w'],
      ['wokwi-esp32-devkit-v1', 'esp32'],
      ['board-esp32-c3-devkitm-1', 'esp32-c3'],
      ['board-esp32-c6-devkitc-1', 'esp32-c6'],
      ['board-velxio-esp32-s3', 'esp32-s3'],
    ]) {
      const a = analyseDiagram(parseDiagram(diagram([{ id: 'b', type }])));
      expect(a.boards[0]?.kind).toBe(kind);
    }
  });

  test('unsupported Wokwi boards fail with a hint, never a silent Uno', () => {
    const pico2 = thrown(() => analyseDiagram(parseDiagram(diagram([{ id: 'b', type: 'board-pi-pico-2' }]))));
    expect(pico2.exitCode).toBe(2);
    expect(pico2.code).toBe('board_not_supported_in_ci');
    expect(pico2.message).toContain('board-pi-pico-2');
    // The suggested kind is planned, so it is named with its phase, not offered as a switch.
    expect(pico2.hints.join(' ')).toContain('xiao-rp2350, is planned for phase-3');
    expect(pico2.hints.join(' ')).not.toContain('use board-velxio-');
    // A suggestion this snapshot does not list is not offered at all.
    const c5 = thrown(() => analyseDiagram(parseDiagram(diagram([{ id: 'b', type: 'board-esp32-c5-devkitc-1' }]))));
    expect(c5.hints.join(' ')).not.toContain('firebeetle');
    const bluepill = thrown(() => analyseDiagram(parseDiagram(diagram([{ id: 'b', type: 'board-stm32-bluepill' }]))));
    expect(bluepill.code).toBe('board_not_supported_in_ci');
    expect(bluepill.message).toContain('supported in phase-4');
  });

  test('a planned board names its Wokwi type and phase (Wokwi default ESP32 template)', () => {
    const e = thrown(() => analyseDiagram(parseDiagram(diagram([{ id: 'esp', type: 'board-esp32-devkit-c-v4' }]))));
    expect(e.code).toBe('board_not_supported_in_ci');
    expect(e.message).toContain('board-esp32-devkit-c-v4');
    expect(e.message).toMatch(/supported in phase-\d/);
    expect(e.hints.join(' ')).toContain('esp32-devkit-c-v4');
  });

  test('an unknown board-velxio- kind is an error while the snapshot is fresh', () => {
    const e = thrown(() => analyseDiagram(parseDiagram(diagram([{ id: 'b', type: 'board-velxio-not-a-board' }]))));
    expect(e.code).toBe('unknown_board_type');
    expect(e.message).toContain("not in this CLI's board list");
  });

  test('no board part is an error; unknown parts only warn', () => {
    expect(() => analyseDiagram(parseDiagram(diagram([{ id: 'l', type: 'wokwi-led' }])))).toThrow(/no board part/);
    expect(thrown(() => analyseDiagram(parseDiagram(diagram([{ id: 'x', type: 'board-some-new-devkit' }])))).message).toContain('types this CLI does not know: board-some-new-devkit');
    const a = analyseDiagram(parseDiagram(diagram([{ id: 'uno', type: 'wokwi-arduino-uno' }, { id: 'x', type: 'wokwi-mystery-widget' }, { id: 'c', type: 'chip-inverter' }])));
    expect(a.warnings.map((w) => w.code)).toEqual(['part_unknown']);
    expect(a.warnings[0]?.detail).toEqual({ ids: ['x'] });
  });

  test('pi-pico-w carries the no_network warning', () => {
    const a = analyseDiagram(parseDiagram(diagram([{ id: 'p', type: 'board-pi-pico-w' }])));
    expect(a.warnings[0]?.code).toBe('no_network');
  });
});

describe('.vlx', () => {
  const payload = {
    format: 'velxio-project',
    version: 1,
    boards: [
      { id: 'b1', boardKind: 'arduino-uno', x: 0, y: 0, activeFileGroupId: 'g' },
      { id: 'b2', boardKind: 'esp32-s3', x: 0, y: 0, activeFileGroupId: 'g2' },
    ],
    fileGroups: { g: [], g2: [] },
    components: [{ id: 'led-1', metadataId: 'led' }],
    wires: [],
    activeBoardId: 'b2',
  };

  test('validates the envelope and picks the active board as primary', () => {
    const a = analyseVlx(parseVlx(JSON.stringify(payload)));
    expect(a.boards.map((b) => b.kind)).toEqual(['arduino-uno', 'esp32-s3']);
    expect(a.primaryBoardId).toBe('b2');
    expect(a.partIds).toEqual(['b1', 'b2', 'led-1']);
  });

  test('rejects a wrong format, version or missing boards', () => {
    expect(() => parseVlx(JSON.stringify({ ...payload, format: 'x' }))).toThrow(/format must be/);
    expect(() => parseVlx(JSON.stringify({ ...payload, version: 2 }))).toThrow(/version must be 1/);
    expect(() => parseVlx(JSON.stringify({ ...payload, boards: [] }))).toThrow(/at least one board/);
    expect(() => parseVlx(JSON.stringify({ ...payload, components: [{ id: 'b1', metadataId: 'led' }] }))).toThrow(/duplicate id/);
  });

  test('unknown board kinds are an error while the snapshot is fresh; planned ones name the phase', () => {
    const one = (boardKind: string) => JSON.stringify({ ...payload, boards: [{ id: 'b', boardKind, x: 0, y: 0, activeFileGroupId: 'g' }], activeBoardId: 'b' });
    expect(thrown(() => analyseVlx(parseVlx(one('not-a-board')))).message).toContain("not in this CLI's board list");
    const planned = thrown(() => analyseVlx(parseVlx(one('stellar-unicorn'))));
    expect(planned.code).toBe('board_not_supported_in_ci');
    expect(planned.message).toContain('supported in phase-3');
  });
});
