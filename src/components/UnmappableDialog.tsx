/**
 * 不可编码字符决策弹窗（F-02 §2.2：保存为非 Unicode 编码前的预检交互）
 *
 * 三选：以数字字符引用写出 / 改存 UTF-8（带 BOM）/ 取消。
 */
import type { UnmappableChar } from '../platform/tauriApi';

interface UnmappableDialogProps {
  encoding: string;
  unmappable: UnmappableChar[];
  onDecide: (decision: 'charref' | 'toutf8' | null) => void;
}

/** 弹窗内最多展示的字符数（其余以省略号汇总） */
const MAX_SHOWN = 12;

export function UnmappableDialog({ encoding, unmappable, onDecide }: UnmappableDialogProps) {
  const shown = unmappable.slice(0, MAX_SHOWN);
  const rest = unmappable.length - shown.length;
  return (
    <div className="dialog-overlay" role="presentation">
      <div className="dialog" role="alertdialog" aria-label="存在不可编码字符">
        <h2 className="dialog-title">无法以 {encoding.toUpperCase()} 编码保存</h2>
        <p className="dialog-text">
          文本中有 {unmappable.length} 个字符无法编码为{' '}
          {encoding.toUpperCase()}：
        </p>
        <div className="dialog-chars">
          {shown.map((u, i) => (
            <span key={`${u.position}-${i}`} className="dialog-char">
              {u.character}
              <small>U+{u.character.codePointAt(0)?.toString(16).toUpperCase()}</small>
            </span>
          ))}
          {rest > 0 && <span className="dialog-char dialog-char-more">…等 {rest} 个</span>}
        </div>
        <p className="dialog-text dialog-hint">
          按 WHATWG 标准，数字字符引用（&#xNNNN;）以纯文本写出，读回该文件的
          工具可还原原字；改存 UTF-8 则无此问题。
        </p>
        <div className="dialog-actions">
          <button onClick={() => onDecide('charref')}>
            以数字字符引用保存
          </button>
          <button onClick={() => onDecide('toutf8')}>改存 UTF-8（带 BOM）</button>
          <button className="dialog-cancel" onClick={() => onDecide(null)}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
