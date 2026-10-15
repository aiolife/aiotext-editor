/**
 * 全局提示（Toast）队列（第九阶段：稳定性 + 收口）
 *
 * 第八阶段之前，应用的提示是 `App.tsx` 里的**两个单槽 state**（`error` / `notice`），
 * 渲染成正文顶部的一条横幅：同一时刻只能有一条，且后一条会**直接顶掉**前一条
 * （比如「保存成功」刚出现就被紧随其后的「替换表读取失败」覆盖）。
 *
 * 第九阶段改为**队列 + 级别**：
 *
 * - 多条可同时在屏（右上角堆叠，最新的在最下），互不覆盖；
 * - 四个级别（`info` / `success` / `warn` / `error`），颜色与语义分开；
 * - 自动消失：普通 4s、**错误 8s**（错误更该看清），也可手动关掉；
 * - 消息为空串时不入队——沿用旧横幅「空字符串 = 什么都不显示」的用法，
 *   调用点不必到处写 `if (msg)`。
 *
 * 队列长度有上限（[`MAX_TOASTS`]），超出丢**最旧**的一条：刷屏时用户最该看的是
 * 「刚刚发生了什么」，而不是十秒前那条。
 *
 * 纯状态层，不碰 DOM，可在 node 环境下直接单测；渲染见 `components/ToastHost.tsx`。
 */
import { create } from 'zustand';

/** 提示级别（决定颜色与默认停留时长） */
export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

/** 一条提示 */
export interface ToastItem {
  /** 自增 ID，也用作 React key 与关闭时的定位依据 */
  id: number;
  level: ToastLevel;
  message: string;
  /** 自动消失毫秒数；`0` 表示不自动消失（只能手动关） */
  timeoutMs: number;
}

/** 普通提示停留时长 */
export const DEFAULT_TIMEOUT_MS = 4000;
/** 错误提示停留时长（给用户留出阅读与截图的时间） */
export const ERROR_TIMEOUT_MS = 8000;
/** 同屏最多几条；超出丢最旧的 */
export const MAX_TOASTS = 4;

interface ToastState {
  toasts: ToastItem[];
  /** 入队；`message` 为空串时返回 `0` 且不入队。返回条目 ID（0 表示未入队） */
  push: (level: ToastLevel, message: string, timeoutMs?: number) => number;
  /** 关掉某条 */
  dismiss: (id: number) => void;
  /** 全部清空 */
  clear: () => void;
}

/** 各级别的默认停留时长 */
export function defaultTimeout(level: ToastLevel): number {
  return level === 'error' ? ERROR_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push: (level, message, timeoutMs) => {
    const text = message.trim();
    if (text === '') return 0;
    const id = nextId++;
    const item: ToastItem = { id, level, message: text, timeoutMs: timeoutMs ?? defaultTimeout(level) };
    set((s) => {
      const next = [...s.toasts, item];
      // 只保留最新 MAX_TOASTS 条（丢最旧的）
      return { toasts: next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next };
    });
    return id;
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  clear: () => set({ toasts: [] }),
}));

/**
 * 免 hook 的便捷入口（可在事件回调、非组件模块里直接调用）。
 *
 * 组件里若要渲染队列，请用 `useToastStore`；只是想「弹一条」时用这个即可。
 */
export const toast = {
  info: (message: string, timeoutMs?: number) => useToastStore.getState().push('info', message, timeoutMs),
  success: (message: string, timeoutMs?: number) =>
    useToastStore.getState().push('success', message, timeoutMs),
  warn: (message: string, timeoutMs?: number) => useToastStore.getState().push('warn', message, timeoutMs),
  error: (message: string, timeoutMs?: number) => useToastStore.getState().push('error', message, timeoutMs),
};
