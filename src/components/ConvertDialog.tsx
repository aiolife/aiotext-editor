/**
 * 简繁转换对话框（F-03 §3.4）
 *
 * 配置转换方向 / 括号对豁免 / 歧义诊断 → 「预览差异」查看前 200 行 Diff
 * → 「应用转换」把结果写回编辑区（整篇或选区）。
 */
import { useState } from 'react';
import {
  BRACKET_PRESETS,
  convertOpencc,
  previewConvert,
  type AmbiguitySpan,
  type ConvertRequest,
  type ConvertPreview,
  type OpenccDirectionMeta,
  type TableMeta,
} from '../platform/tauriApi';
import { useI18n } from '../shared/i18n';
import { CONVERT } from '../shared/i18n/convert';
import { COMMON } from '../shared/i18n/common';
import { fill } from '../shared/i18n/status';

/** 转换作用对象 */
export interface ConvertTarget {
  text: string;
  scope: 'all' | 'selection';
}

interface ConvertDialogProps {
  directions: OpenccDirectionMeta[];
  initialDirection: string;
  target: ConvertTarget;
  /** 可选用户替换表（F-04 模式 B：叠加到 OpenCC 内联词典） */
  userTables?: TableMeta[];
  onApply: (text: string, ambiguities: AmbiguitySpan[], changedCount: number) => void;
  onCancel: () => void;
}

/** 按码点区间高亮行内差异（后端返回的区间为码点下标） */
function renderHighlighted(text: string, range: [number, number] | null) {
  if (!range) return <>{text}</>;
  const chars = Array.from(text);
  const [start, end] = range;
  return (
    <>
      {chars.slice(0, start).join('')}
      <mark className="diff-mark">{chars.slice(start, end).join('')}</mark>
      {chars.slice(end).join('')}
    </>
  );
}

/** 歧义片段列表（同族方向用字不同处） */
function AmbiguityList({ spans }: { spans: AmbiguitySpan[] }) {
  const { t } = useI18n();
  const shown = spans.slice(0, 50);
  return (
    <div className="ambiguity-list">
      <div className="menu-group-title">
        {fill(t(CONVERT.ambiguityTitle), { count: spans.length })}
      </div>
      <ul>
        {shown.map((span, index) => (
          // 片段原文是用户数据，不翻译
          <li key={`${span.start}-${index}`}>
            <code>{span.primary || t(CONVERT.emptySpan)}</code>
            <span className="ambiguity-alt">
              {fill(t(CONVERT.ambiguityAlt), {
                candidates: span.candidates.join(' / ') || t(CONVERT.emptySpan),
              })}
            </span>
            <span className="dialog-hint">{fill(t(CONVERT.position), { start: span.start })}</span>
          </li>
        ))}
      </ul>
      {spans.length > shown.length && (
        <div className="dialog-hint">{fill(t(CONVERT.onlyFirst), { count: shown.length })}</div>
      )}
    </div>
  );
}

export function ConvertDialog({
  directions,
  initialDirection,
  target,
  userTables = [],
  onApply,
  onCancel,
}: ConvertDialogProps) {
  const { t } = useI18n();
  const [direction, setDirection] = useState(initialDirection);
  const [skip, setSkip] = useState<string[]>([]);
  const [applyTables, setApplyTables] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ConvertPreview | null>(null);

  const scopeLabel = target.scope === 'all' ? t(CONVERT.scopeAll) : t(CONVERT.scopeSelection);

  const buildRequest = (): ConvertRequest => ({
    text: target.text,
    direction,
    skipInside: BRACKET_PRESETS.filter((preset) => skip.includes(preset.label)).map(
      (preset) => ({ open: preset.open, close: preset.close }),
    ),
    applyUserTables: applyTables,
    diagnostics,
  });

  const toggleTable = (name: string) => {
    invalidate();
    setApplyTables((prev) =>
      prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name],
    );
  };

  /** 任何配置变化都让已有预览失效 */
  const invalidate = () => setPreview(null);

  const toggleSkip = (label: string) => {
    invalidate();
    setSkip((prev) => (prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label]));
  };

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewConvert(buildRequest()));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const runApply = async () => {
    setBusy(true);
    setError(null);
    try {
      if (preview) {
        onApply(preview.text, preview.ambiguities, preview.changedCount);
      } else {
        const report = await convertOpencc(buildRequest());
        onApply(report.text, report.ambiguities, report.changedCount);
      }
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog-wide" role="dialog" aria-modal="true">
        <h3 className="dialog-title">{t(CONVERT.title)}</h3>
        <p className="dialog-text">
          {t(CONVERT.scopeLabel)}
          <strong>{scopeLabel}</strong>
          <span className="dialog-hint">
            {fill(t(CONVERT.charCount), { count: target.text.length })}
          </span>
        </p>

        <div className="dialog-row">
          <label htmlFor="convert-direction">{t(CONVERT.direction)}</label>
          <select
            id="convert-direction"
            value={direction}
            disabled={busy}
            onChange={(e) => {
              invalidate();
              setDirection(e.target.value);
            }}
          >
            {directions.map((item) => (
              <option key={item.id} value={item.id}>
                {t(item.label)}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="dialog-fieldset">
          <legend>{t(CONVERT.bracketLegend)}</legend>
          <div className="bracket-grid">
            {BRACKET_PRESETS.map((preset) => (
              <label key={preset.label} className="bracket-item">
                <input
                  type="checkbox"
                  checked={skip.includes(preset.label)}
                  disabled={busy}
                  onChange={() => toggleSkip(preset.label)}
                />
                {preset.label}
              </label>
            ))}
          </div>
        </fieldset>

        {userTables.length > 0 && (
          <fieldset className="dialog-fieldset">
            <legend>{t(CONVERT.tableLegend)}</legend>
            <div className="bracket-grid">
              {userTables.map((table) => (
                <label key={table.path} className="bracket-item" title={table.description}>
                  <input
                    type="checkbox"
                    checked={applyTables.includes(table.name)}
                    disabled={busy}
                    onChange={() => toggleTable(table.name)}
                  />
                  {/* 表名是用户数据，不翻译（PRD §3.6 L-3） */}
                  {table.name}
                  {table.builtin && <span className="table-badge">{t(CONVERT.builtin)}</span>}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <label className="dialog-row dialog-check">
          <input
            type="checkbox"
            checked={diagnostics}
            disabled={busy}
            onChange={(e) => {
              invalidate();
              setDiagnostics(e.target.checked);
            }}
          />
          {t(CONVERT.diagnostics)}
        </label>

        {/* 后端错误文案：Rust 侧已按语言输出（PRD L-5），这里原样显示 */}
        {error && <div className="dialog-error">{error}</div>}

        {preview && (
          <div className="convert-preview">
            <div className="convert-preview-head">
              {preview.lines.length === 0
                ? t(CONVERT.emptyPreview)
                : fill(t(CONVERT.diffSummary), {
                    changed: preview.changedLines,
                    total: preview.totalLines,
                    count: preview.changedCount,
                  })}
              {preview.truncated && (
                <span className="dialog-hint">{t(CONVERT.truncated)}</span>
              )}
            </div>
            <div className="diff-list">
              {preview.lines.map((line) => (
                <div key={line.lineNumber} className="diff-line">
                  <span className="diff-no">{line.lineNumber}</span>
                  <div className="diff-old">- {renderHighlighted(line.old, line.oldRange)}</div>
                  <div className="diff-new">+ {renderHighlighted(line.new, line.newRange)}</div>
                </div>
              ))}
            </div>
            {preview.ambiguities.length > 0 && <AmbiguityList spans={preview.ambiguities} />}
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" onClick={runPreview} disabled={busy}>
            {t(CONVERT.preview)}
          </button>
          <button type="button" className="dialog-primary" onClick={runApply} disabled={busy}>
            {t(CONVERT.apply)}
          </button>
          <button type="button" className="dialog-cancel" onClick={onCancel} disabled={busy}>
            {t(COMMON.cancel)}
          </button>
        </div>
      </div>
    </div>
  );
}
