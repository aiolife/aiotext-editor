/**
 * F-11 偏好设置状态（第八阶段）
 *
 * 为什么用 store 而不是 App 的 useState：
 * 设置被「外观整体」（App 顶栏 / 状态栏）、「编辑器」（Editor.tsx 的 CodeMirror
 * 扩展）等多处同时消费，逐层传参会把 App 变成中转站；而**外观改动必须立即
 * 生效**（主题一点就变），所以只能有一份共享状态。
 *
 * ## 落盘策略：改动即存（防抖 300ms）
 *
 * 与 VS Code 一致——没有「应用 / 取消」按钮，改一下就生效、存一下。
 * 于是不存在「用户改了却忘点保存」，也不需要处理「对话框里的草稿 vs 已生效值」
 * 两套状态。代价是误改无法用「取消」回退，故设置对话框提供「恢复默认」。
 *
 * 写盘是**异步且可能被钳制**的：`settingsSave` 返回实际落盘值，我们把它灌回
 * store（`applyServerValue`），这样界面上显示的一定是磁盘真值——否则会出现
 * 「输入框里写着 999、磁盘里存着 32」这种前后端各钳一次的分裂。
 */
import { create } from 'zustand';
import {
  DEFAULT_COMPARE_OPTIONS,
  settingsGet,
  settingsReset,
  settingsSave,
  type Settings,
} from '../platform/tauriApi';
import { resolveBindings, type ResolvedBinding } from '../shared/shortcuts';

/** 保存防抖间隔（毫秒） */
export const SAVE_DEBOUNCE_MS = 300;

/** 首次加载完成前的兜底值（与后端 `Settings::default()` 逐字段一致） */
export const DEFAULT_SETTINGS: Settings = {
  appearance: {
    fontFamily: "'Source Han Serif SC', 'Songti SC', '宋体', serif",
    fontSize: 14,
    showLineNumber: true,
    showToolbar: true,
    showStatusBar: true,
    // 不可见字符默认勾选（与后端 `Appearance::default()` 一致；开关在「选项 → 编辑器」里）
    showSpaces: true,
    showLineEnds: true,
    showParagraphMarks: true,
    theme: 'system',
  },
  editor: {
    tabWidth: 4,
    insertSpaces: true,
    wrap: false,
    defaultEncoding: 'auto',
    defaultLineEnding: 'lf',
  },
  conversion: {
    bracketSkip: '[]',
    preserveConverted: false,
  },
  compare: { ...DEFAULT_COMPARE_OPTIONS },
  shortcuts: {},
  // 默认关闭：保持「关闭即退出」，不常驻内存（与后端 `Settings::default()` 一致）
  hideOnClose: false,
  // 界面语言：默认简体中文（PRD §3.6）
  language: 'zh',
};

interface SettingsState {
  /** 当前生效的设置 */
  settings: Settings;
  /** 首次读取完成前为 false（避免用默认值闪一下再跳到真实值） */
  loaded: boolean;
  /** 最近一次保存失败的原因（供设置对话框提示） */
  saveError: string | null;
  /** 正在写盘 */
  saving: boolean;
  /** 读设置（App 启动时调一次；失败也会把 loaded 置 true，不阻塞界面） */
  load: () => Promise<void>;
  /** 改一部分设置（浅合并到顶层小节；自动防抖落盘） */
  update: (patch: Partial<Settings>) => void;
  /** 恢复默认（删文件 + 覆盖内存） */
  reset: () => Promise<void>;
  /** 立即落盘（关闭设置对话框时调，避免防抖计时器还没到就退出） */
  flush: () => Promise<void>;
  /** 把服务端回执灌回（内部用） */
  applyServerValue: (s: Settings) => void;
}

/** 防抖计时器（模块级：store 之外，无需参与重渲染） */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 有未落盘的改动 */
let dirty = false;

/**
 * 上一次生效的设置（首帧先用它，别让界面「先默认样式再跳一下」）
 *
 * 设置是从后端读的（`settings_get` 一次 IPC），回来之前 store 只能给默认值：
 * 于是深色主题的用户会先看到一帧浅色界面，字体 / 字号也要跳一次 —— 这种
 * 闪动很容易被当成「启动慢」。把上次读到的值缓存进 localStorage，首帧就按
 * 它渲染，异步回来后再校正（`load()` 里照样覆盖）。
 *
 * 缓存只影响观感，不影响正确性：读不到、解析失败、字段缺失都退回默认值。
 */
const CACHE_KEY = 'aiotext.settings.cache.v1';

function readCache(): Settings {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const saved = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      appearance: { ...DEFAULT_SETTINGS.appearance, ...saved.appearance },
      editor: { ...DEFAULT_SETTINGS.editor, ...saved.editor },
      conversion: { ...DEFAULT_SETTINGS.conversion, ...saved.conversion },
      compare: { ...DEFAULT_SETTINGS.compare, ...saved.compare },
      shortcuts: saved.shortcuts ?? {},
      hideOnClose: saved.hideOnClose ?? false,
      // 顶层字段，`...saved` 已能覆盖；显式写一份是为了让「设置结构」在这里一眼看全
      language: saved.language ?? DEFAULT_SETTINGS.language,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeCache(settings: Settings): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式 / 配额满：缓存写不进去无所谓，下次首帧退回默认值即可
  }
}

function cancelPendingSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirty = false;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  // 首帧就用上次的设置（没有则用默认值），见 `readCache` 的说明
  settings: readCache(),
  loaded: false,
  saveError: null,
  saving: false,

  applyServerValue: (s) => {
    writeCache(s);
    set({ settings: s });
  },

  load: async () => {
    try {
      const s = await settingsGet();
      writeCache(s);
      set({ settings: s, loaded: true, saveError: null });
    } catch (e) {
      set({
        loaded: true,
        saveError: `读取设置失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },

  update: (patch) => {
    set((state) => ({ settings: { ...state.settings, ...patch } }));
    dirty = true;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void get().flush();
    }, SAVE_DEBOUNCE_MS);
  },

  flush: async () => {
    if (!dirty && saveTimer === null) return;
    cancelPendingSave();
    set({ saving: true });
    try {
      const written = await settingsSave(get().settings);
      // 回执是「实际落盘值」（可能已钳制），以它为准
      set({ settings: written, saving: false, saveError: null });
    } catch (e) {
      set({
        saving: false,
        saveError: `保存设置失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },

  reset: async () => {
    cancelPendingSave();
    try {
      const defaults = await settingsReset();
      set({ settings: defaults, saveError: null });
    } catch (e) {
      set({ saveError: `恢复默认失败：${e instanceof Error ? e.message : String(e)}` });
    }
  },
}));

/** 测试 / 退出前清掉待落盘的计时器 */
export function cancelPendingSettingsSave(): void {
  cancelPendingSave();
}

/** 当前设置解析出的快捷键绑定（命令 ID → 最终键位） */
export function useBindings(): Map<string, ResolvedBinding> {
  const shortcuts = useSettingsStore((s) => s.settings.shortcuts);
  return resolveBindings(shortcuts);
}
