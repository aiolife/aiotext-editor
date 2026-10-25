/**
 * 比较相关文案（PRD §3.6）
 *
 * 比较的两处特殊：
 * - `paneRole` / `summary` 是**函数拼出来的文案**，所以这里存的是模板，由调用方
 *   `fill` 后拼接；若存拼好的整句，转换时查不到对应的简体原文。
 * - 文件名、差异片段原文是用户数据，只做填充、不过 `t`（PRD §3.6 L-3）。
 */

export const COMPARE = {
  // ---- 比较选项对话框 ----
  title: '文件比较',
  desc: '「{name}」为 A 侧，所选标签在 B 侧显示。开始后 F5 跳下一处差异，\nShift+F5 从两个光标处重新比较；进入后点哪格、哪格就是目标窗（可编辑），\n另一格转为对照窗（只读）。',
  targetTab: '对照标签（B 侧）',
  noOtherTab: '（请先再打开一个文件）',
  unnamed: '未命名',
  ignoreLegend: '忽略项',
  ignoreNewlines: '回车',
  ignoreHalfSpace: '半角空格',
  ignoreFullPunct: '全角标点',
  ignoreHalfPunct: '半角标点',
  variantTitle: '异体字策略',
  orientationLegend: '平铺方向',
  orientationVertical: '上下平铺',
  orientationHorizontal: '左右平铺',
  start: '开始比较',

  // ---- 比较模式工具条 ----
  comparing: '比较中',
  panes: '{a}「{aName}」 ↔ {b}「{bName}」',
  /** `paneRole()` 的返回值，与之一一对应 */
  targetPane: '目标窗',
  refPane: '对照窗',
  comparingProgress: '正在比较…',
  position: '第 {index}/{total} 处：{detail}',
  detail: '{a}{aQuote} ↔ {b}{bQuote}',
  /** 差异片段为空时的占位 */
  none: '（无）',
  identical: '两文一致',
  degradedEmpty: '文本过大，未能完整比较',
  total: '共 {count} 处',
  added: '新增 {count} 字',
  missing: '缺失 {count} 字',
  truncated: '差异过多已截断',
  degraded: '文本过大，未完整比较',
  prev: '上一处',
  prevTitle: '上一处不一致',
  next: '下一处',
  nextTitle: '下一处不一致（F5）',
  restart: '从光标重比',
  restartTitle: '从两个光标处重新比较（Shift+F5）',
  exit: '退出比较',
} as const;
