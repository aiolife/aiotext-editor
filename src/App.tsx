/**
 * 应用骨架（第八阶段：偏好与快捷键）
 *
 * 工具栏 + 多标签 + CodeMirror + 状态栏；
 * 对话框：重新载入（手选编码）、不可编码字符决策、简繁转换（预览 Diff）、
 * 替换表管理（镜像编辑器 + 校验标红）、整理工具选项（实时预览）、
 * 文件比较（忽略项 + 异体字策略 + 平铺方向）、文件合并（手工 / 正则自动）、
 * 批处理（目录 + 步骤 + 进度）、选项（外观 / 编辑器 / 转换 / 比较 / 快捷键）；
 * 比较模式：A/B 双栏平铺，F5 跳下一处差异，Shift+F5 从两个光标处重比；
 * 查找/替换面板（中文增强正则 + 命中高亮 + 对命中套用整理工具）。
 * 所有 I/O / 转换 / 替换 / 查找 / 整理 / 比较 / 合并 / 设置经 platform/tauriApi → Tauri 命令 → core::*。
 *
 * ## 快捷键的唯一入口是命令分发器
 *
 * 原先「Ctrl+O/S/F」与「F5」各自挂了一个 `window` 监听、处理函数散在闭包里。
 * 第八阶段把它们收敛成一张**命令表**（`shared/shortcuts.ts` 的 `COMMANDS` 定义
 * 有哪些命令、默认键位是什么，本文件下方的 `handlers` 定义每个命令做什么）：
 * 按键先规范化成 `ctrl+s` 这样的键位串，再查用户覆盖表得到命令 ID。这样
 * 「自定义快捷键」才可能对**所有**命令生效——否则每加一个快捷键就要再写一个
 * 监听器，且用户改不了。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTabsStore, type EditorTab, type SaveDecision } from './store/tabsStore';
import { useSettingsStore } from './store/settingsStore';
import { countOccurrences, countTextStats } from './shared/textStats';
import { toast } from './store/toastStore';
import { ToastHost } from './components/ToastHost';
import type { SettingsTab } from './components/SettingsDialog';
import {
  buildIndex,
  findConflicts,
  formatKey,
  shouldHandleKey,
  keyFromEvent,
  resolveBindings,
} from './shared/shortcuts';
import {
  pickOpenFile,
  pickSaveFile,
  fsCheckMappable,
  isUnicodeEncoding,
  listOpenccDirections,
  convertOpencc,
  listReplaceTables,
  loadReplaceTable,
  applyReplace,
  ENCODING_OPTIONS,
  applyPipelineStep,
  pipelinesCatalog,
  compareDiff,
  fsRead,
  sessionLoad,
  sessionSave,
  startupMetrics,
  type AmbiguitySpan,
  type CompareOptions,
  type DiffBlock,
  type DiffResult,
  type OpenccDirectionMeta,
  type SessionState,
  type PipelineStep,
  type TableMeta,
  type ToolMeta,
  type UnmappableChar,
} from './platform/tauriApi';
import {
  Editor,
  type EditorCommand,
  type PendingEdit,
  type SearchHighlight,
  type SelectionRequest,
} from './components/Editor';
import { TabBar } from './components/TabBar';
import { StatusBar } from './components/StatusBar';
import { GotoDialog } from './components/GotoDialog';
import { StatDialog } from './components/StatDialog';
import { ReloadDialog } from './components/ReloadDialog';
import { UnmappableDialog } from './components/UnmappableDialog';
import { ConfirmCloseDialog, type CloseDecision } from './components/ConfirmCloseDialog';
import { MenuBar } from './components/MenuBar';
import type { ConvertTarget } from './components/ConvertDialog';
import { SearchPanel } from './components/SearchPanel';
import { ToolOptionsDialog } from './components/ToolOptionsDialog';
import { CompareBar } from './components/CompareBar';
import {
  paneRole,
  buildDiffMarks,
  diffStats,
  mapToOpposite,
  type PaneMarks,
} from './shared/compareView';
import { SELECTION_FILL_LIMIT } from './shared/findText';

/**
 * 对话框按需加载（v0.9 启动优化）
 *
 * 首屏只需要「菜单栏 + 多标签 + 编辑器 + 状态栏」，而这七个对话框（替换表编辑器、
 * 批处理、合并、比较、选项、帮助、转换预览）占了主包里 CodeMirror 之外的很大一块。
 * 打进同一个 chunk 的话，用户每次启动都要为「也许会打开的对话框」付解析与执行的钱。
 *
 * 拆出去之后：点开对话框时才去取对应 chunk（本地资源，几十毫秒级），
 * 首帧要解析的 JS 明显变少。**编辑器不拆**——它是启动后立刻要用的东西，
 * 拆了只会把「能打字」的时间点往后推。
 */
const HelpDialog = lazy(() =>
  import('./components/HelpDialog').then((m) => ({ default: m.HelpDialog })),
);
const SettingsDialog = lazy(() =>
  import('./components/SettingsDialog').then((m) => ({ default: m.SettingsDialog })),
);
const ConvertDialog = lazy(() =>
  import('./components/ConvertDialog').then((m) => ({ default: m.ConvertDialog })),
);
const ReplaceTableDialog = lazy(() =>
  import('./components/ReplaceTableDialog').then((m) => ({ default: m.ReplaceTableDialog })),
);
const CompareDialog = lazy(() =>
  import('./components/CompareDialog').then((m) => ({ default: m.CompareDialog })),
);
const MergeDialog = lazy(() =>
  import('./components/MergeDialog').then((m) => ({ default: m.MergeDialog })),
);
const BatchDialog = lazy(() =>
  import('./components/BatchDialog').then((m) => ({ default: m.BatchDialog })),
);

/**
 * 焦点是否落在「用户正在打字」的地方。
 *
 * `contenteditable` 要算进来——CodeMirror 的 `.cm-content` 就是它。是否让出
 * 按键由 [`shouldHandleKey`] 进一步判断（F 键在编辑区里仍归应用）。
 */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') {
    // 勾选框 / 单选 / 滑杆上的按键仍归应用（例如设置页里按 F5）
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].includes(
      type,
    );
  }
  return false;
}

/** 一条命令的处理方式；`enabled` 为假表示当前环境下不适用 */
interface CommandHandler {
  run: () => void;
  enabled?: () => boolean;
}

/** 主题循环顺序（与后端 `Theme::next` 一致：跟随系统 → 浅 → 深 → 跟随系统） */
const NEXT_THEME = { system: 'light', light: 'dark', dark: 'system' } as const;

/** 主题切换后的提示文案 */
const THEME_LABEL = { system: '跟随系统', light: '浅色', dark: '深色' } as const;

/**
 * 第九阶段：提示统一走全局 Toast 队列（可堆叠、有级别）。保留 `setError` /
 * `setNotice` 两个「旧接口」形状（空值 = 不提示），既有的几十处调用点无需改动。
 *
 * 放在**模块级**而不是组件内：它们不依赖任何组件状态，放外面既是稳定引用，
 * 也不必让几十处 `useCallback` / `useMemo` 的依赖数组都去列它们。
 */
const setError = (msg: string | null): void => {
  if (msg) toast.error(msg);
};
const setNotice = (msg: string | null): void => {
  if (msg) toast.success(msg);
};

/** 会话落盘防抖（连续打字 / 移动光标只在停顿时写一次） */
const SESSION_SAVE_DEBOUNCE_MS = 300;

/**
 * 把 store 里的标签整理成待落盘的会话（F-01 §1.2）。
 *
 * **正文按需保存**：只有「磁盘上没有这份内容」的标签才带正文（有未保存修改，
 * 或从未保存过）；已保存的标签只留路径，启动时从磁盘重读——文件可能已被外部
 * 改动，以磁盘为准，会话文件也不会被大文件撑爆。
 */
function toSessionState(tabs: EditorTab[], activeTabId: string | null): SessionState {
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      filePath: t.filePath,
      fileName: t.fileName,
      content: t.dirty || t.filePath === null ? t.content : null,
      encoding: t.encoding,
      lineEnding: t.lineEnding,
      hadBom: t.hadBom,
      dirty: t.dirty,
      cursorLine: t.cursorLine,
      cursorColumn: t.cursorColumn,
    })),
    activeTabId,
  };
}

interface UnmappableCtx {
  unmappable: UnmappableChar[];
  encoding: string;
  resolve: (decision: SaveDecision | null) => void;
}

/** 统计对话框的内容（字数统计 / 选定文字出现次数 / 段落数共用同一组件） */
interface StatCtx {
  title: string;
  subtitle?: string;
  rows: { label: string; value: string | number; hint?: string }[];
  note?: string;
  /** 两列排（`字数统计` 十几项，一列会超过屏幕高） */
  columns?: 1 | 2;
}

/** 关闭确认对话框的等待上下文（PRD v0.3 §3.4） */
interface CloseCtx {
  /** 待关闭且未保存的标签快照（弹窗期间不应再跟着编辑抖动） */
  tabs: EditorTab[];
  resolve: (decision: CloseDecision) => void;
}

/** 保存前预检结论 */
type Precheck =
  | { kind: 'proceed'; decision: SaveDecision | null } // null = 无不可编码，直接写出
  | { kind: 'cancel' }; // 用户取消保存

/** 转换对话框上下文（快照转换目标的标签，避免跨标签误写） */
interface ConvertDialogCtx {
  tabId: string;
  direction: string;
  target: ConvertTarget;
}

/** 比较会话的核心部分（两侧标签 + 当前目标窗） */
interface CompareCtx {
  aTabId: string;
  bTabId: string;
  /** 哪一格是当前可编辑的目标窗 */
  target: 'a' | 'b';
}

/** 整理工具选项对话框上下文（同样快照内容，避免跨标签误写） */
interface ToolDialogCtx {
  tabId: string;
  meta: ToolMeta;
  content: string;
  selection: { from: number; to: number } | null;
}

export default function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const openFile = useTabsStore((s) => s.openFile);
  const newTab = useTabsStore((s) => s.newTab);
  const restoreSession = useTabsStore((s) => s.restoreSession);
  const activateTab = useTabsStore((s) => s.activateTab);
  const closeTabs = useTabsStore((s) => s.closeTabs);
  const setContent = useTabsStore((s) => s.setContent);
  const setCursor = useTabsStore((s) => s.setCursor);
  const reloadWithEncoding = useTabsStore((s) => s.reloadWithEncoding);
  const saveTab = useTabsStore((s) => s.saveTab);
  const saveTabAs = useTabsStore((s) => s.saveTabAs);
  const reencode = useTabsStore((s) => s.reencode);

  const [busy, setBusy] = useState(false);
  const [reloadTabId, setReloadTabId] = useState<string | null>(null);
  const [unmappableCtx, setUnmappableCtx] = useState<UnmappableCtx | null>(null);
  const [closeCtx, setCloseCtx] = useState<CloseCtx | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  /** 外部编辑器命令（撤销 / 重做 / 跳转）——nonce 递增，连点同一个动作也要各执行一次 */
  const [editorCommand, setEditorCommand] = useState<EditorCommand | null>(null);
  /** 「编辑 → 跳转…」对话框 */
  const [gotoOpen, setGotoOpen] = useState(false);
  /** 统计结果（字数统计 / 选定文字出现次数 / 段落数共用一个对话框） */
  const [statCtx, setStatCtx] = useState<StatCtx | null>(null);
  const [selection, setSelection] = useState<{ tabId: string; from: number; to: number } | null>(
    null,
  );
  /**
   * 垂直选择（列编辑）模式是否开着 —— 菜单勾选与状态栏都读它。
   *
   * 既有 state 也有 ref：state 给渲染用，ref 给命令处理函数用。命令表是
   * `useMemo` 出来的，把 `columnMode` 列进依赖会让整张表随模式重建，不值当。
   */
  const [columnMode, setColumnMode] = useState(false);
  const columnModeRef = useRef(false);
  columnModeRef.current = columnMode;
  /** 模式里当前矩形的行列数（由编辑器同步上来，给状态栏显示） */
  const [columnRect, setColumnRect] = useState<{ rows: number; cols: number } | null>(null);
  /** 进入模式前的自动换行状态：进入时强制关掉，退出时按它还原 */
  const wrapBeforeColumnRef = useRef<boolean | null>(null);

  /** 编辑器 → App：垂直选择的状态同步（拖框也能进模式，所以由它说了算） */
  const handleVerticalState = useCallback(
    (state: { on: boolean; rows: number; cols: number }) => {
      columnModeRef.current = state.on;
      setColumnMode(state.on);
      setColumnRect(state.on ? { rows: state.rows, cols: state.cols } : null);
    },
    [],
  );
  /**
   * 最近这一次选区变更是不是「程序跳过去」造成的（查找下一个 / 跳差异）。
   *
   * 查找面板据此决定要不要把选中的文字回填进输入框 —— 若不分来源，
   * 用户敲好的替换词会被「跳到命中处时自动选中的那个词」顶掉。
   */
  const selectionByJumpRef = useRef(false);
  const handleSelectionChange = useCallback(
    (id: string, from: number, to: number, external?: boolean) => {
      selectionByJumpRef.current = external === true;
      setSelection({ tabId: id, from, to });
    },
    [],
  );
  const [convertDialog, setConvertDialog] = useState<ConvertDialogCtx | null>(null);
  const [directions, setDirections] = useState<OpenccDirectionMeta[]>([]);
  // 第四阶段：查找/替换 + 替换表管理
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlights, setHighlights] = useState<SearchHighlight[]>([]);
  const [pendingSelection, setPendingSelection] = useState<SelectionRequest | null>(null);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [replaceTables, setReplaceTables] = useState<TableMeta[]>([]);
  // 第五阶段：整理工具
  const [tools, setTools] = useState<ToolMeta[]>([]);
  const [toolDialog, setToolDialog] = useState<ToolDialogCtx | null>(null);
  // 第六阶段：文件比较（F-06）
  const [compareDialogOpen, setCompareDialogOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  // 第八阶段：偏好设置（F-11）。`openTab` 为 null 表示未打开；
  // 「自定义快捷键…」与「选项…」共用同一个对话框，只是落到不同页签
  const [settingsOpen, setSettingsOpen] = useState<SettingsTab | null>(null);
  /** 第九阶段：帮助与快捷键对话框（F1 / 帮助菜单） */
  const [helpOpen, setHelpOpen] = useState(false);
  /** 外部驱动的查找面板命令（F3 / Shift+F3 / Ctrl+F / Ctrl+H）；`text` 是选区预填的文字 */
  const [searchExternal, setSearchExternal] = useState<{
    kind: 'next' | 'prev' | 'focusFind' | 'focusReplace' | 'fill';
    nonce: number;
    text?: string;
  } | null>(null);
  /**
   * 比较会话。两侧标签各自记 id —— **不能借 activeTabId 推**：
   * 目标窗会切换、激活标签跟着走，那样 A 窗会渲染成 B 的内容。
   * `target` 指出哪一格是当前可编辑的目标窗，另一格为对照窗（只读）。
   */
  const [compare, setCompare] = useState<{
    aTabId: string;
    bTabId: string;
    opts: CompareOptions;
    orientation: 'vertical' | 'horizontal';
    target: 'a' | 'b';
  } | null>(null);
  /**
   * 比较结果 —— **只有这一个口径**：差异计数、F5 跳差异、标红全用它，
   * 所以工具条上的「N 处」跟屏幕上标红的处数必然一样多。
   */
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [diffIndex, setDiffIndex] = useState(-1);
  /** 差异跳转：A 侧的选区请求（独立一份，不与查找定位共用，见下方渲染） */
  const [compareSelectionA, setCompareSelectionA] = useState<SelectionRequest | null>(null);
  /** 差异跳转：B 侧的选区请求 */
  const [compareSelection, setCompareSelection] = useState<SelectionRequest | null>(null);
  /** B 窗当前光标（UTF-16 偏移，「从光标重比」用） */
  const [compareCursor, setCompareCursor] = useState(0);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const reloadTab = tabs.find((t) => t.id === reloadTabId) ?? null;

  /** 没有活动标签时（标签全关了 / 进了比较模式）模式要一并退掉，别留个空勾选 */
  useEffect(() => {
    if (!activeTab) {
      setColumnMode(false);
      setColumnRect(null);
    }
  }, [activeTab]);

  /** 当前标签的有效选区（from === to 视为无选区） */
  const selectionRange = useMemo(
    () =>
      selection && selection.tabId === activeTabId && selection.from !== selection.to
        ? { from: selection.from, to: selection.to }
        : null,
    [selection, activeTabId],
  );

  // 转换方向列表（引擎元数据；失败时禁用转换入口）
  useEffect(() => {
    // PRD v0.5 §3.5：引擎侧已删除其余方向（`Direction` 枚举只留 6 种），
    // 前端不再需要过滤——列表就是全部可用方向。
    listOpenccDirections()
      .then(setDirections)
      .catch((e) => setError(`繁简引擎初始化失败：${String(e)}（转换功能已禁用）`));
  }, []);

  // ---------- F-01 §1.2 会话恢复：启动时重建上次的标签与未保存内容 ----------

  /** 会话装载完成前不许回写，否则启动瞬间会用空 store 覆盖磁盘上的会话（等于清空） */
  const [sessionReady, setSessionReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = await sessionLoad().catch(() => null);
      if (cancelled) return;
      if (!session || session.tabs.length === 0) {
        // 首次启动 / 上次没留下会话：给一个空标签，符合「没有欢迎页，启动即编辑」
        newTab();
        setSessionReady(true);
        return;
      }
      // v0.9：并行读盘。原来是逐个 `await fsRead`，N 个标签就是 N 次串行往返
      // （IPC + 磁盘读首尾相接），文件越多启动越慢，期间界面一直停在「无标签」。
      // 并发后总耗时取决于最慢的那一个，顺序仍按会话里的顺序还原。
      const settled = await Promise.all(
        session.tabs.map(async (st): Promise<{ tab: EditorTab; unreadable: string | null }> => {
          const base = {
            id: st.id,
            filePath: st.filePath,
            fileName: st.fileName,
            encoding: st.encoding,
            lineEnding: st.lineEnding,
            hadBom: st.hadBom,
            cursorLine: st.cursorLine,
            cursorColumn: st.cursorColumn,
          };
          // 会话里带了正文（有未保存修改 / 从未保存过）→ 直接用，一个字都不丢
          if (st.content !== null) {
            return { tab: { ...base, content: st.content, dirty: st.dirty }, unreadable: null };
          }
          if (!st.filePath) {
            return { tab: { ...base, content: '', dirty: st.dirty }, unreadable: null };
          }
          // 已保存的标签：从磁盘重读（文件可能已被外部改动，以磁盘为准）
          try {
            const loaded = await fsRead(st.filePath);
            return {
              tab: {
                ...base,
                content: loaded.text,
                encoding: loaded.encoding,
                lineEnding: loaded.lineEnding,
                hadBom: loaded.hadBom,
                dirty: false,
              },
              unreadable: null,
            };
          } catch {
            // 文件被删 / 挪走：保留标签但标为未保存，免得用户以为内容还在
            return { tab: { ...base, content: '', dirty: true }, unreadable: st.filePath };
          }
        }),
      );
      if (cancelled) return;
      const restored = settled.map((item) => item.tab);
      const unreadable = settled
        .map((item) => item.unreadable)
        .filter((p): p is string => p !== null);
      restoreSession(restored, session.activeTabId);
      setSessionReady(true);
      if (unreadable.length > 0) {
        setError(`上次打开的文件已无法读取：${unreadable.join('、')}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [newTab, restoreSession]);

  // 会话落盘：标签 / 内容 / 光标 / 活动标签变化后防抖写盘。
  // 失败不打扰用户——会话是「尽力而为」的便利功能，不该用报错打断编辑。
  useEffect(() => {
    if (!sessionReady) return;
    const timer = window.setTimeout(() => {
      void sessionSave(toSessionState(tabs, activeTabId)).catch(() => {});
    }, SESSION_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [tabs, activeTabId, sessionReady]);

  // 启动耗时（第九阶段）：读一次后端指标，暴露给 E2E 与人工排查。
  // 不展示在界面上——它服务的是「启动 < 1.5s」这条验收标准的可断言性。
  useEffect(() => {
    startupMetrics()
      .then((m) => {
        window.__aioStartupMetrics = m;
        console.info(`[aio] 启动耗时（run → setup）：${m.setupMs} ms`);
      })
      .catch(() => {});
  }, []);

  // ---------- F-11 偏好设置：载入 + 外观生效 ----------

  const loadSettings = useSettingsStore((s) => s.load);
  const appearance = useSettingsStore((s) => s.settings.appearance);
  /** 自动换行在「编辑器」分组下（F-11），视图菜单要读它的勾选态 */
  const editorSettings = useSettingsStore((s) => s.settings.editor);
  const shortcuts = useSettingsStore((s) => s.settings.shortcuts);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);


  /**
   * 主题 → `color-scheme`。
   *
   * 本项目整套配色建立在 CSS **系统色**（`canvas` / `canvastext` / `ButtonFace`…）
   * 之上，所以「跟随系统 / 浅色 / 深色」正好对应 `color-scheme` 的三个取值，
   * 不需要再维护第二套色板。代价是只能沿用系统给定的深浅两套色调、无法自定义
   * 强调色；真要自定义时再引入一层 CSS 变量即可。
   *
   * 顺带挂 `data-theme`：便于脚本 / 端到端断言当前主题。
   */
  useEffect(() => {
    document.documentElement.style.colorScheme =
      appearance.theme === 'system' ? 'light dark' : appearance.theme;
    document.documentElement.dataset.theme = appearance.theme;
  }, [appearance.theme]);

  /**
   * 字号 / 字体族只作用于**文档正文**（界面文字保持系统字体，见 global.css 的
   * `.cm-content`）。写成 CSS 变量是为了让比较模式的多窗格自动一致。
   */
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--app-font-family', appearance.fontFamily);
    root.setProperty('--app-font-size', `${appearance.fontSize}px`);
  }, [appearance.fontFamily, appearance.fontSize]);

  // 用户替换表清单（F-04：转换对话框的模式 B 勾选、表管理对话框共用）
  const refreshReplaceTables = useCallback(async () => {
    try {
      setReplaceTables(await listReplaceTables());
    } catch (e) {
      setError(`替换表读取失败：${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refreshReplaceTables();
  }, [refreshReplaceTables]);

  // 整理工具目录（F-09：菜单分组与选项对话框都由后端目录驱动）
  useEffect(() => {
    pipelinesCatalog()
      .then(setTools)
      .catch((e) => setError(`整理工具初始化失败：${String(e)}（整理功能已禁用）`));
  }, []);

  // 切换标签：丢弃尚未应用的替换指令，避免误写
  useEffect(() => {
    setPendingEdit(null);
    setHighlights([]);
  }, [activeTabId]);

  const runGuarded = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(`${label}失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  /** 弹出不可编码决策弹窗，返回用户决策（null = 取消） */
  const askUser = useCallback(
    (unmappable: UnmappableChar[], encoding: string) =>
      new Promise<SaveDecision | null>((resolve) => {
        setUnmappableCtx({ unmappable, encoding, resolve });
      }),
    [],
  );

  /** 保存前预检：非 Unicode 编码时查不可编码字符并弹窗 */
  const precheck = useCallback(
    async (encoding: string, content: string): Promise<Precheck> => {
      if (isUnicodeEncoding(encoding)) return { kind: 'proceed', decision: null };
      const unmappable = await fsCheckMappable(content, encoding);
      if (unmappable.length === 0) return { kind: 'proceed', decision: null };
      const decision = await askUser(unmappable, encoding);
      return decision === null ? { kind: 'cancel' } : { kind: 'proceed', decision };
    },
    [askUser],
  );

  /** 另存为：取路径 → 预检 → 写出；返回是否成功保存 */
  const doSaveAs = useCallback(
    async (tabId: string, defaultName: string): Promise<boolean> => {
      const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab) return false;
      const path = await pickSaveFile(defaultName);
      if (!path) return false;
      const check = await precheck(tab.encoding, tab.content);
      if (check.kind === 'cancel') return false;
      await saveTabAs(tabId, path, check.decision);
      return true;
    },
    [precheck, saveTabAs],
  );

  const handleOpen = useCallback(
    () =>
      runGuarded('打开文件', async () => {
        const path = await pickOpenFile();
        if (path) await openFile(path);
      }),
    [openFile, runGuarded],
  );

  const handleNew = useCallback(() => {
    newTab();
    setError(null);
    setNotice(null);
  }, [newTab]);

  const handleSave = useCallback(
    () =>
      runGuarded('保存', async () => {
        if (!activeTab) return;
        if (activeTab.filePath) {
          await saveTab(activeTab.id, (unmappable, tab) => askUser(unmappable, tab.encoding));
        } else {
          await doSaveAs(activeTab.id, activeTab.fileName);
        }
      }),
    [activeTab, askUser, doSaveAs, runGuarded, saveTab],
  );

  const handleSaveAs = useCallback(
    () =>
      runGuarded('另存为', async () => {
        if (activeTab) await doSaveAs(activeTab.id, activeTab.fileName);
      }),
    [activeTab, doSaveAs, runGuarded],
  );

  /** 保存指定标签（不看当前激活的是谁）：有路径直接存，无路径走另存为；返回是否成功 */
  const saveTabById = useCallback(
    async (id: string): Promise<boolean> => {
      const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
      if (!tab) return false;
      return tab.filePath
        ? await saveTab(id, (unmappable, t) => askUser(unmappable, t.encoding))
        : await doSaveAs(id, tab.fileName);
    },
    [askUser, doSaveAs, saveTab],
  );

  /** 弹出关闭确认对话框并等用户决策（Promise 风格，与 `askUser` 一致） */
  const askClose = useCallback(
    (targets: EditorTab[]) =>
      new Promise<CloseDecision>((resolve) => {
        setCloseCtx({ tabs: targets, resolve });
      }),
    [],
  );

  /**
   * 关闭一批标签的统一入口（PRD v0.3 §3.4 C-1 ~ C-6）。
   *
   * - 没改过的标签直接关，不打扰用户；
   * - 有改动的**只问一次**（多个就汇总成一个对话框，不逐个连弹）；
   * - `cancel`：一个都不动；
   * - `save`：逐个保存，**只有保存成功的才关闭**——保存失败或被取消保存的标签留在原地；
   * - `discard`：直接丢弃。标签一旦从 store 摘除，会话里就不再有它，
   *   所以下次启动不会把它复活（§1.6 第 3 条「丢也是用户在决定」）。
   */
  const requestClose = useCallback(
    async (ids: string[]) => {
      const all = useTabsStore.getState().tabs;
      const targets = ids
        .map((id) => all.find((t) => t.id === id))
        .filter((t): t is EditorTab => t !== undefined);
      if (targets.length === 0) return;

      const closable = targets.filter((t) => !t.dirty).map((t) => t.id);
      const dirtyTabs = targets.filter((t) => t.dirty);

      if (dirtyTabs.length > 0) {
        let decision: CloseDecision;
        try {
          decision = await askClose(dirtyTabs);
        } finally {
          setCloseCtx(null);
        }
        if (decision === 'cancel') return;

        if (decision === 'discard') {
          closable.push(...dirtyTabs.map((t) => t.id));
        } else {
          const savedIds: string[] = [];
          for (const t of dirtyTabs) {
            try {
              if (await saveTabById(t.id)) savedIds.push(t.id);
            } catch (e) {
              setError(`保存「${t.fileName}」失败：${String(e)}`);
            }
          }
          closable.push(...savedIds);
          const failed = dirtyTabs.filter((t) => !savedIds.includes(t.id));
          if (failed.length > 0) {
            setError(
              `已保留 ${failed.length} 个没保存成功的文件：${failed.map((t) => t.fileName).join('、')}`,
            );
          }
        }
      }

      if (closable.length > 0) closeTabs(closable);
    },
    [askClose, closeTabs, saveTabById],
  );

  /** 关闭单个标签（× / 中键 / 双击 / 右键菜单 / `Ctrl·Cmd + W`） */
  const handleCloseTab = useCallback(
    (id: string) => {
      void requestClose([id]);
    },
    [requestClose],
  );

  /** 关闭除该标签外的全部标签 */
  const handleCloseOthers = useCallback(
    (id: string) => {
      void requestClose(tabs.filter((t) => t.id !== id).map((t) => t.id));
    },
    [requestClose, tabs],
  );

  /** 全部关闭 */
  const handleCloseAll = useCallback(() => {
    void requestClose(tabs.map((t) => t.id));
  }, [requestClose, tabs]);

  /** 全部保存（保存后**不关闭**任何标签） */
  const handleSaveAll = useCallback(
    () =>
      runGuarded('全部保存', async () => {
        const dirty = tabs.filter((t) => t.dirty);
        if (dirty.length === 0) {
          setNotice('没有需要保存的文件');
          return;
        }
        let failed = 0;
        for (const t of dirty) {
          if (!(await saveTabById(t.id))) failed += 1;
        }
        if (failed > 0) setError(`${failed} 个文件未保存（可能取消了保存位置选择）`);
        else setNotice(`已保存 ${dirty.length} 个文件`);
      }),
    [runGuarded, saveTabById, tabs],
  );

  /** 保存 / 另存为**指定**标签（标签右键菜单用，不一定是当前激活的那个） */
  const handleSaveTab = useCallback(
    (id: string) => runGuarded('保存', async () => void (await saveTabById(id))),
    [runGuarded, saveTabById],
  );

  const handleSaveTabAs = useCallback(
    (id: string) =>
      runGuarded('另存为', async () => {
        const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
        await doSaveAs(id, tab?.fileName ?? '未命名');
      }),
    [doSaveAs, runGuarded],
  );

  /** 编辑 → 自定义替换 ▸ 某张表：与替换表对话框里的「应用到正文」走同一条路径 */
  const handleApplyTable = useCallback(
    (name: string) =>
      runGuarded(`自定义替换：${name}`, async () => {
        if (!activeTab) return;
        const table = await loadReplaceTable(name);
        const report = await applyReplace(activeTab.content, table, { mode: 'standalone' });
        if (report.changedCount === 0) {
          setNotice(`「${name}」在正文中没有命中`);
          return;
        }
        setPendingEdit({
          from: 0,
          to: activeTab.content.length,
          text: report.text,
          nonce: Date.now(),
        });
        setNotice(`已按「${name}」替换 ${report.changedCount} 处`);
      }),
    [activeTab, runGuarded],
  );

  /** 文件 → 编码转换 ▸ 目标编码：内容不动，按目标编码重写文件 */
  const handleConvertEncoding = useCallback(
    (encodingLabel: string) =>
      runGuarded('编码转换', async () => {
        if (!activeTab) return;
        if (!activeTab.filePath) {
          setError('当前标签还没有保存到磁盘，无法转换编码');
          return;
        }
        const actual = await reencode(activeTab.id, encodingLabel, (unmappable, tab) =>
          askUser(unmappable, tab.encoding),
        );
        if (actual === null) return; // 用户在不可编码字符弹窗里取消
        const label = ENCODING_OPTIONS.find((option) => option.value === actual)?.label ?? actual;
        setNotice(`已按 ${label} 重新写出文件`);
      }),
    [activeTab, askUser, reencode, runGuarded],
  );

  /** 文件 → 重新载入 ▸ 指定编码（null = 打开原来的「选择编码」对话框） */
  const handleReloadWith = useCallback(
    (encodingLabel: string | null) =>
      runGuarded('重新载入', async () => {
        if (!activeTab) return;
        if (!encodingLabel) {
          setReloadTabId(activeTab.id);
          return;
        }
        if (!activeTab.filePath) {
          setError('当前标签还没有保存到磁盘，无法重新载入');
          return;
        }
        await reloadWithEncoding(activeTab.id, encodingLabel);
        setNotice(`已按 ${encodingLabel} 重新载入`);
      }),
    [activeTab, reloadWithEncoding, runGuarded],
  );

  /**
   * 菜单里的撤销 / 重做 / 跳转。
   *
   * 撤销历史挂在 CodeMirror 的 view 里，只有 dispatch 才能动，所以这里是「发意图」：
   * `Editor` 收到 `commandRequest` 后执行一次。**不用 `Date.now()` 做 nonce**——
   * 同一个毫秒里连点两次撤销会撞号导致第二次丢失，故用自增序号。
   */
  const editorCommandNonceRef = useRef(0);
  const sendEditorCommand = useCallback(
    (
      kind:
        | 'undo'
        | 'redo'
        | 'goto'
        | 'columnOn'
        | 'columnOff'
        | 'lineUp'
        | 'lineDown'
        | 'swapLineUp'
        | 'insertTime'
        | 'updateTime',
      line?: number,
    ) => {
      editorCommandNonceRef.current += 1;
      setEditorCommand({ kind, line, nonce: editorCommandNonceRef.current });
    },
    [],
  );

  /** 长字符串截断显示（统计对话框里的「选定文字」） */
  const snippet = (text: string, max = 24) =>
    text.length > max ? `“${text.slice(0, max)}…”` : `“${text}”`;

  /** 视图 → 字数统计 */
  const handleDocStats = useCallback(() => {
    if (!activeTab) return;
    const text = activeTab.content;
    const stats = countTextStats(text);
    const selected =
      selectionRange && selectionRange.to > selectionRange.from
        ? text.slice(selectionRange.from, selectionRange.to)
        : '';
    setStatCtx({
      title: '字数统计',
      subtitle: selected
        ? `全文统计；当前选区 ${snippet(selected)} 额外单列`
        : '全文统计（未选中文字）',
      columns: 2,
      rows: [
        { label: '中文字数（汉字）', value: stats.chineseChars, hint: '含扩展区，々〇 也算' },
        { label: '中文标点', value: stats.chinesePunct, hint: '、。「」【】……—— 等' },
        { label: '字母个数', value: stats.letters, hint: '拉丁 / 假名 / 谚文等 Unicode 字母' },
        { label: '单词个数', value: stats.words, hint: '连续字母数字为一词，汉字不计词' },
        { label: '英文标点', value: stats.englishPunct, hint: 'ASCII 标点' },
        { label: '数字个数', value: stats.digits, hint: '十进制数字符，含全角 ０-９' },
        { label: '数字组', value: stats.numberGroups, hint: '连续数字算一组' },
        { label: '字符数（不计空格与控制符）', value: stats.chars, hint: '代理对算 1 个字符' },
        { label: '字符数（含空格）', value: stats.charsWithSpace, hint: '控制符仍不计' },
        { label: '字符数（含空格与控制符）', value: stats.charsAll, hint: '全部码点' },
        { label: '段落数', value: stats.paragraphs, hint: '空行分隔的连续非空行块' },
        { label: '非空行数', value: stats.nonEmptyLines, hint: 'trim 后非空（段间空一行工具的口径）' },
        { label: '行数', value: stats.lines, hint: '含空行' },
        { label: '字节数（UTF-8）', value: stats.bytes },
        // 有选区时顺便给出选区字数，省得为了看一段话先剪切一遍
        ...(selected
          ? [
              {
                label: '选区字数（不计空格与控制符）',
                value: countTextStats(selected).chars,
              },
            ]
          : []),
      ],
      note: '字符数一律不含代理对重复计数（`𩅯` 算 1 个）；空格、全角空格、制表符、换行与控制符不计入「不计空格」那一栏。',
    });
  }, [activeTab, selectionRange]);

  /** 视图 → 统计选定文字出现的次数 */
  const handleCountSelected = useCallback(() => {
    if (!activeTab) return;
    const text = activeTab.content;
    if (!selectionRange || selectionRange.to <= selectionRange.from) {
      setNotice('请先在正文里选中一段文字，再统计它出现的次数');
      return;
    }
    const needle = text.slice(selectionRange.from, selectionRange.to);
    const stats = countTextStats(text);
    setStatCtx({
      title: '选定文字出现次数',
      subtitle: `在全文范围内统计 ${snippet(needle)}`,
      rows: [
        { label: '出现次数', value: countOccurrences(text, needle), hint: '不重叠计数' },
        { label: '选定文字长度', value: Array.from(needle).length },
        { label: '全文字符数', value: stats.charsAll },
      ],
      note: '次数包含选区自身这一处；重叠出现不重复计数。',
    });
  }, [activeTab, selectionRange]);

  /** 视图 → 显示段落数 */
  const handleParagraphCount = useCallback(() => {
    if (!activeTab) return;
    const stats = countTextStats(activeTab.content);
    setStatCtx({
      title: '段落数',
      subtitle: '段落 = 空行分隔的连续非空行块',
      rows: [
        { label: '段落数', value: stats.paragraphs, hint: '空行分隔的块' },
        { label: '非空行数', value: stats.nonEmptyLines, hint: '段间空一行工具的口径' },
        { label: '行数', value: stats.lines },
        { label: '空行数', value: Math.max(0, stats.lines - stats.nonEmptyLines) },
        { label: '全文字符数', value: stats.charsAll },
      ],
    });
  }, [activeTab]);

  // ---------------------------------------------------------------------
  // F-03 简繁转换
  // ---------------------------------------------------------------------

  /** 转换目标：有选区则只转换选区，否则整篇（F-03 §3.7） */
  const buildTarget = useCallback(
    (tab: EditorTab): ConvertTarget =>
      selectionRange
        ? { text: tab.content.slice(selectionRange.from, selectionRange.to), scope: 'selection' }
        : { text: tab.content, scope: 'all' },
    [selectionRange],
  );

  /** 把转换结果写回编辑区（整篇或选区），并给出反馈 */
  const applyConvertResult = useCallback(
    (
      tabId: string,
      target: ConvertTarget,
      text: string,
      ambiguities: AmbiguitySpan[],
      changedCount: number,
    ) => {
      const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const from = target.scope === 'selection' && selectionRange ? selectionRange.from : 0;
      const to =
        target.scope === 'selection' && selectionRange ? selectionRange.to : tab.content.length;
      setPendingEdit({ from, to, text, nonce: Date.now() });
      setNotice(
        changedCount === 0
          ? '已处理 0 处（没有可转换的内容）'
          : `已转换 ${changedCount} 个字符` +
              (target.scope === 'selection' ? '（选区）' : '（整篇）') +
              (ambiguities.length > 0 ? `，检出 ${ambiguities.length} 处地区用字差异` : ''),
      );
      setConvertDialog(null);
    },
    [selectionRange],
  );

  /** 菜单快捷转换：按当前选区/整篇直接转换（无预览） */
  const handleConvertPick = useCallback(
    (directionId: string) =>
      runGuarded('转换', async () => {
        if (!activeTab) return;
        const target = buildTarget(activeTab);
        const report = await convertOpencc({
          text: target.text,
          direction: directionId,
          skipInside: [],
          applyUserTables: [],
          diagnostics: false,
        });
        applyConvertResult(activeTab.id, target, report.text, report.ambiguities, report.changedCount);
      }),
    [activeTab, applyConvertResult, buildTarget, runGuarded],
  );

  /** 打开转换对话框（可配置方向 / 括号对豁免 / 诊断 / 预览） */
  const handleOpenConvertDialog = useCallback(
    (directionId?: string) => {
      if (!activeTab) return;
      setError(null);
      setNotice(null);
      setConvertDialog({
        tabId: activeTab.id,
        direction: directionId ?? directions[0]?.id ?? 's2t',
        target: buildTarget(activeTab),
      });
    },
    [activeTab, buildTarget, directions],
  );

  // ---------------------------------------------------------------------
  // F-09 文本整理工具
  // ---------------------------------------------------------------------

  /**
   * 应用一个整理步骤：默认作用于选区（有选区时），否则整篇。
   *
   * 结果通过 `pendingEdit` 交给 CodeMirror 精确改写，因此可以撤销（Ctrl+Z）；
   * 纯检查型工具（匹配括号）只是原样返回文本并给出问题清单。
   */
  const applyToolStep = useCallback(
    async (step: PipelineStep, label: string, forcedScope?: 'all' | 'selection') => {
      if (!activeTab) return;
      const scope = forcedScope ?? (selectionRange ? 'selection' : 'all');
      const useSelection = scope === 'selection' && selectionRange !== null;
      const from = useSelection && selectionRange ? selectionRange.from : 0;
      const to = useSelection && selectionRange ? selectionRange.to : activeTab.content.length;
      const target = activeTab.content.slice(from, to);
      const outcome = await applyPipelineStep(target, step);
      const scopeLabel = useSelection ? '（选区）' : '（整篇）';
      const issues = outcome.bracketIssues;
      const detail =
        issues.length > 0
          ? `；${issues
              .slice(0, 3)
              .map((issue) => issue.message)
              .join('；')}${issues.length > 3 ? ` 等共 ${issues.length} 处` : ''}`
          : '';
      if (outcome.text !== target) {
        setPendingEdit({ from, to, text: outcome.text, nonce: Date.now() });
      }
      setNotice(`${label}${scopeLabel}：${outcome.notes.join('；')}${detail}`);
    },
    [activeTab, selectionRange],
  );

  /** 菜单直接应用（无选项工具 / 快捷入口） */
  const handleRunTool = useCallback(
    (step: PipelineStep) =>
      runGuarded('整理', async () => {
        const label = tools.find((tool) => tool.id === step.kind)?.label ?? step.kind;
        await applyToolStep(step, label);
      }),
    [applyToolStep, runGuarded, tools],
  );

  /** 打开选项对话框（带选项的工具） */
  const handleConfigureTool = useCallback(
    (meta: ToolMeta) => {
      if (!activeTab) return;
      setError(null);
      setNotice(null);
      setToolDialog({
        tabId: activeTab.id,
        meta,
        content: activeTab.content,
        selection: selectionRange,
      });
    },
    [activeTab, selectionRange],
  );

  // ---------------------------------------------------------------------
  // F-06 文件比较（双栏平铺：A = 当前标签，B = 对照标签只读）
  // ---------------------------------------------------------------------

  const compareTabA = compare ? (tabs.find((t) => t.id === compare.aTabId) ?? null) : null;
  const compareTabB = compare ? (tabs.find((t) => t.id === compare.bTabId) ?? null) : null;

  /**
   * 两窗各自的差异标红。
   *
   * 目标窗（可编辑的那一格）是「要改的文件」，所以：
   * - 目标窗**缺**的字 —— 标在**对照窗**，让人一眼看到「少了这个字」；
   * - 目标窗**多出**的字 —— 标在**目标窗**，提示这里该删；
   * - 位置对齐但字不同 —— 两边都标（改动前先看清两边写的什么）。
   */
  const diffMarks = useMemo<PaneMarks>(
    () =>
      compare && diffResult
        ? buildDiffMarks(diffResult.blocks, compare.target)
        : { a: [], b: [] },
    [compare, diffResult],
  );

  /**
   * 逐字对照标蓝（F-06）：选中一侧的字，两侧**对应的位置**一起标蓝。
   *
   * 选中发生在哪一侧，那一侧标的就是用户选中的区间，另一侧标的是换算过去的
   * 位置 —— 切到另一窗选中时同理，只是方向反过来。
   * 只有光标没框选时按一个码元算：点一下也能看到它落在对面的哪儿。
   */
  const pairMarks = useMemo(() => {
    if (!compare || !diffResult || !selection) return null;
    const isA = selection.tabId === compare.aTabId;
    const isB = selection.tabId === compare.bTabId;
    if (!isA && !isB) return null;
    const from = selection.from;
    const to = Math.max(selection.to, from + 1);
    const other = mapToOpposite(diffResult.blocks, from, to, isA ? 'a' : 'b');
    // 对侧若是「无对应」的一端（长度 0），也给它一格宽度，否则看不见
    const mapped = other.to > other.from ? other : { from: other.from, to: other.from + 1 };
    return isA ? { a: { from, to }, b: mapped } : { a: mapped, b: { from, to } };
  }, [compare, diffResult, selection]);

  /** 跳到某处差异：A、B 两个窗格同时定位（不抢焦点，由状态栏提示） */
  const jumpToDiff = useCallback((blk: DiffBlock) => {
    const nonce = Date.now();
    setCompareSelectionA({
      from: blk.posA,
      to: blk.posA + blk.lenA,
      nonce,
      focus: false,
    });
    setCompareSelection({
      from: blk.posB,
      to: blk.posB + blk.lenB,
      nonce,
      focus: false,
    });
  }, []);

  /**
   * 跑一次同步逐字比较并定位到第一处差异。
   * `from` 给出各窗「起始对齐位置」（UTF-16 偏移）——后端只认全文，
   * 切片比较后把偏移加回起点，落回原文坐标（契约保持 F-06 §6.3 原样）。
   */
  const runCompare = useCallback(
    async (
      ctx: CompareCtx,
      opts: CompareOptions,
      from: { a: number; b: number } | null,
    ) => {
      const state = useTabsStore.getState();
      const aTab = state.tabs.find((t) => t.id === ctx.aTabId);
      const bTab = state.tabs.find((t) => t.id === ctx.bTabId);
      if (!aTab || !bTab) return;
      try {
        const a = from ? aTab.content.slice(from.a) : aTab.content;
        const b = from ? bTab.content.slice(from.b) : bTab.content;
        const result = await compareDiff(a, b, opts);
        if (from) {
          for (const blk of result.blocks) {
            blk.posA += from.a;
            blk.posB += from.b;
          }
        }
        setDiffResult(result);
        if (result.blocks.length > 0) {
          setDiffIndex(0);
          jumpToDiff(result.blocks[0]);
          const { added, missing } = diffStats(result.blocks, ctx.target);
          const warn = result.degraded ? '（文本过大，未完整比较）' : '';
          setNotice(
            `发现 ${result.blocks.length} 处不一致：新增 ${added} 字、缺失 ${missing} 字${warn}（F5 下一处，Shift+F5 从光标重比）`,
          );
        } else {
          setDiffIndex(-1);
          setNotice(
            result.degraded ? '比较完成：文本过大，未能完整比较' : '比较完成：两文一致',
          );
        }
      } catch (e) {
        setError(`比较失败：${String(e)}`);
      }
    },
    [jumpToDiff],
  );

  const handleStartCompare = useCallback(
    (targetTabId: string, opts: CompareOptions, orientation: 'vertical' | 'horizontal') => {
      if (!activeTabId) return;
      setCompareDialogOpen(false);
      setError(null);
      // 发起比较时，当前激活标签就是 A 侧；目标窗默认落在它身上
      const ctx: CompareCtx = { aTabId: activeTabId, bTabId: targetTabId, target: 'a' };
      setCompare({ ...ctx, opts, orientation });
      setCompareCursor(0);
      void runCompare(ctx, opts, null);
    },
    [activeTabId, runCompare],
  );

  const goNextDiff = useCallback(() => {
    if (!diffResult) return;
    if (diffIndex >= diffResult.blocks.length - 1) {
      setNotice('已到最后一处不一致；改动后可按 Shift+F5 从两个光标处重新比较');
      return;
    }
    const next = diffIndex + 1;
    setDiffIndex(next);
    jumpToDiff(diffResult.blocks[next]);
  }, [diffResult, diffIndex, jumpToDiff]);

  const goPrevDiff = useCallback(() => {
    if (!diffResult || diffIndex <= 0) return;
    const prev = diffIndex - 1;
    setDiffIndex(prev);
    jumpToDiff(diffResult.blocks[prev]);
  }, [diffResult, diffIndex, jumpToDiff]);

  /** 重选同步起点：以两个窗格的当前光标为起点重新比较 */
  const restartCompare = useCallback(() => {
    if (!compare) return;
    const aCursor = selection && selection.tabId === compare.aTabId ? selection.from : 0;
    void runCompare(compare, compare.opts, { a: aCursor, b: compareCursor });
  }, [compare, selection, compareCursor, runCompare]);

  const exitCompare = useCallback(() => {
    setCompare(null);
    setDiffResult(null);
    setDiffIndex(-1);
    setCompareSelectionA(null);
    setCompareSelection(null);
    setCompareCursor(0);
  }, []);

  /**
   * 点哪格、哪格就是目标窗：那一格转为可编辑，另一格转为对照（只读）。
   *
   * 激活标签**必须**跟着切 —— 否则在 B 窗改完按 Ctrl+S，存的是 A 窗那个文件，
   * 改动会凭空消失。这一条是「跟着切」的真正理由，不只是让标签栏高亮对上。
   */
  const focusComparePane = useCallback(
    (pane: 'a' | 'b') => {
      if (!compare || compare.target === pane) return;
      setCompare((c) => (c ? { ...c, target: pane } : c));
      useTabsStore.getState().activateTab(pane === 'a' ? compare.aTabId : compare.bTabId);
    },
    [compare],
  );

  // 任意一侧的标签被关闭就退出比较模式（两侧都得还在）
  useEffect(() => {
    if (!compare) return;
    const alive =
      tabs.some((t) => t.id === compare.aTabId) && tabs.some((t) => t.id === compare.bTabId);
    if (!alive) exitCompare();
  }, [compare, tabs, exitCompare]);

  // ---------- F-11 命令分发器 ----------

  const updateSettings = useSettingsStore((s) => s.update);
  const bindings = useMemo(() => resolveBindings(shortcuts), [shortcuts]);
  const conflictWarnedRef = useRef<string>('');

  /**
   * 当前选中的文字（供查找 / 替换面板预填）。
   *
   * 用 ref 而不是列进命令表的依赖：选区每动一下就重建整套命令表不值得，
   * 而按下 Ctrl+F 那一刻读到的必须是最新值。
   */
  const selectedTextRef = useRef('');
  useEffect(() => {
    const raw =
      activeTab && selectionRange
        ? activeTab.content.slice(selectionRange.from, selectionRange.to)
        : '';
    selectedTextRef.current = raw.length <= SELECTION_FILL_LIMIT ? raw : '';
  }, [activeTab, selectionRange]);

  /** 外部驱动查找面板（F3 / Shift+F3 / Ctrl+F / Ctrl+H）的序号 */
  const externalNonceRef = useRef(0);
  const driveSearch = useCallback(
    (kind: 'next' | 'prev' | 'focusFind' | 'focusReplace' | 'fill', text = '') => {
      externalNonceRef.current += 1;
      setSearchExternal({ kind, nonce: externalNonceRef.current, text });
    },
    [],
  );

  /**
   * 查找面板开着的时候，正文里选中的文字直接补进「当前那个输入框」。
   *
   * 落在哪个框由面板自己定（只有它知道焦点在哪），这里守两条线：
   * - 只认**用户自己框出来**的选区，程序跳转顺带选中的不算；
   * - 空选区不动作 —— 点一下光标不该把框里的字清掉。
   */
  useEffect(() => {
    if (!searchOpen || selectionByJumpRef.current) return;
    const text = selectedTextRef.current;
    if (!text) return;
    driveSearch('fill', text);
  }, [selectionRange, searchOpen, driveSearch]);

  /**
   * 命令 → 做什么。键必须是 `shortcuts.ts` 注册表里的 ID（注册表与这里的
   * 一一对应关系由单测锁定，漏一个就会有「菜单里有、按了没反应」的命令）。
   *
   * `enabled` 为假表示「这个命令当前不适用」（比较命令只在比较模式里、
   * 保存类命令要有活动标签）。此时**既不执行也不拦截按键**——键位还能留给
   * 别的命令，或交给浏览器默认行为。
   */
  const handlers = useMemo<Record<string, CommandHandler>>(
    () => ({
      // 文件
      'file.new': { run: handleNew, enabled: () => !busy },
      'file.open': { run: () => void handleOpen(), enabled: () => !busy },
      'file.save': { run: () => void handleSave(), enabled: () => !busy && activeTab !== null },
      'file.saveAs': { run: () => void handleSaveAs(), enabled: () => !busy && activeTab !== null },
      'file.reload': {
        run: () => {
          if (activeTab) setReloadTabId(activeTab.id);
        },
        enabled: () => !busy && activeTab?.filePath != null,
      },
      'file.close': {
        run: () => {
          if (activeTab) handleCloseTab(activeTab.id);
        },
        enabled: () => activeTab !== null,
      },
      // PRD v0.3 §3.4：标签生命周期管理
      'file.saveAll': {
        run: () => void handleSaveAll(),
        enabled: () => !busy && tabs.some((t) => t.dirty),
      },
      'file.closeAll': {
        run: () => void handleCloseAll(),
        enabled: () => tabs.length > 0,
      },
      'file.closeOthers': {
        run: () => {
          if (activeTab) handleCloseOthers(activeTab.id);
        },
        enabled: () => tabs.length > 1 && activeTab !== null,
      },
      // 搜索
      'search.find': {
        run: () => {
          // 选好了文字再按 Ctrl+F：直接带进查找框，省掉一次复制粘贴
          driveSearch('focusFind', selectedTextRef.current);
          setSearchOpen(true);
        },
        enabled: () => activeTab !== null,
      },
      'search.replace': {
        run: () => {
          driveSearch('focusReplace', selectedTextRef.current);
          setSearchOpen(true);
        },
        enabled: () => activeTab !== null,
      },
      // 面板没开时无「上次的查找」可用，故只在面板打开时生效
      'search.findNext': { run: () => driveSearch('next'), enabled: () => searchOpen },
      'search.findPrevious': { run: () => driveSearch('prev'), enabled: () => searchOpen },
      // 转换
      'convert.s2t': {
        run: () => void handleConvertPick('s2t'),
        enabled: () => !busy && activeTab !== null && directions.length > 0,
      },
      'convert.t2s': {
        run: () => void handleConvertPick('t2s'),
        enabled: () => !busy && activeTab !== null && directions.length > 0,
      },
      // 整理
      'tools.halfToFull': {
        run: () => void handleRunTool({ kind: 'half_to_full' }),
        enabled: () => !busy && activeTab !== null && tools.length > 0,
      },
      'tools.fullToHalf': {
        run: () => void handleRunTool({ kind: 'full_to_half' }),
        enabled: () => !busy && activeTab !== null && tools.length > 0,
      },
      // 编辑（撤销 / 重做 / 跳转：都转给编辑器实例执行，见 sendEditorCommand）
      'edit.undo': { run: () => sendEditorCommand('undo'), enabled: () => activeTab !== null },
      'edit.redo': { run: () => sendEditorCommand('redo'), enabled: () => activeTab !== null },
      'edit.goto': { run: () => setGotoOpen(true), enabled: () => activeTab !== null },
      // 垂直选择（列编辑）模式：Ctrl+Shift+F8 进出。
      //
      // 进入时必须关掉自动换行：一旦换行，「第几列」就没有稳定含义了（同一行在
      // 不同窗口宽度下折成几行，列号飘忽），框出来的矩形会对不上显示。
      // 退出时按进入前的状态还原——原本没开换行就还是不换行，不替用户做主。
      'edit.column': {
        run: () => {
          // 现取而不是闭包里的 editorSettings：躲开 stale closure，也不必进依赖数组
          const editor = useSettingsStore.getState().settings.editor;
          const next = !columnModeRef.current;
          if (next) {
            wrapBeforeColumnRef.current = editor.wrap;
            if (editor.wrap) updateSettings({ editor: { ...editor, wrap: false } });
          } else {
            const previous = wrapBeforeColumnRef.current;
            wrapBeforeColumnRef.current = null;
            if (previous !== null && previous !== editor.wrap) {
              updateSettings({ editor: { ...editor, wrap: previous } });
            }
          }
          columnModeRef.current = next;
          setColumnMode(next);
          setColumnRect(null);
          sendEditorCommand(next ? 'columnOn' : 'columnOff');
        },
        enabled: () => activeTab !== null,
      },
      // 行互换：上移 / 下移与键盘 Alt+↑ / Alt+↓ 是同一套 CodeMirror 命令，
      // 只是菜单没有键盘入口，故从这里发意图
      'edit.moveLineUp': {
        run: () => sendEditorCommand('lineUp'),
        enabled: () => activeTab !== null,
      },
      'edit.moveLineDown': {
        run: () => sendEditorCommand('lineDown'),
        enabled: () => activeTab !== null,
      },
      'edit.swapLineUp': {
        run: () => sendEditorCommand('swapLineUp'),
        enabled: () => activeTab !== null,
      },
      'edit.insertTime': {
        run: () => sendEditorCommand('insertTime'),
        enabled: () => activeTab !== null,
      },
      'edit.updateTime': {
        run: () => sendEditorCommand('updateTime'),
        enabled: () => activeTab !== null,
      },
      // 比较
      'compare.next': { run: goNextDiff, enabled: () => diffResult !== null },
      'compare.previous': {
        run: goPrevDiff,
        enabled: () => diffResult !== null && diffIndex > 0,
      },
      'compare.restart': { run: restartCompare, enabled: () => compare !== null },
      // 视图
      'view.theme': {
        run: () => {
          const next = NEXT_THEME[appearance.theme];
          updateSettings({ appearance: { ...appearance, theme: next } });
          setNotice(`主题：${THEME_LABEL[next]}`);
        },
      },
      'view.toggleToolbar': {
        run: () => updateSettings({ appearance: { ...appearance, showToolbar: !appearance.showToolbar } }),
      },
      'view.toggleStatusBar': {
        run: () =>
          updateSettings({ appearance: { ...appearance, showStatusBar: !appearance.showStatusBar } }),
      },
      'view.toggleLineNumber': {
        run: () =>
          updateSettings({ appearance: { ...appearance, showLineNumber: !appearance.showLineNumber } }),
      },
      'view.toggleWrap': {
        run: () => {
          // 现取而不是闭包里的 editorSettings：躲开 stale closure，也不必进依赖数组
          const editor = useSettingsStore.getState().settings.editor;
          updateSettings({ editor: { ...editor, wrap: !editor.wrap } });
        },
      },
      // 不可见字符：校对用，画出来的符号不进文档、不影响保存
      'view.toggleSpaces': {
        run: () =>
          updateSettings({ appearance: { ...appearance, showSpaces: !appearance.showSpaces } }),
      },
      'view.toggleLineEnds': {
        run: () =>
          updateSettings({ appearance: { ...appearance, showLineEnds: !appearance.showLineEnds } }),
      },
      'view.toggleParagraphMarks': {
        run: () =>
          updateSettings({
            appearance: { ...appearance, showParagraphMarks: !appearance.showParagraphMarks },
          }),
      },
      'doc.stats': { run: handleDocStats, enabled: () => activeTab !== null },
      'doc.countSelected': { run: handleCountSelected, enabled: () => activeTab !== null },
      'doc.paragraphCount': { run: handleParagraphCount, enabled: () => activeTab !== null },
      // 设置
      'settings.open': { run: () => setSettingsOpen('appearance') },
      'settings.shortcuts': { run: () => setSettingsOpen('shortcuts') },
      // 帮助
      'help.open': { run: () => setHelpOpen(true) },
    }),
    [
      busy,
      activeTab,
      handleNew,
      handleOpen,
      handleSave,
      handleSaveAs,
      handleCloseTab,
      handleSaveAll,
      handleCloseAll,
      handleCloseOthers,
      handleConvertPick,
      handleRunTool,
      directions.length,
      tools.length,
      diffResult,
      diffIndex,
      goNextDiff,
      goPrevDiff,
      restartCompare,
      compare,
      appearance,
      updateSettings,
      driveSearch,
      searchOpen,
      sendEditorCommand,
      handleDocStats,
      handleCountSelected,
      handleParagraphCount,
      // 「全部保存 / 全部关闭 / 关闭其他」的可用性取决于标签总数与是否有脏标签
      tabs,
    ],
  );

  // 处理函数随渲染更新，但监听器只挂一次（用 ref 取最新值，避免反复解绑/绑定）
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = keyFromEvent(e);
      if (key === null) return;
      const index = buildIndex(bindingsRef.current);
      const ids = index.get(key);
      if (ids === undefined || ids.length === 0) return;
      // 焦点在输入框里时，会打出字符的组合让给输入（见 shouldHandleKey）
      if (
        !shouldHandleKey(key, {
          inTextEntry: isTextEntry(e.target),
          ctrl: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey,
        })
      ) {
        return;
      }
      // 键位冲突时不必卡死：按注册表顺序取第一个当下可用的命令
      const hit = ids
        .map((id) => handlersRef.current[id])
        .find((h) => h !== undefined && (h.enabled?.() ?? true));
      if (hit === undefined) return;
      e.preventDefault();
      hit.run();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 冲突只在「第一次出现 / 变化时」提示一次，否则每次按键都刷提示条
  useEffect(() => {
    const conflicts = findConflicts(bindings);
    if (conflicts.length === 0) {
      conflictWarnedRef.current = '';
      return;
    }
    const signature = conflicts.map((c) => `${c.key}:${c.commands.join('|')}`).join(';');
    if (conflictWarnedRef.current === signature) return;
    conflictWarnedRef.current = signature;
    // 冲突是「需要注意但不阻断」的情形，用 warn 级别而不是普通提示（第九阶段）
    toast.warn(
      `快捷键冲突：${conflicts
        .map((c) => `${formatKey(c.key)} → ${c.commands.join('、')}`)
        .join('；')}（可在「设置 → 快捷键」里改）`,
    );
  }, [bindings]);

  return (
    <div className="app-shell">
      <header className="app-header">
        {/* 纯文字菜单栏（PRD v0.4 §3.5）：品牌名不再占位——窗口标题栏已有，重复一遍只是噪音 */}
        {appearance.showToolbar ? (
          <MenuBar
            appearance={appearance}
            wrap={editorSettings.wrap}
            columnMode={columnMode}
            bindings={bindings}
            handlers={handlers}
            compareDisabled={busy || !activeTab || tabs.length < 2 || compare !== null}
            convertDisabled={busy || !activeTab || directions.length === 0}
            toolDisabled={busy || !activeTab || tools.length === 0}
            directions={directions}
            tools={tools}
            tables={replaceTables}
            hasActiveTab={activeTab !== null}
            hasFilePath={activeTab?.filePath != null}
            actions={{
              convert: handleConvertPick,
              convertDialog: () => handleOpenConvertDialog(),
              tables: () => setTableDialogOpen(true),
              runTool: handleRunTool,
              configureTool: handleConfigureTool,
              compare: () => setCompareDialogOpen(true),
              merge: () => setMergeDialogOpen(true),
              batch: () => setBatchDialogOpen(true),
              convertEncoding: handleConvertEncoding,
              reloadWith: handleReloadWith,
              applyTable: handleApplyTable,
              resetSettings: () => {
                void useSettingsStore.getState().reset();
                setNotice('已恢复默认设置');
              },
            }}
          />
        ) : null}
      </header>

      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onActivate={activateTab}
        onClose={handleCloseTab}
        onCloseOthers={handleCloseOthers}
        onCloseAll={handleCloseAll}
        onSave={handleSaveTab}
        onSaveAs={handleSaveTabAs}
      />

      <main className="app-main">
        {searchOpen && activeTab && (
          <SearchPanel
            content={activeTab.content}
            tools={tools}
            onHighlights={setHighlights}
            onSelect={(from, to) => setPendingSelection({ from, to, nonce: Date.now() })}
            onApplyEdit={(from, to, next) => setPendingEdit({ from, to, text: next, nonce: Date.now() })}
            onClose={() => {
              setSearchOpen(false);
              setHighlights([]);
            }}
            external={searchExternal}
          />
        )}
        {compare && compareTabA && compareTabB ? (
          <div
            className={
              compare.orientation === 'vertical'
                ? 'compare-split compare-split-v'
                : 'compare-split compare-split-h'
            }
          >
            {/* 点哪格、哪格就是目标窗：那一格可编辑，另一格自动转对照（只读） */}
            <div
              className={`compare-pane${compare.target === 'a' ? ' compare-pane-target' : ''}`}
              onMouseDown={() => focusComparePane('a')}
            >
              <div className="compare-pane-title">
                {paneRole('a', compare.target)} · {compareTabA.fileName || '未命名'}
              </div>
              <Editor
                tab={compareTabA}
                readOnly={compare.target !== 'a'}
                diffMarks={diffMarks.a}
                pairMark={pairMarks?.a ?? null}
                onContentChange={setContent}
                onCursorChange={setCursor}
                onSelectionChange={handleSelectionChange}
                // 查找 / 转换 / 撤销这些只作用于目标窗，别写进只读的那一格
                pendingEdit={compare.target === 'a' ? pendingEdit : null}
                pendingSelection={
                  compare.target === 'a' ? (pendingSelection ?? compareSelectionA) : compareSelectionA
                }
                commandRequest={compare.target === 'a' ? editorCommand : null}
                highlights={compare.target === 'a' ? highlights : []}
              />
            </div>
            <div
              className={`compare-pane${compare.target === 'b' ? ' compare-pane-target' : ''}`}
              onMouseDown={() => focusComparePane('b')}
            >
              <div className="compare-pane-title">
                {paneRole('b', compare.target)} · {compareTabB.fileName || '未命名'}
              </div>
              <Editor
                tab={compareTabB}
                readOnly={compare.target !== 'b'}
                diffMarks={diffMarks.b}
                pairMark={pairMarks?.b ?? null}
                onContentChange={setContent}
                onCursorChange={setCursor}
                onSelectionChange={(id, from, to, external) => {
                  handleSelectionChange(id, from, to, external);
                  setCompareCursor(from);
                }}
                pendingEdit={compare.target === 'b' ? pendingEdit : null}
                pendingSelection={
                  compare.target === 'b' ? (pendingSelection ?? compareSelection) : compareSelection
                }
                commandRequest={compare.target === 'b' ? editorCommand : null}
                highlights={compare.target === 'b' ? highlights : []}
              />
            </div>
          </div>
        ) : activeTab ? (
          <Editor
            tab={activeTab}
            onContentChange={setContent}
            onCursorChange={setCursor}
            onSelectionChange={handleSelectionChange}
            onVerticalState={handleVerticalState}
            pendingEdit={pendingEdit}
            pendingSelection={pendingSelection}
            commandRequest={editorCommand}
            highlights={highlights}
          />
        ) : (
          // 关掉所有标签后就是一片空白：不塞欢迎语、不塞功能介绍。
          // 启动即编辑是本项目的取向（见 PRD），空白页只是「现在没有文档」这件事本身。
          <div className="app-placeholder" />
        )}
        {compare && (
          <CompareBar
            result={diffResult}
            index={diffIndex}
            target={compare.target}
            aName={compareTabA?.fileName || '未命名'}
            bName={compareTabB?.fileName || '未命名'}
            contentA={compareTabA?.content ?? ''}
            contentB={compareTabB?.content ?? ''}
            onPrev={goPrevDiff}
            onNext={goNextDiff}
            onRestart={restartCompare}
            onExit={exitCompare}
          />
        )}
      </main>

      {/* F-11：状态栏可整体隐藏（设置 → 外观，或快捷键「显示 / 隐藏状态栏」） */}
      {appearance.showStatusBar ? (
        <StatusBar tab={activeTab} columnRect={columnMode ? columnRect : null} />
      ) : null}

      {/* 对话框按需加载的边界：`fallback={null}` 是因为它们本来就是条件渲染的，
          取 chunk 的那几十毫秒里什么都不画，比画一个空框更干净 */}
      <Suspense fallback={null}>
        {reloadTab && (
          <ReloadDialog
            tab={reloadTab}
          onConfirm={async (encodingLabel) => {
            await reloadWithEncoding(reloadTab.id, encodingLabel);
            setReloadTabId(null);
          }}
          onCancel={() => setReloadTabId(null)}
        />
      )}

      {unmappableCtx && (
        <UnmappableDialog
          encoding={unmappableCtx.encoding}
          unmappable={unmappableCtx.unmappable}
          onDecide={(decision) => {
            unmappableCtx.resolve(decision);
            setUnmappableCtx(null);
          }}
        />
      )}

      {/* PRD v0.3 §3.4：关闭确认（保存 / 不保存 / 取消）。关闭到账由 requestClose 统一收尾 */}
      {closeCtx && (
        <ConfirmCloseDialog
          tabs={closeCtx.tabs}
          onDecide={(decision) => {
            closeCtx.resolve(decision);
          }}
        />
      )}

      {tableDialogOpen && (
        <ReplaceTableDialog
          onClose={() => setTableDialogOpen(false)}
          onNotice={setNotice}
          onTablesChanged={() => void refreshReplaceTables()}
          activeContent={activeTab?.content ?? null}
          onApplyText={(next) =>
            activeTab &&
            setPendingEdit({ from: 0, to: activeTab.content.length, text: next, nonce: Date.now() })
          }
        />
      )}

      {toolDialog && (
        <ToolOptionsDialog
          meta={toolDialog.meta}
          content={toolDialog.content}
          selection={toolDialog.selection}
          onCancel={() => setToolDialog(null)}
          onApply={(step, scope) => {
            if (toolDialog.tabId !== useTabsStore.getState().activeTabId) {
              setToolDialog(null);
              setError('整理期间切换了标签，已取消本次操作');
              return;
            }
            void runGuarded('整理', async () => {
              await applyToolStep(step, toolDialog.meta.label, scope);
              setToolDialog(null);
            });
          }}
        />
      )}

      {compareDialogOpen && activeTab && (
        <CompareDialog
          tabs={tabs.filter((t) => t.id !== activeTab.id)}
          activeName={activeTab.fileName || '未命名'}
          onStart={handleStartCompare}
          onCancel={() => setCompareDialogOpen(false)}
        />
      )}

      {mergeDialogOpen && (
        <MergeDialog
          onDone={(message) => {
            setMergeDialogOpen(false);
            setNotice(message);
          }}
          onCancel={() => setMergeDialogOpen(false)}
        />
      )}

      {batchDialogOpen && (
        <BatchDialog
          onClose={() => setBatchDialogOpen(false)}
          onNotice={(msg) => setNotice(msg)}
        />
      )}

      {/* F-11 选项：`settingsOpen` 记住「从哪个入口进来的」，直接落到对应页签 */}
      {settingsOpen !== null && (
        <SettingsDialog
          initialTab={settingsOpen}
          onClose={() => setSettingsOpen(null)}
          onNotice={(msg) => setNotice(msg)}
        />
      )}

      {/* 第九阶段：帮助与快捷键（顶栏「帮助」/ F1） */}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}

      {/* v0.6：编辑 → 跳转…（输入行号 → 编辑器滚动到那一行） */}
      {gotoOpen && activeTab && (
        <GotoDialog
          currentLine={activeTab.cursorLine}
          totalLines={Math.max(1, activeTab.content.split(/\r\n|\r|\n/).length)}
          onConfirm={(line) => {
            setGotoOpen(false);
            sendEditorCommand('goto', line);
          }}
          onCancel={() => setGotoOpen(false)}
        />
      )}

      {/* v0.6：视图 → 字数统计 / 统计选定文字出现的次数 / 显示段落数 */}
      {statCtx && <StatDialog {...statCtx} onClose={() => setStatCtx(null)} />}

      {convertDialog && (
        <ConvertDialog
          directions={directions}
          initialDirection={convertDialog.direction}
          target={convertDialog.target}
          userTables={replaceTables}
          onCancel={() => setConvertDialog(null)}
          onApply={(text, ambiguities, changedCount) => {
            if (convertDialog.tabId !== useTabsStore.getState().activeTabId) {
              setConvertDialog(null);
              setError('转换期间切换了标签，已取消本次转换');
              return;
            }
            applyConvertResult(
              convertDialog.tabId,
              convertDialog.target,
              text,
              ambiguities,
              changedCount,
            );
          }}
        />
      )}

      </Suspense>

      {/* 全局提示队列（第九阶段）：挂在根部，z-index 高于对话框遮罩 */}
      <ToastHost />
    </div>
  );
}
