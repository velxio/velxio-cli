import fs from 'node:fs';
import path from 'node:path';
import { configError, type Warning } from '../errors.ts';
import { espTargetOf, LIMITS, wireFormatFor, type BoardCapability, type EspTarget } from '../capabilities/index.ts';
import type { FirmwareRef } from '../config/resolve.ts';
import type { WireFormat } from '../protocol/messages.ts';
import { looksLikeHex, validateIntelHex } from './hex.ts';
import { armElfToHex, avrElfToHex, EM_AVR, isElf, parseElf, machineName, rp2ElfToBin, RP2_FLASH_BASE, RP2_FLASH_SIZE } from './elf.ts';
import { isUf2, parseUf2, uf2ToBin, uf2ToHex, UF2_FAMILY, UF2_FAMILY_NAMES } from './uf2.ts';
import { ESP_BOOTLOADER_OFFSET, ESP_CHIP_IDS, espImageChipId, isEspImage, isMergedImage, looksLikeFlasherArgs, prepareBareApp, prepareFromFlasherArgs, prepareMerged } from './esp32.ts';

export type Sniffed = 'hex' | 'elf' | 'uf2' | 'esp-image' | 'flasher_args' | 'bin';

export interface PreparedFirmware {
  format: WireFormat;
  bytes: Uint8Array;
  /** For the transcript: "Intel HEX", "ELF -> Intel HEX", ... */
  description: string;
  sniffed: Sniffed;
  warnings: Warning[];
}

/** Decide what a file is from its bytes; the extension only breaks ties. */
export function sniff(bytes: Uint8Array, filename: string): Sniffed {
  if (looksLikeFlasherArgs(bytes, filename)) return 'flasher_args';
  if (isElf(bytes)) return 'elf';
  if (isUf2(bytes)) return 'uf2';
  if (looksLikeHex(bytes)) return 'hex';
  if (isEspImage(bytes) || (bytes.length > 0x1000 && bytes[0] === 0xff && isEspImage(bytes, 0x1000)) || (bytes.length > 0x2000 && bytes[0] === 0xff && isEspImage(bytes, 0x2000))) {
    return 'esp-image';
  }
  return 'bin';
}

const MAX_FIRMWARE = LIMITS.max_firmware_bytes;

function readFirmware(ref: FirmwareRef): Uint8Array {
  let st: fs.Stats;
  try {
    st = fs.statSync(ref.path);
  } catch {
    throw configError(`firmware not found: ${ref.path} (from ${ref.origin})`);
  }
  if (!st.isFile()) throw configError(`firmware is not a file: ${ref.path}`);
  if (st.size > MAX_FIRMWARE) throw configError(`firmware ${ref.path} is ${st.size} bytes, over the ${MAX_FIRMWARE} byte cap`, [], 'firmware_too_large');
  if (st.size === 0) throw configError(`firmware ${ref.path} is empty`);
  return new Uint8Array(fs.readFileSync(ref.path));
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function mismatch(file: string, what: string, family: string, wants: string): never {
  throw configError(`${file}: ${what} cannot run on a ${family} board (it takes ${wants})`, [], 'firmware_format_mismatch');
}

/**
 * Read, sniff and convert the firmware into the family's wire format. The
 * server re-validates magic, size and family; this is the local gate. The
 * converted image is held to the per-board cap too (ELF -> HEX roughly
 * triples the size), so an oversized blob never reaches run.create.
 */
export function prepareFirmware(ref: FirmwareRef, board: BoardCapability): PreparedFirmware {
  return checkConvertedSize(convertForBoard(ref, board), ref);
}

/**
 * The firmware of a board this CLI build does not know (the snapshot is
 * stale and the server decides): no family checks, only conversions the
 * file itself settles. HEX stays HEX, a raw image goes as `bin`, a merged
 * ESP32 image names its chip, a UF2 names its family, an AVR ELF becomes
 * HEX. Anything that needs the family to convert is refused with a hint.
 */
export function prepareFirmwareForUnknownBoard(ref: FirmwareRef, boardKind: string): PreparedFirmware {
  return checkConvertedSize(passThrough(ref, boardKind), ref);
}

function checkConvertedSize(fw: PreparedFirmware, ref: FirmwareRef): PreparedFirmware {
  if (fw.bytes.length > MAX_FIRMWARE) {
    throw configError(`firmware ${path.basename(ref.path)} converts to ${fw.bytes.length} bytes (${fw.description}), over the ${MAX_FIRMWARE} byte cap`, [], 'firmware_too_large');
  }
  return fw;
}

function convertForBoard(ref: FirmwareRef, board: BoardCapability): PreparedFirmware {
  const format = wireFormatFor(board.family);
  if (!format) {
    // A family newer than this build: the snapshot knows the board, the code does not.
    if (board.formats.length) return passThrough(ref, board.kind);
    throw configError(`board ${board.kind} (${board.family}) takes no firmware through Velxio CI yet`, [], 'feature_unsupported');
  }
  const bytes = readFirmware(ref);
  const file = path.basename(ref.path);
  const warnings: Warning[] = [];
  let sniffed = sniff(bytes, file);
  if (ref.role === 'elf' && sniffed !== 'elf') throw configError(`${file} was given as an ELF (${ref.origin}) but is not one`);
  if (ref.role === 'flasher_args' && sniffed !== 'flasher_args') throw configError(`${file} was given as flasher_args (${ref.origin}) but has no flash_files`);

  switch (board.family) {
    case 'avr': {
      if (sniffed === 'hex') {
        const text = new TextDecoder().decode(bytes);
        const stats = validateIntelHex(text, file);
        if (!stats.hasEof) warnings.push({ code: 'hex_no_eof', message: `${file}: no end-of-file record` });
        return { format, bytes, description: 'Intel HEX', sniffed, warnings };
      }
      if (sniffed === 'elf') {
        const hex = avrElfToHex(bytes, file);
        return { format, bytes: utf8(hex), description: 'ELF -> Intel HEX', sniffed, warnings };
      }
      mismatch(file, describeSniff(sniffed), 'AVR', '.hex or .elf');
    }
    case 'rp2040':
    case 'rp2350': {
      const families = board.family === 'rp2040' ? [UF2_FAMILY.RP2040] : [UF2_FAMILY.RP2350_ARM_S, UF2_FAMILY.RP2350_RISCV, UF2_FAMILY.RP2350_ARM_NS];
      if (sniffed === 'uf2') {
        const bin = uf2ToBin(bytes, families, RP2_FLASH_BASE, RP2_FLASH_SIZE, file);
        return { format, bytes: bin, description: 'UF2 -> flash image', sniffed, warnings };
      }
      if (sniffed === 'elf') {
        const { bin, skipped } = rp2ElfToBin(bytes, file);
        if (skipped) warnings.push({ code: 'elf_segments_skipped', message: `${file}: ${skipped} non-flash segment(s) skipped` });
        return { format, bytes: bin, description: 'ELF -> flash image', sniffed, warnings };
      }
      if (sniffed === 'bin' || sniffed === 'esp-image') {
        if (sniffed === 'esp-image') warnings.push({ code: 'suspicious_image', message: `${file}: starts like an ESP32 image but the board is ${board.kind}` });
        return { format, bytes, description: 'raw flash image', sniffed: 'bin', warnings };
      }
      mismatch(file, describeSniff(sniffed), board.family.toUpperCase(), '.bin, .uf2 or .elf');
    }
    case 'xiao-arm': {
      if (sniffed === 'hex') {
        const stats = validateIntelHex(new TextDecoder().decode(bytes), file);
        if (!stats.hasEof) warnings.push({ code: 'hex_no_eof', message: `${file}: no end-of-file record` });
        return { format, bytes, description: 'Intel HEX', sniffed, warnings };
      }
      if (sniffed === 'elf') return { format, bytes: utf8(armElfToHex(bytes, file)), description: 'ELF -> Intel HEX', sniffed, warnings };
      if (sniffed === 'uf2') return { format, bytes: utf8(uf2ToHex(bytes, [UF2_FAMILY.NRF52840], file)), description: 'UF2 -> Intel HEX', sniffed, warnings };
      mismatch(file, describeSniff(sniffed), 'XIAO ARM', '.hex, .elf or .uf2');
    }
    case 'esp32': {
      const target = espTargetOf(board);
      if (!target) throw configError(`board ${board.kind} has no ESP32 target in the capabilities snapshot`);
      if (sniffed === 'flasher_args') {
        const out = prepareFromFlasherArgs(ref.path, target);
        return { format, bytes: out.bytes, description: out.description, sniffed, warnings: [...warnings, ...out.warnings] };
      }
      if (sniffed === 'elf') {
        const elf = parseElf(bytes, file);
        throw configError(`${file}: ESP32 ELF (${machineName(elf.machine)}) conversion arrives in phase 3`, [
          'run `esptool.py --chip <target> elf2image` and `esptool.py merge_bin`, or point `flasher_args` at build/flasher_args.json',
        ], 'feature_unsupported');
      }
      if (sniffed === 'hex') mismatch(file, 'Intel HEX', 'ESP32', 'a merged flash image, flasher_args.json or app.bin with its siblings');
      if (sniffed === 'uf2') mismatch(file, 'UF2', 'ESP32', 'a merged flash image, flasher_args.json or app.bin with its siblings');
      if (isMergedImage(bytes, target)) {
        const out = prepareMerged(bytes, target, file);
        return { format, bytes: out.bytes, description: out.description, sniffed: 'esp-image', warnings };
      }
      if (isEspImage(bytes)) {
        const out = prepareBareApp(ref.path, bytes, target);
        return { format, bytes: out.bytes, description: out.description, sniffed: 'esp-image', warnings: [...warnings, ...out.warnings] };
      }
      // 0xFF-padded merged images for another chip's bootloader offset are caught here.
      const out = prepareMerged(bytes, target, file);
      return { format, bytes: out.bytes, description: out.description, sniffed, warnings };
    }
    default:
      // Every family without a wire format was handled above.
      return passThrough(ref, board.kind);
  }
}

function passThrough(ref: FirmwareRef, boardKind: string): PreparedFirmware {
  const bytes = readFirmware(ref);
  const file = path.basename(ref.path);
  const sniffed = sniff(bytes, file);
  const warnings: Warning[] = [];
  let out = bytes;
  const say = (format: WireFormat, description: string): PreparedFirmware => {
    warnings.push({ code: 'unknown_board_firmware', message: `${file}: board kind ${boardKind} is unknown to this CLI build; firmware sent as ${format} without family checks, the server decides` });
    return { format, bytes: out, description, sniffed, warnings };
  };
  const refuse = (what: string, hint: string): never => {
    throw configError(`${file}: ${what} needs the board family to convert, and this CLI build does not know board kind ${boardKind}`, [hint, 'or upgrade the CLI'], 'firmware_format_mismatch');
  };
  switch (sniffed) {
    case 'hex': {
      const stats = validateIntelHex(new TextDecoder().decode(bytes), file);
      if (!stats.hasEof) warnings.push({ code: 'hex_no_eof', message: `${file}: no end-of-file record` });
      return say('hex', 'Intel HEX');
    }
    case 'bin':
      return say('bin', 'raw flash image');
    case 'uf2': {
      const families = new Set(parseUf2(bytes, file).map((b) => b.family).filter((f): f is number => f !== null));
      if (families.has(UF2_FAMILY.RP2040) || families.has(UF2_FAMILY.RP2350_ARM_S) || families.has(UF2_FAMILY.RP2350_RISCV) || families.has(UF2_FAMILY.RP2350_ARM_NS)) {
        const rp = [UF2_FAMILY.RP2040, UF2_FAMILY.RP2350_ARM_S, UF2_FAMILY.RP2350_RISCV, UF2_FAMILY.RP2350_ARM_NS].filter((f) => families.has(f));
        out = uf2ToBin(bytes, rp, RP2_FLASH_BASE, RP2_FLASH_SIZE, file);
        return say('bin', `UF2 (${rp.map((f) => UF2_FAMILY_NAMES[f]).join(', ')}) -> flash image`);
      }
      if (families.has(UF2_FAMILY.NRF52840)) {
        out = new TextEncoder().encode(uf2ToHex(bytes, [UF2_FAMILY.NRF52840], file));
        return say('hex', 'UF2 (nRF52840) -> Intel HEX');
      }
      return refuse('a UF2 without an RP2 or nRF52840 family id', 'convert it to .bin or .hex first');
    }
    case 'elf': {
      const elf = parseElf(bytes, file);
      if (elf.machine === EM_AVR) {
        out = new TextEncoder().encode(avrElfToHex(bytes, file));
        return say('hex', 'ELF -> Intel HEX');
      }
      return refuse(`an ${machineName(elf.machine)} ELF`, 'pass the .hex, .bin or .uf2 your build also writes');
    }
    case 'esp-image': {
      for (const [target, offset] of Object.entries(ESP_BOOTLOADER_OFFSET) as Array<[EspTarget, number]>) {
        if (espImageChipId(bytes, offset) === ESP_CHIP_IDS[target] && isMergedImage(bytes, target)) {
          out = prepareMerged(bytes, target, file).bytes;
          return say('esp-merged', `ESP32 merged image (${target})`);
        }
      }
      return refuse('a bare ESP32 app image', 'run `esptool.py merge_bin` and pass the merged image');
    }
    case 'flasher_args':
      return refuse('flasher_args.json', 'run `esptool.py merge_bin` and pass the merged image');
  }
}

export function describeSniff(s: Sniffed): string {
  switch (s) {
    case 'hex':
      return 'Intel HEX';
    case 'elf':
      return 'an ELF';
    case 'uf2':
      return 'a UF2';
    case 'esp-image':
      return 'an ESP32 image';
    case 'flasher_args':
      return 'flasher_args.json';
    default:
      return 'a raw binary';
  }
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
