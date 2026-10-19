import { describe, it, expect } from 'vitest';
import { buildDiffMarks, paneRole } from './compareView';
import type { DiffSegment } from '../platform/tauriApi';

const seg = (kind: 'delete' | 'insert', posA: number, lenA: number, posB: number, lenB: number): DiffSegment => ({
  kind,
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
    const marks = buildDiffMarks([seg('insert', 2, 0, 2, 1)], 'a');
    expect(marks.a).toEqual([]);
    expect(marks.b).toEqual([{ start: 2, end: 3, kind: 'missing' }]);
  });

  it('目标窗切到 B 之后，同一段红变成「B 多出」', () => {
    const marks = buildDiffMarks([seg('insert', 2, 0, 2, 1)], 'b');
    expect(marks.a).toEqual([]);
    expect(marks.b).toEqual([{ start: 2, end: 3, kind: 'extra' }]);
  });

  it('A 多出的字，标在 A 窗', () => {
    const marks = buildDiffMarks([seg('delete', 2, 1, 2, 0)], 'a');
    expect(marks.a).toEqual([{ start: 2, end: 3, kind: 'extra' }]);
    expect(marks.b).toEqual([]);
  });

  it('A 多出的字，目标窗在 B 时语义变为「B 缺」——但位置仍在 A', () => {
    const marks = buildDiffMarks([seg('delete', 2, 1, 2, 0)], 'b');
    expect(marks.a).toEqual([{ start: 2, end: 3, kind: 'missing' }]);
    expect(marks.b).toEqual([]);
  });

  it('只差一个字时，恢复对齐的部分一个都不标', () => {
    // 逐字口径会把后面的「软件」也标上；这里标红的必须只有「兔」
    const marks = buildDiffMarks([seg('insert', 2, 0, 2, 1)], 'a');
    expect(marks.b).toHaveLength(1);
    expect(marks.b[0]).toEqual({ start: 2, end: 3, kind: 'missing' });
    expect(marks.a).toHaveLength(0);
  });

  it('长度的 0 的一侧不产生空的标红', () => {
    const marks = buildDiffMarks([seg('insert', 5, 0, 5, 0), seg('delete', 0, 0, 0, 0)], 'a');
    expect(marks.a).toEqual([]);
    expect(marks.b).toEqual([]);
  });

  it('多段差异各自落在自己那一格', () => {
    const marks = buildDiffMarks(
      [seg('delete', 0, 2, 0, 0), seg('insert', 8, 0, 6, 3)],
      'a',
    );
    expect(marks.a).toEqual([{ start: 0, end: 2, kind: 'extra' }]);
    expect(marks.b).toEqual([{ start: 6, end: 9, kind: 'missing' }]);
  });
});
