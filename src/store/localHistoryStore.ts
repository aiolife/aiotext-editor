/**
 * 本地历史服务（PRD §3.12）
 *
 * 调度 / 串行化 / emergency 兜底都在模块级，zustand 只持有 UI 状态。
 * 所有写操作经 `enqueue` 串行，避免连续事件与切文档造成乱序或重复清理。
 *
 * 关键契约：
 * - 默认关闭；`setOptions` 由设置变化驱动。
 * - **恢复只回编辑器内存**（`binding.write`），永不写磁盘；恢复前先留
 *   `pre-restore` 存档，因此恢复本身可回退。
 * - 选了「不保存」时 `clearFor` 会连 emergency 草稿一起清掉。
 */
import { create } from 'zustand';
import {
  compareDiff,
  DEFAULT_COMPARE_OPTIONS,
  type DiffResult,
} from '../platform/tauriApi';
import * as api from '../platform/localHistoryApi';
import {
  DEFAULT_HISTORY_OPTIONS,
  HISTORY_LABELS,
  SCHEMA_VERSION,
  byteLength,
  contentHash,
  decideCapture,
  planEviction,
  type CaptureResult,
  type EmergencyDraft,
  type EncodingMeta,
  type HistoryOptions,
  type HistoryTrigger,
  type Snapshot,
  type SnapshotMeta,
} from '../shared/localHistory';
import { useToastStore } from './toastStore';

/** diff 面板需要的完整视图：两侧原文 + 后端的 UTF-16 偏移差异块 */
export interface LocalHistoryDiff {
  snapshot: string;
  current: string;
  result: DiffResult;
}

export interface HistoryBinding {
  path: string;
  /** 读编辑器当前全文 */
  read: () => string;
  /** 读当前 tab 的编码 / BOM / 行尾元数据 */
  meta: () => EncodingMeta;
  /** 恢复：把内容写回编辑器并标 dirty（P3 注入 useTabsStore.setContent） */
  write: (content: string) => void;
}

interface LocalHistoryState {
  enabled: boolean;
  path: string | null;
  items: SnapshotMeta[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  setOptions: (opts: HistoryOptions) => void;
  bind: (binding: HistoryBinding | null) => void;
  markDirty: () => void;
  flush: () => void;
  capture: (trigger: HistoryTrigger, label?: string) => Promise<CaptureResult>;
  markCommitted: () => Promise<CaptureResult>;
  refresh: () => Promise<void>;
  /** 打开面板时把上次异常退出的 emergency 草稿补记成一条可对比 / 可恢复的快照 */
  absorbEmergency: () => Promise<void>;
  diffWithCurrent: (id: string) => Promise<LocalHistoryDiff | null>;
  restore: (id: string) => Promise<void>;
  pin: (id: string, pinned: boolean) => Promise<void>;
  /** 选「不保存 / 全部不保存」时调用；返回清除失败的路径 */
  clearFor: (paths: string[]) => Promise<string[]>;
  clearAll: () => Promise<void>;
  takeEmergency: (path: string) => EmergencyDraft | null;
  setSelected: (id: string | null) => void;
  whenIdle: () => Promise<void>;
}

const EMERGENCY_PREFIX = 'aiotext-lh:emergency:';
const EMERGENCY_MAX_BYTES = 64 * 1024;

let binding: HistoryBinding | null = null;
let options: HistoryOptions = { ...DEFAULT_HISTORY_OPTIONS };
let timer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function emergencyKey(path: string): string {
  return `${EMERGENCY_PREFIX}${encodeURIComponent(path)}`;
}

/** 同步兜底：主存储还没写完就退出时，仍能从 localStorage 找回最近一次内容。 */
function writeEmergency(target: HistoryBinding): void {
  if (!options.enabled || typeof localStorage === 'undefined') return;
  try {
    const content = target.read();
    if (content.length === 0 || byteLength(content) > EMERGENCY_MAX_BYTES) return;
    localStorage.setItem(
      emergencyKey(target.path),
      JSON.stringify({ path: target.path, content, ts: Date.now() }),
    );
  } catch {
    // 配额不足时忽略，主存储仍有效
  }
}

/** 只读草稿、不消耗；`takeEmergency` 与 `absorbEmergency` 共用 */
function peekEmergency(path: string): EmergencyDraft | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(emergencyKey(path));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as EmergencyDraft;
    if (typeof parsed.content !== 'string' || parsed.path !== path) return null;
    return parsed;
  } catch {
    return null;
  }
}

function removeEmergency(paths: string[]): void {
  if (typeof localStorage === 'undefined') return;
  for (const path of paths) {
    try {
      localStorage.removeItem(emergencyKey(path));
    } catch {
      // 忽略
    }
  }
}

function clearAllEmergency(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(EMERGENCY_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // 忽略
  }
}

async function enforceLimits(path: string): Promise<void> {
  const items = await api.historyList(path);
  const ids = planEviction(items, options, Date.now());
  if (ids.length > 0) await api.historyRemove(path, ids);
  // 全局上限由这里统一观测：跨文档删除风险太大，超限时明确提示用户手动清理。
  const total = await api.historyTotalBytes();
  if (total > options.maxTotalBytes) {
    useToastStore
      .getState()
      .push('warn', '本地历史已达容量上限，可在历史面板中清空');
  }
}

async function doCapture(
  target: HistoryBinding,
  trigger: HistoryTrigger,
  label?: string,
  force = false,
): Promise<CaptureResult> {
  if (!options.enabled) return { status: 'skipped', reason: 'disabled' };
  const content = target.read();
  const size = byteLength(content);
  const hash = await contentHash(content);
  const items = await api.historyList(target.path);
  const last = items.length > 0 ? items[items.length - 1] : undefined;
  const decision = decideCapture({
    enabled: options.enabled,
    hasPath: true,
    content,
    trigger,
    last,
    hash,
    size,
    now: Date.now(),
    opts: options,
    force,
  });
  if (decision.action === 'skip') {
    return { status: 'skipped', reason: decision.reason };
  }

  const meta = target.meta();
  const snapshot: Snapshot = {
    id: decision.id,
    ts: Date.now(),
    trigger,
    label,
    hash,
    size,
    schemaVersion: SCHEMA_VERSION,
    committed: trigger === 'save',
    pinned: false,
    encoding: meta.encoding,
    hadBom: meta.hadBom,
    lineEnding: meta.lineEnding,
    path: target.path,
    content,
  };
  await api.historyWrite(snapshot);
  await enforceLimits(target.path);
  return {
    status: decision.action === 'merge' ? 'merged' : 'created',
    id: decision.id,
  };
}

async function refreshInto(
  set: (patch: Partial<LocalHistoryState>) => void,
): Promise<void> {
  // 默认关闭时连读盘都不做：功能关掉就等于这块存储不存在
  if (!binding || !options.enabled) {
    set({ items: [], loading: false, error: null });
    return;
  }
  set({ loading: true });
  const target = binding;
  try {
    const items = await api.historyList(target.path);
    if (binding === target) set({ items, loading: false, error: null });
  } catch (e) {
    if (binding === target) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

export const useLocalHistoryStore = create<LocalHistoryState>((set, get) => ({
  enabled: false,
  path: null,
  items: [],
  selectedId: null,
  loading: false,
  error: null,

  setOptions: (opts) => {
    options = { ...opts };
    set({ enabled: opts.enabled });
    if (!opts.enabled) {
      dirty = false;
      clearTimer();
    }
  },

  bind: (next) => {
    const previous = binding;
    // 切文档前给旧文档留一条强快照，避免切换期间的改动没被记下
    if (previous && options.enabled && dirty && previous.path !== next?.path) {
      writeEmergency(previous);
      void enqueue(() => doCapture(previous, 'switch-doc'));
    }
    dirty = false;
    clearTimer();
    binding = next;
    set({ path: next?.path ?? null, items: [], selectedId: null, error: null });
    void refreshInto(set);
  },

  markDirty: () => {
    if (!options.enabled || !binding) return;
    dirty = true;
    clearTimer();
    timer = setTimeout(() => get().flush(), options.debounceMs);
  },

  flush: () => {
    if (!options.enabled || !binding || !dirty) return;
    dirty = false;
    clearTimer();
    writeEmergency(binding);
    void get().capture('auto');
  },

  capture: (trigger, label) =>
    enqueue(async () => {
      if (!binding) return { status: 'skipped', reason: 'no-path' } as CaptureResult;
      return doCapture(binding, trigger, label);
    }),

  markCommitted: () =>
    enqueue(async () => {
      if (!binding) return { status: 'skipped', reason: 'no-path' } as CaptureResult;
      // 保存成功后才写基线；失败时不要调用，快照保持「未提交」正是要保护的对象
      return doCapture(binding, 'save', HISTORY_LABELS.save, true);
    }),

  refresh: () => refreshInto(set),

  /**
   * 上次「写盘没赶上就退出」留下的草稿，在用户主动打开面板时补记成一条快照。
   *
   * 故意不把草稿直接塞回编辑器：那等于自动复活内容，违背「本地历史只在用户
   * 主动查看时可见」的口径。补成快照后由用户自己决定对比还是恢复。
   */
  absorbEmergency: () =>
    enqueue(async () => {
      if (options.enabled && binding) {
        const target = binding;
        const draft = peekEmergency(target.path);
        if (draft && draft.content.length > 0) {
          const hash = await contentHash(draft.content);
          const size = byteLength(draft.content);
          const items = await api.historyList(target.path);
          // 主存储其实写成功了就别重复补；草稿无论哪种情况都消费掉
          if (!items.some((item) => item.hash === hash && item.size === size)) {
            const meta = target.meta();
            const snapshot: Snapshot = {
              id: `em-${draft.ts.toString(36)}-${hash.slice(0, 8)}`,
              ts: draft.ts,
              trigger: 'manual',
              label: HISTORY_LABELS.emergency,
              hash,
              size,
              schemaVersion: SCHEMA_VERSION,
              committed: false,
              pinned: false,
              encoding: meta.encoding,
              hadBom: meta.hadBom,
              lineEnding: meta.lineEnding,
              path: target.path,
              content: draft.content,
            };
            await api.historyWrite(snapshot);
            await enforceLimits(target.path);
          }
          removeEmergency([target.path]);
        }
      }
      await refreshInto(set);
    }),

  diffWithCurrent: async (id) => {
    if (!binding) return null;
    const target = binding;
    const snapshot = await api.historyRead(target.path, id);
    if (snapshot === null) return null;
    const current = target.read();
    const result = await compareDiff(snapshot, current, { ...DEFAULT_COMPARE_OPTIONS });
    return { snapshot, current, result };
  },

  restore: (id) =>
    enqueue(async () => {
      if (!binding) throw new Error('没有正在编辑的文件');
      const target = binding;
      const content = await api.historyRead(target.path, id);
      if (content === null) throw new Error('快照不存在或已被清理');
      // 先把当前内容存档，恢复本身因此可回退
      await doCapture(target, 'pre-restore', HISTORY_LABELS['pre-restore'], true);
      target.write(content);
      // setContent 走的是 store → Editor 的同步路径，不经过 onContentChange，
      // 所以调度器要显式知道「恢复后的内容也还没存过」，下次空闲时补一条。
      get().markDirty();
      await refreshInto(set);
    }),

  pin: async (id, pinned) => {
    if (!binding) return;
    await api.historyUpdate(binding.path, id, { pinned });
    await refreshInto(set);
  },

  clearFor: (paths) =>
    enqueue(async () => {
      const failed = await api.historyClear(paths);
      removeEmergency(paths);
      if (failed.length > 0) {
        useToastStore
          .getState()
          .push('error', `本地历史清理失败（${failed.length} 个文件），可在历史面板中手动清空`);
      }
      await refreshInto(set);
      return failed;
    }),

  clearAll: async () => {
    clearAllEmergency();
    const failed = await api.historyClear([]);
    if (failed.length > 0) {
      useToastStore.getState().push('error', '清空本地历史失败');
    }
    await refreshInto(set);
  },

  takeEmergency: (path) => {
    const draft = peekEmergency(path);
    if (draft !== null) removeEmergency([path]);
    return draft;
  },

  setSelected: (id) => set({ selectedId: id }),
  whenIdle: () => queue.then(() => undefined),
}));
