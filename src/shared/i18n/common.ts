/**
 * 通用文案（PRD §3.6）
 *
 * 多个对话框共用的按钮与提示。各对话框**独有**的文案不在这里，放在各自的领域表里。
 */

export const COMMON = {
  ok: '确定',
  cancel: '取消',
  close: '关闭',
  apply: '应用',
  reset: '重置',
  browse: '浏览…',
  /** 列编辑模式提示（状态栏 title 用） */
  columnMode: '垂直选择',
} as const;
