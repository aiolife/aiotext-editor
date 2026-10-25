/**
 * 垂直选择（列编辑）的矩形模型与增减计算（F-01 §1.6）
 *
 * ## 为什么单独成文件
 *
 * `Editor.tsx` 里这四个数原来和 CodeMirror 的 `EditorView` 混在一起算，
 * 而 `expandRow` / `expandColumn` 的核心其实是**纯算术**：在四个整数上做
 * 加减再夹回合法区间。挪到这里之后不依赖 `EditorView`，能被单测直接覆盖——
 * 垂直选择这类交互一旦没有自动化保障，只能靠手点，回归时最容易悄悄坏掉。
 *
 * ## 矩形内部为什么存四个数而不是一堆 range
 *
 * 微调都是在这四个数上做加减，来回换算会丢信息。`colEnd === colStart`
 * 表示**零宽**——多行同一列的多个光标（还没选中内容）。
 *
 * 行号、列号均为 **1 起**，行号以文档行为准（`1 .. doc.lines`）。
 */

export interface VRect {
  startLine: number;
  endLine: number;
  colStart: number;
  colEnd: number;
}

/**
 * 纵向增减：`Ctrl+↓` 向下加一行、`Ctrl+↑` 从底边收回一行。
 *
 * ## 为什么 ↑ 是「收」而不是「向上扩」
 *
 * 用户建矩形的动作是「光标处进入 → 一路 `Ctrl+↓` 往下加」，扩的是 `endLine`。
 * 若 ↑ 去动 `startLine`，一旦顶边停在第 1 行（`Math.max(1, 0)` 恒为 1）就再也
 * 收不动，按多少次都是空转——这正是上报的「扩到 N 行却收不回去」。所以 ↑ 改成
 * 动 `endLine`，与 ↓ 严格互逆：加几行就能退几行。代价是没有「向上扩展」，要选
 * 某几行得先把光标放到起始行再往下扩。
 *
 * ## 边界
 *
 * - 收到底用 `Math.max(rect.startLine, ...)` 而不是 `Math.max(1, ...)`：保证塌成
 *   单行就停住，不会让 `endLine` 掉到 `startLine` 以下。
 * - 加到顶用 `Math.min(maxLine, ...)`：不越过文档末尾。
 *
 * @param rect   当前矩形
 * @param upward true = `Ctrl+↑` 收一行；false = `Ctrl+↓` 加一行
 * @param maxLine 文档总行数
 */
export function nextRowRect(rect: VRect, upward: boolean, maxLine: number): VRect {
  return upward
    ? { ...rect, endLine: Math.max(rect.startLine, rect.endLine - 1) }
    : { ...rect, endLine: Math.min(maxLine, rect.endLine + 1) };
}

/**
 * 横向增减：`Ctrl+→` 向右扩一个字符、`Ctrl+←` 向左收一个字符。
 *
 * 收到 `colStart` 就停住（`colEnd` 不会小于 `colStart`），保住零宽语义。
 */
export function nextColRect(rect: VRect, delta: number): VRect {
  return { ...rect, colEnd: Math.max(rect.colStart, rect.colEnd + delta) };
}
