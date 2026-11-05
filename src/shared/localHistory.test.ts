import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HISTORY_OPTIONS,
  KEEP_RECENT_UNCOMMITTED,
  byteLength,
  contentHash,
  decideCapture,
  planClear,
  planEviction,
  triggerLabel,
  type CaptureContext,
  type HistoryTrigger,
  type SnapshotMeta,
} from './localHistory';

const DAY = 24 * 60 * 60 * 1000;

function meta(id: string, overrides: Partial<SnapshotMeta> = {}): SnapshotMeta {
  return {
    id,
    ts: 1_700_000_000_000,
    trigger: 'auto',
    hash: `h-${id}`,
    size: 3,
    schemaVersion: 1,
    committed: false,
    pinned: false,
    encoding: 'utf-8',
    hadBom: false,
    lineEnding: 'lf',
    ...overrides,
  };
}

function ctx(overrides: Partial<CaptureContext> = {}): CaptureContext {
  return {
    enabled: true,
    hasPath: true,
    content: '内容',
    trigger: 'auto',
    last: undefined,
    hash: 'abc',
    size: 6,
    now: 1_700_000_000_000,
    opts: { ...DEFAULT_HISTORY_OPTIONS },
    ...overrides,
  };
}

describe('默认值与基础工具', () => {
  it('默认关闭，符合「一切写盘需用户明确触发」', () => {
    expect(DEFAULT_HISTORY_OPTIONS.enabled).toBe(false);
  });

  it('byteLength 按 UTF-8 字节而非码元', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('中文')).toBe(6);
  });

  it('contentHash 稳定且为 32 位 hex', async () => {
    const a = await contentHash('同一段内容');
    const b = await contentHash('同一段内容');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await contentHash('不同内容')).not.toBe(a);
  });

  it('triggerLabel 覆盖全部触发类型', () => {
    const triggers: HistoryTrigger[] = [
      'auto',
      'save',
      'switch-doc',
      'pre-restore',
      'manual',
    ];
    for (const t of triggers) expect(triggerLabel(t).length).toBeGreaterThan(0);
  });
});

describe('decideCapture', () => {
  it('关闭开关 / 无路径 / 空文档一律跳过', () => {
    expect(decideCapture(ctx({ enabled: false }))).toEqual({
      action: 'skip',
      reason: 'disabled',
    });
    expect(decideCapture(ctx({ hasPath: false }))).toEqual({
      action: 'skip',
      reason: 'no-path',
    });
    expect(decideCapture(ctx({ content: '' }))).toEqual({
      action: 'skip',
      reason: 'empty-doc',
    });
  });

  it('内容未变不重复建快照（hash + size 双条件）', () => {
    const last = meta('s1', { hash: 'abc', size: 6 });
    expect(decideCapture(ctx({ last }))).toEqual({
      action: 'skip',
      reason: 'duplicate',
    });
    // hash 相同但字节数不同 → 不能算重复
    expect(decideCapture(ctx({ last, size: 7 })).action).not.toBe('skip');
  });

  it('force 绕过去重（保存基线 / 恢复前存档必须留痕）', () => {
    const last = meta('s1', { hash: 'abc', size: 6 });
    expect(decideCapture(ctx({ last, force: true })).action).toBe('create');
  });

  it('合并窗口内连续 auto 复用同一条', () => {
    const last = meta('s1', {
      ts: 1_700_000_000_000 - 2_000,
      trigger: 'auto',
    });
    expect(decideCapture(ctx({ last }))).toEqual({ action: 'merge', id: 's1' });
  });

  it('合并窗口外 / 置顶 / 已提交基线都不合并', () => {
    const base = { ts: 1_700_000_000_000 - 20_000, trigger: 'auto' as const };
    expect(decideCapture(ctx({ last: meta('s1', base) })).action).toBe('create');
    expect(
      decideCapture(ctx({ last: meta('s2', { ...base, pinned: true }) })).action,
    ).toBe('create');
    expect(
      decideCapture(ctx({ last: meta('s3', { ...base, committed: true }) })).action,
    ).toBe('create');
  });

  it('大文档降频而不是跳过：auto 停，manual / pre-restore 照常', () => {
    const opts = { ...DEFAULT_HISTORY_OPTIONS, largeDocChars: 5 };
    expect(
      decideCapture(ctx({ content: 'x'.repeat(20), opts })),
    ).toEqual({ action: 'skip', reason: 'large-doc-auto' });
    expect(
      decideCapture(ctx({ content: 'x'.repeat(20), opts, trigger: 'manual' })).action,
    ).toBe('create');
    expect(
      decideCapture(ctx({ content: 'x'.repeat(20), opts, trigger: 'pre-restore' })).action,
    ).toBe('create');
  });

  it('id 由时间 + hash 组成且可排序', () => {
    const decision = decideCapture(ctx());
    expect(decision.action).toBe('create');
    if (decision.action === 'create') expect(decision.id).toMatch(/^[0-9a-z]+-abc$/);
  });
});

describe('planEviction', () => {
  const opts = { ...DEFAULT_HISTORY_OPTIONS, maxPerDoc: 5, retentionDays: 7 };

  it('TTL 过期淘汰，但 pinned / 最近基线 / 最近 N 条受保护', () => {
    const now = 1_700_000_000_000;
    const items = [
      meta('old-pinned', { ts: now - 30 * DAY, pinned: true }),
      meta('old-baseline', { ts: now - 30 * DAY, committed: true }),
      meta('old-plain', { ts: now - 30 * DAY }),
      meta('recent', { ts: now }),
    ];
    const evict = planEviction(items, opts, now);
    expect(evict).toContain('old-plain');
    expect(evict).not.toContain('old-pinned');
    // 最近一条已保存基线是硬保护，过期也不删
    expect(evict).not.toContain('old-baseline');
    expect(evict).not.toContain('recent');
  });

  it('条数上限从最旧开始淘汰，且不会重复淘汰同一条', () => {
    const now = 1_700_000_000_000;
    const items = Array.from({ length: 12 }, (_, i) =>
      meta(`s${i}`, { ts: now - (12 - i) * 1000 }),
    );
    const evict = planEviction(items, opts, now);
    expect(new Set(evict).size).toBe(evict.length);
    expect(evict[0]).toBe('s0');
    // 最近 KEEP_RECENT_UNCOMMITTED 条必须留下
    for (let i = 12 - KEEP_RECENT_UNCOMMITTED; i < 12; i++) {
      expect(evict).not.toContain(`s${i}`);
    }
  });

  it('未超限时返回空数组', () => {
    const now = 1_700_000_000_000;
    expect(planEviction([meta('a'), meta('b')], opts, now)).toEqual([]);
  });
});

describe('planClear（选了不保存就彻底清除）', () => {
  it('discard 返回全部有效路径，自动滤掉未命名文件', () => {
    expect(planClear('discard', ['C:/a.md', null, 'D:/b.txt', ''])).toEqual([
      'C:/a.md',
      'D:/b.txt',
    ]);
  });

  it('save / cancel 一律不清', () => {
    expect(planClear('save', ['C:/a.md'])).toEqual([]);
    expect(planClear('cancel', ['C:/a.md'])).toEqual([]);
  });
});
