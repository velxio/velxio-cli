import { configError } from '../errors.ts';
import { encodeIntelHex, flattenSegments, mergeSegments, type Segment } from './hex.ts';

export const UF2_MAGIC0 = 0x0a324655;
export const UF2_MAGIC1 = 0x9e5d5157;
export const UF2_MAGIC_END = 0x0ab16f30;
const UF2_FLAG_NOT_MAIN_FLASH = 0x0001;
const UF2_FLAG_FAMILY_ID = 0x2000;
const BLOCK = 512;

export const UF2_FAMILY = {
  RP2040: 0xe48bff56,
  RP2350_ARM_S: 0xe48bff59,
  RP2350_RISCV: 0xe48bff5a,
  RP2350_ARM_NS: 0xe48bff5b,
  NRF52840: 0xada52840,
} as const;

export const UF2_FAMILY_NAMES: Record<number, string> = {
  [UF2_FAMILY.RP2040]: 'RP2040',
  [UF2_FAMILY.RP2350_ARM_S]: 'RP2350 ARM-S',
  [UF2_FAMILY.RP2350_RISCV]: 'RP2350 RISC-V',
  [UF2_FAMILY.RP2350_ARM_NS]: 'RP2350 ARM-NS',
  [UF2_FAMILY.NRF52840]: 'nRF52840',
  0xe48bff57: 'RP2 absolute',
  0xe48bff58: 'RP2 data',
};

export interface Uf2Block {
  flags: number;
  addr: number;
  family: number | null;
  data: Uint8Array;
}

export function isUf2(bytes: Uint8Array): boolean {
  if (bytes.length < BLOCK) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dv.getUint32(0, true) === UF2_MAGIC0 && dv.getUint32(4, true) === UF2_MAGIC1 && dv.getUint32(508, true) === UF2_MAGIC_END;
}

/** Every well-formed block; malformed blocks are an error, not skipped. */
export function parseUf2(bytes: Uint8Array, file = 'firmware.uf2'): Uf2Block[] {
  if (bytes.length % BLOCK !== 0) throw configError(`${file}: size ${bytes.length} is not a multiple of 512`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blocks: Uf2Block[] = [];
  for (let off = 0; off < bytes.length; off += BLOCK) {
    if (dv.getUint32(off, true) !== UF2_MAGIC0 || dv.getUint32(off + 4, true) !== UF2_MAGIC1 || dv.getUint32(off + 508, true) !== UF2_MAGIC_END) {
      throw configError(`${file}: bad UF2 magic in block ${off / BLOCK}`);
    }
    const flags = dv.getUint32(off + 8, true);
    const addr = dv.getUint32(off + 12, true);
    const size = dv.getUint32(off + 16, true);
    if (size > 476) throw configError(`${file}: block ${off / BLOCK} payload of ${size} bytes exceeds 476`);
    const family = flags & UF2_FLAG_FAMILY_ID ? dv.getUint32(off + 28, true) : null;
    blocks.push({ flags, addr, family, data: bytes.subarray(off + 32, off + 32 + size) });
  }
  return blocks;
}

/**
 * Blocks of the wanted families, merged into segments. A UF2 without family
 * ids is taken whole. Blocks flagged "not main flash" are skipped.
 */
export function uf2ToSegments(bytes: Uint8Array, families: readonly number[], file = 'firmware.uf2'): Segment[] {
  const blocks = parseUf2(bytes, file);
  const seen = new Set<number>();
  const kept: Segment[] = [];
  for (const b of blocks) {
    if (b.flags & UF2_FLAG_NOT_MAIN_FLASH) continue;
    if (b.family !== null) {
      seen.add(b.family);
      if (!families.includes(b.family)) continue;
    }
    kept.push({ addr: b.addr, data: b.data });
  }
  if (!kept.length) {
    const found = [...seen].map((f) => UF2_FAMILY_NAMES[f] ?? `0x${f.toString(16)}`);
    throw configError(
      `${file}: no UF2 blocks for ${families.map((f) => UF2_FAMILY_NAMES[f] ?? `0x${f.toString(16)}`).join('/')}` +
        (found.length ? ` (file carries ${found.join(', ')})` : ''),
    );
  }
  return mergeSegments(kept);
}

/** RP2040/RP2350: flash image from `base` with 0xFF gaps. */
export function uf2ToBin(bytes: Uint8Array, families: readonly number[], base: number, flashSize: number, file = 'firmware.uf2'): Uint8Array {
  const segs = uf2ToSegments(bytes, families, file).filter((s) => s.addr >= base && s.addr + s.data.length <= base + flashSize);
  if (!segs.length) throw configError(`${file}: UF2 blocks are outside flash (0x${base.toString(16)}..)`);
  return flattenSegments(segs, base);
}

/** nRF52 and friends: Intel HEX with addresses preserved. */
export function uf2ToHex(bytes: Uint8Array, families: readonly number[], file = 'firmware.uf2'): string {
  return encodeIntelHex(uf2ToSegments(bytes, families, file), 'linear');
}
