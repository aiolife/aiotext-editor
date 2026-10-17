/**
 * 正文统计口径的单测（视图 → 字数统计 / 统计选定文字出现的次数 / 显示段落数）。
 *
 * 这些数字一旦悄悄变了（比如哪天有人改成 `.length`），代理对就会算成两个字符、
 * 空格也会被计入"字数"——所以口径锁在这里。
 */
import { describe, expect, it } from 'vitest';
import { countOccurrences, countTextStats } from './textStats';

describe('countTextStats', () => {
  it('不计空格与控制符', () => {
    // a 空格 b 换行 制表符 c
    const stats = countTextStats('a b\n\tc');
    expect(stats.chars).toBe(3);
    expect(stats.charsWithSpace).toBe(4);
    expect(stats.charsAll).toBe(6);
  });

  it('代理对算一个字符', () => {
    const text = '\u{2926F}'; // U+2926F：必须靠代理对表示
    expect(text.length).toBe(2); // JS 的 .length 会数成两个码元
    expect(countTextStats(text).chars).toBe(1);
    expect(countTextStats(text).charsAll).toBe(1);
  });

  it('全角空格与换行都不算字数', () => {
    const stats = countTextStats('甲\u3000乙\n丙');
    expect(stats.chars).toBe(3);
    expect(stats.charsWithSpace).toBe(4);
  });

  it('段落数 = 非空行数（与「段间空一行」工具同口径）', () => {
    const stats = countTextStats('甲\n乙\n\n丙\n');
    expect(stats.lines).toBe(5);
    expect(stats.paragraphs).toBe(3);
  });

  it('CRLF 与 LF 行数一致', () => {
    expect(countTextStats('甲\r\n乙\r\n').lines).toBe(3);
    expect(countTextStats('甲\n乙\n').lines).toBe(3);
  });

  it('空文档：0 段 1 行', () => {
    const stats = countTextStats('');
    expect(stats).toMatchObject({ chars: 0, lines: 1, paragraphs: 0, bytes: 0 });
  });

  it('UTF-8 字节数按实际编码计', () => {
    expect(countTextStats('a中').bytes).toBe(4);
  });
});

describe('countOccurrences', () => {
  it('非重叠计数', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('甲甲乙乙甲', '甲')).toBe(3);
  });

  it('空串 / 空文档返回 0（不是 length+1 那种怪值）', () => {
    expect(countOccurrences('abc', '')).toBe(0);
    expect(countOccurrences('', 'a')).toBe(0);
  });

  it('整篇即查询串时算 1 次', () => {
    expect(countOccurrences('甲乙丙', '甲乙丙')).toBe(1);
  });
});
