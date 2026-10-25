/**
 * 简繁转换对话框文案（PRD §3.6）
 *
 * 方向名来自后端 `OpenccDirectionMeta.label`，替换表名是用户数据（PRD §3.6 L-3：
 * 自定义替换表词条保持原样），两者都不在这里。
 */

export const CONVERT = {
  title: '简繁转换',
  scopeAll: '整篇',
  scopeSelection: '选中文本',
  scopeLabel: '转换范围：',
  charCount: '（{count} 字符）',
  direction: '转换方向',
  bracketLegend: '括号对豁免（范围内的字符不参与转换）',
  tableLegend: '叠加用户替换表（F-04 模式 B：交给 OpenCC 内联词典，先勾选者优先）',
  /** 内置替换表角标 */
  builtin: '内置',
  diagnostics: '歧义片段诊断（列出其他地区标准用字不同的位置）',
  preview: '预览差异',
  apply: '应用转换',

  /** 预览区 */
  emptyPreview: '没有可转换的内容',
  diffSummary: '差异 {changed} / {total} 行 · 变更 {count} 字符',
  truncated: '（仅显示前 200 个差异行）',

  /** 歧义列表 */
  ambiguityTitle: '歧义片段 {count} 处（其他地区标准在此用字不同）',
  emptySpan: '（空）',
  ambiguityAlt: ' ← {candidates}',
  position: ' 位置 {start}',
  onlyFirst: '仅列出前 {count} 处',
} as const;
