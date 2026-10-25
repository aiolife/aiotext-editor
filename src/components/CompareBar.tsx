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
import { useI18n } from '../shared/i18n';
import { COMPARE } from '../shared/i18n/compare';
import { fill } from '../shared/i18n/status';

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

/**
 * 这两个函数拼出来的都是**界面文案**，所以 `t` 要传进来。
 * 不能返回拼好的整句再交给 `t` —— 文案表里存的是模板，拼好的句子查不到原文。
 */
function quote(value: string, t: (text: string) => string): string {
  return value === '' ? t(COMPARE.none) : `『${inline(value)}』`;
}

/** 当前那一处两侧的原文（缺/多的一侧就是「（无）」） */
function currentLabel(
  current: DiffBlock | null,
  target: ComparePane,
  contentA: string,
  contentB: string,
  t: (text: string) => string,
): string {
  if (!current) {
    return '';
  }
  const a = previewText(contentA, current.posA, current.posA + current.lenA);
  const b = previewText(contentB, current.posB, current.posB + current.lenB);
  return fill(t(COMPARE.detail), {
    a: t(paneRole('a', target)),
    aQuote: quote(a, t),
    b: t(paneRole('b', target)),
    bQuote: quote(b, t),
  });
}

/**
 * 站在目标窗立场的统计（借鉴 DiffChecker 那条「新增 / 删除 / 修改」的统计栏）。
 * 降级与截断不许藏着 —— 算不准就说算不准。
 */
function summary(result: DiffResult, target: ComparePane, t: (text: string) => string): string {
  if (result.blocks.length === 0) {
    return result.degraded ? t(COMPARE.degradedEmpty) : t(COMPARE.identical);
  }
  const { added, missing } = diffStats(result.blocks, target);
  const parts = [
    fill(t(COMPARE.total), { count: result.blocks.length }),
    fill(t(COMPARE.added), { count: added }),
    fill(t(COMPARE.missing), { count: missing }),
  ];
  if (result.truncated) {
    parts.push(t(COMPARE.truncated));
  }
  if (result.degraded) {
    parts.push(t(COMPARE.degraded));
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
  const { t } = useI18n();
  const total = result?.blocks.length ?? 0;
  const current: DiffBlock | null = result?.blocks[index] ?? null;
  const hasPrev = index > 0;
  const hasNext = result !== null && index < total - 1;

  return (
    <div className="compare-bar">
      <div className="compare-bar-head">
        <strong>{t(COMPARE.comparing)}</strong>
        {/* 文件名是用户数据，只填充不翻译（PRD §3.6 L-3） */}
        <span>
          {fill(t(COMPARE.panes), {
            a: t(paneRole('a', target)),
            aName,
            b: t(paneRole('b', target)),
            bName,
          })}
        </span>
      </div>
      <div className="compare-bar-status">
        {result === null ? (
          <span>{t(COMPARE.comparingProgress)}</span>
        ) : (
          <span>
            {current
              ? fill(t(COMPARE.position), {
                  index: index + 1,
                  total,
                  detail: currentLabel(current, target, contentA, contentB, t),
                })
              : null}
            {current ? ' · ' : null}
            {summary(result, target, t)}
          </span>
        )}
      </div>
      <div className="compare-bar-actions">
        <button onClick={onPrev} disabled={!hasPrev} title={t(COMPARE.prevTitle)}>
          {t(COMPARE.prev)}
        </button>
        <button onClick={onNext} disabled={!hasNext} title={t(COMPARE.nextTitle)}>
          {t(COMPARE.next)}
        </button>
        <button onClick={onRestart} title={t(COMPARE.restartTitle)}>
          {t(COMPARE.restart)}
        </button>
        <button onClick={onExit}>{t(COMPARE.exit)}</button>
      </div>
    </div>
  );
}
