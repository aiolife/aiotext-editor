/**
 * 多标签 store 单测（mock Tauri invoke）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabsStore } from './tabsStore';
import type { LoadResult, SaveOptions, SaveReport, UnmappableChar } from '../platform/tauriApi';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function makeLoaded(text = '内容', encoding = 'gbk'): LoadResult {
  return { text, encoding, hadBom: false, lineEnding: 'lf' };
}

/** 保存前预检 mock：encoding 非 Unicode 时返回 unmappable */
function setupInvoke({
  unmappable = [] as UnmappableChar[],
  loadEncoding = 'gbk',
}: { unmappable?: UnmappableChar[]; loadEncoding?: string } = {}) {
  invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case 'fs_read':
        return Promise.resolve(makeLoaded('文件内容', loadEncoding));
      case 'fs_read_with':
        return Promise.resolve(makeLoaded('重载内容', String(args.encodingLabel)));
      case 'fs_check_mappable':
        return Promise.resolve(
          args.encodingLabel === 'utf-8' ? [] : unmappable,
        );
      case 'fs_write': {
        const opts = args.opts as SaveOptions;
        const report: SaveReport = {
          writtenPath: String(args.path),
          bytesWritten: 16,
          actualEncoding: opts.unmappable === 'toutf8' ? 'utf-8' : opts.encoding,
          charRefsWritten: 0,
        };
        return Promise.resolve(report);
      }
      default:
        return Promise.reject(new Error(`unknown command: ${cmd}`));
    }
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  useTabsStore.setState({ tabs: [], activeTabId: null });
});

describe('新建与打开', () => {
  it('newTab 创建空标签并激活', () => {
    setupInvoke();
    const id = useTabsStore.getState().newTab();
    const s = useTabsStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe(id);
    const tab = s.tabs[0];
    expect(tab.filePath).toBeNull();
    expect(tab.encoding).toBe('utf-8');
    expect(tab.dirty).toBe(false);
  });

  it('openFile 经 fs_read 建标签', async () => {
    setupInvoke();
    const { tabId, reused } = await useTabsStore.getState().openFile('C:/a/gbk.txt');
    expect(reused).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith('fs_read', { path: 'C:/a/gbk.txt' });
    const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
    expect(tab).toMatchObject({
      filePath: 'C:/a/gbk.txt',
      fileName: 'gbk.txt',
      content: '文件内容',
      encoding: 'gbk',
    });
  });

  it('同一路径再次打开 → 复用标签', async () => {
    setupInvoke();
    const first = await useTabsStore.getState().openFile('C:/a/x.txt');
    const second = await useTabsStore.getState().openFile('C:/a/x.txt');
    expect(second.reused).toBe(true);
    expect(second.tabId).toBe(first.tabId);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });
});

describe('编辑与关闭', () => {
  it('setContent 标记 dirty', async () => {
    setupInvoke();
    const { tabId } = await useTabsStore.getState().openFile('C:/a/x.txt');
    useTabsStore.getState().setContent(tabId, '修改后');
    const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
    expect(tab?.dirty).toBe(true);
    expect(tab?.content).toBe('修改后');
  });

  it('closeTab 激活相邻标签', async () => {
    setupInvoke();
    const a = await useTabsStore.getState().openFile('C:/a/1.txt');
    const b = await useTabsStore.getState().openFile('C:/a/2.txt');
    const c = await useTabsStore.getState().openFile('C:/a/3.txt');
    expect(useTabsStore.getState().activeTabId).toBe(c.tabId);
    useTabsStore.getState().closeTab(c.tabId);
    // 关闭当前激活标签 → 落到相邻
    expect(useTabsStore.getState().activeTabId).toBe(b.tabId);
    useTabsStore.getState().closeTab(a.tabId);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });
});

describe('保存', () => {
  it('Unicode 编码直接保存，清除 dirty', async () => {
    setupInvoke();
    const { tabId } = await useTabsStore.getState().openFile('C:/a/x.txt');
    useTabsStore.getState().setContent(tabId, '新内容');
    const askUser = vi.fn();
    const ok = await useTabsStore.getState().saveTab(tabId, askUser);
    expect(ok).toBe(true);
    expect(askUser).not.toHaveBeenCalled(); // gbk 文件内容可编码 → 不弹窗
    expect(invokeMock).toHaveBeenCalledWith(
      'fs_write',
      expect.objectContaining({
        path: 'C:/a/x.txt',
        text: '新内容',
      }),
    );
    expect(useTabsStore.getState().tabs.find((t) => t.id === tabId)?.dirty).toBe(false);
  });

  it('不可编码时经 askUser 决策 charref 写出', async () => {
    setupInvoke({
      unmappable: [{ position: 0, character: '发' }],
    });
    const { tabId } = await useTabsStore.getState().openFile('C:/a/big5.txt');
    const askUser = vi.fn().mockResolvedValue('charref' as const);
    const ok = await useTabsStore.getState().saveTab(tabId, askUser);
    expect(ok).toBe(true);
    expect(askUser).toHaveBeenCalledTimes(1);
    const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'fs_write');
    expect(call?.[1]).toMatchObject({
      opts: expect.objectContaining({ unmappable: 'charref' }),
    });
  });

  it('用户取消 → 不写盘且保持 dirty', async () => {
    setupInvoke({
      unmappable: [{ position: 0, character: '发' }],
    });
    const { tabId } = await useTabsStore.getState().openFile('C:/a/big5.txt');
    useTabsStore.getState().setContent(tabId, '修改过的内容');
    const askUser = vi.fn().mockResolvedValue(null);
    const ok = await useTabsStore.getState().saveTab(tabId, askUser);
    expect(ok).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith('fs_write', expect.anything());
    expect(useTabsStore.getState().tabs.find((t) => t.id === tabId)?.dirty).toBe(true);
  });

  it('toutf8 决策改存 UTF-8 带 BOM 并更新标签', async () => {
    setupInvoke({
      unmappable: [{ position: 0, character: '发' }],
    });
    const { tabId } = await useTabsStore.getState().openFile('C:/a/big5.txt');
    const askUser = vi.fn().mockResolvedValue('toutf8' as const);
    await useTabsStore.getState().saveTab(tabId, askUser);
    const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'fs_write');
    expect(call?.[1]).toMatchObject({
      opts: expect.objectContaining({ encoding: 'utf-8', addBom: true }),
    });
    const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
    expect(tab?.encoding).toBe('utf-8');
    expect(tab?.hadBom).toBe(true);
  });
});

describe('重新载入', () => {
  it('reloadWithEncoding 替换内容并清 dirty', async () => {
    setupInvoke();
    const { tabId } = await useTabsStore.getState().openFile('C:/a/x.txt');
    useTabsStore.getState().setContent(tabId, '本地修改');
    await useTabsStore.getState().reloadWithEncoding(tabId, 'big5');
    const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
    expect(invokeMock).toHaveBeenCalledWith('fs_read_with', {
      path: 'C:/a/x.txt',
      encodingLabel: 'big5',
    });
    expect(tab).toMatchObject({ content: '重载内容', encoding: 'big5', dirty: false });
  });
});
