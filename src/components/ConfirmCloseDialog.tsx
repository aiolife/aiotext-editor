/**
 * 关闭确认对话框（PRD v0.3 §3.4 C-1 / C-6）
 *
 * 三选：**保存** / **不保存** / **取消**。
 *
 * 单个文件时按文件名措辞；多个文件（关闭其他 / 全部关闭）时**一次汇总**
 * 而不是逐个连弹——十几个脏标签连弹十几次，用户会机械地一路点掉，
 * 反而比一次问清更容易误丢内容。
 */
import { useEffect } from 'react';
import type { EditorTab } from '../store/tabsStore';
import { useI18n } from '../shared/i18n';
import { CONFIRM_CLOSE } from '../shared/i18n/dialogs';
import { COMMON } from '../shared/i18n/common';
import { fill } from '../shared/i18n/status';

export type CloseDecision = 'save' | 'discard' | 'cancel';

interface ConfirmCloseDialogProps {
  /** 待关闭且未保存的标签（快照：关闭过程中内容不该再变） */
  tabs: EditorTab[];
  onDecide: (decision: CloseDecision) => void;
}

/** 汇总列表最多展示的标签数（其余以「…等 N 个」收尾） */
const MAX_SHOWN = 8;

export function ConfirmCloseDialog({ tabs, onDecide }: ConfirmCloseDialogProps) {
  const { t } = useI18n();
  const multiple = tabs.length > 1;
  const shown = tabs.slice(0, MAX_SHOWN);
  const rest = tabs.length - shown.length;

  // Esc = 取消：与「取消」同为安全出口，不用鼠标也能退出
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDecide('cancel');
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onDecide]);

  return (
    <div className="dialog-overlay" role="presentation">
      <div className="dialog" role="alertdialog" aria-label={t(CONFIRM_CLOSE.a11y)}>
        <h2 className="dialog-title">
          {multiple
            ? fill(t(CONFIRM_CLOSE.titleMultiple), { count: tabs.length })
            : t(CONFIRM_CLOSE.titleSingle)}
        </h2>

        {multiple ? (
          <ul className="dialog-list">
            {shown.map((tab) => (
              <li key={tab.id}>{tab.fileName}</li>
            ))}
            {rest > 0 && (
              <li className="dialog-list-more">
                {fill(t(CONFIRM_CLOSE.more), { count: rest })}
              </li>
            )}
          </ul>
        ) : (
          // 文件名是用户数据，只做拼接、不过 t
          <p className="dialog-text">
            {fill(t(CONFIRM_CLOSE.textSingle), { name: tabs[0].fileName })}
          </p>
        )}

        <p className="dialog-text dialog-hint">
          {multiple ? t(CONFIRM_CLOSE.hintMultiple) : t(CONFIRM_CLOSE.hintSingle)}
        </p>

        <div className="dialog-actions">
          <button className="dialog-primary" onClick={() => onDecide('save')}>
            {multiple ? t(CONFIRM_CLOSE.saveAll) : t(CONFIRM_CLOSE.save)}
          </button>
          <button className="dialog-danger" onClick={() => onDecide('discard')}>
            {multiple ? t(CONFIRM_CLOSE.discardAll) : t(CONFIRM_CLOSE.discard)}
          </button>
          {/* 默认焦点落在「取消」：手滑按下的空格 / 回车不会造成任何不可逆后果 */}
          <button className="dialog-cancel" autoFocus onClick={() => onDecide('cancel')}>
            {t(COMMON.cancel)}
          </button>
        </div>
      </div>
    </div>
  );
}
