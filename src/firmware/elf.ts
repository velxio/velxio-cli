import { configError } from '../errors.ts';
import { encodeIntelHex, flattenSegments, mergeSegments, type Segment } from './hex.ts';

export const EM_ARM = 0x28;
export const EM_AVR = 0x53;
export const EM_XTENSA = 0x5e;
export const EM_RISCV = 0xf3;

const PT_LOAD = 1;

export interface ElfInfo {
  class: 32 | 64;
  machine: number;
  /** PT_LOAD segments with file bytes, placed at their physical address (LMA). */
  segments: Segment[];
}

export function isElf(bytes: Uint8Array): boolean {
  return bytes.length >= 52 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}

/** Minimal ELF32/ELF64 little-endian program-header reader. */
export function parseElf(bytes: Uint8Array, file = 'firmware.elf'): ElfInfo {
  if (!isElf(bytes)) throw configError(`${file}: not an ELF file`);
  const cls = bytes[4];
  if (cls !== 1 && cls !== 2) throw configError(`${file}: unknown ELF class ${cls}`);
  if (bytes[5] !== 1) throw configError(`${file}: big-endian ELF is not supported`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const machine = dv.getUint16(18, true);
  const is64 = cls === 2;
  const phoff = is64 ? Number(dv.getBigUint64(32, true)) : dv.getUint32(28, true);
  const phentsize = dv.getUint16(is64 ? 54 : 42, true);
  const phnum = dv.getUint16(is64 ? 56 : 44, true);
  if (phnum === 0) throw configError(`${file}: ELF has no program headers (a relocatable object, not a linked firmware?)`);
  if (phoff + phnum * phentsize > bytes.length) throw configError(`${file}: program header table runs past the end of the file`);
  const segments: Segment[] = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    const type = dv.getUint32(p, true);
    if (type !== PT_LOAD) continue;
    let offset: number, paddr: number, filesz: number;
    if (is64) {
      offset = Number(dv.getBigUint64(p + 8, true));
      paddr = Number(dv.getBigUint64(p + 24, true));
      filesz = Number(dv.getBigUint64(p + 32, true));
    } else {
      offset = dv.getUint32(p + 4, true);
      paddr = dv.getUint32(p + 12, true);
      filesz = dv.getUint32(p + 16, true);
    }
    if (filesz === 0) continue;
    if (offset + filesz > bytes.length) throw configError(`${file}: PT_LOAD segment ${i} runs past the end of the file`);
    segments.push({ addr: paddr, data: bytes.subarray(offset, offset + filesz) });
  }
  return { class: is64 ? 64 : 32, machine, segments: mergeSegments(segments) };
}

export function machineName(machine: number): string {
  switch (machine) {
    case EM_ARM:
      return 'ARM';
    case EM_AVR:
      return 'AVR';
    case EM_XTENSA:
      return 'Xtensa';
    case EM_RISCV:
      return 'RISC-V';
    default:
      return `e_machine 0x${machine.toString(16)}`;
  }
}

/** AVR LMAs at or above 0x800000 are EEPROM/fuses/lock/signature spaces, not flash. */
const AVR_FLASH_LIMIT = 0x800000;

/**
 * AVR: flash segments (LMA below 0x800000) as Intel HEX with type-02
 * records, byte-identical in content to `avr-objcopy -O ihex -R .eeprom`.
 */
export function avrElfToHex(bytes: Uint8Array, file = 'firmware.elf'): string {
  const elf = parseElf(bytes, file);
  if (elf.machine !== EM_AVR) throw configError(`${file}: expected an AVR ELF, got ${machineName(elf.machine)}`);
  const flash = elf.segments.filter((s) => s.addr < AVR_FLASH_LIMIT);
  if (!flash.length) throw configError(`${file}: no flash segments in the ELF`);
  return encodeIntelHex(flash, 'segment');
}

/** ARM (XIAO family): every PT_LOAD by LMA, Intel HEX with type-04 records. */
export function armElfToHex(bytes: Uint8Array, file = 'firmware.elf'): string {
  const elf = parseElf(bytes, file);
  if (elf.machine !== EM_ARM && elf.machine !== EM_RISCV) throw configError(`${file}: expected an ARM or RISC-V ELF, got ${machineName(elf.machine)}`);
  if (!elf.segments.length) throw configError(`${file}: no loadable segments in the ELF`);
  return encodeIntelHex(elf.segments, 'linear');
}

export const RP2_FLASH_BASE = 0x10000000;
export const RP2_FLASH_SIZE = 16 * 1024 * 1024;

/**
 * RP2040/RP2350: flash segments flattened from 0x10000000 with 0xFF gaps.
 * A no_flash / copy_to_ram build has nothing in flash and is refused.
 */
export function rp2ElfToBin(bytes: Uint8Array, file = 'firmware.elf'): { bin: Uint8Array; skipped: number } {
  const elf = parseElf(bytes, file);
  if (elf.machine !== EM_ARM && elf.machine !== EM_RISCV) throw configError(`${file}: expected an ARM or RISC-V ELF, got ${machineName(elf.machine)}`);
  const inFlash = elf.segments.filter((s) => s.addr >= RP2_FLASH_BASE && s.addr + s.data.length <= RP2_FLASH_BASE + RP2_FLASH_SIZE);
  if (!inFlash.length) {
    throw configError(`${file}: no segments in flash (0x10000000..); is this a no_flash or copy_to_ram build?`, [
      'build a default (flash) target, or pass the .uf2 or .bin instead',
    ]);
  }
  return { bin: flattenSegments(inFlash, RP2_FLASH_BASE), skipped: elf.segments.length - inFlash.length };
}
