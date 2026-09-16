import { describe, expect, test } from 'bun:test';
import { avrElfToHex, armElfToHex, EM_ARM, EM_AVR, EM_XTENSA, parseElf, rp2ElfToBin } from '../src/firmware/elf.ts';
import { validateIntelHex } from '../src/firmware/hex.ts';
import { buildElf32, hexRecord } from './helpers/binaries.ts';

const text = new Uint8Array([0x0c, 0x94, 0x34, 0x00, 0x0c, 0x94, 0x3e, 0x00, 0xff, 0xcf]);
const data = new Uint8Array([0x48, 0x69, 0x00]);

describe('ELF', () => {
  test('parses PT_LOAD segments by paddr and merges touching ones', () => {
    const elf = buildElf32(EM_AVR, [
      { paddr: 0, data: text },
      { paddr: text.length, vaddr: 0x800100, data }, // .data: LMA follows .text
      { paddr: 0x810000, vaddr: 0x810000, data: new Uint8Array([0xee]) }, // .eeprom
    ]);
    const info = parseElf(elf);
    expect(info.class).toBe(32);
    expect(info.machine).toBe(EM_AVR);
    expect(info.segments.map((s) => [s.addr, s.data.length])).toEqual([
      [0, text.length + data.length],
      [0x810000, 1],
    ]);
  });

  test('AVR -> HEX golden: flash only, .eeprom dropped, type-02 style', () => {
    const elf = buildElf32(EM_AVR, [
      { paddr: 0, data: text },
      { paddr: text.length, vaddr: 0x800100, data },
      { paddr: 0x810000, vaddr: 0x810000, data: new Uint8Array([0xee]) },
    ]);
    const hex = avrElfToHex(elf);
    const flash = [...text, ...data];
    expect(hex).toBe([':020000020000FC', hexRecord(0, 0, flash), ':00000001FF'].join('\n') + '\n');
    const s = validateIntelHex(hex);
    expect(s.dataBytes).toBe(13);
    expect(s.maxAddress).toBe(13);
  });

  test('AVR conversion refuses a non-AVR ELF', () => {
    const elf = buildElf32(EM_ARM, [{ paddr: 0x10000000, data: text }]);
    expect(() => avrElfToHex(elf)).toThrow(/expected an AVR ELF, got ARM/);
  });

  test('ARM -> HEX keeps addresses with type-04 records', () => {
    const elf = buildElf32(EM_ARM, [{ paddr: 0x27000, data: text }, { paddr: 0x27000 + text.length, vaddr: 0x20000000, data }]);
    const hex = armElfToHex(elf);
    expect(hex.trim().split('\n')[0]).toBe(':020000040002F8');
    const s = validateIntelHex(hex);
    expect(s.minAddress).toBe(0x27000);
    expect(s.maxAddress).toBe(0x27000 + 13);
  });

  test('RP2 -> BIN golden from 0x10000000 with 0xFF gaps; RAM segments skipped', () => {
    const elf = buildElf32(EM_ARM, [
      { paddr: 0x10000000, data: new Uint8Array([1, 2, 3, 4]) },
      { paddr: 0x10000100, data: new Uint8Array([9, 9]) },
      { paddr: 0x20000000, data: new Uint8Array([7]) },
    ]);
    const { bin, skipped } = rp2ElfToBin(elf);
    expect(skipped).toBe(1);
    expect(bin.length).toBe(0x102);
    expect([...bin.subarray(0, 5)]).toEqual([1, 2, 3, 4, 0xff]);
    expect([...bin.subarray(0x100)]).toEqual([9, 9]);
  });

  test('RP2 refuses a RAM-only ELF and a Xtensa one', () => {
    expect(() => rp2ElfToBin(buildElf32(EM_ARM, [{ paddr: 0x20000000, data: text }]))).toThrow(/no segments in flash/);
    expect(() => rp2ElfToBin(buildElf32(EM_XTENSA, [{ paddr: 0x10000000, data: text }]))).toThrow(/expected an ARM or RISC-V ELF/);
  });

  test('rejects non-ELF, big-endian and truncated files', () => {
    expect(() => parseElf(new Uint8Array(64))).toThrow(/not an ELF/);
    const be = buildElf32(EM_AVR, [{ paddr: 0, data: text }]);
    be[5] = 2;
    expect(() => parseElf(be)).toThrow(/big-endian/);
    const short = buildElf32(EM_AVR, [{ paddr: 0, data: text }]).subarray(0, 60);
    expect(() => parseElf(short)).toThrow(/past the end/);
  });
});
