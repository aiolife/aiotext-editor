/**
 * 顶栏菜单栏：`文件 / 编辑 / 简繁 / 排版 / 视图 / 帮助` 六个**纯文字**菜单（PRD v0.5 §3.5）。
 *
 * 「简繁」只装简繁转换（6 个方向直接点，不套二级菜单）与「转换预览…」；
 * 「排版」装文本整理：v0.9 起是 5 个排版类工具 + 6 个高频直点项，
 * 更早那 18 个细项收进了「规范标点 / 片段处理」的选项里。
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
import { useI18n } from '../shared/i18n';
import { MENU_A11Y, MENU_MISC, MENU_TOP } from '../shared/i18n/menu';
import { ENCODING_CONVERT_TARGETS, REOPEN_ENCODINGS } from '../platform/tauriApi';
import type {
  AppearanceSettings,
  OpenccDirectionMeta,
  PipelineStep,
  TableMeta,
  ToolMeta,
} from '../platform/tauriApi';

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
  /** 垂直选择（列编辑）模式是否开着 —— 影响菜单项的勾选态 */
  columnMode: boolean;
  directions: OpenccDirectionMeta[];
  tools: ToolMeta[];
  /** 用户替换表清单（「编辑 → 自定义替换 ▸」的二级菜单项） */
  tables: TableMeta[];
  /** 有活动标签（自定义替换只需要正文） */
  hasActiveTab: boolean;
  /** 活动标签已关联磁盘文件（重新载入 / 编码转换的前提） */
  hasFilePath: boolean;
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
    /** 文件 → 编码转换（按目标编码重写当前文件） */
    convertEncoding: (encodingLabel: string) => void;
    /** 文件 → 重新载入（按指定编码重读当前文件；null = 自动探测，弹原有的选择对话框） */
    reloadWith: (encodingLabel: string | null) => void;
    /** 编辑 → 自定义替换（用指定表替换当前正文） */
    applyTable: (tableName: string) => void;
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
  columnMode,
  directions,
  tools,
  tables,
  hasActiveTab,
  hasFilePath,
  convertDisabled,
  toolDisabled,
  compareDisabled,
  actions,
}: MenuBarProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  /** 当前展开的二级菜单（键为 submenuItem 的 key） */
  const [subOpen, setSubOpen] = useState<string | null>(null);
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

  /** 所有菜单项的统一出口：先收起（含二级菜单），再执行 */
  const fire = (run: () => void) => {
    setOpen(null);
    setSubOpen(null);
    run();
  };

  const accelOf = (id: string): string | null => {
    const key = bindings.get(id)?.key;
    if (key) return formatKey(key);
    // 该命令的键位实际由编辑器（CodeMirror）处理、默认不参与分发，
    // 菜单照样把键位显示出来（否则看着像「没有快捷键」）。
    const display = commandById(id)?.displayKey;
    return display ? formatKey(display) : null;
  };

  const enabledOf = (id: string): boolean => handlers[id]?.enabled?.() ?? true;

  /** 命令项：标签 / 键位 / 可用性全部现取，不写死 */
  const commandItem = (id: string, labelOverride?: string, hint?: string) => {
    const handler = handlers[id];
    // 命令名来自 `COMMANDS`，那份数据已参与批量转繁體，这里过一遍 t 即可
    const label = labelOverride ?? t(commandById(id)?.label ?? id);
    return (
      <button
        key={id}
        type="button"
        role="menuitem"
        className="menu-item menu-item-row"
        disabled={handler === undefined || !enabledOf(id)}
        title={hint}
        onClick={() => fire(() => handler?.run())}
      >
        <span className="menu-item-label">{label}</span>
        <span className="menu-item-more">{accelOf(id) ?? ''}</span>
      </button>
    );
  };

  /** 勾选型命令（菜单栏 / 状态栏 / 行号）；`hint` 是鼠标悬停时的用法说明 */
  const checkItem = (id: string, label: string, checked: boolean, hint?: string) => {
    const handler = handlers[id];
    const labelText = t(label);
    return (
      <button
        key={id}
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        className="menu-item menu-item-row"
        disabled={handler === undefined || !enabledOf(id)}
        title={hint}
        onClick={() => fire(() => handler?.run())}
      >
        <span className="menu-item-check" aria-hidden="true">
          {checked ? '✓' : ''}
        </span>
        <span className="menu-item-label">{labelText}</span>
        <span className="menu-item-more">{accelOf(id) ?? ''}</span>
      </button>
    );
  };

  /**
   * 带二级菜单的项（`文件 → 重新载入 ▸` / `编码转换 ▸`、`编辑 → 自定义替换 ▸`）。
   *
   * 鼠标划过展开、移出收起；整块（主项 + 子面板）共用一个 `menu-sub` 容器，
   * 所以从主项横移到子面板时不会误收起。
   */
  const submenuItem = (
    key: string,
    label: string,
    items: {
      key: string;
      label: string;
      run: () => void;
      disabled?: boolean;
      hint?: string;
      /** 右侧键位提示（「行互换 ▸」里的 Alt+↑ / Alt+↓ / Alt+S） */
      more?: string;
    }[],
    disabled = false,
  ) => (
    <div
      key={key}
      className="menu-sub"
      onMouseEnter={() => setSubOpen(key)}
      onMouseLeave={() => setSubOpen((cur) => (cur === key ? null : cur))}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={subOpen === key}
        className="menu-item menu-item-row"
        disabled={disabled}
        onClick={() => setSubOpen(subOpen === key ? null : key)}
      >
        <span className="menu-item-label">{label}</span>
        <span className="menu-item-more" aria-hidden="true">
          ▸
        </span>
      </button>
      {subOpen === key && !disabled ? (
        <div className="menu-sub-panel" role="menu">
          {items.length === 0 ? (
            <button type="button" role="menuitem" className="menu-item" disabled>
              （暂无）
            </button>
          ) : (
            items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className="menu-item menu-item-row"
                disabled={item.disabled}
                title={item.hint}
                onClick={() => fire(item.run)}
              >
                <span className="menu-item-label">{item.label}</span>
                <span className="menu-item-more">{item.more ?? ''}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );

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
      {/* 重新载入 ▸：第一项是原来的「自动探测…」（弹编码选择框），其后按指定编码硬重读 */}
      {submenuItem('file.reload-with', '重新载入', [
        {
          key: 'reload-auto',
          label: '自动探测…',
          disabled: !enabledOf('file.reload'),
          run: () => handlers['file.reload']?.run(),
        },
        ...REOPEN_ENCODINGS.map((enc) => ({
          key: `reload-${enc.value}`,
          label: enc.label,
          disabled: !hasFilePath,
          run: () => actions.reloadWith(enc.value),
        })),
      ])}
      {/* 编码转换 ▸：内容不动，按目标编码重写文件（GBK ⇄ BIG5 等任意互转） */}
      {submenuItem(
        'file.encoding-convert',
        '编码转换',
        ENCODING_CONVERT_TARGETS.map((enc) => ({
          key: `convert-enc-${enc.value}`,
          label: enc.label,
          disabled: !hasFilePath,
          run: () => actions.convertEncoding(enc.value),
        })),
      )}
    </>
  );

  // ---------- 编辑 ----------

  const editMenu = (
    <>
      {/* 撤销 / 重做走 Editor 的撤销历史（键盘由编辑器自己处理，这里只给菜单入口） */}
      {commandItem('edit.undo')}
      {commandItem('edit.redo')}
      <div className="menu-sep" />
      {commandItem('edit.goto')}
      <div className="menu-sep" />
      {commandItem('search.find')}
      {commandItem('search.replace')}
      {/* 自定义替换 ▸：直接列出「替换表管理」里的表名，点一下就对正文跑一张表 */}
      {submenuItem(
        'edit-custom-replace',
        '自定义替换',
        tables.map((table) => ({
          key: `apply-table-${table.name}`,
          label: table.name,
          disabled: !hasActiveTab,
          hint: table.builtin ? `内置示例表 · ${table.entryCount} 条` : `${table.entryCount} 条`,
          run: () => actions.applyTable(table.name),
        })),
      )}
      {plainItem('convert-tables', '替换表管理…', !convertDisabled, actions.tables)}
      <div className="menu-sep" />
      {checkItem(
        'edit.column',
        '列编辑（垂直选择）',
        columnMode,
        'Ctrl+Shift+F8 进入 / 退出垂直选择模式。按住 Alt 斜着拖鼠标可直接框出矩形（不必先进模式）；模式内 Ctrl+← / → 左右增减一个字符，Ctrl+↑ / ↓ 上下增减一行。进入时会自动关掉自动换行，退出时还原。',
      )}
      {submenuItem(
        'edit-swap-line',
        '行互换',
        [
          {
            key: 'edit.moveLineUp',
            label: '行上移',
            run: () => handlers['edit.moveLineUp']?.run(),
            disabled: !hasActiveTab,
            more: accelOf('edit.moveLineUp') ?? undefined,
          },
          {
            key: 'edit.moveLineDown',
            label: '行下移',
            run: () => handlers['edit.moveLineDown']?.run(),
            disabled: !hasActiveTab,
            more: accelOf('edit.moveLineDown') ?? undefined,
          },
          {
            key: 'edit.swapLineUp',
            label: '与上一行交换',
            run: () => handlers['edit.swapLineUp']?.run(),
            disabled: !hasActiveTab,
            hint: '把当前行整行与上一行对调（已在第一行时无动作）',
            more: accelOf('edit.swapLineUp') ?? undefined,
          },
        ],
        !hasActiveTab,
      )}
      <div className="menu-sep" />
      {commandItem('edit.insertTime', undefined, '在光标处插入当前时间（2026/10/22 15:30:45）')}
      {commandItem('edit.updateTime', undefined, '选区是时间戳就更新为当前时间，否则当作插入')}
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

  // ---------- 简繁 ----------

  /**
   * 转换方向项。6 个方向**直接点**（不套二级菜单）；
   * 其中 `s2t` / `t2s` 有默认键位，右侧照样按用户当前绑定显示。
   */
  const directionItem = (direction: OpenccDirectionMeta) =>
    plainItem(direction.id, direction.label, !convertDisabled, () => actions.convert(direction.id), {
      more: accelOf(`convert.${direction.id}`) ?? undefined,
    });

  const convertMenu = (
    <>
      {directions.map(directionItem)}
      <div className="menu-sep" />
      {plainItem('convert-dialog', '转换预览…', !convertDisabled, actions.convertDialog)}
    </>
  );

  // ---------- 排版 ----------

  /**
   * 排版菜单：5 个排版类工具 + 6 个高频直点项，顺序取自后端 catalog 的分组。
   *
   * v0.9 之前这里塞了 18 个细项，找功能要翻半天；现在细项收进了
   * 「规范标点 / 片段处理」的选项里，菜单只留下「一眼能找到」的入口。
   */
  const layoutMenu = (
    <>
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
      {/* 不可见字符的三个开关已移到「选项 → 编辑器」（默认勾选），菜单里留这三个统计项 */}
      {commandItem('doc.stats')}
      {commandItem('doc.countSelected')}
      {commandItem('doc.paragraphCount')}
      <div className="menu-sep" />
      {commandItem('view.theme', '切换主题')}
      <div className="menu-sep" />
      {commandItem('settings.open')}
      {commandItem('settings.shortcuts')}
      <div className="menu-sep" />
      {plainItem('reset-settings', t(MENU_MISC.resetSettings), true, actions.resetSettings)}
    </>
  );

  // ---------- 帮助 ----------

  const helpMenu = <>{commandItem('help.open')}</>;

  const menus: { id: string; label: string; panel: React.ReactNode; wide?: boolean }[] = [
    { id: 'file', label: t(MENU_TOP.file), panel: fileMenu },
    { id: 'edit', label: t(MENU_TOP.edit), panel: editMenu },
    { id: 'convert', label: t(MENU_TOP.convert), panel: convertMenu },
    // 排版菜单放 5 个排版工具 + 常用项，是最长的一个 → 限高滚动
    { id: 'layout', label: t(MENU_TOP.layout), panel: layoutMenu, wide: true },
    { id: 'view', label: t(MENU_TOP.view), panel: viewMenu },
    { id: 'help', label: t(MENU_TOP.help), panel: helpMenu },
  ];

  return (
    <nav className="menubar" ref={rootRef} aria-label={t(MENU_A11Y.mainMenu)}>
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
