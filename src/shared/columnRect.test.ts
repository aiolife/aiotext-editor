/**
 * `columnRect` 单测 —— 锁定垂直选择的行列增减口径。
 *
 * 第一条用例就是上报的那个 bug：顶边停在第 1 行时 `Ctrl+↑` 收不动。
 */

import { describe, expect, it } from 'vitest';
import { type VRect, nextColRect, nextRowRect } from './columnRect';

const rect = (startLine: number, endLine: number, colStart = 0, colEnd = 0): VRect => ({
  startLine,
  endLine,
  colStart,
  colEnd,
});

describe('nextRowRect — 纵向增减', () => {
  it('★ Ctrl+↑ 从底边收回一行（顶边停在第 1 行也能收）', () => {
    // 用户路径：光标在第 1 行进入 → Ctrl+↓ ×3 扩到 1~4 行 → 用 ↑ 收回
    const r = rect(1, 4);
    expect(nextRowRect(r, true, 10)).toEqual(rect(1, 3));
    // 修复前这里动的是 startLine，Math.max(1, 0) 恒为 1，收不动
  });

  it('Ctrl+↑ 与 Ctrl+↓ 严格互逆：加几行就能退几行', () => {
    const maxLine = 10;
    let r = rect(1, 1);
    for (let i = 0; i < 4; i += 1) r = nextRowRect(r, false, maxLine);
    expect(r).toEqual(rect(1, 5));
    for (let i = 0; i < 4; i += 1) r = nextRowRect(r, true, maxLine);
    expect(r).toEqual(rect(1, 1));
  });

  it('Ctrl+↑ 收到单行就停住，不会塌成 0 行或让 endLine < startLine', () => {
    const one = rect(1, 1);
    expect(nextRowRect(one, true, 10)).toEqual(rect(1, 1));
    // 顶边不在第 1 行时，收到底应该是 startLine 而不是 1
    const mid = rect(3, 3);
    expect(nextRowRect(mid, true, 10)).toEqual(rect(3, 3));
  });

  it('Ctrl+↑ 顶边始终不动', () => {
    const r = rect(2, 7);
    expect(nextRowRect(r, true, 10).startLine).toBe(2);
    expect(nextRowRect(r, true, 10).endLine).toBe(6);
  });

  it('Ctrl+↓ 加到文档末尾就停住', () => {
    const maxLine = 6;
    let r = rect(1, 5);
    r = nextRowRect(r, false, maxLine);
    expect(r).toEqual(rect(1, 6));
    r = nextRowRect(r, false, maxLine);
    expect(r).toEqual(rect(1, 6));
  });

  it('不改动列，也不改动原对象', () => {
    const r = rect(1, 4, 2, 5);
    const next = nextRowRect(r, true, 10);
    expect(next.colStart).toBe(2);
    expect(next.colEnd).toBe(5);
    expect(r).toEqual(rect(1, 4, 2, 5));
  });
});

describe('nextColRect — 横向增减', () => {
  it('Ctrl+→ 扩一个字符', () => {
    expect(nextColRect(rect(1, 3, 2, 2), 1)).toEqual(rect(1, 3, 2, 3));
  });

  it('Ctrl+← 收到 colStart 就停住', () => {
    expect(nextColRect(rect(1, 3, 2, 4), -1)).toEqual(rect(1, 3, 2, 3));
    expect(nextColRect(rect(1, 3, 2, 2), -1)).toEqual(rect(1, 3, 2, 2));
  });

  it('不改动行，也不改动原对象', () => {
    const r = rect(1, 4, 2, 2);
    const next = nextColRect(r, 1);
    expect(next.startLine).toBe(1);
    expect(next.endLine).toBe(4);
    expect(r).toEqual(rect(1, 4, 2, 2));
  });
});
