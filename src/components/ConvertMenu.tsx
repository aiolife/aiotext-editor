/**
 * 「功能 → 简繁转换」菜单（F-03 §3.2）
 *
 * 顶级列出 6 个常用方向，其余方向收进「其他转换」二级菜单；
 * 末项「转换预览…」打开可配置的转换对话框。
 */
import { useEffect, useRef, useState } from 'react';
import type { OpenccDirectionMeta } from '../platform/tauriApi';

interface ConvertMenuProps {
  directions: OpenccDirectionMeta[];
  disabled: boolean;
  /** 直接执行某方向的转换（快捷入口） */
  onPick: (directionId: string) => void;
  /** 打开转换对话框（可选方向 / 括号对豁免 / 诊断 / 预览） */
  onOpenDialog: () => void;
  /** 打开替换表管理（F-04） */
  onOpenTables: () => void;
}

export function ConvertMenu({
  directions,
  disabled,
  onPick,
  onOpenDialog,
  onOpenTables,
}: ConvertMenuProps) {
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

  const common = directions.filter((d) => d.common);
  const others = directions.filter((d) => !d.common);

  const pick = (id: string) => {
    setOpen(false);
    onPick(id);
  };

  return (
    <div className="menu-root" ref={rootRef}>
      <button
        type="button"
        className="menu-trigger"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        功能 ▾
      </button>

      {open && (
        <div className="menu-panel" role="menu">
          <div className="menu-group-title">简繁转换</div>
          {common.map((direction) => (
            <button
              key={direction.id}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => pick(direction.id)}
            >
              {direction.label}
            </button>
          ))}

          <div className="menu-sub">
            <button type="button" role="menuitem" className="menu-item menu-item-sub" aria-haspopup="menu">
              其他转换 ▸
            </button>
            <div className="menu-sub-panel" role="menu">
              {others.map((direction) => (
                <button
                  key={direction.id}
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => pick(direction.id)}
                >
                  {direction.label}
                </button>
              ))}
            </div>
          </div>

          <div className="menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onOpenDialog();
            }}
          >
            转换预览…
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onOpenTables();
            }}
          >
            替换表管理…
          </button>
        </div>
      )}
    </div>
  );
}
