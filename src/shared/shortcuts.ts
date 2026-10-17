/**
 * F-11 §11.2 快捷键引擎（第八阶段）
 *
 * 分三层，都是纯函数 / 纯数据，便于单测：
 *
 * 1. **命令注册表** [`COMMANDS`]：应用能做的事（id / 显示名 / 分组 / 默认键位）。
 *    这是「默认键位」的唯一事实来源——后端 `settings.json` 只存**覆盖项**
 *    （见 `core/settings.rs` 的「三态约定」），不会出现两份默认表漂移。
 * 2. **键位规范化**：[`keyFromEvent`] / [`normalizeKey`] / [`formatKey`]，
 *    在 `KeyboardEvent` 与规范字符串之间转换。
 * 3. **绑定解析**：[`resolveBindings`] / [`buildIndex`] / [`findConflicts`]，
 *    把覆盖表解析成「可分发索引」并找出冲突。
 *
 * ## 规范键位字符串
 *
 * 形如 `ctrl+alt+shift+s`：修饰键**按固定顺序** `ctrl` → `alt` → `shift` → `meta`，
 * 主键小写。固定顺序是必要的——否则 `Shift+Ctrl+S` 与 `Ctrl+Shift+S` 会变成
 * 两个不同的绑定，用户抄来的写法就匹配不上。
 *
 * 主键用 `KeyboardEvent.key`（不是 `code`）：用户看到的是键盘上印的字，
 * 按 `key` 更符合直觉；代价是不同键盘布局下字母位置不同，这一取舍与
 * TextPro 等传统编辑器一致。
 *
 * 空格键在字符串里的写法固定为 `space`：配置里出现裸空白（`"ctrl+ "`）既看不见
 * 也容易在编辑时被吃掉，故不接受；事件路径不受影响，[`keyFromEvent`] 会直接把
 * `' '` 归一成 `space`。
 */

/** 修饰键的固定顺序（规范化输出与解析都依赖它） */
export const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;
export type Modifier = (typeof MODIFIER_ORDER)[number];

/** 一个命令的元信息 */
export interface CommandMeta {
  /** 稳定 ID，同时也是 `settings.shortcuts` 的键 */
  id: string;
  /** 菜单 / 设置里显示的名字 */
  label: string;
  /** 设置对话框里的分组标题 */
  group: string;
  /** 默认键位（规范字符串）；`null` = 默认不绑定 */
  defaultKey: string | null;
}

/**
 * 主修饰键：macOS 是 ⌘，其余平台是 Ctrl。
 *
 * 这是必要的——第八阶段之前的两个内联监听写的是 `e.ctrlKey || e.metaKey`，
 * 也就是**两个都能触发**。若这里直接把默认键位写成字面 `ctrl+s`，
 * macOS 用户的 ⌘S 会静默失效，属于行为回退。故注册表用 `mod` 令牌，
 * 在模块加载时按平台解析成 `ctrl` 或 `meta`；用户在设置里录制的键位
 * 本来就是解析后的形式，两侧一致。
 */
const IS_MAC = isMacPlatform();

/** 主修饰键的规范名（`ctrl` 或 `meta`） */
const MOD: Modifier = IS_MAC ? 'meta' : 'ctrl';

/** 拼一个用主修饰键的默认键位 */
const mod = (rest: string): string => `${MOD}+${rest}`;

/**
 * 命令注册表。
 *
 * 默认键位取自 `docs/04-ui-ux.md` §2 各菜单表的「快捷键（默认）」列；
 * 表里没有的项默认不绑定（`null`），用户可自行分配。
 * 整理工具只收录菜单表里明确给了键位的两项（转全角 / 转半角），
 * 其余 16 个工具的键位留空——F-11 §11.3 的自定义工具栏落地时再统一分配。
 */
export const COMMANDS: readonly CommandMeta[] = [
  // 文件
  { id: 'file.new', label: '新建', group: '文件', defaultKey: mod('n') },
  { id: 'file.open', label: '打开…', group: '文件', defaultKey: mod('o') },
  { id: 'file.save', label: '保存', group: '文件', defaultKey: mod('s') },
  { id: 'file.saveAs', label: '另存为…', group: '文件', defaultKey: mod('shift+s') },
  { id: 'file.reload', label: '重新载入…（自选编码）', group: '文件', defaultKey: mod('shift+r') },
  {
    id: 'file.close',
    label: '关闭当前标签',
    group: '文件',
    // macOS 的 ⌘W 由系统接管（见 RESERVED_KEYS），绑了也不会触发，故那边默认不绑
    defaultKey: IS_MAC ? null : mod('w'),
  },
  // 以下三项是 PRD v0.3 §3.4 的标签生命周期管理；键位沿用 04-ui-ux §2.1 菜单表
  // 已经承诺过的写法（它们在菜单表列了多年却一直没落地）。
  { id: 'file.saveAll', label: '全部保存', group: '文件', defaultKey: mod('shift+a') },
  { id: 'file.closeAll', label: '全部关闭', group: '文件', defaultKey: mod('shift+w') },
  { id: 'file.closeOthers', label: '关闭其他标签', group: '文件', defaultKey: null },

  // 搜索
  { id: 'search.find', label: '查找…', group: '搜索', defaultKey: mod('f') },
  { id: 'search.replace', label: '替换…', group: '搜索', defaultKey: mod('h') },
  { id: 'search.findNext', label: '查找下一个', group: '搜索', defaultKey: 'f3' },
  { id: 'search.findPrevious', label: '查找上一个', group: '搜索', defaultKey: 'shift+f3' },

  // 转换
  { id: 'convert.s2t', label: '简 → 繁', group: '转换', defaultKey: mod('alt+t') },
  { id: 'convert.t2s', label: '繁 → 简', group: '转换', defaultKey: mod('alt+s') },

  // 整理
  { id: 'tools.halfToFull', label: '转全角', group: '整理', defaultKey: mod('alt+f') },
  { id: 'tools.fullToHalf', label: '转半角', group: '整理', defaultKey: mod('alt+h') },

  // 比较
  { id: 'compare.next', label: '下一处不一致', group: '比较', defaultKey: 'f5' },
  { id: 'compare.previous', label: '上一处不一致', group: '比较', defaultKey: null },
  { id: 'compare.restart', label: '从两个光标处重新比较', group: '比较', defaultKey: 'shift+f5' },

  // 视图
  { id: 'view.theme', label: '切换主题（跟随系统 / 浅 / 深）', group: '视图', defaultKey: null },
  // 顶栏现在只有一条菜单栏（PRD v0.4 §3.5），这个开关控制的就是它
  { id: 'view.toggleToolbar', label: '显示 / 隐藏菜单栏', group: '视图', defaultKey: null },
  { id: 'view.toggleStatusBar', label: '显示 / 隐藏状态栏', group: '视图', defaultKey: null },
  { id: 'view.toggleLineNumber', label: '显示 / 隐藏行号', group: '视图', defaultKey: null },
  { id: 'view.toggleWrap', label: '显示 / 隐藏自动换行', group: '视图', defaultKey: null },

  // 设置
  { id: 'settings.open', label: '选项…', group: '设置', defaultKey: mod(',') },
  { id: 'settings.shortcuts', label: '自定义快捷键…', group: '设置', defaultKey: null },

  // 帮助
  { id: 'help.open', label: '帮助与快捷键', group: '帮助', defaultKey: 'f1' },
];

const COMMAND_IDS = new Set(COMMANDS.map((c) => c.id));

/** 是否为已知命令 ID */
export function isCommandId(id: string): boolean {
  return COMMAND_IDS.has(id);
}

/** 按 id 取命令元信息 */
export function commandById(id: string): CommandMeta | undefined {
  return COMMANDS.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// 键位规范化
// ---------------------------------------------------------------------------

/** 纯修饰键的 `KeyboardEvent.key`（按下时不应产生绑定） */
const PURE_MODIFIERS = new Set(['control', 'alt', 'shift', 'meta', 'altgraph', 'capslock', 'numlock', 'scrolllock']);

/** 修饰键别名 → 规范名（`mod` / `cmdOrCtrl` 依赖平台，单独处理） */
const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
};

/** 主修饰键占位符（`mod+s`：macOS 是 ⌘S，其余平台是 Ctrl+S） */
const MOD_PLACEHOLDERS = new Set(['mod', 'cmdorctrl', 'cmdorcontrol']);

/** 主键别名（把 `KeyboardEvent.key` / 用户写法归一成短名） */
const MAIN_KEY_ALIASES: Record<string, string> = {
  ' ': 'space',
  spacebar: 'space',
  space: 'space',
  escape: 'esc',
  esc: 'esc',
  return: 'enter',
  enter: 'enter',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  pageup: 'pgup',
  pagedown: 'pgdn',
  pgup: 'pgup',
  pgdn: 'pgdn',
  backspace: 'backspace',
  delete: 'del',
  del: 'del',
  insert: 'ins',
  ins: 'ins',
  tab: 'tab',
  home: 'home',
  end: 'end',
  // `+` **必须**换名：它是分隔符，否则 `ctrl++` 会被切成 `["ctrl","",""]` 而解析失败。
  // 其余标点（`,` `.` `/` `;` `'` `[` `]` `-` `=` `\` `` ` ``）一律保持原字符——
  // 换名只会让 `ctrl+,` 这类常见写法在规范化后变样（`ctrl+comma`），
  // 既不利于用户手写，也让「默认键位就是规范形式」这条不变量失真。
  '+': 'plus',
  plus: 'plus',
};

/**
 * 把用户写的键位归一成规范字符串；无法解析（只有修饰键、有两个主键、空串）返回 `null`。
 *
 * 大 / 小写、修饰键顺序、别名（`Cmd` / `Option` / `Esc` / `PageUp`…）都会被吸收，
 * 因此 `"Shift+Ctrl+S"` 与 `"ctrl+shift+s"` 解析结果相同。
 *
 * `mod` 是**平台相关**的主修饰键占位符：macOS 解析成 `meta`，其余平台解析成
 * `ctrl`。`mac` 参数只为测试可注入，正常调用走 [`isMacPlatform`]。
 */
export function normalizeKey(raw: string, mac: boolean = IS_MAC): string | null {
  const parts = raw
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  const mods = new Set<Modifier>();
  let main: string | null = null;
  for (const part of parts) {
    if (MOD_PLACEHOLDERS.has(part)) {
      mods.add(mac ? 'meta' : 'ctrl');
      continue;
    }
    const mod = MODIFIER_ALIASES[part];
    if (mod) {
      mods.add(mod);
      continue;
    }
    if (main !== null) return null; // 出现了第二个主键：非法
    main = MAIN_KEY_ALIASES[part] ?? part;
  }
  if (main === null) return null; // 只有修饰键：非法
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), main].join('+');
}

/** 从键盘事件取规范键位；纯修饰键按下返回 `null`（此时不该匹配任何命令） */
export function keyFromEvent(e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  const raw = e.key;
  if (!raw || PURE_MODIFIERS.has(raw.toLowerCase())) return null;
  const mods: Modifier[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('meta');
  const main = MAIN_KEY_ALIASES[raw.toLowerCase()] ?? raw.toLowerCase();
  return [...MODIFIER_ORDER.filter((m) => mods.includes(m)), main].join('+');
}

/** 主键的显示写法（未列出的按单字符大写 / 原样输出） */
const MAIN_KEY_LABELS: Record<string, string> = {
  esc: 'Esc',
  del: 'Del',
  ins: 'Ins',
  space: 'Space',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  pgup: 'PgUp',
  pgdn: 'PgDn',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  plus: '+',
};

const MAC_MOD_LABELS: Record<Modifier, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' };
const OTHER_MOD_LABELS: Record<Modifier, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' };

/** 是否 macOS（`formatKey` 的默认值；测试里显式传入） */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const p = navigator.platform ?? '';
  return /mac|iphone|ipad/i.test(p) || /Mac/i.test(navigator.userAgent ?? '');
}

/** 规范键位 → 人类可读写法（macOS 用符号：`⇧⌘S`；其余平台用 `Shift+Ctrl+S`） */
export function formatKey(key: string, mac: boolean = isMacPlatform()): string {
  const parts = key.split('+');
  const main = parts.pop() ?? '';
  const labels = mac ? MAC_MOD_LABELS : OTHER_MOD_LABELS;
  const mods = parts
    .filter((p): p is Modifier => (MODIFIER_ORDER as readonly string[]).includes(p))
    .map((m) => labels[m]);
  const mainLabel =
    MAIN_KEY_LABELS[main] ??
    (/^f\d{1,2}$/.test(main) ? main.toUpperCase() : main.length === 1 ? main.toUpperCase() : main);
  return mac ? [...mods, mainLabel].join('') : [...mods, mainLabel].join('+');
}

/**
 * 主键是否是「会打出字符」的键。
 *
 * 用来决定输入框的优先级：焦点在文本框里时，**会打出字符**的组合应留给输入
 * （否则给某个命令绑一个裸字母键，打字就会误触发）；而 F3 / F5 / Esc 这类
 * 不产生字符的键在文本框里也必须能被应用拿到——文本编辑器里焦点十有八九
 * 就在编辑区（`contenteditable`），若一律让给输入框，F5 跳差异就永远失灵。
 */
export function isPrintableMain(key: string): boolean {
  const main = key.split('+').pop() ?? '';
  return main === 'space' || main === 'enter' || main.length === 1;
}

/**
 * 这个按键该不该由应用处理（而不是留给输入控件）。
 *
 * 规则：焦点在文本框 / 可编辑区里、且该组合**会打出字符**（无 Ctrl/Alt/Meta
 * 且主键是单字符）时让给输入控件；其余情况（F 键、Esc、任何带修饰键的组合）
 * 由应用处理。
 */
export function shouldHandleKey(
  key: string,
  ctx: { inTextEntry: boolean; ctrl: boolean; alt: boolean; meta: boolean },
): boolean {
  if (!ctx.inTextEntry) return true;
  if (ctx.ctrl || ctx.alt || ctx.meta) return true;
  return !isPrintableMain(key);
}

// ---------------------------------------------------------------------------
// 与系统冲突
// ---------------------------------------------------------------------------

/**
 * 操作系统 / WebView 会截走、或在应用里不该占用的组合
 * （规格 §11.2「与系统冲突时给出警告（不可分配）」）。
 *
 * 只列**确实拿不到**的组合：`Alt+F4`、macOS 的 `⌘Q/⌘W/⌘Tab` 等在到达 WebView
 * 之前就被系统处理掉，绑了也不会触发，坦白告知比让用户白配一次更好。
 */
export const RESERVED_KEYS: ReadonlyMap<string, string> = new Map([
  ['alt+f4', '关闭窗口（系统）'],
  ['alt+tab', '切换窗口（系统）'],
  ['alt+esc', '切换窗口（系统）'],
  ['ctrl+esc', '打开开始菜单（系统）'],
  ['ctrl+alt+del', '系统安全界面（系统）'],
  ['meta+q', '退出应用（macOS）'],
  ['meta+w', '关闭窗口（macOS）'],
  ['meta+tab', '切换应用（系统）'],
  ['meta+space', '输入法切换（macOS）'],
  ['f11', '全屏（系统）'],
]);

/** 命中保留键则返回原因，否则 `null` */
export function reservedReason(key: string): string | null {
  return RESERVED_KEYS.get(normalizeKey(key) ?? key) ?? null;
}

// ---------------------------------------------------------------------------
// 绑定解析
// ---------------------------------------------------------------------------

/** 单个命令的最终绑定 */
export interface ResolvedBinding {
  command: string;
  /** 规范键位；`null` = 未绑定 */
  key: string | null;
  /** 这个键是从哪来的（设置界面要标出来） */
  source: 'default' | 'custom' | 'unbound';
}

/**
 * 把覆盖表解析成「命令 → 最终绑定」。
 *
 * 三态语义（与 `core/settings.rs` 一致）：键不存在 → 用默认；空串 → 显式解绑；
 * 非空 → 覆盖。无法解析的覆盖值视为「用默认」而不是静默丢弃，
 * 这样设置文件被手改坏时行为可预测。
 */
export function resolveBindings(overrides: Record<string, string> = {}): Map<string, ResolvedBinding> {
  const out = new Map<string, ResolvedBinding>();
  for (const cmd of COMMANDS) {
    const raw = Object.prototype.hasOwnProperty.call(overrides, cmd.id) ? overrides[cmd.id] : undefined;
    if (raw === undefined) {
      out.set(cmd.id, { command: cmd.id, key: cmd.defaultKey, source: 'default' });
      continue;
    }
    if (raw.trim() === '') {
      out.set(cmd.id, { command: cmd.id, key: null, source: 'unbound' });
      continue;
    }
    const key = normalizeKey(raw);
    if (key === null) {
      out.set(cmd.id, { command: cmd.id, key: cmd.defaultKey, source: 'default' });
      continue;
    }
    out.set(cmd.id, { command: cmd.id, key, source: 'custom' });
  }
  return out;
}

/** 键位 → 绑定到它的命令（一个键位可能被多个命令占用，那就是冲突） */
export function buildIndex(bindings: Map<string, ResolvedBinding>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const b of bindings.values()) {
    if (!b.key) continue;
    const list = index.get(b.key);
    if (list) list.push(b.command);
    else index.set(b.key, [b.command]);
  }
  return index;
}

/** 一处键位冲突 */
export interface Conflict {
  key: string;
  /** 占用该键位的命令（至少两个） */
  commands: string[];
}

/** 找出所有冲突（同一键位被 ≥ 2 个命令占用） */
export function findConflicts(bindings: Map<string, ResolvedBinding>): Conflict[] {
  const out: Conflict[] = [];
  for (const [key, commands] of buildIndex(bindings)) {
    if (commands.length > 1) out.push({ key, commands: [...commands].sort() });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 若把 `key` 分配给 `command`，会与哪些已生效命令撞车（不含自己）。
 * 用于设置界面在用户按键的**当下**给出提示，而不必等保存后再全局扫。
 */
export function conflictsWith(
  bindings: Map<string, ResolvedBinding>,
  command: string,
  key: string,
): string[] {
  const normalized = normalizeKey(key);
  if (normalized === null) return [];
  const owners = buildIndex(bindings).get(normalized) ?? [];
  return owners.filter((id) => id !== command).sort();
}
