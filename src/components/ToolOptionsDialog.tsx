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
  type ToolMeta,
  type ToolOptions,
} from '../platform/tauriApi';
import { TOOL_FIELDS, type Field } from '../shared/toolFields';
import { useI18n } from '../shared/i18n';
import { TOOL_OPTIONS } from '../shared/i18n/tools';
import { COMMON } from '../shared/i18n/common';
import { fill } from '../shared/i18n/status';

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
  const { t } = useI18n();
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

  const scopeLabel =
    scope === 'selection' ? t(TOOL_OPTIONS.scopeSelection) : t(TOOL_OPTIONS.scopeAll);

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog-wide dialog-tool" role="dialog" aria-modal="true">
        <h3 className="dialog-title">{t(meta.label)}</h3>
        <p className="dialog-text">
          {t(meta.hint)}
          <span className="dialog-hint">
            {fill(t(TOOL_OPTIONS.charCount), { count: targetText.length })}
          </span>
        </p>

        <div className="dialog-body">
          {fields.length === 0 ? (
            <p className="dialog-hint">{t(TOOL_OPTIONS.noOptions)}</p>
          ) : (
            <div className="tool-fields">
              {fields.map((field) => (
                <label key={String(field.key)} className="tool-field">
                  <span className="tool-field-label">{t(field.label)}</span>
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
                          {t(choice.label)}
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
            <legend>{t(TOOL_OPTIONS.scopeLegend)}</legend>
            <label className="dialog-row dialog-check">
              <input
                type="radio"
                name="tool-scope"
                checked={scope === 'all'}
                onChange={() => setScope('all')}
              />
              {t(TOOL_OPTIONS.scopeAll)}
            </label>
            <label className="dialog-row dialog-check">
              <input
                type="radio"
                name="tool-scope"
                checked={scope === 'selection'}
                disabled={!selection || selection.to <= selection.from}
                onChange={() => setScope('selection')}
              />
              {t(TOOL_OPTIONS.scopeSelection)}
              {(!selection || selection.to <= selection.from) && t(TOOL_OPTIONS.noSelection)}
            </label>
          </fieldset>

          <div className="tool-preview">
            <div className="tool-preview-stat">
              {busy && !preview && t(TOOL_OPTIONS.computing)}
              {preview && (
                <>
                  {/* notes 由后端按语言给出（PRD L-5） */}
                  {preview.notes.join('；')}
                  {preview.changed === 0 && t(TOOL_OPTIONS.unchanged)}
                </>
              )}
            </div>
            {error && <div className="tool-preview-error">{error}</div>}
            {preview && (
              <pre className="tool-preview-text" aria-label={t(TOOL_OPTIONS.previewA11y)}>
                {preview.text.slice(0, 800) || t(TOOL_OPTIONS.emptyPreview)}
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
            {fill(t(TOOL_OPTIONS.applyTo), { scope: scopeLabel })}
          </button>
          <button type="button" className="dialog-cancel" onClick={onCancel}>
            {t(COMMON.cancel)}
          </button>
        </div>
      </div>
    </div>
  );
}
