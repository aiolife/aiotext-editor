/**
 * 菜单栏文案（PRD §3.6）
 *
 * 只放**硬编码在 `MenuBar.tsx` 里**的那些——顶级菜单名、以及没有对应命令的杂项。
 * 命令项（`文件 → 新建` 等）的标签来自 `shared/shortcuts.ts` 的 `COMMANDS`，
 * 那份数据单独参与批量转换，不在这里重复列一遍。
 */

/** 顶级菜单名：不在 `COMMANDS` 里，是菜单条自己写的 */
export const MENU_TOP = {
  file: '文件',
  edit: '编辑',
  convert: '简繁',
  layout: '排版',
  view: '视图',
  help: '帮助',
} as const;

/** 菜单条无障碍标签 */
export const MENU_A11Y = {
  mainMenu: '主菜单',
} as const;

/** 菜单栏里散落的、没有命令 id 的项 */
export const MENU_MISC = {
  resetSettings: '恢复默认设置',
} as const;
