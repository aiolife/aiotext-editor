/**
 * 文件合并对话框文案（PRD §3.6）
 *
 * 文件路径、正则、模板都是用户数据，只填充不翻译（PRD §3.6 L-3）。
 */

export const MERGE = {
  title: '文件合并',
  tabManual: '手工合并',
  tabAuto: '自动合并（正则）',

  // 手工
  sourceFiles: '源文件（按挑选顺序合并）',
  noFile: '尚未选择文件',
  remove: '移除',
  addFiles: '添加文件…',
  // `\\d`：这个反斜杠是要**显示给用户看**的正则写法，必须转义，否则 JS 会把它吃掉
  sortKey: '排序关键字（可选，对文件名求值的正则，如 序-(\\d+)-）',
  sortKeyPlaceholder: '留空保持挑选顺序',
  outputFile: '输出文件',
  outputPlaceholder: '选择或输入输出文件路径',
  saveAs: '另存为…',

  // 自动
  sourceDir: '源目录',
  dirPlaceholder: '选择源文件目录',
  browse: '浏览…',
  sourcePattern: '源文件名正则（含捕获组）',
  outputPattern: '输出文件名模板（按第 1 捕获组分文件）',
  autoSortKey: '排序关键字（对捕获组求值的模板）',
  example: '例：源正则 {source} + 模板 {output} + 关键字 {sort}，把 1_2.txt、1_10.txt 合成 1.txt（按第 2 段数字排序）。',

  overwrite: '输出文件已存在时直接覆盖（默认跳过并在报告里说明）',
  errorManual: '请先添加源文件并选择输出文件',
  errorAuto: '请先选择源目录',
  merging: '合并中…',
  start: '合并',

  // 报告（返回给调用方展示）
  reportOutputs: '写出 {count} 个合并文件：{list}',
  reportFile: '{name}（{files} 个文件，{chars} 字）',
  reportSkipped: '跳过 {count} 项：{list}',
  reportSkipItem: '{path}（{reason}）',
} as const;
