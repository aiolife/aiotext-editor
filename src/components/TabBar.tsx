/**
 * 多标签栏（F-01 §1.2：标签 + 未保存圆点 + 关闭按钮；
 * PRD v0.3 §3.4 / 04-ui-ux §4.1：右键菜单、双击关闭）
 */
import { useEffect, useRef, useState } from 'react';
import type { EditorTab } from '../store/tabsStore';

interface TabBarProps {
  tabs: EditorTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** 关闭除该标签外的全部标签 */
  onCloseOthers: (id: string) => void;
  /** 关闭全部标签 */
  onCloseAll: () => void;
  onSave: (id: string) => void;
  onSaveAs: (id: string) => void;
}

/** 右键菜单：作用在哪个标签上、以及弹出位置（视口坐标） */
interface MenuState {
  tabId: string;
  x: number;
  y: number;
}

export function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  onSave,
  onSaveAs,
}: TabBarProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 点击菜单外部 / Esc → 收起
  useEffect(() => {
    if (!menu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  if (tabs.length === 0) return null;

  const run = (fn: (id: string) => void, id: string) => {
    setMenu(null);
    fn(id);
  };

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
          // 04-ui-ux §4.1：双击标签 = 关闭
          onDoubleClick={(e) => {
            e.preventDefault();
            onClose(tab.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
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

      {menu && (
        <div
          ref={menuRef}
          className="menu-panel tabbar-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
        >
          <button type="button" role="menuitem" className="menu-item" onClick={() => run(onClose, menu.tabId)}>
            关闭
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => run(onCloseOthers, menu.tabId)}
          >
            关闭其他标签
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setMenu(null);
              onCloseAll();
            }}
          >
            全部关闭
          </button>
          <div className="menu-sep" />
          <button type="button" role="menuitem" className="menu-item" onClick={() => run(onSave, menu.tabId)}>
            保存
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => run(onSaveAs, menu.tabId)}
          >
            另存为…
          </button>
        </div>
      )}
    </div>
  );
}
