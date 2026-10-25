/**
 * 不可编码字符决策弹窗（F-02 §2.2：保存为非 Unicode 编码前的预检交互）
 *
 * 三选：以数字字符引用写出 / 改存 UTF-8（带 BOM）/ 取消。
 */
import type { UnmappableChar } from '../platform/tauriApi';
import { useI18n } from '../shared/i18n';
import { UNMAPPABLE } from '../shared/i18n/dialogs';
import { COMMON } from '../shared/i18n/common';
import { fill } from '../shared/i18n/status';

interface UnmappableDialogProps {
  encoding: string;
  unmappable: UnmappableChar[];
  onDecide: (decision: 'charref' | 'toutf8' | null) => void;
}

/** 弹窗内最多展示的字符数（其余以省略号汇总） */
const MAX_SHOWN = 12;

export function UnmappableDialog({ encoding, unmappable, onDecide }: UnmappableDialogProps) {
  const { t } = useI18n();
  const shown = unmappable.slice(0, MAX_SHOWN);
  const rest = unmappable.length - shown.length;
  // 编码名是用户数据（编码 id 的显示名），只做填充、不过 t
  const enc = encoding.toUpperCase();
  return (
    <div className="dialog-overlay" role="presentation">
      <div className="dialog" role="alertdialog" aria-label={t(UNMAPPABLE.a11y)}>
        <h2 className="dialog-title">{fill(t(UNMAPPABLE.title), { encoding: enc })}</h2>
        <p className="dialog-text">
          {fill(t(UNMAPPABLE.text), { count: unmappable.length, encoding: enc })}
        </p>
        <div className="dialog-chars">
          {shown.map((u, i) => (
            <span key={`${u.position}-${i}`} className="dialog-char">
              {u.character}
              <small>U+{u.character.codePointAt(0)?.toString(16).toUpperCase()}</small>
            </span>
          ))}
          {rest > 0 && (
            <span className="dialog-char dialog-char-more">
              {fill(t(UNMAPPABLE.more), { count: rest })}
            </span>
          )}
        </div>
        <p className="dialog-text dialog-hint">{t(UNMAPPABLE.hint)}</p>
        <div className="dialog-actions">
          <button onClick={() => onDecide('charref')}>{t(UNMAPPABLE.saveCharref)}</button>
          <button onClick={() => onDecide('toutf8')}>{t(UNMAPPABLE.saveUtf8)}</button>
          <button className="dialog-cancel" onClick={() => onDecide(null)}>
            {t(COMMON.cancel)}
          </button>
        </div>
      </div>
    </div>
  );
}
