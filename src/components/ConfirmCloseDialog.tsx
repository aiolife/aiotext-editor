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

export type CloseDecision = 'save' | 'discard' | 'cancel';

interface ConfirmCloseDialogProps {
  /** 待关闭且未保存的标签（快照：关闭过程中内容不该再变） */
  tabs: EditorTab[];
  onDecide: (decision: CloseDecision) => void;
}

/** 汇总列表最多展示的标签数（其余以「…等 N 个」收尾） */
const MAX_SHOWN = 8;

export function ConfirmCloseDialog({ tabs, onDecide }: ConfirmCloseDialogProps) {
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
      <div className="dialog" role="alertdialog" aria-label="存在未保存的修改">
        <h2 className="dialog-title">
          {multiple ? `有 ${tabs.length} 个文件尚未保存` : '有未保存的修改'}
        </h2>

        {multiple ? (
          <ul className="dialog-list">
            {shown.map((t) => (
              <li key={t.id}>{t.fileName}</li>
            ))}
            {rest > 0 && <li className="dialog-list-more">…等 {rest} 个</li>}
          </ul>
        ) : (
          <p className="dialog-text">「{tabs[0].fileName}」的修改还没有保存到磁盘。</p>
        )}

        <p className="dialog-text dialog-hint">
          {multiple
            ? '「全部保存」会逐个保存（没有保存位置的文件会询问路径），保存成功的才会关闭。'
            : '「不保存」会丢弃此次修改，且下次启动不会恢复。'}
        </p>

        <div className="dialog-actions">
          <button className="dialog-primary" onClick={() => onDecide('save')}>
            {multiple ? '全部保存' : '保存'}
          </button>
          <button className="dialog-danger" onClick={() => onDecide('discard')}>
            {multiple ? '全部不保存' : '不保存'}
          </button>
          {/* 默认焦点落在「取消」：手滑按下的空格 / 回车不会造成任何不可逆后果 */}
          <button className="dialog-cancel" autoFocus onClick={() => onDecide('cancel')}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
