/**
 * 查找 / 替换面板文案（PRD §3.6）
 *
 * 查找词、替换词、以及用户选的正则都是**用户数据**，原样显示（PRD §3.6 L-3）。
 * 中文类目名（`\c[GBK]` 等）来自后端 `regexCategories()`，由 Rust 侧转。
 */

/** 六个开关。与 `RegexOptions` 的字段一一对应 */
export const SEARCH_OPTIONS = {
  regex: '正则',
  ignoreNewlines: '忽略回车',
  ignoreHalfSpace: '忽略半角空格',
  ignorePunct: '忽略标点',
  caseInsensitive: '忽略大小写',
  useEscape: '使用转义符',
} as const;

export const SEARCH = {
  find: '查找',
  replace: '替换',
  /** 查找框占位符里的 `\c[GBK]` 等是写法示例，不是文案 */
  findPlaceholder: '支持 \\c[GBK]、\\c[天干]、\\a、\\d 等中文类目',
  categoryTitle: '插入中文类目',
  categoryPlaceholder: '类目…',
  replacePlaceholder: '可用 \\1 或 $1 引用捕获组',
  replacePlaceholderWithTool: '已选择「使用工具」，替换内容由工具生成',
  useTool: '使用工具',
  useToolTitle: '把每个命中交给整理工具处理（F-09）',
  noTool: '（不使用）',
  defaultOptions: '（默认选项）',

  /** 开关摘要（悬停显示） */
  optionsOff: '关闭：{list}',
  optionsAllOn: '全部开关开启',

  prev: '上一个',
  next: '下一个',
  /** 「使用工具」时替换按钮改叫处理 */
  processCurrent: '处理当前',
  replaceCurrent: '替换',
  processAll: '全部处理',
  replaceAll: '全部替换',
  close: '关闭',

  /** 结果提示 */
  noMatch: '没有命中',
  matchAt: '第 {index} / {total} 个命中',
  nothingToReplace: '没有可替换的命中',
  replacedOne: '已替换 1 处',
  processedOne: '已用工具处理 1 处',
  replacedMany: '已替换 {count} 处',
  processedMany: '已用工具处理 {count} 处',
} as const;
