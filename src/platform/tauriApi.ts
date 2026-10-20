/**
 * 前后端唯一接口层（docs/03-tech-architecture.md §3.2 约束：
 * 前端仅通过本文件调用后端，绝不直接调用 __TAURI__.* 的其它接口）
 */
import { invoke } from '@tauri-apps/api/core';

/** F-02 §2.3 LoadResult（蛇形命名由 Rust 端 serde camelCase 转换） */
export interface LoadResult {
  text: string;
  encoding: string;
  hadBom: boolean;
  lineEnding: 'lf' | 'cr' | 'crlf';
}

/** F-02 §2.3 SaveOptions */
export interface SaveOptions {
  encoding: string;
  addBom: boolean;
  lineEnding: 'lf' | 'cr' | 'crlf';
  unmappable: 'ask' | 'charref' | 'toutf8';
}

/** F-02 §2.3 SaveReport */
export interface SaveReport {
  writtenPath: string;
  bytesWritten: number;
  actualEncoding: string;
  charRefsWritten: number;
}

/** F-02 §2.4 不可编码字符（保存前预检） */
export interface UnmappableChar {
  position: number;
  character: string;
}

/** 打开文件（自动检测编码） */
export async function fsRead(path: string): Promise<LoadResult> {
  return invoke<LoadResult>('fs_read', { path });
}

/** 按手选编码重新读取（「重新载入」） */
export async function fsReadWith(path: string, encodingLabel: string): Promise<LoadResult> {
  return invoke<LoadResult>('fs_read_with', { path, encodingLabel });
}

/** 保存前预检：目标编码不可表示的字符列表 */
export async function fsCheckMappable(
  text: string,
  encodingLabel: string,
): Promise<UnmappableChar[]> {
  return invoke<UnmappableChar[]>('fs_check_mappable', { text, encodingLabel });
}

/** 编码写出文件 */
export async function fsWrite(
  path: string,
  text: string,
  opts: SaveOptions,
): Promise<SaveReport> {
  return invoke<SaveReport>('fs_write', { path, text, opts });
}

/** 系统打开文件对话框（tauri-plugin-dialog），返回所选路径 */
export async function pickOpenFile(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: false, directory: false, title: '打开文件' });
  return typeof picked === 'string' ? picked : null;
}

/**
 * 系统另存为对话框，返回所选路径（用户取消返回 null）
 *
 * 默认文件名补 `.txt`（新标签没有扩展名时），并给出文本文件过滤器；
 * 保存的编码由标签的 `encoding` 决定，新文档固定 UTF-8（tabsStore 的默认值）。
 */
export async function pickSaveFile(defaultName?: string): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const name = defaultName && defaultName.trim() !== '' ? defaultName : '未命名';
  const withExt = /\.[A-Za-z0-9]{1,5}$/.test(name) ? name : `${name}.txt`;
  return (
    (await save({
      title: '另存为',
      defaultPath: withExt,
      filters: [
        { name: '文本文件 (*.txt)', extensions: ['txt'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    })) ?? null
  );
}

/** 系统对话框：选择 TextPro `.tab` 表文件（F-04 §4.9 导入） */
export async function pickTableFile(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    multiple: false,
    directory: false,
    title: '导入 TextPro 表文件',
    filters: [{ name: '替换表', extensions: ['tab', 'txt', 'dat'] }],
  });
  return typeof picked === 'string' ? picked : null;
}

/** 从绝对路径提取文件名（路径分隔符兼容 Windows / POSIX） */
export function baseName(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** 编码显示名（下拉框用） */
export const ENCODING_OPTIONS: { value: string; label: string }[] = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'utf-16le', label: 'UTF-16 LE' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
  { value: 'gb2312', label: 'GB2312' },
  { value: 'gbk', label: 'GBK' },
  { value: 'gb18030', label: 'GB18030' },
  { value: 'big5', label: 'Big5' },
  { value: 'iso-8859-1', label: 'ISO-8859-1 (windows-1252)' },
];

/** 是否为 Unicode 系编码（可表示一切字符，保存前无需预检） */
export function isUnicodeEncoding(label: string): boolean {
  return label === 'utf-8' || label === 'utf-16le' || label === 'utf-16be';
}

/**
 * 「文件 → 编码转换」的目标编码（菜单要求只有这 4 项）。
 * 转换 = 内容不动、按目标编码重写文件，可从任意源编码转成其中任意一种。
 */
export const ENCODING_CONVERT_TARGETS: { value: string; label: string }[] = [
  { value: 'gbk', label: '简体中文（936, GBK）' },
  { value: 'gb18030', label: '简体中文（54936, GB18030）' },
  { value: 'big5', label: '繁体中文（950, BIG5）' },
  { value: 'utf-8', label: 'UTF-8' },
];

/** 「文件 → 重新载入」按指定编码重读当前文件（菜单要求的 7 项） */
export const REOPEN_ENCODINGS: { value: string; label: string }[] = [
  { value: 'gbk', label: '简体中文（936, GBK）' },
  { value: 'gb18030', label: '简体中文（54936, GB18030）' },
  { value: 'big5', label: '繁体中文（950, BIG5）' },
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'utf-16le', label: 'UTF-16LE' },
  { value: 'utf-16be', label: 'UTF-16BE' },
  { value: 'cp437', label: 'NFO（437）' },
];

// ---------------------------------------------------------------------------
// F-03 简繁互转
// ---------------------------------------------------------------------------

/** 转换方向元数据（list_opencc_directions） */
export interface OpenccDirectionMeta {
  /** 's2t' / 't2s' / 's2twp' / 'tw2sp' / 's2hk' / 'hk2s' —— 引擎只提供这 6 种 */
  id: string;
  label: string;
}

/** F-03 §3.3 BracketPair（括号对豁免） */
export interface BracketPair {
  open: string;
  close: string;
}

/** F-03 §3.3 ConvertRequest */
export interface ConvertRequest {
  text: string;
  /** 方向 id（如 's2t'） */
  direction: string;
  /** 括号对豁免：范围内的字符不参与转换 */
  skipInside: BracketPair[];
  /** 叠加的用户自定义表名（F-04，第四阶段接入 UI） */
  applyUserTables: string[];
  /** 是否返回歧义片段诊断 */
  diagnostics: boolean;
}

/** F-03 §3.3 AmbiguitySpan（索引为结果文本的码点位置） */
export interface AmbiguitySpan {
  start: number;
  end: number;
  candidates: string[];
  primary: string;
}

/** F-03 §3.3 ConvertReport */
export interface ConvertReport {
  text: string;
  /** 变更字符数（码点口径） */
  changedCount: number;
  ambiguities: AmbiguitySpan[];
  appliedTables: string[];
  directionLabel: string;
}

/** 预览中的一行差异（行内区间为码点下标，左闭右开） */
export interface DiffLine {
  lineNumber: number;
  old: string;
  new: string;
  oldRange: [number, number] | null;
  newRange: [number, number] | null;
}

/** F-03 §3.4 ConvertPreview */
export interface ConvertPreview {
  text: string;
  changedCount: number;
  changedLines: number;
  totalLines: number;
  lines: DiffLine[];
  truncated: boolean;
  directionLabel: string;
  ambiguities: AmbiguitySpan[];
}

/** 列出全部可用转换方向 */
export async function listOpenccDirections(): Promise<OpenccDirectionMeta[]> {
  return invoke<OpenccDirectionMeta[]>('list_opencc_directions');
}

/** 执行转换 */
export async function convertOpencc(req: ConvertRequest): Promise<ConvertReport> {
  return invoke<ConvertReport>('convert_opencc', { req });
}

/** 转换预览（前 200 行差异） */
export async function previewConvert(req: ConvertRequest): Promise<ConvertPreview> {
  return invoke<ConvertPreview>('preview_convert', { req });
}

// ---------------------------------------------------------------------------
// F-04 自定义替换表
// ---------------------------------------------------------------------------

/** 一条替换规则（左侧可含 `/` 分隔的多个候选） */
export interface ReplaceEntry {
  /** 原始左侧写法（保留 `A/B` 形式） */
  pattern: string;
  /** 已展开的候选（去空白项；转义已还原） */
  candidates: string[];
  replacement: string;
}

/** 表级行为开关 */
export interface ReplaceRules {
  /** 仅整词匹配（独立替换模式；OpenCC 内联模式不生效） */
  wholeWord: boolean;
  caseSensitive: boolean;
  /** 处理 `\n` `\t` `\\` 转义 */
  escape: boolean;
  /** [v1.1] 用正则引擎代替字面替换 */
  useRegex: boolean;
}

/** 表元信息（列表展示用） */
export interface TableMeta {
  name: string;
  builtin: boolean;
  entryCount: number;
  description: string;
  path: string;
}

/** 一张替换表（F-04 §4.5 `ReplaceTable`） */
export interface ReplaceTable {
  name: string;
  description: string;
  entries: ReplaceEntry[];
  rules: ReplaceRules;
  meta: TableMeta;
}

export type IssueSeverity = 'error' | 'warning';

/** 校验问题（行号 1 起；0 表示表级） */
export interface TableIssue {
  line: number;
  severity: IssueSeverity;
  message: string;
}

/** 校验报告（F-04 §4.6 `ValidationReport`） */
export interface ValidationReport {
  ok: boolean;
  errors: number;
  warnings: number;
  entryCount: number;
  issues: TableIssue[];
}

/** 文本解析结果（镜像编辑器数据源） */
export interface ParsedTable {
  table: ReplaceTable;
  report: ValidationReport;
}

/** 应用模式（F-04 §4.5 `ApplyMode`） */
export type ApplyMode = 'standalone' | 'asOpenccDic';

export interface ApplyOpts {
  mode: ApplyMode;
}

/** 应用结果（F-04 §4.5 `ApplyReport`） */
export interface ApplyReport {
  text: string;
  changedCount: number;
  /** 词 → 替换次数 */
  perEntryCount: Record<string, number>;
}

/** 列出全部替换表（用户表 + 内置示例表） */
export async function listReplaceTables(): Promise<TableMeta[]> {
  return invoke<TableMeta[]>('list_replace_tables');
}

/** 载入一张表（按文件名或 `#name:` 显示名） */
export async function loadReplaceTable(name: string): Promise<ReplaceTable> {
  return invoke<ReplaceTable>('load_replace_table', { name });
}

/** 读取表源文本（保留注释与排版） */
export async function readReplaceTableSource(name: string): Promise<string> {
  return invoke<string>('read_replace_table_source', { name });
}

/** 解析表文本并取行号级校验报告 */
export async function parseReplaceTableText(
  text: string,
  name: string,
): Promise<ParsedTable> {
  return invoke<ParsedTable>('parse_replace_table_text', { text, name });
}

/** 保存表源文本（校验不通过时后端阻止保存） */
export async function saveReplaceTableSource(
  name: string,
  text: string,
  sourcePath: string | null,
): Promise<TableMeta> {
  return invoke<TableMeta>('save_replace_table_source', { name, text, sourcePath });
}

/** 删除用户表（内置表示例不可删） */
export async function deleteReplaceTable(name: string): Promise<void> {
  return invoke<void>('delete_replace_table', { name });
}

/** 应用替换表（模式 A 独立引擎 / 模式 B OpenCC 内联字典） */
export async function applyReplace(
  text: string,
  table: ReplaceTable,
  opts: ApplyOpts,
): Promise<ApplyReport> {
  return invoke<ApplyReport>('apply_replace', { text, table, opts });
}

/** 导入 TextPro `.tab` 文件 */
export async function importTextproTab(
  path: string,
  name: string | null,
): Promise<ReplaceTable> {
  return invoke<ReplaceTable>('import_textpro_tab', { path, name });
}

/** 首次启动复制内置示例表（幂等） */
export async function ensureReplaceTables(): Promise<number> {
  return invoke<number>('ensure_replace_tables');
}

/** 新建表模板（含说明注释与示例条目） */
export const NEW_TABLE_TEMPLATE = `# AioTextEditor 自定义替换表（TextPro 风格：A/B=目标）
#name: 我的表
#desc: 说明这张表的用途
# 说明：
#   - 左侧用 / 分隔多个候选，如「少/兔=㝹」表示少、兔都替换为 㝹
#   - 以分号或井号开头的行是注释；#rules: 行保存整词/大小写等开关
#   - 反斜杠写作两条反斜杠；不可见字符写作反斜杠 + n / 反斜杠 + t
鼠标=滑鼠
`;

// ---------------------------------------------------------------------------
// F-05 中文增强正则
// ---------------------------------------------------------------------------

/** 搜索/替换选项（F-05 §5.3 `RegexOptions`） */
export interface RegexOptions {
  /** 正则模式；关闭后为字面查找 */
  regex: boolean;
  /** 忽略回车换行（匹配时跳过这些字符） */
  ignoreNewlines: boolean;
  /** 忽略标点 */
  ignorePunct: boolean;
  /** 忽略半角空格 */
  ignoreHalfSpace: boolean;
  caseInsensitive: boolean;
  /** 处理 `\n` `\t` `\x...` 转义 */
  useEscape: boolean;
}

/** 默认选项：正则开、使用转义开、其余关 */
export const DEFAULT_REGEX_OPTIONS: RegexOptions = {
  regex: true,
  ignoreNewlines: false,
  ignorePunct: false,
  ignoreHalfSpace: false,
  caseInsensitive: false,
  useEscape: true,
};

/** 命中区间（偏移为 UTF-16 码元，可直接用于 CodeMirror 定位） */
export interface MatchSpan {
  start: number;
  end: number;
  text: string;
  groups: string[];
}

/** 替换结果（F-05 §5.4 `regex_replace`） */
export interface RegexReplaceReport {
  text: string;
  count: number;
  spans: MatchSpan[];
  /** 每个区间的实际替换文本（与 spans 一一对应；单次替换时精确改写用） */
  replacements: string[];
}

/** 中文类目（下拉数据源） */
export interface RegexCategory {
  token: string;
  label: string;
  sample: string;
}

/** 列出可用中文类目 */
export async function regexCategories(): Promise<RegexCategory[]> {
  return invoke<RegexCategory[]>('regex_categories');
}

/** 查找全部命中 */
export async function regexFind(
  text: string,
  pattern: string,
  opts: RegexOptions,
): Promise<MatchSpan[]> {
  return invoke<MatchSpan[]>('regex_find', { text, pattern, opts });
}

/** 替换（`skip` 跳过前若干个命中，`limit` 为 null 时替换到底） */
export async function regexReplace(
  text: string,
  pattern: string,
  replacement: string,
  opts: RegexOptions,
  skip: number | null,
  limit: number | null,
): Promise<RegexReplaceReport> {
  return invoke<RegexReplaceReport>('regex_replace', {
    text,
    pattern,
    replacement,
    opts,
    skip,
    limit,
  });
}

// ---------------------------------------------------------------------------
// F-09 文本整理工具集
// ---------------------------------------------------------------------------

/** 工具标识（与后端 `PipelineStep` 的 serde tag 完全一致，由契约测试锁定） */
export type ToolId =
  | 'remove_half_width'
  | 'full_to_half'
  | 'half_to_full'
  | 'normalize_line_head'
  | 'trim_line_end'
  | 'trim_line_head'
  | 'trim_both'
  | 'remove_intra_line_breaks'
  | 'sort_lines'
  | 'dedup_lines'
  | 'remove_empty_lines'
  | 'insert_blank_between'
  | 'simple_layout'
  | 'auto_segment'
  | 'control_width'
  | 'match_brackets'
  | 'fix_brackets'
  | 'half_quote_to_full'
  | 'vertical_to_horizontal'
  // v0.9 排版类工具
  | 'normalize_punctuation'
  | 'web_novel_layout'
  | 'chinese_copywriting'
  | 'tech_doc_layout'
  | 'snippet_process';

/** 删除半角字符的范围 */
export type HalfWidthMode = 'all' | 'alnum' | 'punct';
/** 按行排序方式 */
export type SortMode = 'unicode' | 'reverse' | 'lengthAsc' | 'lengthDesc';
/** 引号体系（规范标点） */
export type QuoteStyle = 'mainland' | 'corner' | 'keep';

/**
 * 工具选项（各工具只用其中若干项）
 *
 * 字段名与后端选项结构体一致（camelCase）；未给出的项由后端取默认值，
 * 因此「直接点菜单」与「打开对话框点应用」都会得到与 F-09 一致的结果。
 */
export interface ToolOptions {
  mode?: HalfWidthMode | SortMode;
  convertAlnum?: boolean;
  convertPunct?: boolean;
  mergeSpaces?: boolean;
  indent?: number;
  skipBlank?: boolean;
  force?: boolean;
  keepBlankRuns?: boolean;
  joiner?: string;
  paragraphPrefix?: string;
  ignoreSurroundingSpace?: boolean;
  trim?: boolean;
  ignoreCase?: boolean;
  keepLast?: boolean;
  breakAfter?: string;
  skipDialog?: boolean;
  maxSegmentChars?: number;
  width?: number;
  forbidHead?: string;
  autoClose?: boolean;
  // ---- v0.9 排版类工具 ----
  /** 规范标点：引号体系 */
  quoteStyle?: QuoteStyle;
  fixEllipsis?: boolean;
  fixDash?: boolean;
  halfToFullPunct?: boolean;
  fixBrackets?: boolean;
  checkBrackets?: boolean;
  verticalToHorizontal?: boolean;
  /** 网文排版 */
  cjkLatin?: boolean;
  cjkDigit?: boolean;
  squeezeSpaces?: boolean;
  trimEnd?: boolean;
  skipCode?: boolean;
  /** 中文文案 */
  spaceCjkLatin?: boolean;
  spaceCjkDigit?: boolean;
  noSpaceAfterPunct?: boolean;
  dedupPunct?: boolean;
  ellipsisAndDash?: boolean;
  digitUnit?: boolean;
  mathSymbol?: boolean;
  halfBracket?: boolean;
  /** 技术文档 */
  headingSpace?: boolean;
  listMarker?: boolean;
  fenceBlank?: boolean;
  cjkSpace?: boolean;
  finalNewline?: boolean;
  /** 片段处理 */
  trimHead?: boolean;
  removeEmpty?: boolean;
  insertBlank?: boolean;
  dedup?: boolean;
  sort?: boolean;
  sortMode?: SortMode;
  removeHalfWidth?: boolean;
  halfWidthMode?: HalfWidthMode;
  joinLines?: boolean;
}

/** 一个整理步骤（后端 `PipelineStep`）；`{kind}` 单独发出即为「默认选项」 */
export type PipelineStep = { kind: ToolId } & ToolOptions;

/** 工具元信息（菜单与选项对话框的数据源） */
export interface ToolMeta {
  id: ToolId;
  label: string;
  /** 菜单分组标题 */
  group: string;
  /** 一句话说明（菜单 title） */
  hint: string;
  /** 有可调选项 → UI 显示「…」并打开选项对话框 */
  hasOptions: boolean;
  /** 只检查不改写（匹配括号） */
  inspectsOnly: boolean;
}

/** 括号检查问题（行/列均从 1 起） */
export interface BracketIssue {
  line: number;
  column: number;
  ch: string;
  message: string;
}

/** 整理步骤的执行结果 */
export interface StepOutcome {
  text: string;
  /** 变更计数（语义按工具而定，见 notes） */
  changed: number;
  notes: string[];
  /** 仅匹配括号会填充 */
  bracketIssues: BracketIssue[];
}

/** 工具目录 */
export async function pipelinesCatalog(): Promise<ToolMeta[]> {
  return invoke<ToolMeta[]>('pipelines_catalog');
}

/** 应用单个整理步骤 */
export async function applyPipelineStep(
  text: string,
  step: PipelineStep,
): Promise<StepOutcome> {
  return invoke<StepOutcome>('apply_pipeline_step', { text, step });
}

/** 串行应用多个整理步骤（组合整理；第七阶段批处理复用） */
export async function applyPipelineChain(
  text: string,
  steps: PipelineStep[],
): Promise<StepOutcome> {
  return invoke<StepOutcome>('apply_pipeline_chain', { text, steps });
}

/** 对每一个命中套用整理工具（查找替换面板的「使用工具」） */
export async function regexReplaceWithTool(
  text: string,
  pattern: string,
  opts: RegexOptions,
  step: PipelineStep,
  skip: number | null,
  limit: number | null,
): Promise<RegexReplaceReport> {
  return invoke<RegexReplaceReport>('regex_replace_with_tool', {
    text,
    pattern,
    opts,
    step,
    skip,
    limit,
  });
}

/** 各工具的默认选项（与后端 `Default` 实现一致，选项对话框以此为初值） */
export const TOOL_OPTION_DEFAULTS: Record<ToolId, ToolOptions> = {
  remove_half_width: { mode: 'all' },
  full_to_half: { convertAlnum: true, convertPunct: false, mergeSpaces: true },
  half_to_full: { convertAlnum: true, convertPunct: false, mergeSpaces: true },
  normalize_line_head: { indent: 2, skipBlank: true, force: true },
  trim_line_end: {},
  trim_line_head: {},
  remove_intra_line_breaks: { keepBlankRuns: true, joiner: '', paragraphPrefix: '' },
  sort_lines: { mode: 'unicode', ignoreSurroundingSpace: false },
  dedup_lines: { trim: false, ignoreCase: false, keepLast: false },
  remove_empty_lines: {},
  insert_blank_between: {},
  simple_layout: { indent: 2 },
  auto_segment: { indent: 2, breakAfter: '。！？…', skipDialog: true, maxSegmentChars: 0 },
  control_width: {
    width: 40,
    indent: 0,
    breakAfter: '，。！？；：、）】」』',
    forbidHead: '，。！？；：、）】」』',
  },
  match_brackets: {},
  fix_brackets: { autoClose: true },
  half_quote_to_full: {},
  vertical_to_horizontal: {},
  trim_both: {},
  // ---- v0.9 排版类工具 ----
  normalize_punctuation: {
    quoteStyle: 'mainland',
    fixEllipsis: true,
    fixDash: true,
    halfToFullPunct: true,
    fixBrackets: false,
    checkBrackets: true,
    verticalToHorizontal: true,
  },
  web_novel_layout: {
    cjkLatin: true,
    cjkDigit: true,
    squeezeSpaces: true,
    trimEnd: true,
    // 默认不动缩进：网文稿件多半已经带着缩进，再补一遍就成了双份
    indent: 0,
    skipCode: true,
  },
  chinese_copywriting: {
    spaceCjkLatin: true,
    spaceCjkDigit: true,
    noSpaceAfterPunct: true,
    dedupPunct: true,
    ellipsisAndDash: true,
    digitUnit: true,
    mathSymbol: true,
    halfBracket: true,
    // 与网文排版相反：中文文案排的是要发布 / 印刷的稿子，默认空两格
    indent: 2,
  },
  tech_doc_layout: {
    headingSpace: true,
    listMarker: true,
    fenceBlank: true,
    trimEnd: true,
    cjkSpace: true,
    finalNewline: true,
  },
  snippet_process: {
    trimHead: true,
    trimEnd: true,
    removeEmpty: true,
    insertBlank: false,
    dedup: false,
    sort: false,
    sortMode: 'unicode',
    removeHalfWidth: false,
    halfWidthMode: 'all',
    joinLines: false,
  },
};

/** 工具栏常用整理快捷入口（F-09 §6.2：工具栏放置常用快捷按钮） */
export const TOOL_SHORTCUTS: ToolId[] = [
  'simple_layout',
  'remove_empty_lines',
  'trim_line_end',
  'insert_blank_between',
];

/** 括号对豁免预设（F-03 §3.2：`[]`、`()`、`<>` 等任意字符对） */
export const BRACKET_PRESETS: { label: string; open: string; close: string }[] = [
  { label: '[ ]', open: '[', close: ']' },
  { label: '( )', open: '(', close: ')' },
  { label: '< >', open: '<', close: '>' },
  { label: '{ }', open: '{', close: '}' },
  { label: '“ ”', open: '“', close: '”' },
  { label: '‘ ’', open: '‘', close: '’' },
  { label: '「 」', open: '「', close: '」' },
  { label: '『 』', open: '『', close: '』' },
];

// ---------------------------------------------------------------------------
// F-06 文件比较
// ---------------------------------------------------------------------------

/** 异体字等同强度：fc1 = 完全等同，fc2 = 部分等同（在 fc1 上叠加） */
export type VariantStrictness = 'fullEq' | 'partialEq' | 'strict';

/** 比较选项（F-06 §6.3；字段与后端 `CompareOptions` 一致，camelCase） */
export interface CompareOptions {
  ignoreNewlines: boolean;
  ignoreHalfSpace: boolean;
  ignoreFullPunct: boolean;
  ignoreHalfPunct: boolean;
  variantStrictness: VariantStrictness;
}

/** 默认全不忽略、逐字比较（与后端 `Default` 一致，选项对话框以此为初值） */
export const DEFAULT_COMPARE_OPTIONS: CompareOptions = {
  ignoreNewlines: false,
  ignoreHalfSpace: false,
  ignoreFullPunct: false,
  ignoreHalfPunct: false,
  variantStrictness: 'strict',
};

/** 异体字策略下拉项 */
export const VARIANT_STRICTNESS_OPTIONS: { value: VariantStrictness; label: string }[] = [
  { value: 'strict', label: '不忽略异体字（逐字）' },
  { value: 'fullEq', label: '完全等同视为相同（fc1：兔＝兎）' },
  { value: 'partialEq', label: '部分等同也视为相同（fc2：达＝達）' },
];

// ---------------------------------------------------------------------------
// 文件比较（F-06 §6.2）—— 差异计数、F5 跳差异、标红，全都用这一份结果
// ---------------------------------------------------------------------------

/**
 * 一处差异：两侧的偏移与长度（偏移为 UTF-16 码元，与 CodeMirror 文档坐标一致）。
 *
 * 长度为 0 的一侧表示「那一侧没有对应的字」：
 * - `lenB === 0` —— A 多出了 `lenA` 个字（删掉才对齐）；
 * - `lenA === 0` —— B 多出了 `lenB` 个字（补上才对齐）；
 * - 两边都大于 0 —— 某处的字被换掉了。
 *
 * 相邻的「缺 + 多」在后端已经并成一块，所以这里的条数就是界面上说的「N 处」。
 */
export interface DiffBlock {
  posA: number;
  posB: number;
  lenA: number;
  lenB: number;
}

export interface DiffResult {
  /** 差异块，按文中出现的先后顺序排列 */
  blocks: DiffBlock[];
  /** 差异过多，已截断到后端上限 */
  truncated: boolean;
  /** 文本过大或差异过密，这份结果只是近似 —— UI 要照实说明 */
  degraded: boolean;
}

/**
 * 求两份文本的差异（最小编辑脚本）。
 *
 * 这与早先那套 TextPro 逐字口径不同：那套在第一处失配之后两侧各进一步，
 * 后面就一路错位；这里求真正的编辑脚本，改了一个字就只有那一个字。
 */
export async function compareDiff(
  a: string,
  b: string,
  opts: CompareOptions,
): Promise<DiffResult> {
  return invoke<DiffResult>('compare_diff', { a, b, opts });
}

// ---------------------------------------------------------------------------
// F-07 文件合并
// ---------------------------------------------------------------------------

/** 拼接策略：简单拼接 / 同名段拼接（按源正则第 1 捕获组分文件） */
export type MergeStrategy = 'simple' | 'sameName';

/** 两种合并模式共用的选项（后端经 serde flatten 平铺进同一层 JSON） */
export interface MergeSharedOptions {
  strategy: MergeStrategy;
  /** 源文件名正则（含捕获组；自动合并必填） */
  sourcePattern?: string | null;
  /** 输出文件名模板（`\1.txt`；仅自动合并使用） */
  outputPattern?: string | null;
  /** 排序关键字：有源正则时是模板（`\2`），否则是对文件名求值的正则 */
  sortKey?: string | null;
  /** 手工合并的输出文件；自动合并在源目录生成 */
  outputPath?: string | null;
  /** 输出已存在时是否覆盖（默认跳过并报告） */
  overwrite: boolean;
}

/** 合并请求（判别联合，与后端 `MergeRequest` 的 tag + flatten 形状对应） */
export type MergeRequest =
  | ({ mode: 'manual'; files: string[] } & MergeSharedOptions)
  | ({ mode: 'auto'; directory: string } & MergeSharedOptions);

/** 一个成功写出的合并产物 */
export interface MergedFile {
  path: string;
  name: string;
  fileCount: number;
  charCount: number;
  /** 参与文件（按合并顺序） */
  order: string[];
}

/** 一个被跳过的文件（读取失败 / 输出已存在等） */
export interface MergeSkip {
  path: string;
  reason: string;
}

export interface MergeReport {
  outputs: MergedFile[];
  skipped: MergeSkip[];
  /** 自动合并扫描到的文件数（手工合并 = 源文件数） */
  scanned: number;
}

/** 执行合并（F-07 §7.3） */
export async function mergeFiles(req: MergeRequest): Promise<MergeReport> {
  return invoke<MergeReport>('merge_files', { req });
}

/** 自动合并正则三件套的规格示例（F-07 §7.2） */
export const DEFAULT_MERGE_PATTERNS = {
  sourcePattern: '(\\d+)_(\\d+)\\.txt',
  outputPattern: '\\1.txt',
  sortKey: '\\2',
};

/** 多选打开文件对话框（F-07 手工合并的源文件清单） */
export async function pickOpenFiles(): Promise<string[] | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: true, directory: false, title: '选择要合并的文件' });
  return Array.isArray(picked) ? picked : null;
}

/** 选择目录对话框（F-07 自动合并的源目录） */
export async function pickDirectory(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: false, directory: true, title: '选择源文件目录' });
  return typeof picked === 'string' ? picked : null;
}

// ---------------------------------------------------------------------------
// F-08 批处理（第七阶段）
// ---------------------------------------------------------------------------

/** 输入 / 输出编码：字符串 `"auto"` 或具体编码标签 */
export type EncodingOrAuto = 'auto' | string;

/** 批处理请求（F-08 §8.4） */
export interface BatchRequest {
  inputs: string[];
  recursive: boolean;
  backup: boolean;
  preserveMtime: boolean;
  inputEncoding: EncodingOrAuto;
  outputEncoding: EncodingOrAuto;
  steps: PipelineStep[];
}

/** 单文件错误（F-08 错误面板染色用） */
export interface BatchFileError {
  path: string;
  /** 'enumerate' | 'read' | 'process' | 'backup' | 'write' | 'mtime' */
  phase: string;
  message: string;
}

/** 批处理汇总（F-08 §8.5 终态回报） */
export interface BatchReport {
  scanned: number;
  unchanged: number;
  written: number;
  backedUp: number;
  cancelled: boolean;
  errors: BatchFileError[];
  elapsedMs: number;
}

/**
 * 进度事件（与后端 `BatchProgress` 同构，tag 枚举）。
 *
 * 后端**已做合并**（至多约 10 条/秒，见 `commands/batch.rs` 的
 * `ProgressThrottle`）——高频事件若逐条过 IPC，`Channel::send` 的开销会
 * 彻底盖过批处理本身（实测 300 文件从 0.12s 膨胀到 21s）。因此前端
 * 不需要再累加计数，直接把快照写进 state 即可。
 */
export type BatchProgress =
  | {
      kind: 'progress';
      done: number;
      total: number;
      modified: number;
      errors: number;
      /** 最近处理的文件（供 UI 显示「正在处理 …」） */
      current: string | null;
      /** 本次快照内新增的最后一条错误（无则 null） */
      lastError: BatchFileError | null;
    }
  | { kind: 'cancelled'; processed: number; total: number }
  | { kind: 'finished'; report: BatchReport };

/** 计划预览（仅枚举、不读盘不写盘） */
export interface BatchPlan {
  fileCount: number;
  sample: string[];
}

/**
 * 跑一次批处理：进度通过 `onProgress` 实时回调，最终返回 `BatchReport`。
 *
 * 借助 Tauri 2 的 `Channel<T>` 实现流式进度推送：前端建通道、后端在
 * `spawn_blocking` 里把每个文件事件 `send` 到通道，前端 `onmessage` 即时拿到。
 */
export async function batchRun(
  req: BatchRequest,
  onProgress: (msg: BatchProgress) => void,
): Promise<BatchReport> {
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  const ch = new Channel<BatchProgress>();
  ch.onmessage = onProgress;
  return invoke<BatchReport>('batch_run', { req, progress: ch });
}

/** 取消当前批处理（不返回错误：未在跑时也是 no-op） */
export async function batchCancel(): Promise<void> {
  return invoke<void>('batch_cancel');
}

/** 计划预览：把 inputs 展开为文件清单，UI 提示「将处理 N 个文件」 */
export async function batchPlan(req: BatchRequest): Promise<BatchPlan> {
  return invoke<BatchPlan>('batch_plan', { req });
}

// ---------------------------------------------------------------------------
// F-11 偏好设置（第八阶段）
// ---------------------------------------------------------------------------

/**
 * 「自动」+ 具体编码：**读取 / 输入**一侧的下拉项（F-08 批处理、F-11 设置）。
 *
 * 由保存对话框那份 [`ENCODING_OPTIONS`] 派生，避免两处编码清单各自漂移——
 * 差别只在多一个「自动（探测）」：保存时必须落到具体编码，不存在「自动」。
 * 放在接口层而不是某个对话框内部，也是同样的理由（后端 `Encoding::from_label`
 * 是唯一的合法性判据）。
 */
export const ENCODING_OR_AUTO_OPTIONS: { label: string; value: EncodingOrAuto }[] = [
  { label: '自动（探测）', value: 'auto' },
  ...ENCODING_OPTIONS,
];

/** 行尾风格（与后端 `LineEnding` 一致） */
export type LineEnding = 'lf' | 'cr' | 'crlf';

/** 行尾下拉项 */
export const LINE_ENDING_OPTIONS: { label: string; value: LineEnding }[] = [
  { label: 'LF（\\n，Unix / macOS）', value: 'lf' },
  { label: 'CRLF（\\r\\n，Windows）', value: 'crlf' },
  { label: 'CR（\\r，旧 Mac）', value: 'cr' },
];

/** 主题（F-11 §11.1） */
export type Theme = 'system' | 'light' | 'dark';

/** 主题下拉项 */
export const THEME_OPTIONS: { label: string; value: Theme }[] = [
  { label: '跟随系统', value: 'system' },
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
];

/** 外观设置（F-11 §11.1） */
export interface AppearanceSettings {
  fontFamily: string;
  fontSize: number;
  showLineNumber: boolean;
  showToolbar: boolean;
  showStatusBar: boolean;
  /** 显示不可见字符：空格 `·` / 制表符 `→` */
  showSpaces: boolean;
  /** 显示行尾符 `¬` */
  showLineEnds: boolean;
  /** 显示换段符 `¶`（段落最后一行；优先于行尾符） */
  showParagraphMarks: boolean;
  theme: Theme;
}

/** 编辑器设置（F-11 §11.1） */
export interface EditorSettings {
  tabWidth: number;
  insertSpaces: boolean;
  wrap: boolean;
  defaultEncoding: EncodingOrAuto;
  defaultLineEnding: LineEnding;
}

/** 转换设置（F-11 §11.1） */
export interface ConversionSettings {
  bracketSkip: string;
  preserveConverted: boolean;
}

/**
 * 全部设置（F-11 §11.1）。
 *
 * `compare` 直接复用 F-06 的 [`CompareOptions`]——「设默认值」与「比较对话框初值」
 * 因此天然是同一个结构，不会出现两份语义相同的类型（后端同理，见
 * `core/settings.rs` 的说明）。
 */
export interface Settings {
  appearance: AppearanceSettings;
  editor: EditorSettings;
  conversion: ConversionSettings;
  compare: CompareOptions;
  /**
   * 快捷键**覆盖表**（不是全量快照）：
   * - 键不存在 → 用 `shared/shortcuts.ts` 注册表里的默认键位
   * - 空串 → 用户显式解绑
   * - 非空 → 自定义覆盖（规范键位字符串）
   */
  shortcuts: Record<string, string>;
}

/** 字号可调区间（F-11 §11.1 / UI §五） */
export const FONT_SIZE_RANGE = { min: 12, max: 32 } as const;
/** 缩进宽度可调区间 */
export const TAB_WIDTH_RANGE = { min: 1, max: 16 } as const;

/**
 * 读取设置。
 *
 * 后端**永不失败**（文件缺失 / 损坏 / 字段越界都会给出可用值），
 * 因此这里不做兜底 catch——若真抛错，那是 IPC 层的问题，不该被静默吞掉。
 */
export async function settingsGet(): Promise<Settings> {
  return invoke<Settings>('settings_get');
}

/** 保存设置；返回**实际落盘**的值（可能已被钳制 / 清洗），调用方应对齐到它 */
export async function settingsSave(settings: Settings): Promise<Settings> {
  return invoke<Settings>('settings_save', { settings });
}

/** 恢复默认：删除 `settings.json`（含 `.bad` / `.tmp` 残留），返回默认值 */
export async function settingsReset(): Promise<Settings> {
  return invoke<Settings>('settings_reset');
}

// ---------------------------------------------------------------------------
// F-01 §1.2 会话与未保存恢复（第九阶段）
// ---------------------------------------------------------------------------

/** 行尾（与 `EditorTab.lineEnding` 一致） */
export type LineEndingLabel = 'lf' | 'cr' | 'crlf';

/** 一个会话标签（与 `tabsStore` 的 `EditorTab` 同形，`content` 可缺省） */
export interface SessionTab {
  id: string;
  filePath: string | null;
  fileName: string;
  /**
   * 未保存正文；`null` = 启动时从 `filePath` 重读。
   *
   * 前端据此决定要不要把正文写进会话：**只有「磁盘上没有这份内容」的标签才带
   * 正文**（`dirty` 或从未保存过），否则「打开几个大文件、一个字没改」也会让
   * `session.json` 膨胀。
   */
  content: string | null;
  encoding: string;
  lineEnding: LineEndingLabel;
  hadBom: boolean;
  dirty: boolean;
  cursorLine: number;
  cursorColumn: number;
}

/** 上次会话（F-01 §1.3） */
export interface SessionState {
  tabs: SessionTab[];
  activeTabId: string | null;
}

/**
 * 读取上次会话。
 *
 * 后端**永不失败**：文件缺失（首次启动）/ 不可读 / 坏掉都会给出一份可用会话
 * （坏标签丢弃，其余保留），故这里不做兜底 catch。
 */
export async function sessionLoad(): Promise<SessionState> {
  return invoke<SessionState>('session_load');
}

/** 保存会话；返回**实际落盘**的值（越界的光标 / 行尾已被纠正） */
export async function sessionSave(state: SessionState): Promise<SessionState> {
  return invoke<SessionState>('session_save', { state });
}

/** 清除会话（下次启动回到「一个空标签」） */
export async function sessionClear(): Promise<void> {
  return invoke<void>('session_clear');
}

// ---------------------------------------------------------------------------
// 启动指标（第九阶段）
// ---------------------------------------------------------------------------

/** 启动耗时指标 */
export interface StartupMetrics {
  /** 后端 `run()` → `setup` 完成的毫秒数（不含前端加载） */
  setupMs: number;
  /** 是否为调试构建：dev 构建启动明显慢，阈值需按它区分 */
  debugBuild: boolean;
}

/**
 * 读取启动耗时指标。
 *
 * 用途是把「启动 < 1.5s」这条验收标准变成**可观测、可断言**的数字：前端启动后
 * 读一次，写进 `window.__aioStartupMetrics` 供 E2E 断言，同时打一条 console.info
 * 便于人工排查。指标口径不含前端资源加载（见后端 `StartupMetrics` 注释）。
 */
export async function startupMetrics(): Promise<StartupMetrics> {
  return invoke<StartupMetrics>('startup_metrics');
}

/** 应用版本号（后端 `Cargo.toml` 的 `version`），用于「帮助 → 关于」 */
export async function appVersion(): Promise<string> {
  return invoke<string>('app_version');
}
