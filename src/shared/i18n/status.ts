/**
 * 状态栏文案（PRD §3.6）
 *
 * 带数字的要整体做一条（如 `rowCol` 用 `{line}` / `{col}` 占位），不能把「行」「列」
 * 拆开翻译——繁體下语序虽然一样，但拆开会让插值点散在两处，改一处忘另一处。
 */

export const STATUS = {
  ready: '就绪',
  /** 文件名列的 title：文件还没落盘时 */
  notSavedToDisk: '尚未保存到磁盘',
  unsavedShort: '未保存',
  /** 带冒号的做成整条：冒号若留在组件里，加语言时容易只顾前半截 */
  encoding: '编码：{value}',
  lineEnding: '行尾：{value}',
  bom: 'BOM：{value}',
  yes: '有',
  no: '无',
  /** 光标位置：`行 3，列 12` */
  rowCol: '行 {line}，列 {col}',
  /** 垂直选择模式下的 title */
  columnHint: '垂直选择（列编辑）模式，Ctrl+Shift+F8 退出',
  /** 垂直选择模式：`垂直选择 3 行 × 2 列` */
  columnSize: '垂直选择 {rows} 行 × {cols} 列',
  /** 字数统计 title（带单位） */
  statsTitle: '汉字 {chinese} · 单词 {words} · {bytes} 字节（UTF-8）',
  /** 字数统计（与 title 同序，省单位） */
  stats: '汉字 {chinese} · 单词 {words} · {bytes} 字节',
  /** 已改未存的圆点标记 */
  dirty: '● 未保存',
} as const;

/**
 * 填占位符。
 *
 * 为什么自己写而不用模板字符串：翻译后的串里占位符位置可能变，`{line}` 这种
 * 显式占位才能按名替换；用 `${}` 就得把值先备好，顺序一变就错。
 */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}
