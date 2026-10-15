/**
 * 多标签栏（F-01 §1.2：标签 + 未保存圆点 + 关闭按钮）
 */
import type { EditorTab } from '../store/tabsStore';

interface TabBarProps {
  tabs: EditorTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

export function TabBar({ tabs, activeTabId, onActivate, onClose }: TabBarProps) {
  if (tabs.length === 0) return null;
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeTabId}
          className={`tabbar-item${tab.id === activeTabId ? ' is-active' : ''}`}
          onMouseDown={(e) => {
            // 中键（按键 1）点击关闭
            if (e.button === 1) {
              e.preventDefault();
              onClose(tab.id);
            } else {
              onActivate(tab.id);
            }
          }}
        >
          {tab.dirty && <span className="tabbar-dot" title="已修改，未保存" />}
          <span className="tabbar-label" title={tab.filePath ?? tab.fileName}>
            {tab.fileName}
          </span>
          <button
            className="tabbar-close"
            aria-label={`关闭 ${tab.fileName}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
