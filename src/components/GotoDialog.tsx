/**
 * 「编辑 → 跳转」对话框（PRD v0.6：输入行号跳到那一行）
 *
 * 只是把行号夹到 `1..total` 后交给 App：真正的滚动定位在 `Editor` 里做
 * （那里才有 CodeMirror 的 view），对话框不碰编辑器内部。
 */
import { useState } from 'react';
import { useI18n } from '../shared/i18n';
import { GOTO } from '../shared/i18n/dialogs';
import { COMMON } from '../shared/i18n/common';
import { fill } from '../shared/i18n/status';

interface GotoDialogProps {
  /** 当前光标所在行（作为输入框初值） */
  currentLine: number;
  /** 文档总行数（用于校验与提示） */
  totalLines: number;
  onConfirm: (line: number) => void;
  onCancel: () => void;
}

export function GotoDialog({ currentLine, totalLines, onConfirm, onCancel }: GotoDialogProps) {
  const { t } = useI18n();
  const [value, setValue] = useState(String(currentLine));
  const parsed = Number(value);
  const valid = value.trim() !== '' && Number.isInteger(parsed) && parsed >= 1 && parsed <= totalLines;

  function handleSubmit() {
    if (!valid) return;
    onConfirm(parsed);
  }

  return (
    <div className="dialog-overlay" role="presentation">
      <div className="dialog dialog-narrow" role="dialog" aria-label={t(GOTO.title)}>
        <h2 className="dialog-title">{t(GOTO.title)}</h2>
        <label className="dialog-row">
          {fill(t(GOTO.label), { total: totalLines })}
          <input
            type="number"
            min={1}
            max={totalLines}
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit();
              if (e.key === 'Escape') onCancel();
            }}
          />
        </label>
        {!valid && value.trim() !== '' ? (
          <p className="dialog-error">{fill(t(GOTO.invalid), { total: totalLines })}</p>
        ) : null}
        <div className="dialog-actions">
          <button className="dialog-primary" onClick={handleSubmit} disabled={!valid}>
            {t(GOTO.go)}
          </button>
          <button className="dialog-cancel" onClick={onCancel}>
            {t(COMMON.cancel)}
          </button>
        </div>
      </div>
    </div>
  );
}
