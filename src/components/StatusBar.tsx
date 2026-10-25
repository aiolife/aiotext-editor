/**
 * 状态栏（F-01 §1.2 / 阶段二任务 5：编码、行尾、BOM、光标、计数）
 *
 * v0.7：右侧的计数由「N 字符（M 码元）」改成 **汉字 / 单词数 / 字节数**——
 * 用户实际看校对数据时关心的是这三项，码点数 / UTF-16 码元是给调试看的。
 */
import { useDeferredValue, useMemo } from 'react';
import type { EditorTab } from '../store/tabsStore';
import { countTextStats, type TextStats } from '../shared/textStats';
import { useI18n } from '../shared/i18n';
import { STATUS, fill } from '../shared/i18n/status';

interface StatusBarProps {
  tab: EditorTab | null;
  /** 垂直选择（列编辑）当前矩形；不在模式里为 null */
  columnRect: { rows: number; cols: number } | null;
}

/**
 * 超过这个规模就不在每次渲染里算了——改用 React 的延迟值，让数字滞后一帧、
 * 把 CPU 让给正在打字的人。
 *
 * 阈值取 20 万字符：`countTextStats` 在这个量级大约几毫秒，
 * 仍在「一帧怎么都够用」的范围里，没必要让数字迟钝。
 */
const INSTANT_LIMIT = 200_000;

/** 全文统计：小文档就地算，大文档延迟算（口径与「视图 → 字数统计」同一个函数） */
function useFullTextStats(content: string): TextStats {
  const deferred = useDeferredValue(content);
  return useMemo(
    () => countTextStats(content.length <= INSTANT_LIMIT ? content : deferred),
    [content, deferred],
  );
}

export function StatusBar({ tab, columnRect }: StatusBarProps) {
  const { t } = useI18n();
  // hook 不能放在下面的提前 return 之后，所以先按可能为空的内容取出来
  const stats = useFullTextStats(tab?.content ?? '');
  if (!tab) {
    return (
      <footer className="app-statusbar">
        <span>{t(STATUS.ready)}</span>
      </footer>
    );
  }
  return (
    <footer className="app-statusbar">
      <span title={tab.filePath ?? t(STATUS.notSavedToDisk)}>
        {tab.filePath ?? t(STATUS.unsavedShort)}
      </span>
      <span>{fill(t(STATUS.encoding), { value: tab.encoding.toUpperCase() })}</span>
      <span>{fill(t(STATUS.lineEnding), { value: tab.lineEnding.toUpperCase() })}</span>
      <span>{fill(t(STATUS.bom), { value: tab.hadBom ? t(STATUS.yes) : t(STATUS.no) })}</span>
      <span>{fill(t(STATUS.rowCol), { line: tab.cursorLine, col: tab.cursorColumn })}</span>
      {columnRect && (
        <span className="statusbar-column" title={t(STATUS.columnHint)}>
          {fill(t(STATUS.columnSize), { rows: columnRect.rows, cols: columnRect.cols })}
        </span>
      )}
      <span
        className="statusbar-right"
        title={fill(t(STATUS.statsTitle), {
          chinese: stats.chineseChars,
          words: stats.words,
          bytes: stats.bytes,
        })}
      >
        {/* 顺序与「视图 → 字数统计」里的一致；标题里放一份带单位的完整说明 */}
        {fill(t(STATUS.stats), {
          chinese: stats.chineseChars,
          words: stats.words,
          bytes: stats.bytes,
        })}
      </span>
      {tab.dirty && <span className="statusbar-dirty">{t(STATUS.dirty)}</span>}
    </footer>
  );
}
