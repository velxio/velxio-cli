import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  assembleFlash,
  ESP_BOOTLOADER_OFFSET,
  ESP_CHIP_IDS,
  espImageChipId,
  findSiblings,
  isMergedImage,
  parseFlasherArgs,
  prepareBareApp,
  prepareFromFlasherArgs,
  prepareMerged,
  trimTrailingFf,
} from '../src/firmware/esp32.ts';
import { prepareFirmware, prepareFirmwareForUnknownBoard, sniff } from '../src/firmware/detect.ts';
import { boardByKind, type Family } from '../src/capabilities/index.ts';
import { CliError } from '../src/errors.ts';
import { buildEspImage, buildMergedImage, buildElf32, buildUf2, sampleHex } from './helpers/binaries.ts';
import { rmTmp, tmpProject } from './helpers/tmp.ts';
import { thrown } from './helpers/thrown.ts';

const S3 = boardByKind('esp32-s3')!;
const CLASSIC = boardByKind('esp32')!;
const C3 = boardByKind('esp32-c3')!;

describe('ESP32 images', () => {
  test('chip id table and bootloader offsets', () => {
    expect(ESP_CHIP_IDS).toEqual({ esp32: 0, esp32s2: 2, esp32c3: 5, esp32s3: 9, esp32c6: 13, esp32h2: 16, esp32p4: 18, esp32c5: 23 });
    expect(ESP_BOOTLOADER_OFFSET).toEqual({ esp32: 0x1000, esp32s2: 0x1000, esp32p4: 0x2000, esp32c5: 0x2000, esp32s3: 0, esp32c3: 0, esp32c6: 0, esp32h2: 0 });
    expect(espImageChipId(buildEspImage(13))).toBe(13);
    expect(espImageChipId(new Uint8Array(64))).toBeNull();
  });

  test('merged detection per family and trailing 0xFF trim', () => {
    const s3 = buildMergedImage(9, 0x0, new Uint8Array(100).fill(0x5a), 8192);
    expect(isMergedImage(s3, 'esp32s3')).toBe(true);
    expect(isMergedImage(s3, 'esp32')).toBe(false);
    const classic = buildMergedImage(0, 0x1000, new Uint8Array(100).fill(0x5a), 0);
    expect(isMergedImage(classic, 'esp32')).toBe(true);
    expect(isMergedImage(classic, 'esp32s3')).toBe(false);
    const out = prepareMerged(s3, 'esp32s3', 'f.bin');
    expect(out.bytes.length).toBe(0x10000 + 24 + 100);
    expect(trimTrailingFf(new Uint8Array([1, 0xff, 0xff])).length).toBe(1);
  });

  test('a merged image for another chip is a format mismatch with the offset hint', () => {
    const classic = buildMergedImage(0, 0x1000, new Uint8Array(100).fill(0x5a), 0);
    try {
      prepareMerged(classic, 'esp32s3', 'f.bin');
      throw new Error('did not throw');
    } catch (err) {
      const e = err as CliError;
      expect(e.code).toBe('firmware_format_mismatch');
      expect(e.hints.join(' ')).toContain('0x1000');
    }
    // Right layout, wrong chip id in the bootloader.
    const wrongId = buildMergedImage(5, 0x0, new Uint8Array(100).fill(0x5a), 0);
    expect(() => prepareMerged(wrongId, 'esp32s3', 'f.bin')).toThrow(/built for esp32c3, but the board is esp32s3/);
  });

  test('assembleFlash rounds to 4 MiB, caps at 16 MiB, refuses overlaps, trims', () => {
    const img = assembleFlash([
      { offset: 0x0, data: buildEspImage(9), label: 'bootloader' },
      { offset: 0x8000, data: new Uint8Array([0xaa, 0x50, 1, 2]), label: 'partitions' },
      { offset: 0x10000, data: buildEspImage(9), label: 'app' },
    ]);
    expect(img.length).toBe(0x10000 + 24 + 64);
    expect(img[0x8000]).toBe(0xaa);
    expect(() => assembleFlash([{ offset: 0, data: new Uint8Array(10), label: 'a' }, { offset: 5, data: new Uint8Array(10), label: 'b' }])).toThrow(/overlaps/);
    expect(() => assembleFlash([{ offset: 16 * 1024 * 1024, data: new Uint8Array(1), label: 'far' }])).toThrow(/16 MiB cap/);
  });

  test('flasher_args.json assembles the listed files at their offsets', () => {
    const dir = tmpProject({
      'build/flasher_args.json': JSON.stringify({ flash_files: { '0x0': 'bootloader/bootloader.bin', '0x8000': 'partition_table/partition-table.bin', '0x10000': 'app.bin' } }),
      'build/bootloader/bootloader.bin': buildEspImage(9, new Uint8Array(50).fill(1)),
      'build/partition_table/partition-table.bin': new Uint8Array([0xaa, 0x50, 1, 2, 3]),
      'build/app.bin': buildEspImage(9, new Uint8Array(300).fill(2)),
    });
    try {
      const entries = parseFlasherArgs(fs.readFileSync(path.join(dir, 'build/flasher_args.json'), 'utf8'), path.join(dir, 'build'));
      expect(entries.map((e) => e.offset)).toEqual([0, 0x8000, 0x10000]);
      const out = prepareFromFlasherArgs(path.join(dir, 'build/flasher_args.json'), 'esp32s3');
      expect(out.bytes.length).toBe(0x10000 + 24 + 300);
      expect(isMergedImage(out.bytes, 'esp32s3')).toBe(true);
      expect(() => prepareFromFlasherArgs(path.join(dir, 'build/flasher_args.json'), 'esp32c3')).toThrow(/built for esp32s3/);
      const fw = prepareFirmware({ path: path.join(dir, 'build/flasher_args.json'), role: 'flasher_args', origin: 'test' }, S3);
      expect(fw.format).toBe('esp-merged');
      expect(fw.sniffed).toBe('flasher_args');
    } finally {
      rmTmp(dir);
    }
    expect(() => parseFlasherArgs('{"x": 1}', '/tmp')).toThrow(/missing flash_files/);
    expect(() => parseFlasherArgs('{"flash_files": {"zz": "a"}}', '/tmp')).toThrow(/bad flash offset/);
  });

  test('bare app.bin: Arduino export siblings (with boot_app0) at the classic offsets', () => {
    const dir = tmpProject({
      'blink.ino.bin': buildEspImage(0, new Uint8Array(200).fill(7)),
      'blink.ino.bootloader.bin': buildEspImage(0, new Uint8Array(40).fill(8)),
      'blink.ino.partitions.bin': new Uint8Array([0xaa, 0x50, 0, 0]),
      'boot_app0.bin': new Uint8Array([1, 2, 3, 4]),
    });
    try {
      const s = findSiblings(path.join(dir, 'blink.ino.bin'));
      expect(s && 'how' in s ? s.how : null).toBe('Arduino export');
      const out = prepareBareApp(path.join(dir, 'blink.ino.bin'), fs.readFileSync(path.join(dir, 'blink.ino.bin')), 'esp32');
      expect(out.bytes[0x1000]).toBe(0xe9);
      expect(out.bytes[0x8000]).toBe(0xaa);
      expect(out.bytes[0xe000]).toBe(1);
      expect(out.bytes[0x10000]).toBe(0xe9);
      expect(isMergedImage(out.bytes, 'esp32')).toBe(true);
      const fw = prepareFirmware({ path: path.join(dir, 'blink.ino.bin'), role: 'firmware', origin: 'test' }, CLASSIC);
      expect(fw.description).toContain('Arduino export');
      expect(() => prepareFirmware({ path: path.join(dir, 'blink.ino.bin'), role: 'firmware', origin: 'test' }, C3)).toThrow(/built for esp32, but the board is esp32c3/);
    } finally {
      rmTmp(dir);
    }
  });

  test('bare app.bin: PlatformIO siblings, <stem>.merged.bin, and none at all', () => {
    const pio = tmpProject({
      'firmware.bin': buildEspImage(5, new Uint8Array(200).fill(7)),
      'bootloader.bin': buildEspImage(5, new Uint8Array(40).fill(8)),
      'partitions.bin': new Uint8Array([0xaa, 0x50, 0, 0]),
    });
    const merged = tmpProject({
      'app.bin': buildEspImage(9, new Uint8Array(200).fill(7)),
      'app.merged.bin': buildMergedImage(9, 0x0),
    });
    const alone = tmpProject({ 'app.bin': buildEspImage(9, new Uint8Array(200).fill(7)) });
    try {
      const fw = prepareFirmware({ path: path.join(pio, 'firmware.bin'), role: 'firmware', origin: 'test' }, C3);
      expect(fw.description).toContain('PlatformIO');
      expect(fw.bytes[0]).toBe(0xe9);
      const fw2 = prepareFirmware({ path: path.join(merged, 'app.bin'), role: 'firmware', origin: 'test' }, S3);
      expect(fw2.description).toContain('app.merged.bin');
      try {
        prepareFirmware({ path: path.join(alone, 'app.bin'), role: 'firmware', origin: 'test' }, S3);
        throw new Error('did not throw');
      } catch (err) {
        const e = err as CliError;
        expect(e.exitCode).toBe(2);
        expect(e.message).toMatch(/bare app image/);
        expect(e.hints.join(' ')).toContain('esptool.py merge_bin');
      }
    } finally {
      rmTmp(pio);
      rmTmp(merged);
      rmTmp(alone);
    }
  });

  test('wrong formats for ESP32: hex, uf2, elf', () => {
    const dir = tmpProject({
      'a.hex': sampleHex(),
      'a.uf2': buildUf2([{ addr: 0x10000000, data: new Uint8Array(8), family: 0xe48bff56 }]),
      'a.elf': buildElf32(0x5e, [{ paddr: 0x40380000, data: new Uint8Array(8) }]),
    });
    try {
      expect(() => prepareFirmware({ path: path.join(dir, 'a.hex'), role: 'firmware', origin: 't' }, S3)).toThrow(/Intel HEX cannot run on a ESP32/);
      expect(() => prepareFirmware({ path: path.join(dir, 'a.uf2'), role: 'firmware', origin: 't' }, S3)).toThrow(/UF2 cannot run/);
      const elf = thrown(() => prepareFirmware({ path: path.join(dir, 'a.elf'), role: 'elf', origin: 't' }, S3));
      expect(elf.code).toBe('feature_unsupported');
      expect(elf.message).toContain('phase 3');
    } finally {
      rmTmp(dir);
    }
  });
});

describe('sniff + family dispatch', () => {
  test('sniffs each format', () => {
    expect(sniff(new TextEncoder().encode(sampleHex()), 'a.hex')).toBe('hex');
    expect(sniff(buildElf32(0x53, [{ paddr: 0, data: new Uint8Array(4) }]), 'a.elf')).toBe('elf');
    expect(sniff(buildUf2([{ addr: 0, data: new Uint8Array(4) }]), 'a.uf2')).toBe('uf2');
    expect(sniff(buildEspImage(9), 'app.bin')).toBe('esp-image');
    expect(sniff(buildMergedImage(0, 0x1000), 'merged.bin')).toBe('esp-image');
    expect(sniff(new TextEncoder().encode('{"flash_files": {}}'), 'flasher_args.json')).toBe('flasher_args');
    expect(sniff(new Uint8Array([1, 2, 3, 4]), 'x.bin')).toBe('bin');
  });

  test('AVR takes hex or elf, not bin; RP2040 takes uf2/elf/bin, not hex', () => {
    const dir = tmpProject({
      'a.hex': sampleHex(),
      'a.elf': buildElf32(0x53, [{ paddr: 0, data: new Uint8Array([1, 2, 3]) }]),
      'a.bin': new Uint8Array([1, 2, 3]),
      'p.uf2': buildUf2([{ addr: 0x10000000, data: new Uint8Array(8).fill(4), family: 0xe48bff56 }]),
    });
    const uno = boardByKind('arduino-uno')!;
    const pico = boardByKind('raspberry-pi-pico')!;
    try {
      const hex = prepareFirmware({ path: path.join(dir, 'a.hex'), role: 'firmware', origin: 't' }, uno);
      expect(hex.format).toBe('hex');
      expect(new TextDecoder().decode(hex.bytes)).toBe(sampleHex());
      const elf = prepareFirmware({ path: path.join(dir, 'a.elf'), role: 'elf', origin: 't' }, uno);
      expect(elf.format).toBe('hex');
      expect(new TextDecoder().decode(elf.bytes)).toContain(':03000000010203F7');
      expect(thrown(() => prepareFirmware({ path: path.join(dir, 'a.bin'), role: 'firmware', origin: 't' }, uno)).code).toBe('firmware_format_mismatch');
      const uf2 = prepareFirmware({ path: path.join(dir, 'p.uf2'), role: 'firmware', origin: 't' }, pico);
      expect(uf2.format).toBe('bin');
      expect(uf2.bytes.length).toBe(8);
      expect(() => prepareFirmware({ path: path.join(dir, 'a.hex'), role: 'firmware', origin: 't' }, pico)).toThrow(/Intel HEX cannot run on a RP2040/);
      expect(() => prepareFirmware({ path: path.join(dir, 'a.bin'), role: 'elf', origin: '--elf' }, pico)).toThrow(/given as an ELF/);
      expect(() => prepareFirmware({ path: path.join(dir, 'missing.hex'), role: 'firmware', origin: 't' }, uno)).toThrow(/not found/);
    } finally {
      rmTmp(dir);
    }
  });
});

describe('size caps', () => {
  test('a converted image over 16 MiB is firmware_too_large before any upload', () => {
    // 6 MiB of ARM flash is under the input cap; as Intel HEX it is ~17 MiB.
    const dir = tmpProject({ 'big.elf': buildElf32(0x28, [{ paddr: 0, data: new Uint8Array(6 * 1024 * 1024).fill(0x5a) }]) });
    try {
      const e = thrown(() => prepareFirmware({ path: path.join(dir, 'big.elf'), role: 'elf', origin: 't' }, boardByKind('xiao-nrf52840-sense')!));
      expect(e.code).toBe('firmware_too_large');
      expect(e.message).toContain('ELF -> Intel HEX');
    } finally {
      rmTmp(dir);
    }
  });

  test('flasher_args pieces and siblings are sized before they are read', () => {
    const dir = tmpProject({
      'build/flasher_args.json': JSON.stringify({ flash_files: { '0x0': 'bootloader.bin', '0x10000': 'app.bin' } }),
      'build/bootloader.bin': buildEspImage(9),
      'app.bin': buildEspImage(9),
    });
    try {
      // Sparse: 17 MiB on paper, nothing on disk.
      fs.truncateSync(path.join(dir, 'build/bootloader.bin'), 17 * 1024 * 1024);
      fs.writeFileSync(path.join(dir, 'build/app.bin'), buildEspImage(9));
      const e = thrown(() => prepareFirmware({ path: path.join(dir, 'build/flasher_args.json'), role: 'flasher_args', origin: 't' }, S3));
      expect(e.code).toBe('firmware_too_large');
      expect(e.message).toContain('bootloader.bin');
      fs.writeFileSync(path.join(dir, 'app.merged.bin'), '');
      fs.truncateSync(path.join(dir, 'app.merged.bin'), 17 * 1024 * 1024);
      expect(thrown(() => prepareFirmware({ path: path.join(dir, 'app.bin'), role: 'firmware', origin: 't' }, S3)).code).toBe('firmware_too_large');
    } finally {
      rmTmp(dir);
    }
  });
});

describe('firmware for a board this build does not know (stale snapshot)', () => {
  test('files that settle their own format pass through for the server to decide', () => {
    const dir = tmpProject({
      'a.hex': sampleHex(),
      'a.bin': new Uint8Array([1, 2, 3, 4]),
      'p.uf2': buildUf2([{ addr: 0x10000000, data: new Uint8Array(8).fill(4), family: 0xe48bff59 }]),
      'n.uf2': buildUf2([{ addr: 0x1000, data: new Uint8Array(8).fill(5), family: 0xada52840 }]),
      'avr.elf': buildElf32(0x53, [{ paddr: 0, data: new Uint8Array([1, 2, 3]) }]),
      'merged.bin': buildMergedImage(13, 0x0),
    });
    const ref = (f: string) => ({ path: path.join(dir, f), role: 'firmware' as const, origin: 't' });
    try {
      const hex = prepareFirmwareForUnknownBoard(ref('a.hex'), 'future-board');
      expect(hex.format).toBe('hex');
      expect(hex.warnings.map((w) => w.code)).toContain('unknown_board_firmware');
      expect(prepareFirmwareForUnknownBoard(ref('a.bin'), 'future-board').format).toBe('bin');
      const uf2 = prepareFirmwareForUnknownBoard(ref('p.uf2'), 'future-board');
      expect(uf2.format).toBe('bin');
      expect(uf2.bytes.length).toBe(8);
      expect(prepareFirmwareForUnknownBoard(ref('n.uf2'), 'future-board').format).toBe('hex');
      expect(prepareFirmwareForUnknownBoard(ref('avr.elf'), 'future-board').format).toBe('hex');
      const esp = prepareFirmwareForUnknownBoard(ref('merged.bin'), 'future-board');
      expect(esp.format).toBe('esp-merged');
      expect(esp.description).toContain('esp32c6');
    } finally {
      rmTmp(dir);
    }
  });

  test('a snapshot family newer than this build passes through; a family with no formats is refused', () => {
    const dir = tmpProject({ 'a.hex': sampleHex() });
    const ref = { path: path.join(dir, 'a.hex'), role: 'firmware' as const, origin: 't' };
    try {
      const future = { ...boardByKind('arduino-uno')!, kind: 'future-board', family: 'future-family' as unknown as Family, formats: ['hex' as const] };
      expect(prepareFirmware(ref, future).format).toBe('hex');
      expect(thrown(() => prepareFirmware(ref, boardByKind('stm32-bluepill')!)).code).toBe('feature_unsupported');
    } finally {
      rmTmp(dir);
    }
  });

  test('files that need the family to convert are refused with a hint', () => {
    const dir = tmpProject({
      'arm.elf': buildElf32(0x28, [{ paddr: 0x10000000, data: new Uint8Array(8) }]),
      'app.bin': buildEspImage(9),
    });
    try {
      const arm = thrown(() => prepareFirmwareForUnknownBoard({ path: path.join(dir, 'arm.elf'), role: 'elf', origin: 't' }, 'future-board'));
      expect(arm.code).toBe('firmware_format_mismatch');
      expect(arm.message).toContain('ARM ELF');
      expect(arm.message).toContain('future-board');
      const app = thrown(() => prepareFirmwareForUnknownBoard({ path: path.join(dir, 'app.bin'), role: 'firmware', origin: 't' }, 'future-board'));
      expect(app.hints.join(' ')).toContain('merge_bin');
    } finally {
      rmTmp(dir);
    }
  });
});
