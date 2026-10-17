import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  buildIndex,
  commandById,
  conflictsWith,
  findConflicts,
  formatKey,
  isCommandId,
  isMacPlatform,
  keyFromEvent,
  normalizeKey,
  reservedReason,
  resolveBindings,
  shouldHandleKey,
  type ResolvedBinding,
} from './shortcuts';

/** 造一个只带 `keyFromEvent` 需要的字段的事件对象 */
function ev(
  key: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {},
) {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
  };
}

describe('命令注册表', () => {
  it('命令 ID 唯一', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('默认键位本身已是规范形式（否则注册表里的写法无法被解析回同一个键）', () => {
    for (const cmd of COMMANDS) {
      if (cmd.defaultKey === null) continue;
      expect(normalizeKey(cmd.defaultKey), `${cmd.id} 的默认键位 ${cmd.defaultKey}`).toBe(
        cmd.defaultKey,
      );
    }
  });

  it('默认键位互不冲突', () => {
    const conflicts = findConflicts(resolveBindings({}));
    expect(conflicts).toEqual([]);
  });

  it('默认键位不与系统保留键冲突', () => {
    for (const cmd of COMMANDS) {
      if (!cmd.defaultKey) continue;
      expect(reservedReason(cmd.defaultKey), `${cmd.id} 占用了系统键`).toBeNull();
    }
  });

  it('默认键位用主修饰键令牌：macOS 是 ⌘，其余平台是 Ctrl', () => {
    const isMac = isMacPlatform();
    const expected = isMac ? 'meta' : 'ctrl';
    // 保存 / 查找这两个最常用的键必须跟着平台走，
    // 否则 macOS 用户的 ⌘S / ⌘F 会静默失效
    expect(commandById('file.save')?.defaultKey).toBe(`${expected}+s`);
    expect(commandById('search.find')?.defaultKey).toBe(`${expected}+f`);
    // macOS 的 ⌘W 归系统，故那边默认不绑定
    expect(commandById('file.close')?.defaultKey).toBe(isMac ? null : `${expected}+w`);
  });

  it('isCommandId 只认注册过的命令', () => {
    expect(isCommandId('file.save')).toBe(true);
    expect(isCommandId('file.nope')).toBe(false);
  });
});

describe('键位规范化', () => {
  it('吸收大小写与修饰键顺序', () => {
    expect(normalizeKey('Ctrl+S')).toBe('ctrl+s');
    expect(normalizeKey('Shift+Ctrl+S')).toBe('ctrl+shift+s');
    expect(normalizeKey('ctrl+SHIFT+s')).toBe('ctrl+shift+s');
    expect(normalizeKey('  Alt + Ctrl + T  ')).toBe('ctrl+alt+t');
  });

  it('吸收别名（Cmd / Option / Esc / PageUp …）', () => {
    expect(normalizeKey('Cmd+S')).toBe('meta+s');
    expect(normalizeKey('Command+Option+T')).toBe('alt+meta+t');
    expect(normalizeKey('Esc')).toBe('esc');
    expect(normalizeKey('PageUp')).toBe('pgup');
    expect(normalizeKey('Escape')).toBe('esc');
    expect(normalizeKey('Space')).toBe('space');
  });

  it('空格键的字符串写法是 space，裸空白不算（配置里看不见的空白没法维护）', () => {
    // 事件路径不受影响：`keyFromEvent({key:' '})` 直接产出 `space`
    expect(keyFromEvent(ev(' '))).toBe('space');
    expect(normalizeKey(' ')).toBeNull();
    expect(normalizeKey('ctrl+ ')).toBeNull();
  });

  it('`+` 键用 plus 表示（分隔符本身的转义）', () => {
    expect(normalizeKey('ctrl+plus')).toBe('ctrl+plus');
    expect(normalizeKey('Control+Plus')).toBe('ctrl+plus');
  });

  it('标点保持原字符，`ctrl+,` 不被改写', () => {
    expect(normalizeKey('Ctrl+,')).toBe('ctrl+,');
    expect(normalizeKey('ctrl+/')).toBe('ctrl+/');
    expect(normalizeKey('ctrl+[')).toBe('ctrl+[');
  });

  it('拒绝只有修饰键 / 两个主键 / 空串', () => {
    expect(normalizeKey('Ctrl')).toBeNull();
    expect(normalizeKey('Ctrl+Shift')).toBeNull();
    expect(normalizeKey('Ctrl+A+B')).toBeNull();
    expect(normalizeKey('')).toBeNull();
    expect(normalizeKey('   ')).toBeNull();
  });

  it('无修饰键的单键也合法（F3 / F5）', () => {
    expect(normalizeKey('F3')).toBe('f3');
    expect(normalizeKey('f5')).toBe('f5');
  });

  it('`mod` 占位符按平台解析（macOS ⌘ / 其余 Ctrl）', () => {
    expect(normalizeKey('mod+s', true)).toBe('meta+s');
    expect(normalizeKey('mod+s', false)).toBe('ctrl+s');
    // 占位符先落成 `meta`，再按 MODIFIER_ORDER（ctrl→alt→shift→meta）重排，
    // 所以 `shift` 在 `meta` 前——这与用户书写顺序无关，是规范形式的必然结果。
    expect(normalizeKey('cmdOrCtrl+Shift+S', true)).toBe('shift+meta+s');
    expect(normalizeKey('mod+Alt+T', false)).toBe('ctrl+alt+t');
    // 注册表里的默认键位就是按本平台解析后的形式
    expect(normalizeKey(commandById('file.save')!.defaultKey!)).toBe(
      commandById('file.save')!.defaultKey,
    );
  });

  it('重复的同名修饰键被合并', () => {
    expect(normalizeKey('Ctrl+Ctrl+S')).toBe('ctrl+s');
  });
});

describe('按键该由谁处理（分发器守卫）', () => {
  it('焦点不在输入区时一律由应用处理', () => {
    expect(shouldHandleKey('a', { inTextEntry: false, ctrl: false, alt: false, meta: false })).toBe(
      true,
    );
  });

  it('输入区里裸字符让给输入控件（回车 / 空格 / 单字符）', () => {
    const bare = { inTextEntry: true, ctrl: false, alt: false, meta: false } as const;
    expect(shouldHandleKey('a', bare)).toBe(false);
    expect(shouldHandleKey('space', bare)).toBe(false);
    expect(shouldHandleKey('enter', bare)).toBe(false);
  });

  it('输入区里带 Ctrl/Alt/Meta 的组合仍归应用（避开 Shift，它会打大写）', () => {
    expect(shouldHandleKey('s', { inTextEntry: true, ctrl: true, alt: false, meta: false })).toBe(
      true,
    );
    expect(shouldHandleKey('s', { inTextEntry: true, ctrl: false, alt: false, meta: true })).toBe(
      true,
    );
  });

  it('输入区里 F 键 / Esc / 方向键归应用（不产生字符）', () => {
    const bare = { inTextEntry: true, ctrl: false, alt: false, meta: false } as const;
    expect(shouldHandleKey('f3', bare)).toBe(true);
    expect(shouldHandleKey('esc', bare)).toBe(true);
    expect(shouldHandleKey('up', bare)).toBe(true);
  });
});

describe('从键盘事件取键位', () => {
  it('按固定顺序组装修饰键', () => {
    expect(keyFromEvent(ev('S', { ctrl: true, shift: true }))).toBe('ctrl+shift+s');
    expect(keyFromEvent(ev('T', { alt: true, ctrl: true }))).toBe('ctrl+alt+t');
    expect(keyFromEvent(ev('s', { meta: true }))).toBe('meta+s');
  });

  it('纯修饰键按下返回 null（此时不应匹配任何命令）', () => {
    expect(keyFromEvent(ev('Control', { ctrl: true }))).toBeNull();
    expect(keyFromEvent(ev('Shift', { shift: true }))).toBeNull();
    expect(keyFromEvent(ev('Alt', { alt: true }))).toBeNull();
    expect(keyFromEvent(ev('Meta', { meta: true }))).toBeNull();
    expect(keyFromEvent(ev('CapsLock'))).toBeNull();
  });

  it('方向键 / 空格 / Esc 归一成短名', () => {
    expect(keyFromEvent(ev('ArrowUp'))).toBe('up');
    expect(keyFromEvent(ev(' ', { ctrl: true }))).toBe('ctrl+space');
    expect(keyFromEvent(ev('Escape'))).toBe('esc');
  });

  it('与 normalizeKey 口径一致：事件产物必是规范形式', () => {
    for (const e of [ev('S', { ctrl: true }), ev('F5'), ev('ArrowDown', { shift: true })]) {
      const k = keyFromEvent(e)!;
      expect(normalizeKey(k)).toBe(k);
    }
  });
});

describe('键位显示', () => {
  it('非 macOS 用 Ctrl/Alt/Shift/Win 拼接', () => {
    expect(formatKey('ctrl+shift+s', false)).toBe('Ctrl+Shift+S');
    expect(formatKey('ctrl+alt+t', false)).toBe('Ctrl+Alt+T');
    expect(formatKey('f5', false)).toBe('F5');
    expect(formatKey('ctrl+,', false)).toBe('Ctrl+,');
  });

  it('macOS 用符号且不加分隔符', () => {
    expect(formatKey('ctrl+shift+s', true)).toBe('⌃⇧S');
    expect(formatKey('meta+s', true)).toBe('⌘S');
    expect(formatKey('shift+f5', true)).toBe('⇧F5');
  });

  it('方向键显示成箭头', () => {
    expect(formatKey('ctrl+up', false)).toBe('Ctrl+↑');
  });
});

describe('绑定解析（覆盖表三态）', () => {
  it('缺键 → 默认；空串 → 解绑；非空 → 覆盖', () => {
    const b = resolveBindings({
      'file.save': 'ctrl+alt+1',
      'file.open': '',
    });
    expect(b.get('file.save')).toEqual({ command: 'file.save', key: 'ctrl+alt+1', source: 'custom' });
    expect(b.get('file.open')).toEqual({ command: 'file.open', key: null, source: 'unbound' });
    expect(b.get('file.new')).toEqual({ command: 'file.new', key: 'ctrl+n', source: 'default' });
    // 显式解绑的空值即便带空白也算解绑
    const spaced = resolveBindings({ 'file.save': '   ' });
    expect(spaced.get('file.save')?.key).toBeNull();
    expect(spaced.get('file.save')?.source).toBe('unbound');
  });

  it('覆盖值会先规范化（用户写 Shift+Ctrl+S 也认）', () => {
    const b = resolveBindings({ 'file.save': 'Shift+Ctrl+S' });
    expect(b.get('file.save')?.key).toBe('ctrl+shift+s');
  });

  it('无法解析的覆盖值回落默认，而不是静默丢成未绑定', () => {
    const b = resolveBindings({ 'file.save': 'Ctrl+Shift+Alt+Meta' });
    expect(b.get('file.save')).toEqual({ command: 'file.save', key: 'ctrl+s', source: 'default' });
  });

  it('未知命令 ID 被忽略（设置文件里残留的旧命令）', () => {
    const b = resolveBindings({ 'nope.old': 'ctrl+9' });
    expect(b.has('nope.old')).toBe(false);
    expect(b.size).toBe(COMMANDS.length);
  });
});

describe('冲突检测', () => {
  it('覆盖成同一个键 → 报冲突', () => {
    const b = resolveBindings({ 'file.open': 'ctrl+n' });
    const conflicts = findConflicts(b);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].key).toBe('ctrl+n');
    expect(conflicts[0].commands).toEqual(['file.new', 'file.open']);
  });

  it('三个命令抢同一个键也算一处冲突', () => {
    const b = resolveBindings({ 'file.open': 'ctrl+n', 'file.save': 'ctrl+n' });
    expect(findConflicts(b)[0].commands).toEqual(['file.new', 'file.open', 'file.save']);
  });

  it('解绑后不再冲突（冲突消失）', () => {
    const b = resolveBindings({ 'file.open': 'ctrl+n', 'file.new': '' });
    expect(findConflicts(b)).toEqual([]);
  });

  it('conflictsWith 排除自己，并吸收大小写写法', () => {
    const b = resolveBindings({});
    // 把「打开」挪到 Ctrl+N：与「新建」撞车
    expect(conflictsWith(b, 'file.open', 'ctrl+n')).toEqual(['file.new']);
    // 大小写不影响判定
    expect(conflictsWith(b, 'file.open', 'CTRL+N')).toEqual(['file.new']);
    // 没人占用的键
    expect(conflictsWith(b, 'file.open', 'ctrl+9')).toEqual([]);
    // 「新建」占着自己的默认键 Ctrl+N：自己不算冲突
    expect(conflictsWith(b, 'file.new', 'ctrl+n')).toEqual([]);
    // 无法解析的值不报冲突
    expect(conflictsWith(b, 'file.open', 'Ctrl+Shift')).toEqual([]);
  });

  it('buildIndex 跳过未绑定的命令', () => {
    const b = new Map<string, ResolvedBinding>([
      ['a', { command: 'a', key: null, source: 'unbound' }],
      ['b', { command: 'b', key: 'f5', source: 'default' }],
    ]);
    const index = buildIndex(b);
    expect(index.size).toBe(1);
    expect(index.get('f5')).toEqual(['b']);
  });
});

describe('系统保留键', () => {
  it('识别系统级组合并给出原因', () => {
    expect(reservedReason('Alt+F4')).toContain('系统');
    expect(reservedReason('Cmd+Q')).toContain('macOS');
    expect(reservedReason('Ctrl+Esc')).toBeTruthy();
  });

  it('普通组合不算保留', () => {
    expect(reservedReason('ctrl+n')).toBeNull();
    expect(reservedReason('f5')).toBeNull();
    expect(reservedReason('ctrl+alt+t')).toBeNull();
  });
});
