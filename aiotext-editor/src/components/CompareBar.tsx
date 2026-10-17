/**
 * 比较模式工具条（F-06 §6.2）：差异计数 + 上一处 / 下一处 / 从光标重比 / 退出。
 * 状态栏位于其下方，两者共同承担「状态栏提示」职责。
 */
import type { CompareDifference, CompareReport } from '../platform/tauriApi';

interface CompareBarProps {
  report: CompareReport | null;
  /** 当前定位的差异下标（无则 -1） */
  index: number;
  aName: string;
  bName: string;
  onPrev: () => void;
  onNext: () => void;
  /** 从两个窗格当前光标处重新比较（重选同步起点） */
  onRestart: () => void;
  onExit: () => void;
}

function charLabel(value: string | null): string {
  if (value === null) {
    return '（已到尾部）';
  }
  return value === '\n' ? '␊' : value;
}

function endHint(report: CompareReport | null): string {
  if (!report) {
    return '';
  }
  if (report.end === 'aEnded') {
    return `A 窗先到尾部，B 窗还剩 ${report.remainingB} 字`;
  }
  if (report.end === 'bEnded') {
    return `B 窗先到尾部，A 窗还剩 ${report.remainingA} 字`;
  }
  if (report.end === 'truncated') {
    return `差异过多，仅显示前 ${report.differences.length} 处`;
  }
  return '双方同时到尾部，比较完成';
}

export function CompareBar({
  report,
  index,
  aName,
  bName,
  onPrev,
  onNext,
  onRestart,
  onExit,
}: CompareBarProps) {
  const total = report?.differences.length ?? 0;
  const current: CompareDifference | null = report?.differences[index] ?? null;
  const hasPrev = index > 0;
  const hasNext = report !== null && index < total - 1;

  return (
    <div className="compare-bar">
      <div className="compare-bar-head">
        <strong>比较中</strong>
        <span>
          A「{aName}」 ↔ B「{bName}」
        </span>
      </div>
      <div className="compare-bar-status">
        {report === null ? (
          <span>正在比较…</span>
        ) : total === 0 ? (
          <span>未发现不一致（{endHint(report)}）</span>
        ) : (
          <span>
            差异 {index + 1}/{total}
            {current ? (
              <>：A『{charLabel(current.charA)}』↔ B『{charLabel(current.charB)}』</>
            ) : null}
            {report.truncated ? '（已截断）' : ''} · {endHint(report)}
          </span>
        )}
      </div>
      <div className="compare-bar-actions">
        <button onClick={onPrev} disabled={!hasPrev} title="上一处不一致">
          上一处
        </button>
        <button onClick={onNext} disabled={!hasNext} title="下一处不一致（F5）">
          下一处
        </button>
        <button onClick={onRestart} title="从两个光标处重新比较（Shift+F5）">
          从光标重比
        </button>
        <button onClick={onExit}>退出比较</button>
      </div>
    </div>
  );
}
