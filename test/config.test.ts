import { describe, expect, test } from 'bun:test';
import { parseVelxioToml } from '../src/config/velxioToml.ts';
import { parseWokwiToml } from '../src/config/wokwiToml.ts';
import { resolveProject } from '../src/config/resolve.ts';
import { CliError } from '../src/errors.ts';
import { rmTmp, tmpProject, UNO_DIAGRAM } from './helpers/tmp.ts';
import { thrown } from './helpers/thrown.ts';

describe('velxio.toml', () => {
  test('parses the documented keys', () => {
    const { config, warnings } = parseVelxioToml(`
[velxio]
version = 1
board = "esp32-s3"
firmware = "build/app.bin"
diagram = "diagram.json"
scenario = "test.yaml"
language = "arduino"
[[chip]]
name = "inverter"
source = "chips/inverter.chip.c"
`);
    expect(config.board).toBe('esp32-s3');
    expect(config.firmware).toBe('build/app.bin');
    expect(config.chips).toEqual([{ name: 'inverter', source: 'chips/inverter.chip.c', binary: undefined }]);
    expect(warnings).toEqual([]);
  });

  test('requires version = 1 and the [velxio] table', () => {
    expect(() => parseVelxioToml('[velxio]\nversion = 2\n')).toThrow(/version must be 1/);
    expect(() => parseVelxioToml('[wokwi]\nversion = 1\n')).toThrow(/missing \[velxio\]/);
    expect(() => parseVelxioToml('not toml = = =')).toThrow(CliError);
  });

  test('firmware and flasher_args are exclusive; unknown keys warn', () => {
    expect(() => parseVelxioToml('[velxio]\nversion = 1\nfirmware = "a"\nflasher_args = "b"\n')).toThrow(/mutually exclusive/);
    const { warnings } = parseVelxioToml('[velxio]\nversion = 1\nbogus = "x"\n');
    expect(warnings[0]?.code).toBe('unknown_key');
  });
});

describe('wokwi.toml', () => {
  test('parses firmware, elf, ports, net.forward and chips', () => {
    const c = parseWokwiToml(`
[wokwi]
version = 1
firmware = "build/firmware.bin"
elf = "build/firmware.elf"
gdbServerPort = 3333
rfc2217ServerPort = 4000
vcdFile = "trace.vcd"
[[net.forward]]
from = "localhost:8080"
to = "target:80"
[[chip]]
name = "inverter"
binary = "chips/inverter.chip.wasm"
`);
    expect(c.firmware).toBe('build/firmware.bin');
    expect(c.elf).toBe('build/firmware.elf');
    expect(c.gdbServerPort).toBe(3333);
    expect(c.netForward).toEqual([{ from: 'localhost:8080', to: 'target:80' }]);
    expect(c.chips[0]?.binary).toBe('chips/inverter.chip.wasm');
  });

  test('rejects a missing table or wrong version', () => {
    expect(() => parseWokwiToml('[velxio]\nversion = 1\n')).toThrow(/missing \[wokwi\]/);
    expect(() => parseWokwiToml('[wokwi]\nversion = 0\n')).toThrow(/version must be 1/);
  });
});

describe('resolveProject precedence', () => {
  test('velxio.toml wins over wokwi.toml; paths relative to the toml', () => {
    const dir = tmpProject({
      'velxio.toml': '[velxio]\nversion = 1\nboard = "arduino-uno"\nfirmware = "out/a.hex"\nscenario = "t.yaml"\n',
      'wokwi.toml': '[wokwi]\nversion = 1\nfirmware = "b.bin"\n',
      'diagram.json': UNO_DIAGRAM,
    });
    try {
      const p = resolveProject(dir);
      expect(p.configKind).toBe('velxio');
      expect(p.board).toBe('arduino-uno');
      expect(p.firmware?.path).toBe(`${dir}/out/a.hex`);
      expect(p.firmware?.origin).toBe('[velxio] firmware');
      expect(p.scenario).toBe(`${dir}/t.yaml`);
      expect(p.circuit).toEqual({ kind: 'diagram', path: `${dir}/diagram.json` });
    } finally {
      rmTmp(dir);
    }
  });

  test('wokwi.toml: firmware over elf, ignored features warn, wasm chips fail', () => {
    const dir = tmpProject({
      'wokwi.toml': '[wokwi]\nversion = 1\nfirmware = "f.bin"\nelf = "f.elf"\ngdbServerPort = 1\nvcdFile = "x.vcd"\n[[net.forward]]\nfrom = "a"\nto = "b"\n',
      'diagram.json': UNO_DIAGRAM,
    });
    try {
      const p = resolveProject(dir);
      expect(p.configKind).toBe('wokwi');
      expect(p.firmware?.origin).toBe('[wokwi] firmware');
      expect(p.warnings.map((w) => w.code)).toEqual(['feature_ignored', 'feature_ignored', 'feature_ignored']);
      expect(p.warnings.map((w) => w.message).join('\n')).toContain('[[net.forward]]');
    } finally {
      rmTmp(dir);
    }
    const dir2 = tmpProject({
      'wokwi.toml': '[wokwi]\nversion = 1\nelf = "f.elf"\n[[chip]]\nname = "inv"\nbinary = "inv.chip.wasm"\n',
      'diagram.json': UNO_DIAGRAM,
    });
    try {
      const wasm = thrown(() => resolveProject(dir2));
      expect(wasm.message).toMatch(/\.wasm/);
      expect(wasm.hints[0]).toContain('inv.chip.c');
    } finally {
      rmTmp(dir2);
    }
  });

  test('wokwi.toml elf is used when firmware is absent', () => {
    const dir = tmpProject({ 'wokwi.toml': '[wokwi]\nversion = 1\nelf = "f.elf"\n', 'diagram.json': UNO_DIAGRAM });
    try {
      const p = resolveProject(dir);
      expect(p.firmware).toEqual({ path: `${dir}/f.elf`, role: 'elf', origin: '[wokwi] elf' });
    } finally {
      rmTmp(dir);
    }
  });

  test('flags beat the toml: --firmware > --elf > toml; --project-file > diagram', () => {
    const dir = tmpProject({
      'velxio.toml': '[velxio]\nversion = 1\nfirmware = "toml.hex"\ndiagram = "d.json"\n',
      'd.json': UNO_DIAGRAM,
      'c.vlx': '{}',
    });
    try {
      const p = resolveProject(dir, { firmware: 'flag.hex', elf: 'flag.elf', projectFile: 'c.vlx' });
      expect(p.firmware?.path).toBe(`${dir}/flag.hex`);
      expect(p.circuit).toEqual({ kind: 'vlx', path: `${dir}/c.vlx` });
      const q = resolveProject(dir, { elf: 'flag.elf' });
      expect(q.firmware?.role).toBe('elf');
    } finally {
      rmTmp(dir);
    }
  });

  test('a single .vlx is the config; two are an error; none is exit 2', () => {
    const one = tmpProject({ 'a.vlx': '{}' });
    const two = tmpProject({ 'a.vlx': '{}', 'b.vlx': '{}' });
    const none = tmpProject({ 'readme.txt': 'x' });
    try {
      const p = resolveProject(one);
      expect(p.configKind).toBe('vlx');
      expect(p.circuit).toEqual({ kind: 'vlx', path: `${one}/a.vlx` });
      expect(p.firmware).toBeNull();
      expect(() => resolveProject(two)).toThrow(/several \.vlx/);
      const e = thrown(() => resolveProject(none));
      expect(e.exitCode).toBe(2);
      expect(e.message).toMatch(/no config found/);
    } finally {
      rmTmp(one);
      rmTmp(two);
      rmTmp(none);
    }
  });

  test('phase-3/4 features are refused, never dropped in silence', () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ 'velxio.toml': '[velxio]\nversion = 1\nlanguage = "micropython"\n' }, /MicroPython projects arrive in Velxio CI in phase 4/],
      [{ 'velxio.toml': '[velxio]\nversion = 1\n[[chip]]\nname = "inv"\nsource = "inv.chip.c"\n' }, /custom chips arrive in Velxio CI in phase 3/],
      [{ 'wokwi.toml': '[wokwi]\nversion = 1\n[[chip]]\nname = "inv"\nbinary = "inv.chip.bin"\n' }, /custom chips arrive in Velxio CI in phase 3/],
    ];
    for (const [files, message] of cases) {
      const dir = tmpProject({ ...files, 'diagram.json': UNO_DIAGRAM });
      try {
        const e = thrown(() => resolveProject(dir));
        expect(e.code).toBe('feature_unsupported');
        expect(e.exitCode).toBe(2);
        expect(e.message).toMatch(message);
      } finally {
        rmTmp(dir);
      }
    }
  });

  test('missing diagram.json is exit 2', () => {
    const dir = tmpProject({ 'velxio.toml': '[velxio]\nversion = 1\n' });
    try {
      expect(() => resolveProject(dir)).toThrow(/circuit file not found/);
    } finally {
      rmTmp(dir);
    }
  });
});
