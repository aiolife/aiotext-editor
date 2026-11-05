/**
 * 本地历史（PRD §3.12）——纯决策层，零 DOM / 零 Tauri，可在 node 环境单测。
 *
 * 这里只回答「该不该写、写哪条、淘汰哪些、清除哪些」，所有 IO 交给
 * `platform/localHistoryApi.ts` 与 `store/localHistoryStore.ts`。
 * 类型与后端 `core/local_history.rs` 的 serde 形状一一对应（见契约测试）。
 */

export type HistoryTrigger = 'auto' | 'save' | 'switch-doc' | 'pre-restore' | 'manual';

/** 与 `tauriApi.LocalHistorySettings` / Rust `LocalHistorySettings` 同形 */
export interface HistoryOptions {
  enabled: boolean;
  debounceMs: number;
  mergeWindowMs: number;
  retentionDays: number;
  maxPerDoc: number;
  maxTotalBytes: number;
  largeDocChars: number;
}

/** 默认关闭：项目设计哲学是「一切写盘需用户明确触发」 */
export const DEFAULT_HISTORY_OPTIONS: HistoryOptions = {
  enabled: false,
  debounceMs: 30_000,
  mergeWindowMs: 10_000,
  retentionDays: 7,
  maxPerDoc: 20,
  maxTotalBytes: 50 * 1024 * 1024,
  largeDocChars: 1_000_000,
};

export const SCHEMA_VERSION = 1;
/** 淘汰时至少保住最近这么多条未提交快照（不暴露给用户） */
export const KEEP_RECENT_UNCOMMITTED = 10;

export interface SnapshotMeta {
  id: string;
  ts: number;
  trigger: HistoryTrigger;
  label?: string;
  hash: string;
  /** UTF-8 字节数 */
  size: number;
  schemaVersion: number;
  /** 已成功保存到磁盘的基线 */
  committed: boolean;
  /** 用户置顶，永不自动淘汰 */
  pinned: boolean;
  /** 以下三项保证恢复后再次保存逐字节一致 */
  encoding: string;
  hadBom: boolean;
  lineEnding: 'lf' | 'cr' | 'crlf';
}

export type Snapshot = SnapshotMeta & { path: string; content: string };
export type MetaPatch = Partial<Pick<SnapshotMeta, 'pinned' | 'committed' | 'label'>>;
export type EncodingMeta = Pick<SnapshotMeta, 'encoding' | 'hadBom' | 'lineEnding'>;

export type SkipReason =
  | 'disabled'
  | 'no-path'
  | 'empty-doc'
  | 'duplicate'
  | 'large-doc-auto';

export type CaptureResult =
  | { status: 'created'; id: string }
  | { status: 'merged'; id: string }
  | { status: 'skipped'; reason: SkipReason };

export type CaptureDecision =
  | { action: 'skip'; reason: SkipReason }
  | { action: 'merge'; id: string }
  | { action: 'create'; id: string };

export interface EmergencyDraft {
  path: string;
  content: string;
  ts: number;
}

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** `crypto.subtle` 不可用时的降级指纹：非加密用途，只用于去重。 */
function fallbackHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619) >>> 0;
    b = Math.imul(b ^ (code >>> 8), 16777619) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return `${hex(a)}${hex(b)}${hex(text.length)}${hex(a ^ b)}`;
}

/** SHA-256 前 16 字节（32 hex）；WebView2 无 secure context 时自动降级。 */
export async function contentHash(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fallbackHash(text);
  try {
    const digest = await subtle.digest('SHA-256', encoder.encode(text));
    return Array.from(new Uint8Array(digest).slice(0, 16), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join('');
  } catch {
    return fallbackHash(text);
  }
}

export interface CaptureContext {
  enabled: boolean;
  hasPath: boolean;
  content: string;
  trigger: HistoryTrigger;
  last: SnapshotMeta | undefined;
  hash: string;
  size: number;
  now: number;
  opts: HistoryOptions;
  /** `markCommitted` / `pre-restore` 用：绕过去重，必须留一条 */
  force?: boolean;
}

/**
 * 单次捕获的决策。大文档**降频**（超大时不做 auto）而不是跳过——
 * 通用原型那套 256KB 硬跳过会让项目 100 万字目标场景完全失效。
 */
export function decideCapture(ctx: CaptureContext): CaptureDecision {
  if (!ctx.enabled) return { action: 'skip', reason: 'disabled' };
  if (!ctx.hasPath) return { action: 'skip', reason: 'no-path' };
  if (ctx.content.length === 0) return { action: 'skip', reason: 'empty-doc' };
  if (
    ctx.trigger === 'auto' &&
    ctx.content.length > ctx.opts.largeDocChars
  ) {
    return { action: 'skip', reason: 'large-doc-auto' };
  }
  if (
    !ctx.force &&
    ctx.last &&
    ctx.last.hash === ctx.hash &&
    ctx.last.size === ctx.size
  ) {
    return { action: 'skip', reason: 'duplicate' };
  }
  if (
    !ctx.force &&
    ctx.trigger === 'auto' &&
    ctx.last &&
    ctx.last.trigger === 'auto' &&
    !ctx.last.pinned &&
    !ctx.last.committed &&
    ctx.now - ctx.last.ts < ctx.opts.mergeWindowMs
  ) {
    // 合并窗口内复用同一条：连续打字不会长出几十份快照
    return { action: 'merge', id: ctx.last.id };
  }
  return {
    action: 'create',
    id: `${ctx.now.toString(36)}-${ctx.hash.slice(0, 8)}`,
  };
}

/**
 * 单档淘汰计划：TTL → 条数上限。
 *
 * 原型的实现把「全局总字节」与「单档条数」混在同一条循环里判断，会出现
 * 别的文档撑爆总量时、本档只有一条也被反复尝试淘汰的情况。这里只管单档，
 * 全局上限由 store 读取 `history_total_bytes` 后单独提示。
 */
export function planEviction(
  items: SnapshotMeta[],
  opts: HistoryOptions,
  now: number,
): string[] {
  const sorted = [...items].sort((a, b) => a.ts - b.ts);
  // 分两级保护：pinned 与最近一条已保存基线是「硬保护」，连 TTL 都不删；
  // 最近 N 条未提交只是「软保护」，只挡条数淘汰。
  // 若把三者混成一份 protectedIds，快照总数 < N 时所有条目都受保护，
  // 7 天保留期就永远不会生效（通用原型正是这么写的）。
  const hardProtected = new Set<string>();
  const softProtected = new Set<string>();
  for (const item of sorted) {
    if (item.pinned) hardProtected.add(item.id);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].committed) {
      hardProtected.add(sorted[i].id);
      break;
    }
  }
  for (const item of sorted.slice(-KEEP_RECENT_UNCOMMITTED)) {
    softProtected.add(item.id);
  }

  const toRemove: string[] = [];
  const ttlMs = opts.retentionDays * 24 * 60 * 60 * 1000;
  for (const item of sorted) {
    if (!hardProtected.has(item.id) && now - item.ts > ttlMs) {
      toRemove.push(item.id);
    }
  }
  let remaining = sorted.length - toRemove.length;
  for (const item of sorted) {
    if (remaining <= opts.maxPerDoc) break;
    if (
      hardProtected.has(item.id) ||
      softProtected.has(item.id) ||
      toRemove.includes(item.id)
    ) {
      continue;
    }
    toRemove.push(item.id);
    remaining--;
  }
  return toRemove;
}

/** 三选对话框的决策 → 需要彻底清除历史的路径。取消 / 保存一律不清。 */
export function planClear(
  decision: 'save' | 'discard' | 'cancel',
  paths: (string | null)[],
): string[] {
  if (decision !== 'discard') return [];
  return paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/**
 * 快照的默认标签。单列成表而不是散在各处硬编码：
 * `messages.ts` 要把它注册进批量转繁體的输入源，否则繁體界面的时间线
 * 会漏出简体（PRD L-1 / §3.6）。
 */
export const HISTORY_LABELS = {
  auto: '自动快照',
  save: '已保存基线',
  'switch-doc': '切换文档',
  'pre-restore': '恢复前存档',
  manual: '手动快照',
  emergency: '异常退出前的草稿',
} as const;

export function triggerLabel(trigger: HistoryTrigger): string {
  return HISTORY_LABELS[trigger];
}
