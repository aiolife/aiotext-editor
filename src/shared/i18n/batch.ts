/**
 * 批处理对话框文案（PRD §3.6）
 *
 * 布局照 TextPro，按钮上的 `(F)` / `(A)` / `(S)` 是助记符（快捷键字母），
 * 属于界面符号而非文案，转换时整条一起送 OpenCC —— 助记符本身是 ASCII，不受影响。
 *
 * 文件路径、工具名（来自后端 `catalog()`）都不在这里。
 */

export const BATCH = {
  a11y: '批处理',
  title: '批处理操作',
  hintConfig: '加入文件 → 选处理步骤 → 处理',
  progress: '{done}/{total}（已改 {modified}）',

  // 需处理文件
  filesHead: '需处理文件',
  backup: '建立后备文件',
  fileName: '文件名',
  filePath: '路径',
  emptyFiles: '用右侧「文件(F)…」选目录，或直接把路径粘到下面回车',
  browseFile: '文件(F)…',
  selectAll: '全选(A)',
  selectNone: '全不选(A)',
  selectOne: '选择(S)',
  deselectOne: '不选(X)',
  clear: '清空(C)',
  pathPlaceholder: '目录或文件路径（键入 / 粘贴后回车）',
  add: '添加',
  recursive: '递归子目录',
  planHint: '将处理 {count} 个文件',

  // 处理步骤
  availableTools: '可选择的处理',
  queue: '需进行的处理',
  /** 后端没给分组名时的兜底 */
  otherGroup: '其他',
  addStepTitle: '把选中的处理加到右侧',
  removeStepTitle: '从右侧移除选中的处理',
  queueEmpty: '左侧双击或选中后点 >>',
  moveUp: '上移',
  moveDown: '下移',
  remove: '移除',

  // 编码
  inputEncoding: '输入编码：',
  outputEncoding: '输出编码：',
  preserveMtime: '保留修改时间',

  // 运行
  progressStats: '{done}/{total}（已改 {modified}，错误 {errors}）',
  currentFile: ' · 正在处理 {name}',
  errorPanel: '错误面板（{count}）',
  errorTruncated: '… 运行中已累计 {count} 条，结束后显示完整清单',
  finalReport:
    '处理 {scanned} 个文件 · 改写 {written} · 未变 {unchanged} · 备份 {backedUp} · 错误 {errors} · 耗时 {elapsed}ms',
  cancelled: ' · 已取消',

  // 通知
  needFiles: '请先选择要处理的文件（右侧「全选 / 选择」或添加路径）',
  needSteps: '请至少选择一个处理步骤',
  noFilesInDir: '所选目录下没有可处理的文件（深度={depth}）',
  previewFailed: '预览失败：{error}',
  cancelledAt: '已取消：处理到 {done}/{total}',
  doneCancelled: '批处理已取消（已处理 {done}/{total}）',
  done: '批处理完成：处理 {scanned} 个文件，改写 {written}，备份 {backedUp}，错误 {errors}，耗时 {elapsed}ms',
  failed: '批处理失败：{error}',

  // 页脚
  exit: '退出',
  start: '处理',
  cancel: '取消',
  finish: '完成',
} as const;
