/**
 * 整理工具选项对话框（F-09 §6.2）
 *
 * 只服务于「有选项」的工具：字段由本文件的声明式 schema 生成，
 * 改动选项后**实时**把结果跑一遍（防抖 250ms）并给出提示与结果预览，
 * 应用时可选择「整篇 / 选中文本」，与其他转换功能的作用范围语义一致。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TOOL_OPTION_DEFAULTS,
  applyPipelineStep,
  type PipelineStep,
  type StepOutcome,
  type ToolId,
  type ToolMeta,
  type ToolOptions,
} from '../platform/tauriApi';

type Field =
  | { key: keyof ToolOptions; label: string; type: 'number'; min?: number; max?: number }
  | { key: keyof ToolOptions; label: string; type: 'text'; hint?: string }
  | { key: keyof ToolOptions; label: string; type: 'checkbox' }
  | {
      key: keyof ToolOptions;
      label: string;
      type: 'select';
      choices: { value: string; label: string }[];
    };

/** 每个工具的可调字段（顺序即表单顺序） */
const TOOL_FIELDS: Partial<Record<ToolId, Field[]>> = {
  remove_half_width: [
    {
      key: 'mode',
      label: '删除范围',
      type: 'select',
      choices: [
        { value: 'all', label: '全部半角字符' },
        { value: 'alnum', label: '仅字母与数字' },
        { value: 'punct', label: '仅标点' },
      ],
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
      choices: [
        { value: 'unicode', label: 'Unicode 升序' },
        { value: 'reverse', label: 'Unicode 降序' },
        { value: 'lengthAsc', label: '短行在前' },
        { value: 'lengthDesc', label: '长行在前' },
      ],
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
      choices: [
        { value: 'unicode', label: 'Unicode 升序' },
        { value: 'reverse', label: 'Unicode 降序' },
        { value: 'lengthAsc', label: '短行在前' },
        { value: 'lengthDesc', label: '长行在前' },
      ],
    },
    { key: 'removeHalfWidth', label: '删除半角字符', type: 'checkbox' },
    {
      key: 'halfWidthMode',
      label: '删除范围',
      type: 'select',
      choices: [
        { value: 'all', label: '全部半角字符' },
        { value: 'alnum', label: '仅字母与数字' },
        { value: 'punct', label: '仅标点' },
      ],
    },
  ],
};

interface ToolOptionsDialogProps {
  meta: ToolMeta;
  /** 当前文档正文 */
  content: string;
  /** 当前选区（无选区传 null） */
  selection: { from: number; to: number } | null;
  onApply: (step: PipelineStep, scope: 'all' | 'selection') => void;
  onCancel: () => void;
}

export function ToolOptionsDialog({
  meta,
  content,
  selection,
  onApply,
  onCancel,
}: ToolOptionsDialogProps) {
  const fields = useMemo<Field[]>(() => TOOL_FIELDS[meta.id] ?? [], [meta.id]);
  const [options, setOptions] = useState<ToolOptions>(() => ({
    ...TOOL_OPTION_DEFAULTS[meta.id],
  }));
  const [scope, setScope] = useState<'all' | 'selection'>(
    selection && selection.to > selection.from ? 'selection' : 'all',
  );
  const [preview, setPreview] = useState<StepOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const step = useMemo<PipelineStep>(
    () => ({ kind: meta.id, ...options }),
    [meta.id, options],
  );

  const targetText = useMemo(() => {
    if (scope === 'selection' && selection && selection.to > selection.from) {
      return content.slice(selection.from, selection.to);
    }
    return content;
  }, [content, scope, selection]);

  // 选项 / 范围变化 → 防抖后再跑一遍预览
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setBusy(true);
      applyPipelineStep(targetText, step)
        .then((outcome) => {
          if (cancelled) return;
          setPreview(outcome);
          setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(String(e));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [step, targetText]);

  const setValue = useCallback((key: keyof ToolOptions, value: unknown) => {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }, []);

  const scopeLabel = scope === 'selection' ? '选中文本' : '整篇';

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog-wide dialog-tool" role="dialog" aria-modal="true">
        <h3 className="dialog-title">{meta.label}</h3>
        <p className="dialog-text">
          {meta.hint}
          <span className="dialog-hint">（{targetText.length} 字符）</span>
        </p>

        <div className="dialog-body">
          {fields.length === 0 ? (
            <p className="dialog-hint">该工具没有可调选项，可直接应用。</p>
          ) : (
            <div className="tool-fields">
              {fields.map((field) => (
                <label key={String(field.key)} className="tool-field">
                  <span className="tool-field-label">{field.label}</span>
                  {field.type === 'checkbox' ? (
                    <input
                      type="checkbox"
                      checked={Boolean(options[field.key])}
                      onChange={(e) => setValue(field.key, e.target.checked)}
                    />
                  ) : field.type === 'number' ? (
                    <input
                      type="number"
                      className="tool-input-number"
                      min={field.min}
                      max={field.max}
                      value={Number(options[field.key] ?? 0)}
                      onChange={(e) => {
                        const raw = Number.parseInt(e.target.value, 10);
                        setValue(field.key, Number.isNaN(raw) ? 0 : raw);
                      }}
                    />
                  ) : field.type === 'select' ? (
                    <select
                      className="tool-input-select"
                      value={String(options[field.key] ?? '')}
                      onChange={(e) => setValue(field.key, e.target.value)}
                    >
                      {field.choices.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      className="tool-input-text"
                      value={String(options[field.key] ?? '')}
                      onChange={(e) => setValue(field.key, e.target.value)}
                    />
                  )}
                </label>
              ))}
            </div>
          )}

          <fieldset className="dialog-fieldset">
            <legend>作用范围</legend>
            <label className="dialog-row dialog-check">
              <input
                type="radio"
                name="tool-scope"
                checked={scope === 'all'}
                onChange={() => setScope('all')}
              />
              整篇
            </label>
            <label className="dialog-row dialog-check">
              <input
                type="radio"
                name="tool-scope"
                checked={scope === 'selection'}
                disabled={!selection || selection.to <= selection.from}
                onChange={() => setScope('selection')}
              />
              选中文本
              {(!selection || selection.to <= selection.from) && '（当前没有选中内容）'}
            </label>
          </fieldset>

          <div className="tool-preview">
            <div className="tool-preview-stat">
              {busy && !preview && '计算中…'}
              {preview && (
                <>
                  {preview.notes.join('；')}
                  {preview.changed === 0 && '（内容不变）'}
                </>
              )}
            </div>
            {error && <div className="tool-preview-error">{error}</div>}
            {preview && (
              <pre className="tool-preview-text" aria-label="处理结果预览">
                {preview.text.slice(0, 800) || '（空）'}
                {preview.text.length > 800 ? '\n…' : ''}
              </pre>
            )}
          </div>
        </div>

        <div className="dialog-actions">
          <button
            type="button"
            className="dialog-primary"
            disabled={busy}
            onClick={() => onApply(step, scope)}
          >
            应用到{scopeLabel}
          </button>
          <button type="button" className="dialog-cancel" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
