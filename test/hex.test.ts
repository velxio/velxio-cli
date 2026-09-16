import { describe, expect, test } from 'bun:test';
import { encodeIntelHex, flattenSegments, looksLikeHex, mergeSegments, validateIntelHex } from '../src/firmware/hex.ts';
import { hexRecord, sampleHex } from './helpers/binaries.ts';

describe('Intel HEX', () => {
  test('validates a good file and reports its stats', () => {
    const s = validateIntelHex(sampleHex());
    expect(s.records).toBe(4);
    expect(s.dataBytes).toBe(48);
    expect(s.hasEof).toBe(true);
    expect(s.maxAddress).toBe(48);
    expect(looksLikeHex(new TextEncoder().encode(sampleHex()))).toBe(true);
    expect(looksLikeHex(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe(false);
  });

  test('CRLF and extended records are fine', () => {
    const text = [hexRecord(4, 0, [0x08, 0x00]), hexRecord(0, 0x1000, [1, 2, 3]), ':00000001FF'].join('\r\n');
    const s = validateIntelHex(text);
    expect(s.extended).toBe(true);
    expect(s.minAddress).toBe(0x08001000);
  });

  test('rejects a bad checksum, a bad length and junk', () => {
    const bad = sampleHex().replace(/^(:10000000.*)(..)$/m, (_m, body: string, ck: string) => body + ((parseInt(ck, 16) + 1) & 0xff).toString(16).padStart(2, '0'));
    expect(() => validateIntelHex(bad)).toThrow(/checksum mismatch/);
    expect(() => validateIntelHex(':0200000001FF\n')).toThrow(/does not match record length/);
    expect(() => validateIntelHex('hello\n')).toThrow(/not an Intel HEX record/);
    expect(() => validateIntelHex(hexRecord(7, 0, []) + '\n')).toThrow(/unknown record type/);
    expect(validateIntelHex(hexRecord(0, 0, [1]) + '\n').hasEof).toBe(false);
  });

  test('encodes with type-04 records at 64 KB boundaries and splits across them', () => {
    const hex = encodeIntelHex([{ addr: 0xfff8, data: new Uint8Array(16).fill(0xab) }], 'linear');
    const lines = hex.trim().split('\n');
    expect(lines[0]).toBe(':020000040000FA');
    expect(lines[1]).toBe(hexRecord(0, 0xfff8, new Array(8).fill(0xab)));
    expect(lines[2]).toBe(':020000040001F9');
    expect(lines[3]).toBe(hexRecord(0, 0x0000, new Array(8).fill(0xab)));
    expect(lines[4]).toBe(':00000001FF');
    const s = validateIntelHex(hex);
    expect(s.dataBytes).toBe(16);
    expect(s.maxAddress).toBe(0x10008);
  });

  test('type-02 records carry the base >> 4', () => {
    const hex = encodeIntelHex([{ addr: 0x10000, data: new Uint8Array([1, 2]) }], 'segment');
    expect(hex.trim().split('\n')[0]).toBe(':020000021000EC');
    expect(validateIntelHex(hex).minAddress).toBe(0x10000);
  });

  test('flatten and merge fill gaps with 0xFF', () => {
    const bin = flattenSegments([{ addr: 0x10, data: new Uint8Array([1, 2]) }, { addr: 0x14, data: new Uint8Array([3]) }], 0x10);
    expect([...bin]).toEqual([1, 2, 0xff, 0xff, 3]);
    const merged = mergeSegments([{ addr: 4, data: new Uint8Array([9]) }, { addr: 0, data: new Uint8Array([1, 2, 3, 4]) }]);
    expect(merged).toHaveLength(1);
    expect([...merged[0]!.data]).toEqual([1, 2, 3, 4, 9]);
  });
});
