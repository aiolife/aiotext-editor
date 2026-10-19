/**
 * 比较模式工具条（F-06 §6.2）：差异计数 + 上一处 / 下一处 / 从光标重比 / 退出。
 * 状态栏位于其下方，两者共同承担「状态栏提示」职责。
 */
import type { DiffBlock, DiffResult } from '../platform/tauriApi';
import {
  diffStats,
  paneRole,
  previewText,
  type ComparePane,
} from '../shared/compareView';

interface CompareBarProps {
  result: DiffResult | null;
  /** 当前定位的差异下标（无则 -1） */
  index: number;
  /** 哪一格是当前目标窗（可编辑的那一侧） */
  target: ComparePane;
  aName: string;
  bName: string;
  /** 两侧正文，用来抄出当前那一处的原文片段 */
  contentA: string;
  contentB: string;
  onPrev: () => void;
  onNext: () => void;
  /** 从两个窗格当前光标处重新比较（重选同步起点） */
  onRestart: () => void;
  onExit: () => void;
}

/** 片段里的换行画成符号，免得把工具条撑高 */
function inline(value: string): string {
  return value.replace(/\n/g, '␊');
}

function quote(value: string): string {
  return value === '' ? '（无）' : `『${inline(value)}』`;
}

/** 当前那一处两侧的原文（缺/多的一侧就是「（无）」） */
function currentLabel(
  current: DiffBlock | null,
  target: ComparePane,
  contentA: string,
  contentB: string,
): string {
  if (!current) {
    return '';
  }
  const a = previewText(contentA, current.posA, current.posA + current.lenA);
  const b = previewText(contentB, current.posB, current.posB + current.lenB);
  return `${paneRole('a', target)}${quote(a)} ↔ ${paneRole('b', target)}${quote(b)}`;
}

/**
 * 站在目标窗立场的统计（借鉴 DiffChecker 那条「新增 / 删除 / 修改」的统计栏）。
 * 降级与截断不许藏着 —— 算不准就说算不准。
 */
function summary(result: DiffResult, target: ComparePane): string {
  if (result.blocks.length === 0) {
    return result.degraded ? '文本过大，未能完整比较' : '两文一致';
  }
  const { added, missing } = diffStats(result.blocks, target);
  const parts = [`共 ${result.blocks.length} 处`, `新增 ${added} 字`, `缺失 ${missing} 字`];
  if (result.truncated) {
    parts.push('差异过多已截断');
  }
  if (result.degraded) {
    parts.push('文本过大，未完整比较');
  }
  return parts.join(' · ');
}

export function CompareBar({
  result,
  index,
  target,
  aName,
  bName,
  contentA,
  contentB,
  onPrev,
  onNext,
  onRestart,
  onExit,
}: CompareBarProps) {
  const total = result?.blocks.length ?? 0;
  const current: DiffBlock | null = result?.blocks[index] ?? null;
  const hasPrev = index > 0;
  const hasNext = result !== null && index < total - 1;

  return (
    <div className="compare-bar">
      <div className="compare-bar-head">
        <strong>比较中</strong>
        <span>
          {paneRole('a', target)}「{aName}」 ↔ {paneRole('b', target)}「{bName}」
        </span>
      </div>
      <div className="compare-bar-status">
        {result === null ? (
          <span>正在比较…</span>
        ) : (
          <span>
            {current ? `第 ${index + 1}/${total} 处：${currentLabel(current, target, contentA, contentB)}` : null}
            {current ? ' · ' : null}
            {summary(result, target)}
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
