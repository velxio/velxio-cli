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
    // Velxio has no Pico 2, but it does have an RP2350 board that runs, so the
    // hint offers it as something to switch to, spelled the way a diagram
    // spells a board with no Wokwi type of its own.
    expect(pico2.hints.join(' ')).toContain('runs today is xiao-rp2350');
    expect(pico2.hints.join(' ')).toContain('use board-velxio-xiao-rp2350');
    const bluepill = thrown(() => analyseDiagram(parseDiagram(diagram([{ id: 'b', type: 'board-stm32-bluepill' }]))));
    expect(bluepill.code).toBe('board_not_supported_in_ci');
    expect(bluepill.message).toContain('planned for phase-4');
  });

  test('a board held back by launch control says so, not a phase', () => {
    // The distinction the message has to carry: the P4 preview devkit is not
    // waiting on an engine (the P4 engine runs the Function EV today), it is
    // waiting on a product decision.
    const e = thrown(() => analyseDiagram(parseDiagram(diagram([{ id: 'esp', type: 'board-esp32-p4-preview' }]))));
    expect(e.code).toBe('board_not_supported_in_ci');
    expect(e.message).toContain('board-esp32-p4-preview');
    expect(e.message).toContain('waiting on its public launch');
    expect(e.message).not.toMatch(/phase-\d/);
    expect(e.hints.join(' ')).toContain('esp32-p4-preview');
  });

  test('the ESP32 devkits Wokwi templates use all run today', () => {
    // Every one of these was refused before the board sweep; a regression here
    // would send a working project back to exit 2.
    for (const [type, kind] of [
      ['board-esp32-devkit-c-v4', 'esp32-devkit-c-v4'],
      ['board-esp32-cam', 'esp32-cam'],
      ['board-wemos-lolin32-lite', 'wemos-lolin32-lite'],
      ['board-xiao-esp32-s3', 'xiao-esp32-s3'],
      ['board-esp32-p4-function-ev', 'esp32-p4'],
    ] as const) {
      const a = analyseDiagram(parseDiagram(diagram([{ id: 'b', type }])));
      expect(a.boards[0]?.kind).toBe(kind);
    }
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
    const planned = thrown(() => analyseVlx(parseVlx(one('stm32-bluepill'))));
    expect(planned.code).toBe('board_not_supported_in_ci');
    expect(planned.message).toContain('planned for phase-4');
    const embargoed = thrown(() => analyseVlx(parseVlx(one('dfrobot-beetle-rp2040'))));
    expect(embargoed.code).toBe('board_not_supported_in_ci');
    expect(embargoed.message).toContain('waiting on its public launch');
    // And the RP2350 boards that used to sit here now run.
    expect(analyseVlx(parseVlx(one('stellar-unicorn'))).boards[0]?.kind).toBe('stellar-unicorn');
  });
});
