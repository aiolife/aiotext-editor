/**
 * Toast 渲染容器（第九阶段）
 *
 * 订阅 [`useToastStore`] 的队列，在右下角堆叠显示；每条自己管一个自动关闭定时器。
 * 挂在 `App` 根部（`z-index` 高于对话框遮罩），所以**对话框里的提示也看得见**。
 *
 * 无障碍：容器 `aria-live="polite"`；`error` 级别的条目用 `role="alert"`
 * （读屏会立刻播报），其余用 `role="status"`。
 */
import { useEffect } from 'react';
import { useToastStore, type ToastItem } from '../store/toastStore';

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    if (item.timeoutMs <= 0) return;
    const timer = window.setTimeout(() => dismiss(item.id), item.timeoutMs);
    return () => window.clearTimeout(timer);
  }, [item.id, item.timeoutMs, dismiss]);

  return (
    <div
      className={`toast toast-${item.level}`}
      role={item.level === 'error' ? 'alert' : 'status'}
      data-level={item.level}
    >
      <span className="toast-text">{item.message}</span>
      <button className="toast-close" aria-label="关闭提示" onClick={() => dismiss(item.id)}>
        ×
      </button>
    </div>
  );
}

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </div>
  );
}
