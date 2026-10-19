import { describe, it, expect } from 'vitest';
import { buildDiffMarks, diffStats, paneRole, previewText } from './compareView';
import type { DiffBlock } from '../platform/tauriApi';

const blk = (posA: number, lenA: number, posB: number, lenB: number): DiffBlock => ({
  posA,
  posB,
  lenA,
  lenB,
});

describe('paneRole', () => {
  it('目标窗是目标、另一格是对照', () => {
    expect(paneRole('a', 'a')).toBe('目标窗');
    expect(paneRole('b', 'a')).toBe('对照窗');
  });

  it('目标窗换到 B 之后，角色名跟着整体易位', () => {
    expect(paneRole('a', 'b')).toBe('对照窗');
    expect(paneRole('b', 'b')).toBe('目标窗');
  });
});

describe('buildDiffMarks', () => {
  it('B 多出的字，标在 B 窗（目标窗在 A → 那是 A 缺的字）', () => {
    // 汉字软件 vs 汉字兔软件：只有「兔」一个字是多出来的
    const marks = buildDiffMarks([blk(2, 0, 2, 1)], 'a');
    expect(marks.a).toEqual([]);
    expect(marks.b).toEqual([{ start: 2, end: 3, kind: 'missing' }]);
  });

  it('目标窗切到 B 之后，同一处红变成「B 多出」', () => {
    const marks = buildDiffMarks([blk(2, 0, 2, 1)], 'b');
    expect(marks.a).toEqual([]);
    expect(marks.b).toEqual([{ start: 2, end: 3, kind: 'extra' }]);
  });

  it('A 多出的字，标在 A 窗', () => {
    const marks = buildDiffMarks([blk(2, 1, 2, 0)], 'a');
    expect(marks.a).toEqual([{ start: 2, end: 3, kind: 'extra' }]);
    expect(marks.b).toEqual([]);
  });

  it('A 多出的字，目标窗在 B 时语义变为「B 缺」——但位置仍在 A', () => {
    const marks = buildDiffMarks([blk(2, 1, 2, 0)], 'b');
    expect(marks.a).toEqual([{ start: 2, end: 3, kind: 'missing' }]);
    expect(marks.b).toEqual([]);
  });

  it('换了一个字：两侧都要标，好让人看清两边写的什么', () => {
    const marks = buildDiffMarks([blk(2, 1, 2, 1)], 'a');
    expect(marks.a).toEqual([{ start: 2, end: 3, kind: 'extra' }]);
    expect(marks.b).toEqual([{ start: 2, end: 3, kind: 'missing' }]);
  });

  it('只差一个字时，恢复对齐的部分一个都不标', () => {
    const marks = buildDiffMarks([blk(2, 0, 2, 1)], 'a');
    expect(marks.b).toHaveLength(1);
    expect(marks.b[0]).toEqual({ start: 2, end: 3, kind: 'missing' });
    expect(marks.a).toHaveLength(0);
  });

  it('长度为 0 的一侧不产生空的标红', () => {
    const marks = buildDiffMarks([blk(5, 0, 5, 0), blk(0, 0, 0, 0)], 'a');
    expect(marks.a).toEqual([]);
    expect(marks.b).toEqual([]);
  });

  it('多处差异各自落在自己那一格', () => {
    const marks = buildDiffMarks([blk(0, 2, 0, 0), blk(8, 0, 6, 3)], 'a');
    expect(marks.a).toEqual([{ start: 0, end: 2, kind: 'extra' }]);
    expect(marks.b).toEqual([{ start: 6, end: 9, kind: 'missing' }]);
  });
});

describe('diffStats', () => {
  it('站在目标窗的立场：多出的是新增、缺的是缺失', () => {
    // A 侧多出 3 个字、B 侧多出 5 个字
    const blocks = [blk(0, 3, 0, 5)];
    expect(diffStats(blocks, 'a')).toEqual({ added: 3, missing: 5 });
    expect(diffStats(blocks, 'b')).toEqual({ added: 5, missing: 3 });
  });

  it('目标窗切过去，两个数正好互换', () => {
    const blocks = [blk(2, 0, 2, 1)];
    expect(diffStats(blocks, 'a')).toEqual({ added: 0, missing: 1 });
    expect(diffStats(blocks, 'b')).toEqual({ added: 1, missing: 0 });
  });

  it('多处差异累加，而不是取最后一处', () => {
    const blocks = [blk(0, 1, 0, 1), blk(5, 2, 5, 0)];
    expect(diffStats(blocks, 'a')).toEqual({ added: 3, missing: 1 });
  });

  it('两文一致时两个计数都是 0', () => {
    expect(diffStats([], 'a')).toEqual({ added: 0, missing: 0 });
  });
});

describe('previewText', () => {
  it('短片段原样返回', () => {
    expect(previewText('汉字兔软件', 0, 3)).toBe('汉字兔');
  });

  it('超过上限就掐断加省略号', () => {
    expect(previewText('字'.repeat(30), 0, 30)).toBe(`${'字'.repeat(12)}…`);
  });

  it('按码元切也不会把汉字切成半个', () => {
    // U+20000 在 UTF-16 里占两个码元：切到第 3 个码元正好是「它 + 兔」
    const wide = String.fromCodePoint(0x20000);
    expect(previewText(`${wide}兔子`, 0, 3)).toBe(`${wide}兔`);
  });
});
