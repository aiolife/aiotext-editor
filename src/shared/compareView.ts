/**
 * 比较视图的纯计算（F-06 §6.2）。
 *
 * 抽到 shared 而不是留在组件里：这几处**最容易搞反方向** ——
 * 标红该标在哪一格、角色名跟着目标窗易位、新增与缺失谁算谁。
 * 搞反了界面看着也「能转」，只有单测能把它钉住。
 */
import type { DiffBlock } from '../platform/tauriApi';

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
 * 目标窗（可编辑的那一格）是「要改的文件」，所以看每一处差异归谁：
 *
 * - A 多出的那些字（`lenA`）—— 标在 **A 窗**：目标窗在 A 时是「多出，该删」；
 *   目标窗在 B 时，那里是照着补进目标窗的字。
 * - B 多出的那些字（`lenB`）—— 标在 **B 窗**，同一个道理镜像过来。
 *
 * 所以**落在哪一格是固定的**（看谁多出了字），变的只是语义称谓；
 * 也就意味着切目标窗时，同一处红的 kind 会翻面。
 */
export function buildDiffMarks(blocks: DiffBlock[], target: ComparePane): PaneMarks {
  const a: DiffMarkRange[] = [];
  const b: DiffMarkRange[] = [];
  for (const blk of blocks) {
    if (blk.lenA > 0) {
      a.push({
        start: blk.posA,
        end: blk.posA + blk.lenA,
        kind: target === 'a' ? 'extra' : 'missing',
      });
    }
    if (blk.lenB > 0) {
      b.push({
        start: blk.posB,
        end: blk.posB + blk.lenB,
        kind: target === 'b' ? 'extra' : 'missing',
      });
    }
  }
  return { a, b };
}

/** 目标窗的增漏字数（工具条那句「新增 N 字 / 缺失 N 字」） */
export interface DiffStats {
  added: number;
  missing: number;
}

/**
 * 站在目标窗的立场统计。
 *
 * 目标窗是 A 时：A 多出的 `lenA` 算「新增」（要删掉才对齐），
 * A 缺的 `lenB` 算「缺失」（要补进来）；目标窗切到 B 正好反过来。
 */
export function diffStats(blocks: DiffBlock[], target: ComparePane): DiffStats {
  let added = 0;
  let missing = 0;
  for (const blk of blocks) {
    if (target === 'a') {
      added += blk.lenA;
      missing += blk.lenB;
    } else {
      added += blk.lenB;
      missing += blk.lenA;
    }
  }
  return { added, missing };
}

/** 一段位置（偏移为 UTF-16 码元） */
export interface Span {
  from: number;
  to: number;
}

/**
 * 把一侧的一段位置换算到**另一侧** —— 逐字对照标蓝用。
 *
 * 差异块把两文切成若干段：块与块之间**逐字相同**（偏移差固定），块内部则是
 * 「A 的这几个字 ↔ B 的那几个字」。所以分两种情形：
 *
 * - **落在差异块里**：对侧标**整块**。A 三字对 B 一字时，逐字对应本就无从
 *   谈起，标整块比乱指一个字诚实；
 * - **其余位置**：偏移差是固定的，把前面所有块的长度差累加起来即可。
 *
 * 这份映射完全由 `blocks` 推算，不需要再问后端 —— 选中时零延迟。
 */
export function mapToOpposite(
  blocks: DiffBlock[],
  from: number,
  to: number,
  side: ComparePane,
): Span {
  for (const blk of blocks) {
    const [selfFrom, selfTo, otherFrom, otherTo] =
      side === 'a'
        ? [blk.posA, blk.posA + blk.lenA, blk.posB, blk.posB + blk.lenB]
        : [blk.posB, blk.posB + blk.lenB, blk.posA, blk.posA + blk.lenA];
    // 两侧都空（0 对 0）的块没有位置可谈
    if (selfTo <= selfFrom && otherTo <= otherFrom) continue;
    // 有一点搭上就算落在这一块里
    if (from < selfTo && to > selfFrom) {
      return { from: otherFrom, to: otherTo };
    }
  }
  return { from: shiftPos(blocks, from, side), to: shiftPos(blocks, to, side) };
}

/** 块与块之间的等值段：偏移差就是「前面所有块的长度差」之和 */
function shiftPos(blocks: DiffBlock[], pos: number, side: ComparePane): number {
  let delta = 0;
  for (const blk of blocks) {
    const selfEnd = side === 'a' ? blk.posA + blk.lenA : blk.posB + blk.lenB;
    if (pos >= selfEnd) {
      delta += side === 'a' ? blk.lenB - blk.lenA : blk.lenA - blk.lenB;
    }
  }
  return pos + delta;
}

/** 工具条要显示原文片段；太长就掐断加省略号 */
export function previewText(text: string, start: number, end: number, max = 12): string {
  const chars = Array.from(text.slice(start, end));
  if (chars.length <= max) {
    return chars.join('');
  }
  return `${chars.slice(0, max).join('')}…`;
}
