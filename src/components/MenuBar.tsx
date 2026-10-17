/**
 * 顶栏菜单栏：`文件 / 编辑 / 功能 / 视图 / 帮助` 五个**纯文字**菜单（PRD v0.5 §3.5）。
 *
 * 「功能」是照 `04-ui-ux §2.5` 的形态还原的：**常用 6 个转换方向直接点**（不套二级菜单），
 * 其余 11 种收进 `其他转换 ▸`；18 个整理工具按后端 catalog 的顺序分 4 组铺在菜单下半部分。
 *
 * ## 为什么菜单项不各自写死行为
 *
 * 凡是注册在 `COMMANDS` 里的动作，一律从 `handlers`（命令分发器）与 `bindings`
 * （当前键位）里现取标签、键位提示和可用性——与快捷键走的是**同一份数据**。
 * 于是「菜单里显示 Ctrl+Shift+A」和「真的按 Ctrl+Shift+A」不可能各说各话，
 * 用户改过键位后菜单也随之变化（§3.5 T-3），按钮时代的 `disabled` 条件
 * 也由命令自己的 `enabled()` 原样保留（§3.5 T-4）。
 *
 * 非命令动作（比较 / 合并 / 批处理 / 转换 / 整理）没有对应的快捷键命令，
 * 由 `actions` 直接注入。
 */
import { useEffect, useRef, useState } from 'react';
import { commandById, formatKey } from '../shared/shortcuts';
import type { AppearanceSettings, OpenccDirectionMeta, PipelineStep, ToolMeta } from '../platform/tauriApi';

/** 命令 id → 处理函数（与 `App` 的命令分发器同构） */
export interface MenuHandlers {
  [id: string]: { run: () => void; enabled?: () => boolean };
}

export interface MenuBarProps {
  handlers: MenuHandlers;
  /** 命令 id → 当前生效绑定；`key` 为 null 表示未绑定 */
  bindings: Map<string, { key: string | null }>;
  appearance: AppearanceSettings;
  /** 自动换行的当前勾选态（在「编辑器」设置分组下，F-11） */
  wrap: boolean;
  directions: OpenccDirectionMeta[];
  tools: ToolMeta[];
  convertDisabled: boolean;
  toolDisabled: boolean;
  compareDisabled: boolean;
  actions: {
    convert: (directionId: string) => void;
    convertDialog: () => void;
    tables: () => void;
    runTool: (step: PipelineStep) => void;
    configureTool: (meta: ToolMeta) => void;
    compare: () => void;
    merge: () => void;
    batch: () => void;
    /** 恢复默认设置（原「设置 ▾」里的同名片项） */
    resetSettings: () => void;
  };
}

/** 整理工具按 catalog 的分组顺序聚拢（不重排：菜单顺序 = 后端目录顺序） */
function groupTools(tools: ToolMeta[]): { name: string; items: ToolMeta[] }[] {
  const out: { name: string; items: ToolMeta[] }[] = [];
  for (const tool of tools) {
    const last = out[out.length - 1];
    if (last && last.name === tool.group) last.items.push(tool);
    else out.push({ name: tool.group, items: [tool] });
  }
  return out;
}

export function MenuBar({
  handlers,
  bindings,
  appearance,
  wrap,
  directions,
  tools,
  convertDisabled,
  toolDisabled,
  compareDisabled,
  actions,
}: MenuBarProps) {
  const [open, setOpen] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  // 点菜单外部 / Esc 收起
  useEffect(() => {
    if (open === null) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  /** 所有菜单项的统一出口：先收起，再执行 */
  const fire = (run: () => void) => {
    setOpen(null);
    run();
  };

  const accelOf = (id: string): string | null => {
    const key = bindings.get(id)?.key;
    return key ? formatKey(key) : null;
  };

  const enabledOf = (id: string): boolean => handlers[id]?.enabled?.() ?? true;

  /** 命令项：标签 / 键位 / 可用性全部现取，不写死 */
  const commandItem = (id: string, labelOverride?: string) => {
    const handler = handlers[id];
    const label = labelOverride ?? commandById(id)?.label ?? id;
    return (
      <button
        key={id}
        type="button"
        role="menuitem"
        className="menu-item menu-item-row"
        disabled={handler === undefined || !enabledOf(id)}
        onClick={() => fire(() => handler?.run())}
      >
        <span className="menu-item-label">{label}</span>
        <span className="menu-item-more">{accelOf(id) ?? ''}</span>
      </button>
    );
  };

  /** 勾选型命令（菜单栏 / 状态栏 / 行号） */
  const checkItem = (id: string, label: string, checked: boolean) => {
    const handler = handlers[id];
    return (
      <button
        key={id}
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        className="menu-item menu-item-row"
        disabled={handler === undefined || !enabledOf(id)}
        onClick={() => fire(() => handler?.run())}
      >
        <span className="menu-item-check" aria-hidden="true">
          {checked ? '✓' : ''}
        </span>
        <span className="menu-item-label">{label}</span>
        <span className="menu-item-more">{accelOf(id) ?? ''}</span>
      </button>
    );
  };

  /** 无快捷键命令的普通项（比较 / 合并 / 批处理 / 转换方向 / 整理工具） */
  const plainItem = (
    key: string,
    label: string,
    enabled: boolean,
    run: () => void,
    extra?: { badge?: string; more?: string; hint?: string },
  ) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      className="menu-item menu-item-row"
      disabled={!enabled}
      title={extra?.hint}
      onClick={() => fire(run)}
    >
      <span className="menu-item-label">{label}</span>
      {extra?.badge ? <span className="menu-item-badge">{extra.badge}</span> : null}
      {extra?.more ? <span className="menu-item-more">{extra.more}</span> : null}
    </button>
  );

  // PRD v0.5 §3.5：引擎只提供 6 种方向（其余已从 Rust 的 Direction 枚举删除），直接点用
  const toolGroups = groupTools(tools);

  // ---------- 文件 ----------

  const fileMenu = (
    <>
      {commandItem('file.new')}
      {commandItem('file.open')}
      <div className="menu-sep" />
      {commandItem('file.save')}
      {commandItem('file.saveAs')}
      {commandItem('file.saveAll')}
      <div className="menu-sep" />
      {commandItem('file.close')}
      {commandItem('file.closeOthers')}
      {commandItem('file.closeAll')}
      <div className="menu-sep" />
      {commandItem('file.reload')}
    </>
  );

  // ---------- 编辑 ----------

  const editMenu = (
    <>
      {commandItem('search.find')}
      {commandItem('search.replace')}
      {plainItem('convert-tables', '替换表管理…', !convertDisabled, actions.tables)}
      <div className="menu-sep" />
      {plainItem('compare', '比较…', !compareDisabled, actions.compare, {
        hint: '平铺比较两份文本（F-06）：F5 跳差异，Shift+F5 从光标重比',
      })}
      {plainItem('merge', '合并文件…', !toolDisabled, actions.merge)}
      {plainItem('batch', '批处理…', !toolDisabled, actions.batch, {
        hint: '批量运行整理流水线（F-08）：目录 + 步骤 + 备份 + 进度',
      })}
    </>
  );

  // ---------- 功能 ----------

  /**
   * 转换方向项。常用 6 个**直接点**（不再套一层二级菜单）；
   * 其中 `s2t` / `t2s` 有默认键位，右侧照样按用户当前绑定显示。
   */
  const directionItem = (direction: OpenccDirectionMeta) =>
    plainItem(direction.id, direction.label, !convertDisabled, () => actions.convert(direction.id), {
      more: accelOf(`convert.${direction.id}`) ?? undefined,
    });

  const funcMenu = (
    <>
      {directions.map(directionItem)}
      <div className="menu-sep" />
      {plainItem('convert-dialog', '转换预览…', !convertDisabled, actions.convertDialog)}
      <div className="menu-sep" />
      {/* 18 个工具：按后端 catalog 的顺序分 4 组，组间分隔线（不重排） */}
      {toolGroups.map((group, index) => (
        <div key={group.name}>
          {index > 0 && <div className="menu-sep" />}
          <div className="menu-group-title">{group.name}</div>
          {group.items.map((tool) =>
            plainItem(
              tool.id,
              tool.label,
              !toolDisabled,
              () => (tool.hasOptions ? actions.configureTool(tool) : actions.runTool({ kind: tool.id })),
              {
                badge: tool.inspectsOnly ? '仅检查' : undefined,
                more: tool.hasOptions ? '…' : undefined,
                hint: tool.hint,
              },
            ),
          )}
        </div>
      ))}
    </>
  );

  // ---------- 视图 ----------

  const viewMenu = (
    <>
      {checkItem('view.toggleToolbar', '菜单栏', appearance.showToolbar)}
      {checkItem('view.toggleStatusBar', '状态栏', appearance.showStatusBar)}
      {checkItem('view.toggleLineNumber', '行号', appearance.showLineNumber)}
      {checkItem('view.toggleWrap', '自动换行', wrap)}
      <div className="menu-sep" />
      {commandItem('view.theme', '切换主题')}
      <div className="menu-sep" />
      {commandItem('settings.open')}
      {commandItem('settings.shortcuts')}
      <div className="menu-sep" />
      {plainItem('reset-settings', '恢复默认设置', true, actions.resetSettings)}
    </>
  );

  // ---------- 帮助 ----------

  const helpMenu = <>{commandItem('help.open')}</>;

  const menus: { id: string; label: string; panel: React.ReactNode; wide?: boolean }[] = [
    { id: 'file', label: '文件', panel: fileMenu },
    { id: 'edit', label: '编辑', panel: editMenu },
    // 功能菜单装 6 个转换方向 + 18 个工具，是最长的一个 → 限高滚动
    { id: 'func', label: '功能', panel: funcMenu, wide: true },
    { id: 'view', label: '视图', panel: viewMenu },
    { id: 'help', label: '帮助', panel: helpMenu },
  ];

  return (
    <nav className="menubar" ref={rootRef} aria-label="主菜单">
      {menus.map((menu) => (
        <div className="menu-root" key={menu.id}>
          <button
            type="button"
            className="menubar-trigger"
            aria-haspopup="menu"
            aria-expanded={open === menu.id}
            onClick={() => setOpen(open === menu.id ? null : menu.id)}
            // 已经展开时，鼠标划过别的菜单直接切过去（与原生菜单栏一致）
            onMouseEnter={() => {
              if (open !== null && open !== menu.id) setOpen(menu.id);
            }}
          >
            {menu.label}
          </button>
          {open === menu.id ? (
            <div className={menu.wide ? 'menu-panel menu-panel-wide' : 'menu-panel'} role="menu">
              {menu.panel}
            </div>
          ) : null}
        </div>
      ))}
    </nav>
  );
}
