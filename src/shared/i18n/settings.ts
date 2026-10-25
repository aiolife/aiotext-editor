/**
 * 设置对话框文案（PRD §3.6）
 *
 * 「多语言」这一项在**外观** tab（PRD §3.6 目标形态：与主题、字体同页，不新增 tab）。
 */

export const SETTINGS_TABS = {
  appearance: '外观',
  editor: '编辑器',
  conversion: '转换',
  compare: '比较',
  shortcuts: '快捷键',
} as const;

/** 外观 tab */
export const SETTINGS_APPEARANCE = {
  bodyFont: '正文字体',
  bodyFontHint: 'CSS font-family；作用于文档正文，界面文字保持系统字体',
  fontSize: '正文字号',
  fontSizeHint: '{min} – {max} px',
  theme: '主题',
  themeHint: '本项目配色建立在 CSS 系统色之上，故切换主题 = 切 color-scheme',
  language: '多语言',
  languageHint: '繁體由 OpenCC 自动生成，不改动你编辑的文档内容。Rust 侧提示需重启后生效',
  showLineNumber: '显示行号',
  showMenubar: '显示菜单栏',
  showStatusBar: '显示状态栏',
  hideOnClose: '关闭窗口时隐藏到托盘',
  hideOnCloseHint:
    '开启后关闭窗口不再退出程序，下次打开几乎瞬时（实测 748ms → 约 100ms）；代价是程序会继续常驻并占用约 300MB 内存。开启后托盘图标会亮起，可用来唤回窗口或真正退出',
} as const;

/** 编辑器 tab */
export const SETTINGS_EDITOR = {
  tabWidth: '缩进宽度',
  tabWidthHint: '{min} – {max} 个空格宽度',
  insertSpaces: '用空格代替制表符',
  insertSpacesHint: '关闭后按 Tab 插入真正的制表符',
  wrap: '自动换行',
  showSpaces: '显示空格字符',
  showSpacesHint: '空格画 ·，制表符画 →',
  showLineEnds: '显示行尾字符',
  showLineEndsHint: '有换行的行尾画 ¬',
  showParagraphMarks: '显示换段符',
  showParagraphMarksHint: '段落的最后一行画 ¶（优先于行尾符）',
  defaultEncoding: '默认编码',
  defaultEncodingHint: '打开无 BOM 文件时的探测偏好、另存为的初值',
  defaultLineEnding: '默认行尾',
} as const;

/** 转换 tab */
export const SETTINGS_CONVERSION = {
  bracketSkip: '括号转换跳过',
  bracketSkipHint: '「匹配括号 / 括号嵌套转换」要跳过的括号对，例如 []',
  preserveConverted: '转换后保留原文',
  preserveConvertedHint: '转换对话框里「保留原文以便对照」的默认勾选状态',
} as const;

/** 比较 tab */
export const SETTINGS_COMPARE = {
  ignoreNewlines: '忽略换行',
  ignoreHalfSpace: '忽略半角空格',
  ignoreFullPunct: '忽略全角标点',
  ignoreHalfPunct: '忽略半角标点',
  variantStrictness: '异体字等同强度',
  variantStrictnessHint: 'fc1 / fc2 组表；影响「相同」的判定范围',
} as const;

/** 快捷键 tab */
export const SETTINGS_SHORTCUTS = {
  hint: '点「录制」后按下组合键即可改绑；Esc 取消录制。「清除」表示显式解绑（与「用默认」不同）。',
  conflicts: '存在 {count} 处键位冲突：',
  capturing: '按下组合键…',
  unbound: '（未绑定）',
  customBadge: '自定义',
  record: '录制',
  cancel: '取消',
  clear: '清除',
  restoreDefault: '默认',
} as const;

/** 页脚与反馈 */
export const SETTINGS_FOOTER = {
  saving: '正在保存…',
  autoSave: '改动立即生效并自动保存',
  resetAll: '恢复全部默认',
  close: '关闭',
  /** 恢复默认后的 toast */
  resetNotice: '已恢复默认设置',
} as const;
