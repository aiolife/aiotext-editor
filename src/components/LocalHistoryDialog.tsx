/**
 * 本地历史面板（PRD §3.12）
 *
 * 时间线 → 对比 → 恢复。diff 复用后端 `compare_diff` 的**字符级**结果，
 * 双栏直接按 `DiffBlock` 的 UTF-16 偏移取两侧片段（React 的 textContent
 * 天然转义，不会把 Markdown 内容当 HTML 注入）。
 * 恢复只回编辑器内存并标 dirty，磁盘文件不变；恢复前服务层会先留一条存档。
 */
import { useEffect, useState } from 'react';
import { fill } from '../shared/i18n/status';
import { t } from '../shared/i18n';
import { LOCAL_HISTORY } from '../shared/i18n/localHistory';
import { triggerLabel } from '../shared/localHistory';
import { useLocalHistoryStore, type LocalHistoryDiff } from '../store/localHistoryStore';
import { toast } from '../store/toastStore';

interface Props {
  onClose: () => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** 所有 IPC 失败统一走 toast，不让任何一条 Promise 静默 unhandled */
function report(e: unknown): void {
  toast.error(e instanceof Error ? e.message : String(e));
}

export function LocalHistoryDialog({ onClose }: Props) {
  const state = useLocalHistoryStore();
  const [diff, setDiff] = useState<LocalHistoryDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [clearArm, setClearArm] = useState<'doc' | 'all' | null>(null);

  useEffect(() => {
    // 顺带把上次异常退出的草稿补记成一条快照，再刷新时间线
    void useLocalHistoryStore.getState().absorbEmergency().catch(report);
  }, []);

  const compare = async (id: string) => {
    setBusy(true);
    try {
      const view = await useLocalHistoryStore.getState().diffWithCurrent(id);
      setDiff(view);
      useLocalHistoryStore.getState().setSelected(id);
    } catch (e) {
      setDiff(null);
      report(e);
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async (id: string) => {
    setBusy(true);
    try {
      await useLocalHistoryStore.getState().restore(id);
      toast.success(t(LOCAL_HISTORY.restoreNotice));
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  const armClear = (kind: 'doc' | 'all') => {
    if (clearArm !== kind) {
      setClearArm(kind);
      return;
    }
    setClearArm(null);
    const task =
      kind === 'doc'
        ? state.path
          ? useLocalHistoryStore.getState().clearFor([state.path])
          : Promise.resolve([])
        : useLocalHistoryStore.getState().clearAll();
    void task.then(() => setDiff(null)).catch(report);
  };

  return (
    <div className="dialog-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog lh-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t(LOCAL_HISTORY.title)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="lh-header">
          <span className="lh-title">{t(LOCAL_HISTORY.title)}</span>
          <button type="button" className="lh-close" onClick={onClose}>
            {t(LOCAL_HISTORY.close)}
          </button>
        </div>

        {!state.enabled ? (
          <p className="lh-note">{t(LOCAL_HISTORY.disabled)}</p>
        ) : !state.path ? (
          <p className="lh-note">{t(LOCAL_HISTORY.noFile)}</p>
        ) : (
          <>
            <div className="lh-toolbar">
              <span className="lh-path" title={state.path}>
                {state.path}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void useLocalHistoryStore
                    .getState()
                    .capture('manual')
                    .then(() => useLocalHistoryStore.getState().refresh())
                    .catch(report);
                }}
              >
                {t(LOCAL_HISTORY.capture)}
              </button>
            </div>

            <div className="lh-list">
              {state.loading && <p className="lh-note">…</p>}
              {state.error && <p className="lh-note lh-error">{state.error}</p>}
              {!state.loading && state.items.length === 0 && (
                <p className="lh-note">{t(LOCAL_HISTORY.noSnapshots)}</p>
              )}
              {[...state.items].reverse().map((item) => (
                <div
                  className={`lh-item${state.selectedId === item.id ? ' lh-item-selected' : ''}`}
                  key={item.id}
                >
                  <span className="lh-time">{formatTime(item.ts)}</span>
                  <span className="lh-label">{t(item.label ?? triggerLabel(item.trigger))}</span>
                  <span className={`lh-badge${item.committed ? ' lh-badge-committed' : ''}`}>
                    {t(item.committed ? LOCAL_HISTORY.committed : LOCAL_HISTORY.uncommitted)}
                  </span>
                  {item.pinned && <span className="lh-pinned">★</span>}
                  <button type="button" disabled={busy} onClick={() => void compare(item.id)}>
                    {t(LOCAL_HISTORY.compare)}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void useLocalHistoryStore.getState().pin(item.id, !item.pinned).catch(report)
                    }
                  >
                    {t(item.pinned ? LOCAL_HISTORY.unpin : LOCAL_HISTORY.pin)}
                  </button>
                  <button type="button" disabled={busy} onClick={() => void doRestore(item.id)}>
                    {t(LOCAL_HISTORY.restore)}
                  </button>
                </div>
              ))}
            </div>

            {diff && (
              <div className="lh-diff">
                <div className="lh-diff-meta">
                  {diff.result.blocks.length === 0
                    ? t(LOCAL_HISTORY.noDiff)
                    : fill(t(LOCAL_HISTORY.diffCount), {
                        count: String(diff.result.blocks.length),
                      })}
                  {diff.result.truncated && ` · ${t(LOCAL_HISTORY.truncated)}`}
                  {diff.result.degraded && ` · ${t(LOCAL_HISTORY.degraded)}`}
                </div>
                <div className="lh-diff-head">
                  <span>{t(LOCAL_HISTORY.snapshotSide)}</span>
                  <span>{t(LOCAL_HISTORY.currentSide)}</span>
                </div>
                <div className="lh-diff-body">
                  {diff.result.blocks.slice(0, 200).map((block, index) => (
                    // 差异块按文中顺序排列，位置即稳定 key
                    <div className="lh-diff-row" key={`${block.posA}-${block.posB}-${index}`}>
                      <span className="lh-diff-old">
                        {diff.snapshot.slice(block.posA, block.posA + block.lenA) || ' '}
                      </span>
                      <span className="lh-diff-new">
                        {diff.current.slice(block.posB, block.posB + block.lenB) || ' '}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="dialog-actions lh-footer">
              {clearArm && <span className="lh-confirm">{t(LOCAL_HISTORY.confirmClear)}</span>}
              <button type="button" onClick={() => armClear('doc')} disabled={busy}>
                {t(LOCAL_HISTORY.clearDoc)}
              </button>
              <button type="button" onClick={() => armClear('all')} disabled={busy}>
                {t(LOCAL_HISTORY.clearAll)}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
