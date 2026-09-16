/**
 * Regenerates the binary fixtures under test/fixtures/*. Deterministic;
 * run with `bun test/fixtures/generate.ts`. Nothing here is a real
 * firmware: the images only carry the headers the CLI inspects.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildMergedImage, buildUf2, sampleHex } from '../helpers/binaries.ts';

const here = import.meta.dir;

fs.writeFileSync(path.join(here, 'uno-blink/build/firmware.hex'), sampleHex());

// ESP32-S3 (chip id 9, bootloader at 0x0) with 4 KB of trailing 0xFF to trim.
fs.writeFileSync(path.join(here, 'wokwi-esp32/build/firmware.bin'), buildMergedImage(9, 0x0, new Uint8Array(300).fill(0x5a), 4096));

// RP2040 UF2: two blocks at the flash base, one gap block later.
const rp2040 = 0xe48bff56;
fs.writeFileSync(
  path.join(here, 'pico-uf2/build/firmware.uf2'),
  buildUf2([
    { addr: 0x10000000, data: new Uint8Array(256).fill(0x01), family: rp2040 },
    { addr: 0x10000100, data: new Uint8Array(256).fill(0x02), family: rp2040 },
    { addr: 0x10000400, data: new Uint8Array(16).fill(0x03), family: rp2040 },
  ]),
);
console.log('fixtures written');
