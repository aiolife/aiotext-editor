/**
 * 「重新载入」对话框（F-02 §2.2 手选编码；阶段二任务 6）
 *
 * 用所选编码重新从磁盘读取并替换当前标签内容（放弃未保存修改）。
 */
import { useState } from 'react';
import { ENCODING_OPTIONS } from '../platform/tauriApi';
import type { EditorTab } from '../store/tabsStore';

interface ReloadDialogProps {
  tab: EditorTab;
  onConfirm: (encodingLabel: string) => Promise<void>;
  onCancel: () => void;
}

export function ReloadDialog({ tab, onConfirm, onCancel }: ReloadDialogProps) {
  const [encoding, setEncoding] = useState(tab.encoding);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(encoding);
    } catch (e) {
      setError(String(e));
      setBusy(false); // 失败保留对话框供重试
      return;
    }
  }

  return (
    <div className="dialog-overlay" role="presentation">
      <div className="dialog" role="dialog" aria-label="重新载入文件">
        <h2 className="dialog-title">重新载入</h2>
        <p className="dialog-text">
          以指定编码重新读取「{tab.fileName}」。
          {tab.dirty && (
            <strong className="dialog-warn">当前有未保存的修改，重载后将丢失。</strong>
          )}
        </p>
        <label className="dialog-row">
          编码：
          <select
            value={encoding}
            onChange={(e) => setEncoding(e.target.value)}
            autoFocus
          >
            {ENCODING_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="dialog-error">读取失败：{error}</p>}
        <div className="dialog-actions">
          <button onClick={handleConfirm} disabled={busy}>
            {busy ? '读取中…' : '重载'}
          </button>
          <button onClick={onCancel} disabled={busy}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
