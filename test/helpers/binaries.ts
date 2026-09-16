/**
 * Builders for tiny synthetic firmware files: an ELF32 with PT_LOAD
 * segments, a UF2 stream, an ESP32 image header, Intel HEX records. Used by
 * the unit tests and by test/fixtures/generate.ts.
 */

export interface SegmentSpec {
  paddr: number;
  vaddr?: number;
  data: Uint8Array;
}

function u16(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}

function u32(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}

/** Little-endian ELF32 executable with one PT_LOAD per segment. */
export function buildElf32(machine: number, segments: SegmentSpec[]): Uint8Array {
  const ehsize = 52;
  const phentsize = 32;
  const phoff = ehsize;
  let dataOff = phoff + phentsize * segments.length;
  const placed = segments.map((s) => {
    const off = dataOff;
    dataOff += s.data.length;
    return { ...s, off };
  });
  const out = new Uint8Array(dataOff);
  const ident = [0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const header = [
    ...ident,
    ...u16(2), // e_type EXEC
    ...u16(machine),
    ...u32(1), // e_version
    ...u32(0), // e_entry
    ...u32(phoff),
    ...u32(0), // e_shoff
    ...u32(0), // e_flags
    ...u16(ehsize),
    ...u16(phentsize),
    ...u16(segments.length),
    ...u16(40), // e_shentsize
    ...u16(0), // e_shnum
    ...u16(0), // e_shstrndx
  ];
  out.set(header, 0);
  placed.forEach((s, i) => {
    const ph = [
      ...u32(1), // PT_LOAD
      ...u32(s.off),
      ...u32(s.vaddr ?? s.paddr),
      ...u32(s.paddr),
      ...u32(s.data.length), // filesz
      ...u32(s.data.length), // memsz
      ...u32(5), // flags R+X
      ...u32(1), // align
    ];
    out.set(ph, phoff + i * phentsize);
    out.set(s.data, s.off);
  });
  return out;
}

export interface Uf2BlockSpec {
  addr: number;
  data: Uint8Array;
  family?: number | null;
  flags?: number;
}

/** UF2 stream; blocks with a family id set flag 0x2000. */
export function buildUf2(blocks: Uf2BlockSpec[]): Uint8Array {
  const out = new Uint8Array(blocks.length * 512);
  blocks.forEach((b, i) => {
    const off = i * 512;
    const family = b.family ?? null;
    const flags = (b.flags ?? 0) | (family !== null ? 0x2000 : 0);
    const head = [
      ...u32(0x0a324655),
      ...u32(0x9e5d5157),
      ...u32(flags),
      ...u32(b.addr),
      ...u32(b.data.length),
      ...u32(i),
      ...u32(blocks.length),
      ...u32(family ?? 0),
    ];
    out.set(head, off);
    out.set(b.data, off + 32);
    out.set(u32(0x0ab16f30), off + 508);
  });
  return out;
}

/** An ESP32 image header (24 bytes) + `body`, with `chipId` at offset 12. */
export function buildEspImage(chipId: number, body: Uint8Array = new Uint8Array(64).fill(0x11)): Uint8Array {
  const header = new Uint8Array(24);
  header[0] = 0xe9;
  header[1] = 1; // segment count
  header[2] = 0x02;
  header[3] = 0x20;
  header.set(u32(0x40380000), 4);
  header[8] = 0xee;
  header.set(u16(chipId), 12);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

/** A merged flash image: bootloader at `bootOffset`, partition table at 0x8000, app at 0x10000. */
export function buildMergedImage(chipId: number, bootOffset: number, appBody = new Uint8Array(200).fill(0x22), trailingFf = 0): Uint8Array {
  const app = buildEspImage(chipId, appBody);
  const size = 0x10000 + app.length + trailingFf;
  const out = new Uint8Array(size).fill(0xff);
  out.set(buildEspImage(chipId, new Uint8Array(100).fill(0x33)), bootOffset);
  out.set([0xaa, 0x50, 0x01, 0x02, 0x00, 0x90, 0x00, 0x00], 0x8000);
  out.set(app, 0x10000);
  return out;
}

export function hexRecord(type: number, addr: number, data: number[]): string {
  const bytes = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  bytes.push((0x100 - sum) & 0xff);
  return ':' + bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/** A small valid Intel HEX program (an AVR `rjmp .-2` loop plus filler). */
export function sampleHex(): string {
  const lines: string[] = [];
  const bytes: number[] = [];
  for (let i = 0; i < 48; i++) bytes.push(i & 1 ? 0xcf : 0xff);
  for (let a = 0; a < bytes.length; a += 16) lines.push(hexRecord(0, a, bytes.slice(a, a + 16)));
  lines.push(':00000001FF');
  return lines.join('\n') + '\n';
}
