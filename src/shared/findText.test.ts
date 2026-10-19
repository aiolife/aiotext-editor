import { describe, it, expect } from 'vitest';
import { escapeForFind, SELECTION_FILL_LIMIT } from './findText';

describe('escapeForFind', () => {
  it('普通文字原样返回（这种情形不需要切正则）', () => {
    expect(escapeForFind('汉字abc')).toBe('汉字abc');
  });

  it('正则元字符逐个转义', () => {
    expect(escapeForFind('a(b')).toBe('a\\(b');
    expect(escapeForFind('1+1')).toBe('1\\+1');
    expect(escapeForFind('[注]')).toBe('\\[注\\]');
  });

  it('跨行 / 跨段的选区转成字面的 \\n', () => {
    expect(escapeForFind('上\n下')).toBe('上\\n下');
  });

  it('CRLF 归一成一个 \\n —— 不能变成两个', () => {
    expect(escapeForFind('a\r\nb')).toBe('a\\nb');
  });

  it('制表符转成 \\t', () => {
    expect(escapeForFind('a\tb')).toBe('a\\tb');
  });

  it('转义结果与原文是否相同，就是「要不要切正则」的判据', () => {
    expect(escapeForFind('汉字')).toBe('汉字');
    expect(escapeForFind('a(b')).not.toBe('a(b');
    expect(escapeForFind('上\n下')).not.toBe('上\n下');
  });
});

describe('SELECTION_FILL_LIMIT', () => {
  it('选区自动填充的上限是 600 字', () => {
    // 这个数字改了会有行为差异，锁住它
    expect(SELECTION_FILL_LIMIT).toBe(600);
  });
});
