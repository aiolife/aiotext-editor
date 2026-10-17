/**
 * 状态栏（F-01 §1.2 / 阶段二任务 5：编码、行尾、BOM、光标、字符数）
 */
import type { EditorTab } from '../store/tabsStore';
import { countChars } from '../shared/countChars';

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
  const stats = countChars(tab.content);
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
      <span className="statusbar-right">
        {stats.codePoints} 字符（{stats.utf16Units} 码元）
      </span>
      {tab.dirty && <span className="statusbar-dirty">● 未保存</span>}
    </footer>
  );
}
