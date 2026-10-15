import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEOUT_MS,
  ERROR_TIMEOUT_MS,
  MAX_TOASTS,
  defaultTimeout,
  toast,
  useToastStore,
} from './toastStore';

const state = () => useToastStore.getState();
const messages = () => state().toasts.map((t) => t.message);

beforeEach(() => {
  state().clear();
});

describe('Toast 队列', () => {
  it('入队后保留 level / message / timeout 并返回 ID', () => {
    const id = state().push('success', '已保存');
    expect(id).toBeGreaterThan(0);
    expect(state().toasts).toHaveLength(1);
    expect(state().toasts[0]).toMatchObject({
      id,
      level: 'success',
      message: '已保存',
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  it('空消息（含纯空白）不入队，返回 0', () => {
    expect(state().push('info', '')).toBe(0);
    expect(state().push('info', '   ')).toBe(0);
    expect(state().toasts).toHaveLength(0);
  });

  it('消息两端空白被修剪', () => {
    state().push('info', '  已复制  ');
    expect(messages()).toEqual(['已复制']);
  });

  it('error 级默认停留更久（8s vs 4s）', () => {
    expect(defaultTimeout('error')).toBe(ERROR_TIMEOUT_MS);
    expect(defaultTimeout('info')).toBe(DEFAULT_TIMEOUT_MS);
    state().push('error', '打开失败');
    expect(state().toasts[0].timeoutMs).toBe(ERROR_TIMEOUT_MS);
  });

  it('可显式指定停留时长（0 = 不自动消失）', () => {
    state().push('info', '常驻', 0);
    expect(state().toasts[0].timeoutMs).toBe(0);
  });

  it('多条可同时在屏，互不覆盖（旧横幅会被顶掉）', () => {
    state().push('success', 'A');
    state().push('error', 'B');
    expect(messages()).toEqual(['A', 'B']);
  });

  it('超出上限时丢最旧的', () => {
    for (let i = 1; i <= MAX_TOASTS + 2; i += 1) state().push('info', `M${i}`);
    expect(state().toasts).toHaveLength(MAX_TOASTS);
    expect(messages()).toEqual(['M3', 'M4', 'M5', 'M6']);
  });

  it('dismiss 只移除指定条目', () => {
    const a = state().push('info', 'A');
    state().push('info', 'B');
    state().dismiss(a);
    expect(messages()).toEqual(['B']);
  });

  it('clear 清空全部', () => {
    state().push('info', 'A');
    state().push('error', 'B');
    state().clear();
    expect(state().toasts).toHaveLength(0);
  });

  it('toast 便捷入口对应各自级别', () => {
    toast.info('i');
    toast.success('s');
    toast.warn('w');
    toast.error('e');
    expect(state().toasts.map((t) => t.level)).toEqual(['info', 'success', 'warn', 'error']);
  });
});
