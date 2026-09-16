import { describe, expect, test } from 'bun:test';
import { isUf2, parseUf2, UF2_FAMILY, uf2ToBin, uf2ToHex, uf2ToSegments } from '../src/firmware/uf2.ts';
import { validateIntelHex } from '../src/firmware/hex.ts';
import { buildUf2 } from './helpers/binaries.ts';

const BASE = 0x10000000;

describe('UF2', () => {
  test('sniffs and parses blocks with family ids', () => {
    const uf2 = buildUf2([{ addr: BASE, data: new Uint8Array(256).fill(1), family: UF2_FAMILY.RP2040 }]);
    expect(isUf2(uf2)).toBe(true);
    expect(isUf2(uf2.subarray(0, 100))).toBe(false);
    const blocks = parseUf2(uf2);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ addr: BASE, family: UF2_FAMILY.RP2040 });
    expect(blocks[0]!.data.length).toBe(256);
  });

  test('RP2040 -> BIN golden with a 0xFF gap', () => {
    const uf2 = buildUf2([
      { addr: BASE, data: new Uint8Array(256).fill(1), family: UF2_FAMILY.RP2040 },
      { addr: BASE + 256, data: new Uint8Array(256).fill(2), family: UF2_FAMILY.RP2040 },
      { addr: BASE + 0x400, data: new Uint8Array(16).fill(3), family: UF2_FAMILY.RP2040 },
    ]);
    const bin = uf2ToBin(uf2, [UF2_FAMILY.RP2040], BASE, 16 * 1024 * 1024);
    expect(bin.length).toBe(0x410);
    expect(bin[0]).toBe(1);
    expect(bin[0x1ff]).toBe(2);
    expect(bin[0x200]).toBe(0xff);
    expect(bin[0x3ff]).toBe(0xff);
    expect(bin[0x400]).toBe(3);
  });

  test('blocks of other families are skipped; none left is an error naming them', () => {
    const uf2 = buildUf2([
      { addr: BASE, data: new Uint8Array(16).fill(1), family: UF2_FAMILY.RP2350_ARM_S },
      { addr: BASE + 16, data: new Uint8Array(16).fill(2), family: 0xe48bff57 },
    ]);
    const segs = uf2ToSegments(uf2, [UF2_FAMILY.RP2350_ARM_S, UF2_FAMILY.RP2350_RISCV, UF2_FAMILY.RP2350_ARM_NS]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.data.length).toBe(16);
    expect(() => uf2ToSegments(uf2, [UF2_FAMILY.RP2040])).toThrow(/no UF2 blocks for RP2040 \(file carries RP2350 ARM-S, RP2 absolute\)/);
  });

  test('a UF2 without family ids is taken whole; not-main-flash blocks are skipped', () => {
    const uf2 = buildUf2([
      { addr: BASE, data: new Uint8Array(8).fill(1) },
      { addr: BASE + 8, data: new Uint8Array(8).fill(2), flags: 0x1 },
    ]);
    const segs = uf2ToSegments(uf2, [UF2_FAMILY.RP2040]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.data.length).toBe(8);
  });

  test('nRF52840 -> HEX keeps the address', () => {
    const uf2 = buildUf2([{ addr: 0x27000, data: new Uint8Array(32).fill(5), family: UF2_FAMILY.NRF52840 }]);
    const hex = uf2ToHex(uf2, [UF2_FAMILY.NRF52840]);
    const s = validateIntelHex(hex);
    expect(s.minAddress).toBe(0x27000);
    expect(s.dataBytes).toBe(32);
  });

  test('malformed streams are errors', () => {
    const uf2 = buildUf2([{ addr: BASE, data: new Uint8Array(8), family: UF2_FAMILY.RP2040 }]);
    expect(() => parseUf2(uf2.subarray(0, 300))).toThrow(/multiple of 512/);
    const bad = new Uint8Array(uf2);
    bad[512 - 4] = 0;
    expect(() => parseUf2(bad)).toThrow(/bad UF2 magic/);
    expect(() => uf2ToBin(buildUf2([{ addr: 0x20000000, data: new Uint8Array(8), family: UF2_FAMILY.RP2040 }]), [UF2_FAMILY.RP2040], BASE, 1024)).toThrow(/outside flash/);
  });
});
