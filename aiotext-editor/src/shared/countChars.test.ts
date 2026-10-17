import { describe, expect, it } from 'vitest';
import { countChars } from './countChars';

describe('countChars', () => {
  it('ASCII 计数', () => {
    expect(countChars('hello')).toEqual({ codePoints: 5, utf16Units: 5 });
  });

  it('BMP 中文按 1 个码点计', () => {
    expect(countChars('中文').codePoints).toBe(2);
  });

  it('增补平面字符（代理对）不拆分', () => {
    // 𩅯 = U+2956F，UTF-16 中占 2 个码元
    expect(countChars('𩅯')).toEqual({ codePoints: 1, utf16Units: 2 });
  });

  it('fc2 异体字组示例行', () => {
    // "奔倴𢍃𡗲𥤀𣦴渀犇䄯𧾜𧿣𨁼𨃦逩𩦥"（来自 data-extracted/fc2.txt）
    const line = '奔倴𢍃𡗲𥤀𣦴渀犇䄯𧾜𧿣𨁼𨃦逩𩦥';
    expect(countChars(line).codePoints).toBe(15);
  });

  it('空字符串', () => {
    expect(countChars('')).toEqual({ codePoints: 0, utf16Units: 0 });
  });
});
