import { describe, expect, it } from 'vitest';
import { decodeBytes, detectEncoding } from '../encoding';

// Byte fixtures (hand-encoded, so the test needs no encoder for legacy charsets).
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0xa3, 0xac, 0xc4, 0xe3, 0xba, 0xc3]; // 中文测试，你好
const SJIS_NIHONGO = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x82, 0xcc, 0x83, 0x65, 0x83, 0x4c, 0x83, 0x58, 0x83, 0x67]; // 日本語のテキスト
const LATIN1_CAFE = [...'Un caf'].map((c) => c.charCodeAt(0)).concat([0xe9, 0x20, ...'tr'.split('').map((c) => c.charCodeAt(0)), 0xe8, ...'s bon'.split('').map((c) => c.charCodeAt(0))]); // Un café très bon

describe('encoding detection (#94)', () => {
  it('UTF-8 (with and without BOM) and UTF-16 BOMs', () => {
    expect(detectEncoding(new TextEncoder().encode('héllo 中文'))).toBe('utf-8');
    expect(detectEncoding(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('utf-8');
    expect(detectEncoding(Uint8Array.from([0xff, 0xfe, 0x41, 0x00]))).toBe('utf-16le');
    expect(detectEncoding(Uint8Array.from([0xfe, 0xff, 0x00, 0x41]))).toBe('utf-16be');
    expect(decodeBytes(Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x2d, 0x4e]), 'utf-16le')).toBe('A中');
  });

  it('GBK Chinese, Shift JIS Japanese, Latin-1 Western', () => {
    const gbk = Uint8Array.from([...'# '].map((c) => c.charCodeAt(0)).concat(GBK_ZHONGWEN));
    expect(detectEncoding(gbk)).toBe('gb18030');
    expect(decodeBytes(gbk, 'auto')).toBe('# 中文测试，你好');
    const sjis = Uint8Array.from(SJIS_NIHONGO);
    expect(detectEncoding(sjis)).toBe('shift_jis');
    expect(decodeBytes(sjis, 'auto')).toBe('日本語のテキスト');
    const latin = Uint8Array.from(LATIN1_CAFE);
    expect(detectEncoding(latin)).toBe('windows-1252');
    expect(decodeBytes(latin, 'auto')).toBe('Un café très bon');
  });

  it('explicit encodings override detection (lossless for the chosen charset)', () => {
    expect(decodeBytes(Uint8Array.from(GBK_ZHONGWEN.slice(0, 4)), 'gb18030')).toBe('中文');
    // Read as Latin-1 on purpose: every byte maps to one character.
    expect(decodeBytes(Uint8Array.from(GBK_ZHONGWEN.slice(0, 2)), 'windows-1252')).toBe('ÖÐ');
  });
});
