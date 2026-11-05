/**
 * 本地历史 IPC（PRD §3.12）
 *
 * 沿用 `tauriApi.ts` 的惯例：每个导出函数各自 `invoke`，前端 camelCase、
 * 命令 snake_case。前端一律传**真实文件路径**，路径 → 安全 docId 的映射
 * 由 Rust `core/local_history.rs` 的 `docs.json` 负责。
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  MetaPatch,
  Snapshot,
  SnapshotMeta,
} from '../shared/localHistory';

export function historyList(path: string): Promise<SnapshotMeta[]> {
  return invoke<SnapshotMeta[]>('history_list', { path });
}

export function historyRead(path: string, id: string): Promise<string | null> {
  return invoke<string | null>('history_read', { path, id });
}

export function historyWrite(snapshot: Snapshot): Promise<void> {
  return invoke<void>('history_write', { input: snapshot });
}

export function historyUpdate(
  path: string,
  id: string,
  patch: MetaPatch,
): Promise<void> {
  return invoke<void>('history_update', { path, id, patch });
}

/** 返回删除失败的 id（空数组 = 全成功） */
export function historyRemove(path: string, ids: string[]): Promise<string[]> {
  return invoke<string[]>('history_remove', { path, ids });
}

/**
 * 彻底清除。`paths` 为空 = 清空全部（连路径映射一起删）。
 * 返回删除失败的路径，供上层 toast 提示。
 */
export function historyClear(paths: string[]): Promise<string[]> {
  return invoke<string[]>('history_clear', { paths });
}

/** 实际占用字节（按真实 .snap 文件统计，含孤儿） */
export function historyTotalBytes(): Promise<number> {
  return invoke<number>('history_total_bytes');
}
