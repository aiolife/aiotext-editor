/**
 * 多标签编辑状态（F-01 编辑器核心 + F-02 多编码 I/O）
 *
 * 文本在 store 与编辑器中统一为 LF 行尾（后端读入即归一），
 * 原始行尾风格记录于 tab.lineEnding，保存时还原。
 */
import { create } from 'zustand';
import {
  fsRead,
  fsReadWith,
  fsCheckMappable,
  fsWrite,
  baseName,
  isUnicodeEncoding,
  type LoadResult,
  type SaveOptions,
} from '../platform/tauriApi';

export interface EditorTab {
  id: string;
  /** null = 未保存的新文件 */
  filePath: string | null;
  fileName: string;
  content: string;
  encoding: string;
  lineEnding: 'lf' | 'cr' | 'crlf';
  hadBom: boolean;
  dirty: boolean;
  cursorLine: number;
  cursorColumn: number;
}

/** 保存前的用户决策（F-02 §2.2 不可编码字符策略） */
export type SaveDecision = 'charref' | 'toutf8';

interface OpenFileResult {
  tabId: string;
  /** 已存在同路径标签时复用 */
  reused: boolean;
}

interface TabsState {
  tabs: EditorTab[];
  activeTabId: string | null;
  /** 打开文件（自动检测编码）；已在标签中则激活 */
  openFile: (path: string) => Promise<OpenFileResult>;
  /** 新建空标签 */
  newTab: () => string;
  /** 激活标签 */
  activateTab: (id: string) => void;
  /** 关闭标签（不做 dirty 确认，由 UI 层负责） */
  closeTab: (id: string) => void;
  /**
   * 批量关闭标签（PRD v0.3 §3.4）。
   *
   * 与 `closeTab` 一视同仁：**不做 dirty 确认**，UI 层必须先把「保存 / 不保存 /
   * 取消」问清楚再调用，这样同一套收敛规则只有一个实现。
   */
  closeTabs: (ids: string[]) => void;
  /** 关闭除 id 之外的全部标签 */
  closeOthers: (id: string) => void;
  /** 关闭全部标签 */
  closeAll: () => void;
  /** 编辑器内容变更（CodeMirror change 回调） */
  setContent: (id: string, content: string) => void;
  /** 光标位置变更 */
  setCursor: (id: string, line: number, column: number) => void;
  /** 按手选编码重新载入文件内容（放弃当前修改） */
  reloadWithEncoding: (id: string, encodingLabel: string) => Promise<void>;
  /**
   * 保存到已关联路径。非 Unicode 编码且含不可编码字符时，
   * 通过回调把预检结果交给 UI 弹窗，返回用户决策；UI 返回 null 表示取消。
   */
  saveTab: (id: string, askUser: (unmappable: { character: string; position: number }[], tab: EditorTab) => Promise<SaveDecision | null>) => Promise<boolean>;
  /** 另存为（UI 层先取好目标路径） */
  saveTabAs: (id: string, path: string, decision: SaveDecision | null) => Promise<boolean>;
  /** 标签内容整体替换（重载等场景），并清除 dirty */
  replaceContent: (id: string, loaded: LoadResult) => void;
  /**
   * 用上次会话重建标签（F-01 §1.2 启动恢复）。
   *
   * `content` 已由调用方备好（未保存正文来自会话，其余从磁盘重读），这里只负责
   * 装载；同时把内部 id 计数器推到已有 id 之后，避免之后新建标签撞 id。
   */
  restoreSession: (tabs: EditorTab[], activeTabId: string | null) => void;
}

let nextId = 1;

function makeEmptyTab(): EditorTab {
  return {
    id: `tab-${nextId++}`,
    filePath: null,
    fileName: `未命名-${nextId - 1}`,
    content: '',
    encoding: 'utf-8',
    lineEnding: 'lf',
    hadBom: false,
    dirty: false,
    cursorLine: 1,
    cursorColumn: 1,
  };
}

function loadedToTab(path: string, loaded: LoadResult): EditorTab {
  return {
    id: `tab-${nextId++}`,
    filePath: path,
    fileName: baseName(path),
    content: loaded.text,
    encoding: loaded.encoding,
    lineEnding: loaded.lineEnding,
    hadBom: loaded.hadBom,
    dirty: false,
    cursorLine: 1,
    cursorColumn: 1,
  };
}

/** 按标签当前属性构造保存选项 */
function saveOptionsFor(tab: EditorTab, unmappable: SaveOptions['unmappable']): SaveOptions {
  return {
    encoding: tab.encoding,
    addBom: tab.hadBom,
    lineEnding: tab.lineEnding,
    unmappable,
  };
}

/**
 * 摘掉一批标签后 `activeTabId` 的收敛规则（沿用 `closeTab` 的既有语义）：
 * 当前标签被关掉时，落到它**右侧最近的幸存者**；右侧没有了就落到最后一个。
 * 当前标签不在被关名单里则原地不动——用户正在编辑的东西不会因为关闭别的标签而跳走。
 */
function nextActiveAfterClose(
  tabs: EditorTab[],
  removed: ReadonlySet<string>,
  activeTabId: string | null,
): string | null {
  const survivors = tabs
    .map((tab, index) => ({ tab, index }))
    .filter(({ tab }) => !removed.has(tab.id));
  if (survivors.length === 0) return null;
  if (activeTabId === null) return null; // 本来就没有激活标签，不自动填一个
  if (!removed.has(activeTabId)) return activeTabId;
  const closedIndex = tabs.findIndex((t) => t.id === activeTabId);
  const next = survivors.find(({ index }) => index > closedIndex) ?? survivors[survivors.length - 1];
  return next.tab.id;
}

/** 状态 → 摘掉 `removed` 后的下一份状态（标签列表 + 收敛后的激活标签） */
function removeTabs(
  state: Pick<TabsState, 'tabs' | 'activeTabId'>,
  removed: ReadonlySet<string>,
): Pick<TabsState, 'tabs' | 'activeTabId'> {
  return {
    tabs: state.tabs.filter((t) => !removed.has(t.id)),
    activeTabId: nextActiveAfterClose(state.tabs, removed, state.activeTabId),
  };
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openFile: async (path) => {
    // 已打开同一路径 → 直接激活
    const existing = get().tabs.find((t) => t.filePath === path);
    if (existing) {
      set({ activeTabId: existing.id });
      return { tabId: existing.id, reused: true };
    }
    const loaded = await fsRead(path);
    const tab = loadedToTab(path, loaded);
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    return { tabId: tab.id, reused: false };
  },

  newTab: () => {
    const tab = makeEmptyTab();
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },

  activateTab: (id) => set({ activeTabId: id }),

  closeTab: (id) => set((s) => removeTabs(s, new Set([id]))),

  closeTabs: (ids) => set((s) => removeTabs(s, new Set(ids))),

  closeOthers: (id) =>
    set((s) => removeTabs(s, new Set(s.tabs.filter((t) => t.id !== id).map((t) => t.id)))),

  closeAll: () => set({ tabs: [], activeTabId: null }),

  setContent: (id, content) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, content, dirty: true } : t)),
    })),

  setCursor: (id, line, column) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, cursorLine: line, cursorColumn: column } : t)),
    })),

  reloadWithEncoding: async (id, encodingLabel) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab?.filePath) throw new Error('该标签没有关联文件');
    const loaded = await fsReadWith(tab.filePath, encodingLabel);
    get().replaceContent(id, loaded);
  },

  replaceContent: (id, loaded) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              content: loaded.text,
              encoding: loaded.encoding,
              lineEnding: loaded.lineEnding,
              hadBom: loaded.hadBom,
              dirty: false,
            }
          : t,
      ),
    })),

  saveTab: async (id, askUser) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return false;
    if (!tab.filePath) throw new Error('请先使用「另存为」指定保存路径');

    // 非 Unicode 编码：先预检，把决策权交给 UI（F-02 §2.2）
    let decision: SaveDecision | null = null;
    if (!isUnicodeEncoding(tab.encoding)) {
      const unmappable = await fsCheckMappable(tab.content, tab.encoding);
      if (unmappable.length > 0) {
        decision = await askUser(unmappable, tab);
        if (!decision) return false; // 用户取消
      }
    }

    const unmappable: SaveOptions['unmappable'] =
      decision === 'charref' ? 'charref' : decision === 'toutf8' ? 'toutf8' : 'charref';
    const report = await fsWrite(tab.filePath, tab.content, {
      ...saveOptionsFor(tab, unmappable),
      // 改存 UTF-8 按契约带 BOM
      ...(decision === 'toutf8' ? { encoding: 'utf-8', addBom: true } : {}),
    });

    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              dirty: false,
              ...(decision === 'toutf8' ? { encoding: report.actualEncoding, hadBom: true } : {}),
            }
          : t,
      ),
    }));
    return true;
  },

  saveTabAs: async (id, path, decision) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return false;

    const unmappable: SaveOptions['unmappable'] =
      decision === 'charref' ? 'charref' : decision === 'toutf8' ? 'toutf8' : 'charref';
    const report = await fsWrite(path, tab.content, {
      ...saveOptionsFor(tab, unmappable),
      ...(decision === 'toutf8' ? { encoding: 'utf-8', addBom: true } : {}),
    });

    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              filePath: report.writtenPath,
              fileName: baseName(report.writtenPath),
              dirty: false,
              ...(decision === 'toutf8' ? { encoding: report.actualEncoding, hadBom: true } : {}),
            }
          : t,
      ),
    }));
    return true;
  },

  restoreSession: (tabs, activeTabId) => {
    // 会话里的 id 形如 `tab-7`；把计数器推到最大值之后，避免新建标签撞 id
    for (const t of tabs) {
      const m = /^tab-(\d+)$/.exec(t.id);
      if (m) nextId = Math.max(nextId, Number(m[1]) + 1);
    }
    set({ tabs, activeTabId: activeTabId ?? tabs[0]?.id ?? null });
  },
}));
