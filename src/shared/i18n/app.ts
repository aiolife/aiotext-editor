/**
 * App 层文案：错误 / 通知 / 统计对话框（PRD §3.6）
 *
 * 文件名、选区文字都是用户数据，只做填充不翻译（PRD §3.6 L-3）。
 * `runGuarded` 的动作名单独成组：它既用于按钮，也拼进「{动作}失败」的提示里。
 */

/** `runGuarded` 的动作名——拼进失败提示，所以必须是一份可查表的原文 */
export const ACTION = {
  open: '打开文件',
  save: '保存',
  saveAs: '另存为',
  saveAll: '全部保存',
  convert: '转换',
  tool: '整理',
  reload: '重新载入',
  encodingConvert: '编码转换',
  customReplace: '自定义替换：{name}',
} as const;

export const APP = {
  unnamed: '未命名',

  // ---- 启动与初始化 ----
  engineInitFailed: '繁简引擎初始化失败：{error}（转换功能已禁用）',
  sessionUnreadable: '上次打开的文件已无法读取：{list}',
  tableLoadFailed: '替换表读取失败：{error}',
  toolInitFailed: '整理工具初始化失败：{error}（整理功能已禁用）',

  // ---- 通用失败 / 通知 ----
  actionFailed: '{label}失败：{error}',
  saveTabFailed: '保存「{name}」失败：{error}',
  keepUnsaved: '已保留 {count} 个没保存成功的文件：{list}',
  noFileToSave: '没有需要保存的文件',
  someNotSaved: '{count} 个文件未保存（可能取消了保存位置选择）',
  savedCount: '已保存 {count} 个文件',

  // ---- 替换表 / 编码 / 载入 ----
  replaceNoHit: '「{name}」在正文中没有命中',
  replaceDone: '已按「{name}」替换 {count} 处',
  noPathForEncoding: '当前标签还没有保存到磁盘，无法转换编码',
  rewrittenAs: '已按 {label} 重新写出文件',
  noPathForReload: '当前标签还没有保存到磁盘，无法重新载入',
  reloadedAs: '已按 {encoding} 重新载入',

  // ---- 转换 ----
  convertedNothing: '已处理 0 处（没有可转换的内容）',
  convertedCount: '已转换 {count} 个字符',
  scopeSelection: '（选区）',
  scopeAll: '（整篇）',
  ambiguityFound: '，检出 {count} 处地区用字差异',
  convertTabSwitched: '转换期间切换了标签，已取消本次转换',
  toolTabSwitched: '整理期间切换了标签，已取消本次操作',

  // ---- 整理 ----
  toolIssues: ' 等共 {count} 处',

  // ---- 比较 ----
  compareDegradedSuffix: '（文本过大，未完整比较）',
  compareFound:
    '发现 {count} 处不一致：新增 {added} 字、缺失 {missing} 字{warn}（F5 下一处，Shift+F5 从光标重比）',
  compareDegradedDone: '比较完成：文本过大，未能完整比较',
  compareIdentical: '比较完成：两文一致',
  compareFailed: '比较失败：{error}',
  compareAtLast: '已到最后一处不一致；改动后可按 Shift+F5 从两个光标处重新比较',

  // ---- 主题 / 设置 ----
  themeSwitched: '主题：{label}',
  settingsRestored: '已恢复默认设置',
  shortcutConflicts: '快捷键冲突：{detail}（可在「设置 → 快捷键」里改）',

  // ---- 选区统计提示 ----
  needSelection: '请先在正文里选中一段文字，再统计它出现的次数',
} as const;

/** 视图 → 字数统计 */
export const STATS_DOC = {
  title: '字数统计',
  subtitleWithSelection: '全文统计；当前选区 {snippet} 额外单列',
  subtitleNoSelection: '全文统计（未选中文字）',

  chineseChars: '中文字数（汉字）',
  chineseCharsHint: '含扩展区，々〇 也算',
  chinesePunct: '中文标点',
  chinesePunctHint: '、。「」【】……—— 等',
  letters: '字母个数',
  lettersHint: '拉丁 / 假名 / 谚文等 Unicode 字母',
  words: '单词个数',
  wordsHint: '连续字母数字为一词，汉字不计词',
  englishPunct: '英文标点',
  englishPunctHint: 'ASCII 标点',
  digits: '数字个数',
  digitsHint: '十进制数字符，含全角 ０-９',
  numberGroups: '数字组',
  numberGroupsHint: '连续数字算一组',
  chars: '字符数（不计空格与控制符）',
  charsHint: '代理对算 1 个字符',
  charsWithSpace: '字符数（含空格）',
  charsWithSpaceHint: '控制符仍不计',
  charsAll: '字符数（含空格与控制符）',
  charsAllHint: '全部码点',
  paragraphs: '段落数',
  paragraphsHint: '空行分隔的连续非空行块',
  nonEmptyLines: '非空行数',
  nonEmptyLinesHint: 'trim 后非空（段间空一行工具的口径）',
  lines: '行数',
  linesHint: '含空行',
  bytes: '字节数（UTF-8）',

  selectionChars: '选区字数（不计空格与控制符）',
  note: '字符数一律不含代理对重复计数（`𩅯` 算 1 个）；空格、全角空格、制表符、换行与控制符不计入「不计空格」那一栏。',
} as const;

/** 视图 → 统计选定文字出现的次数 */
export const STATS_WORD = {
  title: '选定文字出现次数',
  subtitle: '在全文范围内统计 {snippet}',
  count: '出现次数',
  countHint: '不重叠计数',
  length: '选定文字长度',
  totalChars: '全文字符数',
  note: '次数包含选区自身这一处；重叠出现不重复计数。',
} as const;

/** 视图 → 显示段落数 */
export const STATS_PARA = {
  title: '段落数',
  subtitle: '段落 = 空行分隔的连续非空行块',
  paragraphs: '段落数',
  paragraphsHint: '空行分隔的块',
  nonEmptyLines: '非空行数',
  nonEmptyLinesHint: '段间空一行工具的口径',
  lines: '行数',
  emptyLines: '空行数',
  totalChars: '全文字符数',
} as const;
