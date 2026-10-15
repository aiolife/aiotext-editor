/**
 * 「整理 → 文本整理工具」菜单（F-09 §6.2）
 *
 * 18 个工具按后端目录的分组顺序铺开：
 * - 带选项的工具（`hasOptions`）尾部显示「…」，点击打开选项对话框；
 * - 纯检查型工具（匹配括号）标注「仅检查」，不改写正文；
 * - 其余工具点一下即以**默认选项**应用到整篇（或选区）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PipelineStep, ToolId, ToolMeta } from '../platform/tauriApi';

interface ToolMenuProps {
  tools: ToolMeta[];
  disabled: boolean;
  /** 直接应用（无选项工具 / 快捷入口） */
  onRun: (step: PipelineStep) => void;
  /** 打开选项对话框（带选项的工具） */
  onConfigure: (meta: ToolMeta) => void;
  /** 工具栏快捷按钮（常用工具） */
  shortcuts?: ToolId[];
}

export function ToolMenu({
  tools,
  disabled,
  onRun,
  onConfigure,
  shortcuts = [],
}: ToolMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点击菜单外部 → 收起
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // 按目录顺序分组（不重新排序，菜单顺序 = 后端 catalog 顺序）
  const groups = useMemo(() => {
    const out: { name: string; items: ToolMeta[] }[] = [];
    for (const tool of tools) {
      const last = out[out.length - 1];
      if (last && last.name === tool.group) {
        last.items.push(tool);
      } else {
        out.push({ name: tool.group, items: [tool] });
      }
    }
    return out;
  }, [tools]);

  const shortcutTools = shortcuts
    .map((id) => tools.find((tool) => tool.id === id))
    .filter((tool): tool is ToolMeta => Boolean(tool));

  const empty = groups.length === 0;

  return (
    <div className="menu-root" ref={rootRef}>
      <button
        type="button"
        className="menu-trigger"
        disabled={disabled || empty}
        aria-haspopup="menu"
        aria-expanded={open}
        title="文本整理工具（F-09）"
        onClick={() => setOpen((v) => !v)}
      >
        整理 ▾
      </button>

      {open && (
        <div className="menu-panel menu-panel-wide" role="menu">
          {shortcutTools.length > 0 && (
            <>
              <div className="menu-group-title">常用</div>
              <div className="menu-shortcuts">
                {shortcutTools.map((tool) => (
                  <button
                    key={`shortcut-${tool.id}`}
                    type="button"
                    role="menuitem"
                    className="menu-item menu-item-inline"
                    title={tool.hint}
                    onClick={() => {
                      setOpen(false);
                      onRun({ kind: tool.id });
                    }}
                  >
                    {tool.label}
                  </button>
                ))}
              </div>
              <div className="menu-sep" />
            </>
          )}

          {groups.map((group, index) => (
            <div key={group.name}>
              {index > 0 && <div className="menu-sep" />}
              <div className="menu-group-title">{group.name}</div>
              {group.items.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  title={tool.hint}
                  onClick={() => {
                    setOpen(false);
                    if (tool.hasOptions) {
                      onConfigure(tool);
                    } else {
                      onRun({ kind: tool.id });
                    }
                  }}
                >
                  <span className="menu-item-label">{tool.label}</span>
                  {tool.inspectsOnly && <span className="menu-item-badge">仅检查</span>}
                  {tool.hasOptions && <span className="menu-item-more">…</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
