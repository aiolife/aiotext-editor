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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTabsStore, type EditorTab, type SaveDecision } from './store/tabsStore';
import { useSettingsStore } from './store/settingsStore';
import { toast } from './store/toastStore';
import { ToastHost } from './components/ToastHost';
import { HelpDialog } from './components/HelpDialog';
import { SettingsDialog, type SettingsTab } from './components/SettingsDialog';
import {
  buildIndex,
  findConflicts,
  formatKey,
  shouldHandleKey,
  keyFromEvent,
  resolveBindings,
} from './shared/shortcuts';
import {
  TOOL_SHORTCUTS,
  pickOpenFile,
  pickSaveFile,
  fsCheckMappable,
  isUnicodeEncoding,
  listOpenccDirections,
  convertOpencc,
  listReplaceTables,
  applyPipelineStep,
  pipelinesCatalog,
  compareTexts,
  fsRead,
  sessionLoad,
  sessionSave,
  startupMetrics,
  type AmbiguitySpan,
  type CompareDifference,
  type CompareOptions,
  type CompareReport,
  type OpenccDirectionMeta,
  type SessionState,
  type PipelineStep,
  type TableMeta,
  type ToolMeta,
  type UnmappableChar,
} from './platform/tauriApi';
import { Editor, type PendingEdit, type SearchHighlight, type SelectionRequest } from './components/Editor';
import { TabBar } from './components/TabBar';
import { StatusBar } from './components/StatusBar';
import { ReloadDialog } from './components/ReloadDialog';
import { UnmappableDialog } from './components/UnmappableDialog';
import { ConfirmCloseDialog, type CloseDecision } from './components/ConfirmCloseDialog';
import { ConvertMenu } from './components/ConvertMenu';
import { ConvertDialog, type ConvertTarget } from './components/ConvertDialog';
import { SearchPanel } from './components/SearchPanel';
import { ReplaceTableDialog } from './components/ReplaceTableDialog';
import { ToolMenu } from './components/ToolMenu';
import { ToolOptionsDialog } from './components/ToolOptionsDialog';
import { CompareDialog } from './components/CompareDialog';
import { CompareBar } from './components/CompareBar';
import { MergeDialog } from './components/MergeDialog';
import { BatchDialog } from './components/BatchDialog';

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

  const [busy, setBusy] = useState(false);
  const [reloadTabId, setReloadTabId] = useState<string | null>(null);
  const [unmappableCtx, setUnmappableCtx] = useState<UnmappableCtx | null>(null);
  const [closeCtx, setCloseCtx] = useState<CloseCtx | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  const [selection, setSelection] = useState<{ tabId: string; from: number; to: number } | null>(
    null,
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
  /** 顶栏「设置 ▾」下拉是否展开 */
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  /** 第九阶段：帮助与快捷键对话框（F1 / 顶栏「帮助」） */
  const [helpOpen, setHelpOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement | null>(null);
  /** 外部驱动的查找面板命令（F3 / Shift+F3 / Ctrl+H 聚焦替换框） */
  const [searchExternal, setSearchExternal] = useState<{
    kind: 'next' | 'prev' | 'focusFind' | 'focusReplace';
    nonce: number;
  } | null>(null);
  /** 比较会话：B 窗对照标签 + 选项 + 平铺方向 */
  const [compare, setCompare] = useState<{
    targetTabId: string;
    opts: CompareOptions;
    orientation: 'vertical' | 'horizontal';
  } | null>(null);
  const [compareReport, setCompareReport] = useState<CompareReport | null>(null);
  const [diffIndex, setDiffIndex] = useState(-1);
  /** B 窗（只读）的选区跳转请求 */
  const [compareSelection, setCompareSelection] = useState<SelectionRequest | null>(null);
  /** B 窗当前光标（UTF-16 偏移，「从光标重比」用） */
  const [compareCursor, setCompareCursor] = useState(0);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const reloadTab = tabs.find((t) => t.id === reloadTabId) ?? null;

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
      const restored: EditorTab[] = [];
      const unreadable: string[] = [];
      for (const st of session.tabs) {
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
          restored.push({ ...base, content: st.content, dirty: st.dirty });
          continue;
        }
        if (!st.filePath) {
          restored.push({ ...base, content: '', dirty: st.dirty });
          continue;
        }
        // 已保存的标签：从磁盘重读（文件可能已被外部改动，以磁盘为准）
        try {
          const loaded = await fsRead(st.filePath);
          restored.push({
            ...base,
            content: loaded.text,
            encoding: loaded.encoding,
            lineEnding: loaded.lineEnding,
            hadBom: loaded.hadBom,
            dirty: false,
          });
        } catch {
          // 文件被删 / 挪走：保留标签但标为未保存，免得用户以为内容还在
          unreadable.push(st.filePath);
          restored.push({ ...base, content: '', dirty: true });
        }
      }
      if (cancelled) return;
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
  const shortcuts = useSettingsStore((s) => s.settings.shortcuts);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // 设置下拉：点空白处收起（沿用 ConvertMenu / ToolMenu 的 rootRef 做法）
  useEffect(() => {
    if (!settingsMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (settingsMenuRef.current?.contains(e.target as Node)) return;
      setSettingsMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [settingsMenuOpen]);

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
        direction: directionId ?? directions.find((d) => d.common)?.id ?? 's2t',
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

  const compareTab = compare ? (tabs.find((t) => t.id === compare.targetTabId) ?? null) : null;

  /** 跳到某处差异：A、B 两个窗格同时定位（不抢焦点，由状态栏提示） */
  const jumpToDiff = useCallback((diff: CompareDifference) => {
    const nonce = Date.now();
    setPendingSelection({
      from: diff.posA,
      to: diff.posA + (diff.charA?.length ?? 0),
      nonce,
      focus: false,
    });
    setCompareSelection({
      from: diff.posB,
      to: diff.posB + (diff.charB?.length ?? 0),
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
    async (targetTabId: string, opts: CompareOptions, from: { a: number; b: number } | null) => {
      const state = useTabsStore.getState();
      const aTab = state.tabs.find((t) => t.id === state.activeTabId);
      const bTab = state.tabs.find((t) => t.id === targetTabId);
      if (!aTab || !bTab) return;
      try {
        const a = from ? aTab.content.slice(from.a) : aTab.content;
        const b = from ? bTab.content.slice(from.b) : bTab.content;
        const report = await compareTexts(a, b, opts);
        if (from) {
          for (const diff of report.differences) {
            diff.posA += from.a;
            diff.posB += from.b;
          }
        }
        setCompareReport(report);
        if (report.differences.length > 0) {
          setDiffIndex(0);
          jumpToDiff(report.differences[0]);
          const first = report.differences[0];
          setNotice(
            `发现 ${report.differences.length} 处不一致：第 1 处 A『${first.charA ?? '（尾部）'}』↔ B『${first.charB ?? '（尾部）'}』（F5 下一处，Shift+F5 从光标重比）`,
          );
        } else {
          setDiffIndex(-1);
          const endHint =
            report.end === 'bothEnded'
              ? '两文一致'
              : report.end === 'aEnded'
                ? `A 窗先到尾部，B 窗还剩 ${report.remainingB} 字`
                : report.end === 'truncated'
                  ? '差异过多，报告已截断'
                  : `B 窗先到尾部，A 窗还剩 ${report.remainingA} 字`;
          setNotice(`比较完成：${endHint}`);
        }
      } catch (e) {
        setError(`比较失败：${String(e)}`);
      }
    },
    [jumpToDiff],
  );

  const handleStartCompare = useCallback(
    (targetTabId: string, opts: CompareOptions, orientation: 'vertical' | 'horizontal') => {
      setCompareDialogOpen(false);
      setError(null);
      setCompare({ targetTabId, opts, orientation });
      setCompareCursor(0);
      void runCompare(targetTabId, opts, null);
    },
    [runCompare],
  );

  const goNextDiff = useCallback(() => {
    if (!compareReport) return;
    if (diffIndex >= compareReport.differences.length - 1) {
      setNotice('已到最后一处不一致；改动后可按 Shift+F5 从两个光标处重新比较');
      return;
    }
    const next = diffIndex + 1;
    setDiffIndex(next);
    jumpToDiff(compareReport.differences[next]);
  }, [compareReport, diffIndex, jumpToDiff]);

  const goPrevDiff = useCallback(() => {
    if (!compareReport || diffIndex <= 0) return;
    const prev = diffIndex - 1;
    setDiffIndex(prev);
    jumpToDiff(compareReport.differences[prev]);
  }, [compareReport, diffIndex, jumpToDiff]);

  /** 重选同步起点：以两个窗格的当前光标为起点重新比较 */
  const restartCompare = useCallback(() => {
    if (!compare) return;
    const aCursor = selection && selection.tabId === activeTabId ? selection.from : 0;
    void runCompare(compare.targetTabId, compare.opts, { a: aCursor, b: compareCursor });
  }, [compare, selection, activeTabId, compareCursor, runCompare]);

  const exitCompare = useCallback(() => {
    setCompare(null);
    setCompareReport(null);
    setDiffIndex(-1);
    setCompareSelection(null);
    setCompareCursor(0);
  }, []);

  // 对照标签被关闭时退出比较模式
  useEffect(() => {
    if (compare && !tabs.some((t) => t.id === compare.targetTabId)) {
      exitCompare();
    }
  }, [compare, tabs, exitCompare]);

  // ---------- F-11 命令分发器 ----------

  const updateSettings = useSettingsStore((s) => s.update);
  const bindings = useMemo(() => resolveBindings(shortcuts), [shortcuts]);
  const conflictWarnedRef = useRef<string>('');

  /** 外部驱动查找面板（F3 / Shift+F3 / Ctrl+H 聚焦替换框）的序号 */
  const externalNonceRef = useRef(0);
  const driveSearch = useCallback((kind: 'next' | 'prev' | 'focusFind' | 'focusReplace') => {
    externalNonceRef.current += 1;
    setSearchExternal({ kind, nonce: externalNonceRef.current });
  }, []);

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
          driveSearch('focusFind');
          setSearchOpen(true);
        },
        enabled: () => activeTab !== null,
      },
      'search.replace': {
        run: () => {
          driveSearch('focusReplace');
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
      // 比较
      'compare.next': { run: goNextDiff, enabled: () => compareReport !== null },
      'compare.previous': {
        run: goPrevDiff,
        enabled: () => compareReport !== null && diffIndex > 0,
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
      compareReport,
      diffIndex,
      goNextDiff,
      goPrevDiff,
      restartCompare,
      compare,
      appearance,
      updateSettings,
      driveSearch,
      searchOpen,
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
        <span className="app-title">AioTextEditor</span>
        {/* 工具栏可由「视图 → 显示 / 隐藏工具栏」整体收起（F-11） */}
        {appearance.showToolbar ? (
          <>
            <button onClick={handleNew} disabled={busy}>
              新建
            </button>
            <button onClick={handleOpen} disabled={busy}>
              打开…
            </button>
            <button onClick={handleSave} disabled={busy || !activeTab} title="Ctrl+S">
              保存
            </button>
            <button onClick={handleSaveAs} disabled={busy || !activeTab} title="Ctrl+Shift+S">
              另存为…
            </button>
            <button
              onClick={() => void handleSaveAll()}
              disabled={busy || !tabs.some((t) => t.dirty)}
              title="保存所有有改动的文件（Ctrl+Shift+A）；不关闭任何标签"
            >
              全部保存
            </button>
            <button
              onClick={() => void handleCloseAll()}
              disabled={busy || tabs.length === 0}
              title="关闭所有标签（Ctrl+Shift+W）；有未保存内容时先询问"
            >
              全部关闭
            </button>
            <button
              onClick={() => activeTab && setReloadTabId(activeTab.id)}
              disabled={busy || !activeTab?.filePath}
            >
              重新载入…
            </button>
            <button
              onClick={() => {
                driveSearch('focusFind');
                setSearchOpen(true);
              }}
              disabled={!activeTab}
              title="Ctrl+F / Ctrl+H"
            >
              查找/替换
            </button>
            <ConvertMenu
              directions={directions}
              disabled={busy || !activeTab || directions.length === 0}
              onPick={handleConvertPick}
              onOpenDialog={() => handleOpenConvertDialog()}
              onOpenTables={() => setTableDialogOpen(true)}
            />
            <ToolMenu
              tools={tools}
              disabled={busy || !activeTab || tools.length === 0}
              shortcuts={TOOL_SHORTCUTS}
              onRun={handleRunTool}
              onConfigure={handleConfigureTool}
            />
            <button
              onClick={() => setCompareDialogOpen(true)}
              disabled={busy || !activeTab || tabs.length < 2 || compare !== null}
              title="平铺比较两份文本（F-06）：F5 跳差异，Shift+F5 从光标重比"
            >
              比较…
            </button>
            <button onClick={() => setMergeDialogOpen(true)} disabled={busy} title="合并文件（F-07）">
              合并…
            </button>
            <button
              onClick={() => setBatchDialogOpen(true)}
              disabled={busy}
              title="批量运行整理流水线（F-08）：目录 + 步骤 + 备份 + 进度"
            >
              批处理…
            </button>
          </>
        ) : null}
        {/* 设置入口**不在**可隐藏的工具栏里：否则误关工具栏就再也打不开了 */}
        <div className="menu-root" ref={settingsMenuRef}>
          <button
            type="button"
            className="menu-trigger"
            aria-haspopup="menu"
            aria-expanded={settingsMenuOpen}
            title="选项（Ctrl+,）"
            onClick={() => setSettingsMenuOpen((v) => !v)}
          >
            设置 ▾
          </button>
          {settingsMenuOpen ? (
            <div className="menu-panel" role="menu">
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setSettingsMenuOpen(false);
                  setSettingsOpen('appearance');
                }}
              >
                <span className="menu-item-label">选项…</span>
                <span className="menu-item-more">Ctrl+,</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setSettingsMenuOpen(false);
                  setSettingsOpen('shortcuts');
                }}
              >
                <span className="menu-item-label">自定义快捷键…</span>
              </button>
              <div className="menu-sep" />
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setSettingsMenuOpen(false);
                  void useSettingsStore.getState().reset();
                  setNotice('已恢复默认设置');
                }}
              >
                <span className="menu-item-label">恢复默认设置</span>
              </button>
            </div>
          ) : null}
        </div>
        {/* 第九阶段：帮助入口。与设置同理放在**不可隐藏**的位置——工具栏被关掉也要能打开 */}
        <div className="menu-root">
          <button
            type="button"
            className="menu-trigger"
            aria-haspopup="dialog"
            title="帮助与快捷键（F1）"
            onClick={() => setHelpOpen(true)}
          >
            帮助
          </button>
        </div>
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
        {activeTab && compare && compareTab ? (
          <div
            className={
              compare.orientation === 'vertical'
                ? 'compare-split compare-split-v'
                : 'compare-split compare-split-h'
            }
          >
            <div className="compare-pane">
              <div className="compare-pane-title">A · {activeTab.fileName || '未命名'}</div>
              <Editor
                tab={activeTab}
                onContentChange={setContent}
                onCursorChange={setCursor}
                onSelectionChange={(id, from, to) => setSelection({ tabId: id, from, to })}
                pendingEdit={pendingEdit}
                pendingSelection={pendingSelection}
                highlights={highlights}
              />
            </div>
            <div className="compare-pane">
              <div className="compare-pane-title">B · {compareTab.fileName || '未命名'}（只读）</div>
              <Editor
                tab={compareTab}
                readOnly
                onContentChange={setContent}
                onCursorChange={setCursor}
                onSelectionChange={(_id, from) => setCompareCursor(from)}
                pendingSelection={compareSelection}
              />
            </div>
          </div>
        ) : activeTab ? (
          <Editor
            tab={activeTab}
            onContentChange={setContent}
            onCursorChange={setCursor}
            onSelectionChange={(id, from, to) => setSelection({ tabId: id, from, to })}
            pendingEdit={pendingEdit}
            pendingSelection={pendingSelection}
            highlights={highlights}
          />
        ) : (
          <div className="app-placeholder">
            第七阶段：批处理（F-08）。
            <br />
            「新建」或「打开…」开始编辑；「功能」菜单提供简繁转换与「替换表管理…」。
            <br />
            「整理」菜单按行处理 / 空格与全半角 / 标点与括号 / 排版与分段分组，带「…」的工具可调选项并实时预览；
            有选区时只整理选区，否则整理整篇，全部可 Ctrl+Z 撤销。
            <br />
            打开两份文本后可用「比较…」平铺校对（F5 跳差异，可忽略回车 / 空格 / 标点，
            异体字按 fc1 / fc2 视为相同）；「合并…」支持手工清单与正则自动分文件。
            <br />
            「批处理…」把整理步骤编成流水线，对整个目录（可递归）批量执行，
            支持输入 / 输出编码、<code>.bak</code> 备份、保留 mtime、实时进度与错误面板，可中途取消。
            <br />
            「查找/替换」（Ctrl+F）支持中文类目（<code>\c[GBK]</code>、<code>\c[天干]</code>、
            <code>\a</code>、<code>\d</code>），并可选择「使用工具」把整理工具套用到每个命中上。
          </div>
        )}
        {compare && (
          <CompareBar
            report={compareReport}
            index={diffIndex}
            aName={activeTab?.fileName || '未命名'}
            bName={compareTab?.fileName || '未命名'}
            onPrev={goPrevDiff}
            onNext={goNextDiff}
            onRestart={restartCompare}
            onExit={exitCompare}
          />
        )}
      </main>

      {/* F-11：状态栏可整体隐藏（设置 → 外观，或快捷键「显示 / 隐藏状态栏」） */}
      {appearance.showStatusBar ? <StatusBar tab={activeTab} /> : null}

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

      {/* 全局提示队列（第九阶段）：挂在根部，z-index 高于对话框遮罩 */}
      <ToastHost />
    </div>
  );
}
