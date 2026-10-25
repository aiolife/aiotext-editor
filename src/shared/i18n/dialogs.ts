/**
 * 小对话框与片段文案（PRD §3.6）
 *
 * 这里放**各处散落的短文案**：跳转、关闭确认、不可编码字符、标签栏右键菜单、
 * 整理菜单。体量大、且成体系的（转换 / 比较 / 搜索 / 替换表 / 批处理 / 合并 /
 * 整理选项）各有自己的领域表，不塞在这里。
 *
 * 与 `COMMON` / `COMMANDS` 有重复的原文是允许的：`t()` 是「原文 → 译文」映射，
 * 同样的原文必然得到同样的译文，不存在两处翻译打架的问题。
 */

/** 编辑 → 跳转 */
export const GOTO = {
  title: '跳转到行',
  label: '行号（1 – {total}）：',
  /** 输入不合法时的行内提示 */
  invalid: '请输入 1 到 {total} 之间的整数',
  go: '跳转',
} as const;

/** 关闭确认（单个 / 多个文件两套措辞） */
export const CONFIRM_CLOSE = {
  a11y: '存在未保存的修改',
  titleMultiple: '有 {count} 个文件尚未保存',
  titleSingle: '有未保存的修改',
  more: '…等 {count} 个',
  textSingle: '「{name}」的修改还没有保存到磁盘。',
  hintMultiple: '「全部保存」会逐个保存（没有保存位置的文件会询问路径），保存成功的才会关闭。',
  hintSingle: '「不保存」会丢弃此次修改，且下次启动不会恢复。',
  saveAll: '全部保存',
  save: '保存',
  discardAll: '全部不保存',
  discard: '不保存',
} as const;

/** 保存前的不可编码字符决策 */
export const UNMAPPABLE = {
  a11y: '存在不可编码字符',
  title: '无法以 {encoding} 编码保存',
  text: '文本中有 {count} 个字符无法编码为 {encoding}：',
  more: '…等 {count} 个',
  hint: '按 WHATWG 标准，数字字符引用（&#xNNNN;）以纯文本写出，读回该文件的工具可还原原字；改存 UTF-8 则无此问题。',
  saveCharref: '以数字字符引用保存',
  saveUtf8: '改存 UTF-8（带 BOM）',
} as const;

/** 标签栏：圆点 title 与右键菜单 */
export const TABBAR = {
  dirtyTitle: '已修改，未保存',
  closeA11y: '关闭 {name}',
  close: '关闭',
  closeOthers: '关闭其他标签',
  closeAll: '全部关闭',
  save: '保存',
  saveAs: '另存为…',
} as const;

/**
 * 整理菜单
 *
 * 工具名 / 分组名 / 提示语来自后端 `catalog()`，那份数据在 Rust 侧参与转换，
 * 这里只有菜单自己的「整理」「常用」「仅检查」几个词。
 */
export const TOOL_MENU = {
  /** 触发按钮。▾ 是箭头符号，不是文案，留着不转 */
  trigger: '整理 ▾',
  title: '文本整理工具（F-09）',
  common: '常用',
  inspectOnly: '仅检查',
} as const;
