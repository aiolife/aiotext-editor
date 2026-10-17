/**
 * 状态栏（F-01 §1.2 / 阶段二任务 5：编码、行尾、BOM、光标、计数）
 *
 * v0.7：右侧的计数由「N 字符（M 码元）」改成 **汉字 / 单词数 / 字节数**——
 * 用户实际看校对数据时关心的是这三项，码点数 / UTF-16 码元是给调试看的。
 */
import type { EditorTab } from '../store/tabsStore';
import { countTextStats } from '../shared/textStats';

interface StatusBarProps {
  tab: EditorTab | null;
}

export function StatusBar({ tab }: StatusBarProps) {
  if (!tab) {
    return (
      <footer className="app-statusbar">
        <span>就绪</span>
      </footer>
    );
  }
  // 口径与「视图 → 字数统计」完全一致（同一个 countTextStats）
  const stats = countTextStats(tab.content);
  return (
    <footer className="app-statusbar">
      <span title={tab.filePath ?? '尚未保存到磁盘'}>
        {tab.filePath ?? '未保存'}
      </span>
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
        汉字 {stats.chineseChars} · 单词 {stats.words} · {stats.bytes} 字节
      </span>
      {tab.dirty && <span className="statusbar-dirty">● 未保存</span>}
    </footer>
  );
}
