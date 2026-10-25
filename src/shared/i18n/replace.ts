/**
 * 替换表管理对话框文案（PRD §3.6）
 *
 * 表名、表源文本、词条都是**用户数据**（PRD §3.6 L-3：自定义替换表词条保持原样），
 * 一律不翻译；这里只有界面自身的标签与提示。
 */

/** 规则开关（写进表文件的 `#rules:` 行，显示名要翻译、写入值不翻译） */
export const REPLACE_RULES = {
  wholeWord: '仅整词匹配',
  caseSensitive: '区分大小写',
  escape: '处理转义',
  useRegex: '正则替换（v1.1）',
} as const;

export const REPLACE_TABLE = {
  title: '替换表管理',
  userTables: '用户表（{count}）',
  builtinTables: '内置示例表（{count}）',
  builtin: '内置',
  entryCount: '{count} 条',
  noUserTable: '暂无用户表',
  new: '新建',
  import: '导入…',
  delete: '删除',
  /** 未选中任何表时的默认表名（写进表文件前） */
  newTableName: '新表',

  sourceFile: '源文件：{path}',
  newTableHint: '新表：保存后写入 %APPDATA%/AioTextEditor/tables/',
  dirty: '未保存',
  clean: '已保存',
  rulesLabel: '规则：',

  validating: '校验中…',
  validOk: '校验通过：{count} 条',
  hasErrors: '发现 {count} 处错误',
  warningsSuffix: '，{count} 处警告',
  lineAt: '第 {line} 行',

  save: '保存',
  saveAsCopy: '另存副本…',
  applyToDoc: '应用到正文',
  saveBlocked: '存在错误，无法保存（F-04 §4.8）',
  saveHint: '保存到用户表目录',
  applyBlocked: '当前没有打开的文档',
  applyHint: '用独立替换引擎（模式 A）应用到当前正文，可撤销（Ctrl+Z）',

  /** window.prompt / confirm 与通知文案 */
  promptName: '另存为新表名',
  copySuffix: '{name} 副本',
  confirmDelete: '删除替换表「{name}」？此操作不可撤销。',
  imported: '已导入 {count} 条，确认后点「保存」入库',
  saved: '已保存「{name}」（{count} 条）',
  deleted: '已删除「{name}」',
  noHit: '「{name}」在正文中没有命中',
  applied: '已应用「{name}」：{count} 处（{top}）',
} as const;
