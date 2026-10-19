import { describe, it, expect } from 'vitest';
import { buildDiffMarks, paneRole } from './compareView';
import type { CompareDifference } from '../platform/tauriApi';

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
  it('目标窗缺的字 → 标在对照窗（让人看见少了什么）', () => {
    const diffs: CompareDifference[] = [{ posA: 3, posB: 4, charA: null, charB: '兔' }];
    const marks = buildDiffMarks(diffs, 'a');
    expect(marks.a).toEqual([]);
    expect(marks.b).toEqual([{ start: 4, end: 5, kind: 'missing' }]);
  });

  it('目标窗多出的字 → 标在目标窗（提示这里该删）', () => {
    const diffs: CompareDifference[] = [{ posA: 3, posB: 4, charA: '兔', charB: null }];
    const marks = buildDiffMarks(diffs, 'a');
    expect(marks.a).toEqual([{ start: 3, end: 4, kind: 'extra' }]);
    expect(marks.b).toEqual([]);
  });

  it('位置对齐但字不同 → 两边都标，各自提醒', () => {
    const diffs: CompareDifference[] = [{ posA: 3, posB: 3, charA: '兔', charB: '兎' }];
    const marks = buildDiffMarks(diffs, 'a');
    expect(marks.a).toEqual([{ start: 3, end: 4, kind: 'extra' }]);
    expect(marks.b).toEqual([{ start: 3, end: 4, kind: 'missing' }]);
  });

  it('目标窗切到 B：同一份差异，标红的那一格随之对调', () => {
    // 这份差异里 A 缺、B 有。目标窗在 A 时标 B；切到 B 后，B 成了多出的一方，改标 B
    const diffs: CompareDifference[] = [{ posA: 3, posB: 4, charA: null, charB: '兔' }];
    const marks = buildDiffMarks(diffs, 'b');
    expect(marks.b).toEqual([{ start: 4, end: 5, kind: 'extra' }]);
    expect(marks.a).toEqual([]);
  });

  it('两侧都到尾部（都没有字）时不标', () => {
    const diffs: CompareDifference[] = [{ posA: 10, posB: 10, charA: null, charB: null }];
    const marks = buildDiffMarks(diffs, 'a');
    expect(marks.a).toEqual([]);
    expect(marks.b).toEqual([]);
  });

  it('区间按字符数算，与 UTF-16 偏移口径一致', () => {
    const diffs: CompareDifference[] = [
      { posA: 0, posB: 1, charA: '兔', charB: null },
      { posA: 1, posB: 2, charA: '兔', charB: null },
    ];
    const marks = buildDiffMarks(diffs, 'a');
    expect(marks.a).toEqual([
      { start: 0, end: 1, kind: 'extra' },
      { start: 1, end: 2, kind: 'extra' },
    ]);
  });
});
