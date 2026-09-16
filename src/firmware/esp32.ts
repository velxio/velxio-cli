import fs from 'node:fs';
import path from 'node:path';
import { configError, type Warning } from '../errors.ts';
import type { EspTarget } from '../capabilities/index.ts';

/** `chip_id` (u16 LE at image header offset 12) per target. */
export const ESP_CHIP_IDS: Record<EspTarget, number> = {
  esp32: 0,
  esp32s2: 2,
  esp32c3: 5,
  esp32s3: 9,
  esp32c6: 13,
  esp32h2: 16,
  esp32p4: 18,
  esp32c5: 23,
};

/** Where the boot ROM expects the second-stage bootloader. */
export const ESP_BOOTLOADER_OFFSET: Record<EspTarget, number> = {
  esp32: 0x1000,
  esp32s2: 0x1000,
  esp32p4: 0x2000,
  esp32c5: 0x2000,
  esp32s3: 0x0,
  esp32c3: 0x0,
  esp32c6: 0x0,
  esp32h2: 0x0,
};

export const ESP_PARTITION_OFFSET = 0x8000;
export const ESP_BOOT_APP0_OFFSET = 0xe000;
export const ESP_APP_OFFSET = 0x10000;
export const ESP_IMAGE_MAGIC = 0xe9;
const FLASH_ROUND = 4 * 1024 * 1024;
export const ESP_FLASH_CAP = 16 * 1024 * 1024;

export function espTargetName(id: number): string {
  for (const [name, v] of Object.entries(ESP_CHIP_IDS)) if (v === id) return name;
  return `chip id ${id}`;
}

export function isEspImage(bytes: Uint8Array, offset = 0): boolean {
  return bytes.length > offset + 24 && bytes[offset] === ESP_IMAGE_MAGIC;
}

/** u16 LE at header offset 12, or null when there is no image there. */
export function espImageChipId(bytes: Uint8Array, offset = 0): number | null {
  if (!isEspImage(bytes, offset)) return null;
  return bytes[offset + 12]! | (bytes[offset + 13]! << 8);
}

/** 0xE9 at the family's bootloader offset AND at 0x10000, `AA 50` at 0x8000. */
export function isMergedImage(bytes: Uint8Array, target: EspTarget): boolean {
  const boot = ESP_BOOTLOADER_OFFSET[target];
  return (
    bytes.length > ESP_APP_OFFSET + 24 &&
    bytes[boot] === ESP_IMAGE_MAGIC &&
    bytes[ESP_APP_OFFSET] === ESP_IMAGE_MAGIC &&
    bytes[ESP_PARTITION_OFFSET] === 0xaa &&
    bytes[ESP_PARTITION_OFFSET + 1] === 0x50
  );
}

export function trimTrailingFf(bytes: Uint8Array, keepAtLeast = 0): Uint8Array {
  let end = bytes.length;
  while (end > keepAtLeast && bytes[end - 1] === 0xff) end--;
  return bytes.subarray(0, end);
}

export interface FlashPiece {
  offset: number;
  data: Uint8Array;
  label: string;
}

/**
 * Pieces into one 0xFF flash image sized to max(offset + len) rounded up to
 * 4 MiB (cap 16 MiB), then trimmed of trailing 0xFF for the wire.
 */
export function assembleFlash(pieces: FlashPiece[], file = 'firmware'): Uint8Array {
  let end = 0;
  for (const p of pieces) end = Math.max(end, p.offset + p.data.length);
  const size = Math.ceil(end / FLASH_ROUND) * FLASH_ROUND;
  if (size > ESP_FLASH_CAP) throw configError(`${file}: flash image would be ${size} bytes, over the 16 MiB cap`);
  const out = new Uint8Array(size).fill(0xff);
  for (const p of pieces) {
    const overlap = pieces.find((q) => q !== p && q.offset < p.offset + p.data.length && p.offset < q.offset + q.data.length);
    if (overlap) throw configError(`${file}: ${p.label} at 0x${p.offset.toString(16)} overlaps ${overlap.label} at 0x${overlap.offset.toString(16)}`);
    out.set(p.data, p.offset);
  }
  return trimTrailingFf(out, ESP_APP_OFFSET + 24);
}

export interface FlasherArgsEntry {
  offset: number;
  path: string;
}

/** ESP-IDF `flasher_args.json`: `flash_files` maps "0x1000" -> "bootloader/bootloader.bin". */
export function parseFlasherArgs(text: string, baseDir: string, file = 'flasher_args.json'): FlasherArgsEntry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw configError(`${file}: not valid JSON (${(err as Error).message})`);
  }
  const files = (doc as Record<string, unknown> | null)?.flash_files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw configError(`${file}: missing flash_files object`);
  const entries: FlasherArgsEntry[] = [];
  for (const [key, rel] of Object.entries(files as Record<string, unknown>)) {
    const offset = Number(key);
    if (!Number.isInteger(offset) || offset < 0) throw configError(`${file}: bad flash offset "${key}"`);
    if (typeof rel !== 'string' || !rel) throw configError(`${file}: flash_files["${key}"] must be a path`);
    entries.push({ offset, path: path.resolve(baseDir, rel.replace(/\\/g, '/')) });
  }
  if (!entries.length) throw configError(`${file}: flash_files is empty`);
  return entries.sort((a, b) => a.offset - b.offset);
}

export function looksLikeFlasherArgs(bytes: Uint8Array, filename: string): boolean {
  if (!filename.toLowerCase().endsWith('.json')) return false;
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  return head.includes('flash_files');
}

export interface Siblings {
  bootloader: string;
  partitions: string;
  bootApp0: string | null;
  how: string;
}

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Companions of a bare app image: Arduino "Export compiled binary"
 * (`<stem>.bootloader.bin` + `<stem>.partitions.bin`, `<stem>.merged.bin`),
 * PlatformIO (`bootloader.bin` + `partitions.bin`) or an ESP-IDF build dir
 * (`bootloader/bootloader.bin` + `partition_table/partition-table.bin`).
 */
export function findSiblings(appPath: string): { merged: string } | Siblings | null {
  const dir = path.dirname(appPath);
  const base = path.basename(appPath);
  const stem = base.toLowerCase().endsWith('.bin') ? base.slice(0, -4) : base;
  const merged = path.join(dir, `${stem}.merged.bin`);
  if (exists(merged)) return { merged };
  const bootApp0 = exists(path.join(dir, 'boot_app0.bin')) ? path.join(dir, 'boot_app0.bin') : null;
  const candidates: Array<[string, string, string]> = [
    [path.join(dir, `${stem}.bootloader.bin`), path.join(dir, `${stem}.partitions.bin`), 'Arduino export'],
    [path.join(dir, 'bootloader.bin'), path.join(dir, 'partitions.bin'), 'PlatformIO build'],
    [path.join(dir, 'bootloader', 'bootloader.bin'), path.join(dir, 'partition_table', 'partition-table.bin'), 'ESP-IDF build'],
  ];
  for (const [bootloader, partitions, how] of candidates) {
    if (exists(bootloader) && exists(partitions)) return { bootloader, partitions, bootApp0, how };
  }
  return null;
}

export interface EspPrepared {
  bytes: Uint8Array;
  description: string;
  warnings: Warning[];
}

function checkChipId(bytes: Uint8Array, offset: number, target: EspTarget, label: string, file: string): void {
  const id = espImageChipId(bytes, offset);
  if (id === null) throw configError(`${file}: no image header for the ${label} at 0x${offset.toString(16)}`);
  if (id !== ESP_CHIP_IDS[target]) {
    throw configError(`${file}: the ${label} was built for ${espTargetName(id)}, but the board is ${target}`, [], 'firmware_format_mismatch');
  }
}

function validateMerged(bytes: Uint8Array, target: EspTarget, file: string): void {
  if (!isMergedImage(bytes, target)) {
    const boot = ESP_BOOTLOADER_OFFSET[target];
    const hints = [`a merged image has the bootloader at 0x${boot.toString(16)}, the partition table at 0x8000 and the app at 0x10000`];
    for (const [t, off] of Object.entries(ESP_BOOTLOADER_OFFSET)) {
      if (off !== boot && bytes[off] === ESP_IMAGE_MAGIC && bytes[ESP_APP_OFFSET] === ESP_IMAGE_MAGIC) {
        hints.push(`the bootloader sits at 0x${off.toString(16)}, the offset of ${t}; was this image built for another chip?`);
        break;
      }
    }
    throw configError(`${file}: not a merged ESP32 flash image for ${target}`, hints, 'firmware_format_mismatch');
  }
  checkChipId(bytes, ESP_BOOTLOADER_OFFSET[target], target, 'bootloader', file);
  checkChipId(bytes, ESP_APP_OFFSET, target, 'app', file);
}

/** A flash piece named by a sibling or flasher_args.json: sized before it is read. */
function readBin(p: string, label: string): Uint8Array {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw configError(`${label} not found: ${p}`);
  }
  if (!st.isFile()) throw configError(`${label} is not a file: ${p}`);
  if (st.size > ESP_FLASH_CAP) throw configError(`${label} ${p} is ${st.size} bytes, over the ${ESP_FLASH_CAP} byte flash cap`, [], 'firmware_too_large');
  return new Uint8Array(fs.readFileSync(p));
}

/** A file the user says is a merged image (or that sniffs as one). */
export function prepareMerged(bytes: Uint8Array, target: EspTarget, file: string): EspPrepared {
  validateMerged(bytes, target, file);
  const trimmed = trimTrailingFf(bytes, ESP_APP_OFFSET + 24);
  return { bytes: trimmed, description: 'ESP32 merged image', warnings: [] };
}

export function prepareFromFlasherArgs(jsonPath: string, target: EspTarget): EspPrepared {
  const entries = parseFlasherArgs(fs.readFileSync(jsonPath, 'utf8'), path.dirname(jsonPath), path.basename(jsonPath));
  const pieces: FlashPiece[] = entries.map((e) => ({ offset: e.offset, data: readBin(e.path, `flasher_args.json entry 0x${e.offset.toString(16)}`), label: path.basename(e.path) }));
  const image = assembleFlash(pieces, path.basename(jsonPath));
  validateMerged(image, target, path.basename(jsonPath));
  return { bytes: image, description: `ESP-IDF flasher_args (${pieces.length} files merged)`, warnings: [] };
}

/** A bare app image: find its bootloader and partition table next to it. */
export function prepareBareApp(appPath: string, app: Uint8Array, target: EspTarget): EspPrepared {
  const file = path.basename(appPath);
  const siblings = findSiblings(appPath);
  if (!siblings) {
    throw configError(`${file}: this is a bare app image; the bootloader and partition table are missing`, [
      'run `esptool.py merge_bin` and point firmware at the merged image,',
      'or point `flasher_args` at build/flasher_args.json (ESP-IDF),',
      'or keep the Arduino export siblings (<sketch>.bootloader.bin, <sketch>.partitions.bin) next to it',
    ]);
  }
  if ('merged' in siblings) {
    const merged = readBin(siblings.merged, 'merged image');
    const out = prepareMerged(merged, target, path.basename(siblings.merged));
    return { ...out, description: `ESP32 merged image (${path.basename(siblings.merged)})` };
  }
  checkChipId(app, 0, target, 'app', file);
  const bootloader = readBin(siblings.bootloader, 'bootloader');
  checkChipId(bootloader, 0, target, 'bootloader', path.basename(siblings.bootloader));
  const pieces: FlashPiece[] = [
    { offset: ESP_BOOTLOADER_OFFSET[target], data: bootloader, label: 'bootloader' },
    { offset: ESP_PARTITION_OFFSET, data: readBin(siblings.partitions, 'partition table'), label: 'partition table' },
    { offset: ESP_APP_OFFSET, data: app, label: 'app' },
  ];
  if (siblings.bootApp0) pieces.push({ offset: ESP_BOOT_APP0_OFFSET, data: readBin(siblings.bootApp0, 'boot_app0'), label: 'boot_app0' });
  const image = assembleFlash(pieces, file);
  validateMerged(image, target, file);
  return { bytes: image, description: `ESP32 image merged from ${siblings.how}`, warnings: [] };
}
