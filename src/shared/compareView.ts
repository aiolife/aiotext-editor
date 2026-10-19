/**
 * 比较视图的两块纯计算（F-06 §6.2）。
 *
 * 抽到 shared 而不是留在组件里：这两处**最容易搞反方向** ——
 * 标红标在哪一格、角色名跟着目标窗易位。搞反了界面看着也「能转」，
 * 只有单测能把它钉住。
 */
import type { CompareDifference } from '../platform/tauriApi';

/** 差异数据里 A / B 两侧的记号 */
export type ComparePane = 'a' | 'b';

/**
 * 差异数据里的 A / B 是两侧的固定记号（不随目标窗切换而变），
 * 显示时才翻译成用户看到的角色名。
 */
export function paneRole(pane: ComparePane, target: ComparePane): string {
  return pane === target ? '目标窗' : '对照窗';
}

/** 一处待标红的区间（偏移为 UTF-16 码元，与后端报告口径一致） */
export interface DiffMarkRange {
  start: number;
  end: number;
  /**
   * `missing` = 目标窗缺这个字（标在对照窗）；
   * `extra`   = 目标窗多出这个字（标在目标窗）。
   */
  kind: 'missing' | 'extra';
}

export interface PaneMarks {
  a: DiffMarkRange[];
  b: DiffMarkRange[];
}

/**
 * 两窗各自的差异标红。
 *
 * 目标窗（可编辑的那一格）是「要改的文件」，所以：
 *
 * - 目标窗**缺**的字 —— 标在**对照窗**，让人一眼看到「少了这个字」；
 * - 目标窗**多出**的字 —— 标在**目标窗**，提示这里该删；
 * - 位置对齐但字不同 —— 两边都标（改动前先看清两边各写的是什么）。
 */
export function buildDiffMarks(differences: CompareDifference[], target: ComparePane): PaneMarks {
  const a: DiffMarkRange[] = [];
  const b: DiffMarkRange[] = [];
  const targetIsA = target === 'a';
  const targetMarks = targetIsA ? a : b;
  const refMarks = targetIsA ? b : a;
  for (const d of differences) {
    const tPos = targetIsA ? d.posA : d.posB;
    const rPos = targetIsA ? d.posB : d.posA;
    const tLen = (targetIsA ? d.charA : d.charB)?.length ?? 0;
    const rLen = (targetIsA ? d.charB : d.charA)?.length ?? 0;
    if (tLen > 0 && rLen === 0) {
      // 目标窗多出：标在目标窗
      targetMarks.push({ start: tPos, end: tPos + tLen, kind: 'extra' });
    } else if (tLen === 0 && rLen > 0) {
      // 目标窗缺失：标在对照窗
      refMarks.push({ start: rPos, end: rPos + rLen, kind: 'missing' });
    } else if (tLen > 0 && rLen > 0) {
      targetMarks.push({ start: tPos, end: tPos + tLen, kind: 'extra' });
      refMarks.push({ start: rPos, end: rPos + rLen, kind: 'missing' });
    }
  }
  return { a, b };
}
