/**
 * 比较视图的两块纯计算（F-06 §6.2）。
 *
 * 抽到 shared 而不是留在组件里：这两处**最容易搞反方向** ——
 * 标红标在哪一格、角色名跟着目标窗易位。搞反了界面看着也「能转」，
 * 只有单测能把它钉住。
 */
import type { DiffSegment } from '../platform/tauriApi';

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
   *
   * 目前两侧同一副样子（都标红），但语义记在这里 —— 哪天要区分，
   * 改样式就够了，不必再推一遍方向。
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
 * 目标窗（可编辑的那一格）是「要改的文件」，所以看每一段差异的**归属**：
 *
 * - `delete` 段（**A 多出**这些字）—— 标在 **A 窗**：
 *   目标窗在 A 时是「多出，该删」；目标窗在 B 时是多出了对方没有的字，
 *   标在 A 正好提示「这里有字要补进目标窗」。
 * - `insert` 段（**B 多出**这些字）—— 标在 **B 窗**，同一个道理镜像过来。
 *
 * 所以**落在哪一格是固定的**（看谁多出了字），变的只是语义称谓；
 * 也就意味着切目标窗时，同一段红的 kind 会翻面。
 */
export function buildDiffMarks(segments: DiffSegment[], target: ComparePane): PaneMarks {
  const a: DiffMarkRange[] = [];
  const b: DiffMarkRange[] = [];
  for (const s of segments) {
    if (s.kind === 'delete') {
      if (s.lenA > 0) {
        a.push({
          start: s.posA,
          end: s.posA + s.lenA,
          kind: target === 'a' ? 'extra' : 'missing',
        });
      }
    } else if (s.lenB > 0) {
      b.push({
        start: s.posB,
        end: s.posB + s.lenB,
        kind: target === 'b' ? 'extra' : 'missing',
      });
    }
  }
  return { a, b };
}
