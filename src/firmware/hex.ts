import { configError } from '../errors.ts';

/** A contiguous run of bytes at a load address. */
export interface Segment {
  addr: number;
  data: Uint8Array;
}

export interface HexStats {
  records: number;
  dataBytes: number;
  minAddress: number;
  maxAddress: number;
  hasEof: boolean;
  extended: boolean;
}

const HEX_LINE_RE = /^:[0-9A-Fa-f]+$/;

/** Cheap sniff: the first non-blank line is an Intel HEX record. */
export function looksLikeHex(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512));
  const first = head.split(/\r?\n/).find((l) => l.trim().length > 0);
  return !!first && /^:[0-9A-Fa-f]{10,}\s*$/.test(first);
}

/** Validate every record (length, checksum, type) without altering the text. */
export function validateIntelHex(text: string, file = 'firmware.hex'): HexStats {
  const stats: HexStats = { records: 0, dataBytes: 0, minAddress: Infinity, maxAddress: 0, hasEof: false, extended: false };
  let upper = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const where = `${file}:${i + 1}`;
    if (!HEX_LINE_RE.test(line)) throw configError(`${where}: not an Intel HEX record`);
    if (line.length % 2 !== 1) throw configError(`${where}: odd number of hex digits`);
    const bytes = new Uint8Array((line.length - 1) / 2);
    for (let j = 0; j < bytes.length; j++) bytes[j] = parseInt(line.substr(1 + j * 2, 2), 16);
    if (bytes.length < 5) throw configError(`${where}: record too short`);
    const len = bytes[0]!;
    if (bytes.length !== len + 5) throw configError(`${where}: byte count ${len} does not match record length`);
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xff;
    if (sum !== 0) throw configError(`${where}: checksum mismatch`);
    const addr = (bytes[1]! << 8) | bytes[2]!;
    const type = bytes[3]!;
    stats.records++;
    switch (type) {
      case 0x00: {
        const start = upper + addr;
        stats.dataBytes += len;
        stats.minAddress = Math.min(stats.minAddress, start);
        stats.maxAddress = Math.max(stats.maxAddress, start + len);
        break;
      }
      case 0x01:
        stats.hasEof = true;
        break;
      case 0x02:
        if (len !== 2) throw configError(`${where}: extended segment address record must carry 2 bytes`);
        upper = ((bytes[4]! << 8) | bytes[5]!) << 4;
        stats.extended = true;
        break;
      case 0x04:
        if (len !== 2) throw configError(`${where}: extended linear address record must carry 2 bytes`);
        upper = ((bytes[4]! << 8) | bytes[5]!) << 16;
        stats.extended = true;
        break;
      case 0x03:
      case 0x05:
        break;
      default:
        throw configError(`${where}: unknown record type 0x${type.toString(16).padStart(2, '0')}`);
    }
    if (stats.hasEof) break;
  }
  if (stats.records === 0) throw configError(`${file}: no Intel HEX records found`);
  if (stats.minAddress === Infinity) stats.minAddress = 0;
  return stats;
}

function record(type: number, addr: number, data: Uint8Array): string {
  const bytes = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  bytes.push((0x100 - sum) & 0xff);
  return ':' + bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/**
 * Encode segments as Intel HEX with 16-byte data records. Addresses above
 * 64 KB get type-02 (`segment`, what avr-objcopy writes) or type-04
 * (`linear`, what arm-none-eabi-objcopy writes) records.
 */
export function encodeIntelHex(segments: Segment[], extended: 'segment' | 'linear' = 'linear'): string {
  const out: string[] = [];
  let upper = -1;
  const sorted = [...segments].filter((s) => s.data.length > 0).sort((a, b) => a.addr - b.addr);
  for (const seg of sorted) {
    let addr = seg.addr;
    let off = 0;
    while (off < seg.data.length) {
      const hi = addr >>> 16;
      if (hi !== upper) {
        if (hi > 0xffff) throw configError(`address 0x${addr.toString(16)} does not fit Intel HEX`);
        if (extended === 'segment' && hi > 0xf) throw configError(`address 0x${addr.toString(16)} does not fit a type-02 record`);
        // Type 02 carries the base >> 4; we only emit 64 KB-aligned bases.
        const ext = extended === 'segment' ? (hi << 12) & 0xffff : hi;
        out.push(record(extended === 'segment' ? 0x02 : 0x04, 0, new Uint8Array([(ext >> 8) & 0xff, ext & 0xff])));
        upper = hi;
      }
      const room = 0x10000 - (addr & 0xffff);
      const n = Math.min(16, seg.data.length - off, room);
      out.push(record(0x00, addr & 0xffff, seg.data.subarray(off, off + n)));
      addr += n;
      off += n;
    }
  }
  out.push(':00000001FF');
  return out.join('\n') + '\n';
}

/** Lay segments into one image starting at `base`; gaps are `fill`. */
export function flattenSegments(segments: Segment[], base: number, fill = 0xff): Uint8Array {
  let end = base;
  for (const s of segments) end = Math.max(end, s.addr + s.data.length);
  const out = new Uint8Array(end - base).fill(fill);
  for (const s of segments) out.set(s.data, s.addr - base);
  return out;
}

/** Merge touching or overlapping runs so callers see the fewest segments. */
export function mergeSegments(segments: Segment[]): Segment[] {
  const sorted = [...segments].filter((s) => s.data.length > 0).sort((a, b) => a.addr - b.addr);
  const out: Segment[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.addr <= last.addr + last.data.length) {
      const end = Math.max(last.addr + last.data.length, s.addr + s.data.length);
      const merged = new Uint8Array(end - last.addr);
      merged.set(last.data, 0);
      merged.set(s.data, s.addr - last.addr);
      last.data = merged;
    } else {
      out.push({ addr: s.addr, data: new Uint8Array(s.data) });
    }
  }
  return out;
}
