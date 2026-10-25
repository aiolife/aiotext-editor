/**
 * 整理工具选项对话框文案（PRD §3.6）
 *
 * 字段名与下拉选项住在 `shared/toolFields.ts` 的 schema 里（那份数据单独收集），
 * 这里只放对话框自身的标签与提示。工具名与提示语来自后端 `catalog()`。
 */

export const TOOL_OPTIONS = {
  /** 无选项工具被打开时（正常不会发生，兜底） */
  noOptions: '该工具没有可调选项，可直接应用。',
  scopeLegend: '作用范围',
  scopeAll: '整篇',
  scopeSelection: '选中文本',
  noSelection: '（当前没有选中内容）',
  charCount: '（{count} 字符）',
  computing: '计算中…',
  unchanged: '（内容不变）',
  emptyPreview: '（空）',
  previewA11y: '处理结果预览',
  applyTo: '应用到{scope}',
} as const;
