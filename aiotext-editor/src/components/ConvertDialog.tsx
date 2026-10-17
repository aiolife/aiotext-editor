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
  const shown = spans.slice(0, 50);
  return (
    <div className="ambiguity-list">
      <div className="menu-group-title">
        歧义片段 {spans.length} 处（其他地区标准在此用字不同）
      </div>
      <ul>
        {shown.map((span, index) => (
          <li key={`${span.start}-${index}`}>
            <code>{span.primary || '（空）'}</code>
            <span className="ambiguity-alt"> ← {span.candidates.join(' / ') || '（空）'}</span>
            <span className="dialog-hint"> 位置 {span.start}</span>
          </li>
        ))}
      </ul>
      {spans.length > shown.length && (
        <div className="dialog-hint">仅列出前 {shown.length} 处</div>
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
  const [direction, setDirection] = useState(initialDirection);
  const [skip, setSkip] = useState<string[]>([]);
  const [applyTables, setApplyTables] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ConvertPreview | null>(null);

  const scopeLabel = target.scope === 'all' ? '整篇' : '选中文本';

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
        <h3 className="dialog-title">简繁转换</h3>
        <p className="dialog-text">
          转换范围：<strong>{scopeLabel}</strong>
          <span className="dialog-hint">（{target.text.length} 字符）</span>
        </p>

        <div className="dialog-row">
          <label htmlFor="convert-direction">转换方向</label>
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
                {item.label}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="dialog-fieldset">
          <legend>括号对豁免（范围内的字符不参与转换）</legend>
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
            <legend>叠加用户替换表（F-04 模式 B：交给 OpenCC 内联词典，先勾选者优先）</legend>
            <div className="bracket-grid">
              {userTables.map((table) => (
                <label key={table.path} className="bracket-item" title={table.description}>
                  <input
                    type="checkbox"
                    checked={applyTables.includes(table.name)}
                    disabled={busy}
                    onChange={() => toggleTable(table.name)}
                  />
                  {table.name}
                  {table.builtin && <span className="table-badge">内置</span>}
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
          歧义片段诊断（列出其他地区标准用字不同的位置）
        </label>

        {error && <div className="dialog-error">{error}</div>}

        {preview && (
          <div className="convert-preview">
            <div className="convert-preview-head">
              {preview.lines.length === 0
                ? '没有可转换的内容'
                : `差异 ${preview.changedLines} / ${preview.totalLines} 行 · 变更 ${preview.changedCount} 字符`}
              {preview.truncated && <span className="dialog-hint">（仅显示前 200 个差异行）</span>}
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
            预览差异
          </button>
          <button type="button" className="dialog-primary" onClick={runApply} disabled={busy}>
            应用转换
          </button>
          <button type="button" className="dialog-cancel" onClick={onCancel} disabled={busy}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
