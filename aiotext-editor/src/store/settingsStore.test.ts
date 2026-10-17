/**
 * F-11 设置 store 单测
 *
 * 重点在「改动即存」这条链路：防抖合并、以及**把服务端回执灌回 store**
 * （后端会钳制 `fontSize` / `tabWidth`，界面必须显示磁盘真值而不是用户输入值）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../platform/tauriApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/tauriApi')>();
  return {
    ...actual,
    settingsGet: vi.fn(),
    settingsSave: vi.fn(),
    settingsReset: vi.fn(),
  };
});

import { settingsGet, settingsReset, settingsSave, type Settings } from '../platform/tauriApi';
import {
  DEFAULT_SETTINGS,
  SAVE_DEBOUNCE_MS,
  cancelPendingSettingsSave,
  useSettingsStore,
} from './settingsStore';

const getMock = vi.mocked(settingsGet);
const saveMock = vi.mocked(settingsSave);
const resetMock = vi.mocked(settingsReset);

/** 造一份「服务端返回」的设置（可覆盖若干字段） */
function settingsWith(patch: Partial<Settings> = {}): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...patch };
}

beforeEach(() => {
  vi.useFakeTimers();
  cancelPendingSettingsSave();
  getMock.mockReset();
  saveMock.mockReset();
  resetMock.mockReset();
  useSettingsStore.setState({
    settings: structuredClone(DEFAULT_SETTINGS),
    loaded: false,
    saveError: null,
    saving: false,
  });
});

afterEach(() => {
  cancelPendingSettingsSave();
  vi.useRealTimers();
});

describe('载入', () => {
  it('load 把服务端设置写进 store 并标记已载入', async () => {
    getMock.mockResolvedValue(settingsWith({ appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'dark' } }));
    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.settings.appearance.theme).toBe('dark');
    expect(s.saveError).toBeNull();
  });

  it('load 失败也标记已载入（界面不能因为读设置失败就卡白屏）', async () => {
    getMock.mockRejectedValue(new Error('IPC 挂了'));
    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.saveError).toContain('IPC 挂了');
    // 设置保持默认值可用
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe('改动即存（防抖）', () => {
  it('连续改动只落盘一次，且落盘的是合并后的最终值', async () => {
    saveMock.mockImplementation(async (s: Settings) => s);
    const { update } = useSettingsStore.getState();
    update({ appearance: { ...DEFAULT_SETTINGS.appearance, fontSize: 16 } });
    await vi.advanceTimersByTimeAsync(100);
    update({ appearance: { ...DEFAULT_SETTINGS.appearance, fontSize: 18 } });
    await vi.advanceTimersByTimeAsync(100);
    update({ editor: { ...DEFAULT_SETTINGS.editor, wrap: true } });

    expect(saveMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    expect(saveMock).toHaveBeenCalledTimes(1);
    const sent = saveMock.mock.calls[0][0];
    expect(sent.appearance.fontSize).toBe(18);
    expect(sent.editor.wrap).toBe(true);
  });

  it('多个小节互不干扰（浅合并只替换被改的那节）', async () => {
    saveMock.mockImplementation(async (s: Settings) => s);
    useSettingsStore.getState().update({
      editor: { ...DEFAULT_SETTINGS.editor, tabWidth: 2 },
    });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    const s = useSettingsStore.getState().settings;
    expect(s.editor.tabWidth).toBe(2);
    // 没碰过的小节原样保留
    expect(s.appearance).toEqual(DEFAULT_SETTINGS.appearance);
    expect(s.shortcuts).toEqual({});
  });

  it('服务端钳制后的回执会灌回 store（界面显示磁盘真值）', async () => {
    // 用户输入 999，后端钳到 32 后返回
    saveMock.mockImplementation(async (s: Settings) =>
      settingsWith({ appearance: { ...s.appearance, fontSize: 32, fontFamily: '回落到默认' } }),
    );
    useSettingsStore.getState().update({
      appearance: { ...DEFAULT_SETTINGS.appearance, fontSize: 999 },
    });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    const s = useSettingsStore.getState();
    expect(s.settings.appearance.fontSize).toBe(32);
    expect(s.settings.appearance.fontFamily).toBe('回落到默认');
    expect(s.saving).toBe(false);
    expect(s.saveError).toBeNull();
  });

  it('落盘失败会把原因留在 saveError，且不清空用户改动', async () => {
    saveMock.mockRejectedValue(new Error('磁盘满了'));
    useSettingsStore.getState().update({
      appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'dark' },
    });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    const s = useSettingsStore.getState();
    expect(s.saveError).toContain('磁盘满了');
    expect(s.saving).toBe(false);
    // 用户的改动仍在内存里，界面不会跳回去
    expect(s.settings.appearance.theme).toBe('dark');
  });

  it('没有改动时 flush 不发请求（关闭设置对话框时的空转）', async () => {
    await useSettingsStore.getState().flush();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('flush 立即落盘，不等防抖计时器', async () => {
    saveMock.mockImplementation(async (s: Settings) => s);
    useSettingsStore.getState().update({
      appearance: { ...DEFAULT_SETTINGS.appearance, fontSize: 20 },
    });
    // 计时器还没到就 flush
    await useSettingsStore.getState().flush();
    expect(saveMock).toHaveBeenCalledTimes(1);
    // 之后再等也不会有第二次（计时器已被取消）
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    expect(saveMock).toHaveBeenCalledTimes(1);
  });
});

describe('恢复默认', () => {
  it('reset 调命令并把返回值放进 store', async () => {
    resetMock.mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
    useSettingsStore.getState().update({
      appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'dark' },
    });
    await useSettingsStore.getState().reset();
    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('reset 会取消待落盘的改动（避免复位后又被旧值覆盖）', async () => {
    saveMock.mockImplementation(async (s: Settings) => s);
    resetMock.mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
    useSettingsStore.getState().update({
      appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'dark' },
    });
    await useSettingsStore.getState().reset();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    expect(saveMock).not.toHaveBeenCalled();
  });
});
