/**
 * 整理工具的可调字段 schema（F-09 §6.2）
 *
 * 从 `ToolOptionsDialog.tsx` 搬到这里，是为了让**字段名的文案能被批量转繁體**
 * （PRD §3.6）：文案汇总（`shared/i18n/messages.ts`）需要 import 这份数据去收集
 * label，而组件文件不该被文案模块反向依赖。这里只有数据与类型，不碰 React。
 */

import type { ToolId, ToolOptions } from '../platform/tauriApi';

export type Field =
  | { key: keyof ToolOptions; label: string; type: 'number'; min?: number; max?: number }
  | { key: keyof ToolOptions; label: string; type: 'text'; hint?: string }
  | { key: keyof ToolOptions; label: string; type: 'checkbox' }
  | {
      key: keyof ToolOptions;
      label: string;
      type: 'select';
      choices: { value: string; label: string }[];
    };

/** 排序方式（两处工具共用，抽出来免得两份漂移） */
const SORT_CHOICES: { value: string; label: string }[] = [
  { value: 'unicode', label: 'Unicode 升序' },
  { value: 'reverse', label: 'Unicode 降序' },
  { value: 'lengthAsc', label: '短行在前' },
  { value: 'lengthDesc', label: '长行在前' },
];

/** 删除半角字符的范围 */
const HALF_WIDTH_CHOICES: { value: string; label: string }[] = [
  { value: 'all', label: '全部半角字符' },
  { value: 'alnum', label: '仅字母与数字' },
  { value: 'punct', label: '仅标点' },
];

/** 每个工具的可调字段（顺序即表单顺序） */
export const TOOL_FIELDS: Partial<Record<ToolId, Field[]>> = {
  remove_half_width: [
    {
      key: 'mode',
      label: '删除范围',
      type: 'select',
      choices: HALF_WIDTH_CHOICES,
    },
  ],
  full_to_half: [
    { key: 'convertAlnum', label: '转换字母与数字', type: 'checkbox' },
    { key: 'convertPunct', label: '同时转换标点（中文标点也会变）', type: 'checkbox' },
    { key: 'mergeSpaces', label: '全角空格转为两个半角空格', type: 'checkbox' },
  ],
  half_to_full: [
    { key: 'convertAlnum', label: '转换字母与数字', type: 'checkbox' },
    { key: 'convertPunct', label: '同时转换标点', type: 'checkbox' },
    { key: 'mergeSpaces', label: '两个半角空格合成一个全角空格', type: 'checkbox' },
  ],
  normalize_line_head: [
    { key: 'indent', label: '段首缩进（全角空格个数）', type: 'number', min: 0, max: 8 },
    { key: 'skipBlank', label: '空行不加缩进', type: 'checkbox' },
    { key: 'force', label: '重排已有缩进的行', type: 'checkbox' },
  ],
  remove_intra_line_breaks: [
    { key: 'keepBlankRuns', label: '保留段落之间的空行', type: 'checkbox' },
    { key: 'joiner', label: '段内行连接串', type: 'text' },
    { key: 'paragraphPrefix', label: '段首插入', type: 'text' },
  ],
  sort_lines: [
    {
      key: 'mode',
      label: '排序方式',
      type: 'select',
      choices: SORT_CHOICES,
    },
    { key: 'ignoreSurroundingSpace', label: '忽略行首行末空格', type: 'checkbox' },
  ],
  dedup_lines: [
    { key: 'trim', label: '忽略行首行末空格后比较', type: 'checkbox' },
    { key: 'ignoreCase', label: '忽略大小写', type: 'checkbox' },
    { key: 'keepLast', label: '仅保留最后一次出现', type: 'checkbox' },
  ],
  simple_layout: [
    { key: 'indent', label: '段首缩进（全角空格个数）', type: 'number', min: 0, max: 8 },
  ],
  auto_segment: [
    { key: 'indent', label: '段首缩进（全角空格个数）', type: 'number', min: 0, max: 8 },
    { key: 'breakAfter', label: '在这些标点后断句', type: 'text' },
    { key: 'maxSegmentChars', label: '超长强制断开（0 = 不限）', type: 'number', min: 0, max: 500 },
    { key: 'skipDialog', label: '对话行不加缩进', type: 'checkbox' },
  ],
  control_width: [
    { key: 'width', label: '每行宽度（半角字符，CJK 记 2）', type: 'number', min: 4, max: 300 },
    { key: 'indent', label: '续行缩进（全角空格个数）', type: 'number', min: 0, max: 8 },
    { key: 'breakAfter', label: '优先断在这些标点之后', type: 'text' },
    { key: 'forbidHead', label: '不让这些标点出现在行首', type: 'text' },
  ],
  fix_brackets: [{ key: 'autoClose', label: '行末自动补齐未闭合的括号', type: 'checkbox' }],
  // ---- v0.9 排版类工具 ----
  normalize_punctuation: [
    {
      key: 'quoteStyle',
      label: '引号体系',
      type: 'select',
      choices: [
        { value: 'mainland', label: '大陆： “”‘’' },
        { value: 'corner', label: '港澳台： 「」『』' },
        { value: 'keep', label: '不转换引号' },
      ],
    },
    { key: 'fixEllipsis', label: '省略号统一为「……」', type: 'checkbox' },
    { key: 'fixDash', label: '破折号统一为「——」', type: 'checkbox' },
    { key: 'halfToFullPunct', label: '中文语境里的半角标点转全角', type: 'checkbox' },
    { key: 'verticalToHorizontal', label: '竖排符号转横排', type: 'checkbox' },
    { key: 'checkBrackets', label: '检查括号配对（只提示）', type: 'checkbox' },
    { key: 'fixBrackets', label: '括号按嵌套阶梯改写并补齐', type: 'checkbox' },
  ],
  web_novel_layout: [
    { key: 'cjkLatin', label: '中文与英文字母之间补空格', type: 'checkbox' },
    { key: 'cjkDigit', label: '中文与数字之间补空格', type: 'checkbox' },
    { key: 'squeezeSpaces', label: '去掉全角标点旁的多余空格', type: 'checkbox' },
    { key: 'trimEnd', label: '清理行尾空格', type: 'checkbox' },
    { key: 'indent', label: '段首缩进（全角空格个数，0 = 不动）', type: 'number', min: 0, max: 8 },
    { key: 'skipCode', label: '跳过 URL 与行内代码', type: 'checkbox' },
  ],
  chinese_copywriting: [
    { key: 'spaceCjkLatin', label: '中文与英文字母之间补空格', type: 'checkbox' },
    { key: 'spaceCjkDigit', label: '中文与数字之间补空格', type: 'checkbox' },
    { key: 'noSpaceAfterPunct', label: '全角标点之后不留空格', type: 'checkbox' },
    { key: 'dedupPunct', label: '重复标点合并（！！→！）', type: 'checkbox' },
    { key: 'ellipsisAndDash', label: '省略号与破折号规范化', type: 'checkbox' },
    { key: 'digitUnit', label: '数字与英文单位之间补空格（度、% 除外）', type: 'checkbox' },
    { key: 'mathSymbol', label: '数学符号两侧补空格（E=mc² → E = mc²）', type: 'checkbox' },
    { key: 'halfBracket', label: '半角括号前后补空格（Tree(DT) → Tree (DT)）', type: 'checkbox' },
    { key: 'indent', label: '段首缩进（全角空格个数，0 = 不动）', type: 'number', min: 0, max: 8 },
  ],
  tech_doc_layout: [
    { key: 'headingSpace', label: '标题与内容之间补空格（#标题 → # 标题）', type: 'checkbox' },
    { key: 'listMarker', label: '列表符号统一为 -', type: 'checkbox' },
    { key: 'fenceBlank', label: '代码围栏前后补空行', type: 'checkbox' },
    { key: 'cjkSpace', label: '中英文之间补空格（围栏内不动）', type: 'checkbox' },
    { key: 'trimEnd', label: '清理行尾空格', type: 'checkbox' },
    { key: 'finalNewline', label: '文件末尾补一个换行', type: 'checkbox' },
  ],
  snippet_process: [
    { key: 'trimHead', label: '删除行首空格', type: 'checkbox' },
    { key: 'trimEnd', label: '删除行末空格', type: 'checkbox' },
    { key: 'removeEmpty', label: '删除空行', type: 'checkbox' },
    { key: 'insertBlank', label: '段间空一行', type: 'checkbox' },
    { key: 'joinLines', label: '删除段内回车（合并成一段）', type: 'checkbox' },
    { key: 'dedup', label: '删除重复行', type: 'checkbox' },
    { key: 'sort', label: '按行排序', type: 'checkbox' },
    {
      key: 'sortMode',
      label: '排序方式',
      type: 'select',
      choices: SORT_CHOICES,
    },
    { key: 'removeHalfWidth', label: '删除半角字符', type: 'checkbox' },
    {
      key: 'halfWidthMode',
      label: '删除范围',
      type: 'select',
      choices: HALF_WIDTH_CHOICES,
    },
  ],
};

/**
 * 字段与选项的**界面文案**（供批量转繁體收集）。
 *
 * 字段名不进文案表（它们是表单 schema），但同样要转，所以单独列出来。
 */
export function toolFieldTexts(): string[] {
  const out = new Set<string>();
  for (const fields of Object.values(TOOL_FIELDS)) {
    for (const field of fields ?? []) {
      if (field.label) out.add(field.label);
      if (field.type === 'select') {
        for (const choice of field.choices) out.add(choice.label);
      }
    }
  }
  return [...out];
}
