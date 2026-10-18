/**
 * 状态栏（F-01 §1.2 / 阶段二任务 5：编码、行尾、BOM、光标、计数）
 *
 * v0.7：右侧的计数由「N 字符（M 码元）」改成 **汉字 / 单词数 / 字节数**——
 * 用户实际看校对数据时关心的是这三项，码点数 / UTF-16 码元是给调试看的。
 */
import { useDeferredValue, useMemo } from 'react';
import type { EditorTab } from '../store/tabsStore';
import { countTextStats, type TextStats } from '../shared/textStats';

interface StatusBarProps {
  tab: EditorTab | null;
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

export function StatusBar({ tab }: StatusBarProps) {
  // hook 不能放在下面的提前 return 之后，所以先按可能为空的内容取出来
  const stats = useFullTextStats(tab?.content ?? '');
  if (!tab) {
    return (
      <footer className="app-statusbar">
        <span>就绪</span>
      </footer>
    );
  }
  return (
    <footer className="app-statusbar">
      <span title={tab.filePath ?? '尚未保存到磁盘'}>{tab.filePath ?? '未保存'}</span>
      <span>编码：{tab.encoding.toUpperCase()}</span>
      <span>行尾：{tab.lineEnding.toUpperCase()}</span>
      <span>BOM：{tab.hadBom ? '有' : '无'}</span>
      <span>
        行 {tab.cursorLine}，列 {tab.cursorColumn}
      </span>
      <span
        className="statusbar-right"
        title={`汉字 ${stats.chineseChars} · 单词 ${stats.words} · ${stats.bytes} 字节（UTF-8）`}
      >
        {/* 顺序与「视图 → 字数统计」里的一致；标题里放一份带单位的完整说明 */}
        汉字 {stats.chineseChars} · 单词 {stats.words} · {stats.bytes} 字节
      </span>
      {tab.dirty && <span className="statusbar-dirty">● 未保存</span>}
    </footer>
  );
}
