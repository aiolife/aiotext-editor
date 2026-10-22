/**
 * CodeMirror 6 编辑器（F-01 §1.6）
 *
 * - 编辑器内部文本统一 LF 行尾（与 store 约定一致）
 * - doc 变更 → store.setContent（标 dirty）；程序性替换（切标签 / 内容同步）
 *   期间抑制回调，避免把同步误判为用户编辑
 * - 光标 / 选区 → 状态栏与「转换到选区」使用
 * - 标签切换 / 重载 / 转换结果 → 整体或局部换 doc
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  moveLineDown,
  moveLineUp,
  redo,
  undo,
} from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import type { EditorTab } from '../store/tabsStore';
import { useSettingsStore } from '../store/settingsStore';

/** 外部发起的文档替换（如「简繁转换」写入整篇或选区） */
export interface PendingEdit {
  from: number;
  to: number;
  text: string;
  /** 变更序号：内容相同也需重新触发 */
  nonce: number;
}

/** 搜索命中高亮（偏移为 UTF-16 码元，来自 F-05 `regex_find`） */
export interface SearchHighlight {
  start: number;
  end: number;
  /** 当前定位的命中 */
  active: boolean;
}

/** 外部选区请求（查找下一个 / 上一个 / 比较跳差异） */
export interface SelectionRequest {
  from: number;
  to: number;
  nonce: number;
  /** false = 只滚动定位、不抢焦点（比较模式两个窗格同时跳转时用） */
  focus?: boolean;
}

/**
 * 外部编辑器命令（菜单项没有键盘原生入口的那几个）。
 *
 * 撤销 / 重做本来是 CodeMirror 键盘快捷键（`historyKeymap`）能触发的，但撤销历史
 * 挂在 view 的 state 里，**必须** `view.dispatch` 才能动——JS 侧拿不到 view，
 * 所以走跟 `pendingEdit` 一样的路：父组件发意图 + nonce，这里执行一次。
 */
export interface EditorCommand {
  kind:
    | 'undo'
    | 'redo'
    | 'goto'
    // 列编辑（垂直选择）：把当前普通选区转成矩形选区
    | 'column'
    // 行互换（上移 / 下移走 CodeMirror 的 moveLineUp / moveLineDown）
    | 'lineUp'
    | 'lineDown'
    | 'swapLineUp'
    | 'insertTime'
    | 'updateTime';
  /** `goto` 用：目标行号（1 起，越界会被夹到有效范围） */
  line?: number;
  nonce: number;
}

interface EditorProps {
  tab: EditorTab;
  onContentChange: (id: string, content: string) => void;
  onCursorChange: (id: string, line: number, column: number) => void;
  /**
   * 选区变更（from/to 为文档偏移；相等表示无选区）。
   * `external` 为 true 表示这一笔是外部请求跳过去的（查找下一个 / 跳差异），
   * 不是用户自己框出来的。
   */
  onSelectionChange: (id: string, from: number, to: number, external?: boolean) => void;
  /** 待应用的外部替换（按 nonce 触发一次） */
  pendingEdit?: PendingEdit | null;
  /** 待应用的外部选区（按 nonce 触发一次） */
  pendingSelection?: SelectionRequest | null;
  /** 搜索命中高亮 */
  highlights?: SearchHighlight[];
  /** 外部编辑器命令（撤销 / 重做 / 跳转）：按 nonce 触发一次 */
  commandRequest?: EditorCommand | null;
  /** 只读（F-06 比较对照窗：可看可选不可改）。目标窗切换时可在运行时翻转 */
  readOnly?: boolean;
  /** 比较差异标红（F-06 §6.2） */
  diffMarks?: DiffMark[];
  /**
   * 逐字对照标蓝（F-06）：要标蓝的那一处。
   *
   * 两侧都传同一个语义 —— 哪格是「用户选中的」、哪格是「对过去的对应位置」，
   * 由调用方按选中发生在哪一侧决定（见 `App` 里的 `pairMarks`）。
   */
  pairMark?: PairSpan | null;
}

// ---------------------------------------------------------------------------
// 搜索命中高亮扩展（F-05 §5.4：实时高亮命中）
// ---------------------------------------------------------------------------

const setHighlights = StateEffect.define<SearchHighlight[]>();

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setHighlights)) continue;
      const docLength = transaction.state.doc.length;
      const ranges: Range<Decoration>[] = [];
      for (const hit of effect.value) {
        const from = Math.max(0, Math.min(hit.start, docLength));
        const to = Math.max(from, Math.min(hit.end, docLength));
        if (to <= from) continue;
        const className = hit.active ? 'cm-search-hit cm-search-hit-active' : 'cm-search-hit';
        ranges.push(Decoration.mark({ class: className }).range(from, to));
      }
      // 排序后统一挂载，避免多处 mark 冲突
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// ---------------------------------------------------------------------------
// 比较差异标红（F-06 §6.2）
//
// 与搜索命中高亮分开：两者含义不同（「查到了」与「两文不一致」），
// 共用一套 decoration 会让配色相互覆盖。
// ---------------------------------------------------------------------------

export interface DiffMark {
  start: number;
  end: number;
  /**
   * `missing` = 这一处本窗没有、对面窗有（对方多出来的字标在对方那边）；
   * `extra`   = 本窗多出、对面窗没有。
   */
  kind: 'missing' | 'extra';
}

const setDiffMarks = StateEffect.define<DiffMark[]>();

/**
 * 差异装饰用 RangeSet：它是分块稀疏结构，**只有视口内的装饰才真正绘制**，
 * 所以标全部差异也不会随文档长度线性变慢。上限由后端截断（5000 处）兜住。
 */
const diffMarkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setDiffMarks)) continue;
      const docLength = transaction.state.doc.length;
      const ranges: Range<Decoration>[] = [];
      for (const mark of effect.value) {
        const from = Math.max(0, Math.min(mark.start, docLength));
        const to = Math.max(from, Math.min(mark.end, docLength));
        if (to <= from) continue;
        const className =
          mark.kind === 'missing' ? 'cm-diff-mark cm-diff-missing' : 'cm-diff-mark cm-diff-extra';
        ranges.push(Decoration.mark({ class: className }).range(from, to));
      }
      // Decoration.set 的第二参数要求已按位置排序
      ranges.sort((a, b) => a.from - b.from || a.to - b.to);
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// ---------------------------------------------------------------------------
// 逐字对照标蓝（F-06）
//
// 与标红分开：红是「两文不一致」，蓝是「正在对照的这一处」（它多半是一致的），
// 含义与配色都不该混在一起。同一时刻只标一处（最后选中的那处），所以这里
// 收的是一个区间而不是区间数组。
// ---------------------------------------------------------------------------

export interface PairSpan {
  from: number;
  to: number;
}

const setPairMark = StateEffect.define<PairSpan | null>();

const pairMarkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setPairMark)) continue;
      const span = effect.value;
      if (!span) {
        next = Decoration.none;
        continue;
      }
      const docLength = transaction.state.doc.length;
      const from = Math.max(0, Math.min(span.from, docLength));
      const to = Math.max(from, Math.min(span.to, docLength));
      next =
        to <= from
          ? Decoration.none
          : Decoration.set([Decoration.mark({ class: 'cm-pair-mark' }).range(from, to)], true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// ---------------------------------------------------------------------------
// 行互换后的当前行高亮（黄底，约 1 秒）
// ---------------------------------------------------------------------------

/**
 * 行互换之后把光标所在行短暂标黄。
 *
 * 只闪一下而不是常驻：常驻高亮会让**所有**编辑场景都跟着变样，而这里要解决的
 * 只是「这行跑到哪去了」——移动完那一瞬间看得见就够了。
 */
/** 行互换高亮的持续时间（毫秒） */
const FLASH_MS = 1000;

const setFlash = StateEffect.define<{ from: number; to: number } | null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    // 行装饰要跟着文档变化挪，否则这段时间内改到别处会标错行
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setFlash)) continue;
      const span = effect.value;
      next = span
        ? Decoration.set([Decoration.line({ class: 'cm-swap-flash' }).range(span.from)], true)
        : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** 时间戳：`2026/10/22 15:30:45`（规格要求的 %Y/%m/%d %H:%M:%S） */
function formatTimestamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 整段匹配才算时间戳——否则选中一大段文字会被误判成「要更新」 */
const TIMESTAMP_ANCHORED = /^\d{4}[/-]\d{1,2}[/-]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/;
/** 光标扫描用（不带锚点，可在整行里找时间戳） */
const TIMESTAMP_SCAN = /\d{4}[/-]\d{1,2}[/-]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?/g;

/** 与上一行交换；已在第一行则不动，返回是否真的换了 */
function swapLineUp(view: EditorView): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  if (line.number <= 1) return false;
  const prev = state.doc.line(line.number - 1);
  const column = head - line.from;
  view.dispatch({
    changes: { from: prev.from, to: line.to, insert: `${line.text}\n${prev.text}` },
    // 光标跟着「原来那一行」走（它现在到了上面），列位置保持不变
    selection: { anchor: prev.from + Math.min(column, line.text.length) },
    scrollIntoView: true,
  });
  return true;
}

/** 在光标处插入当前时间；有选区则替换选区 */
function insertTimestamp(view: EditorView): void {
  const spec = view.state.replaceSelection(formatTimestamp());
  view.dispatch({ ...spec, scrollIntoView: true });
}

/**
 * 更新时间（notepad4 语义）：选区是时间戳就刷新它；否则光标若落在某个时间戳
 * 里就刷那个；都不是才当作插入。
 */
function updateTimestamp(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;

  if (!range.empty) {
    const selected = state.sliceDoc(range.from, range.to).trim();
    if (selected && TIMESTAMP_ANCHORED.test(selected)) {
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: formatTimestamp() },
        scrollIntoView: true,
      });
      return;
    }
    insertTimestamp(view);
    return;
  }

  // 无选区：光标落在哪一行的哪个时间戳里，就刷哪一个
  const line = state.doc.lineAt(range.head);
  TIMESTAMP_SCAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TIMESTAMP_SCAN.exec(line.text)) !== null) {
    const start = line.from + match.index;
    const end = start + match[0].length;
    if (range.head >= start && range.head <= end) {
      view.dispatch({
        changes: { from: start, to: end, insert: formatTimestamp() },
        scrollIntoView: true,
      });
      return;
    }
  }
  insertTimestamp(view);
}

/**
 * 把当前普通选区转成矩形（列）选区：每行一段、列范围相同。
 *
 * 转换完就能直接输入，每行都插同样的内容。单行选区没有「列」可言，故不动。
 */
function toRectangular(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;
  if (range.empty) return;
  const doc = state.doc;
  const first = doc.lineAt(range.from);
  const last = doc.lineAt(range.to);
  if (first.number === last.number) return;
  const colStart = range.from - first.from;
  const colEnd = Math.max(range.to - last.from, colStart);
  const ranges = [];
  for (let n = first.number; n <= last.number; n += 1) {
    const line = doc.line(n);
    const from = Math.min(line.from + colStart, line.to);
    const to = Math.min(line.from + colEnd, line.to);
    ranges.push(EditorSelection.range(from, Math.max(from, to)));
  }
  view.dispatch({ selection: EditorSelection.create(ranges), scrollIntoView: true });
}

/**
 * F-11 外观设置的作用点（行号 / 自动换行 / 缩进宽度）。
 *
 * 用 `Compartment` 而不是重建 EditorState：改设置要能**原地生效**，
 * 重建状态会丢掉撤销历史与滚动位置（比较模式的两个窗格更是会跳）。
 *
 * 显示偏好直接读设置 store 而不是走 props：它是**全局**偏好，比较模式会同时
 * 挂 2~3 个 Editor，逐层透传很容易出现「某个窗格没跟上设置」的不一致。
 */
const lineNumberCompartment = new Compartment();
const wrapCompartment = new Compartment();
const indentCompartment = new Compartment();
const invisibleCompartment = new Compartment();
/**
 * 只读也走 Compartment：比较模式里目标窗可以在两格之间切换，
 * 固定成挂载时的常量就切不动了（重建 state 又会丢撤销历史与滚动位置）。
 */
const readOnlyCompartment = new Compartment();

/** 只读窗格：可看可选不可改 */
function readOnlyExt(readOnly: boolean) {
  return readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
}

/**
 * 标记「这一笔选区是外部请求跳过去的」。
 *
 * 查找 / 跳差异都会把光标挪到某处并选中一段（见 `pendingSelection`），
 * 那不是用户用鼠标框出来的 —— 若不标明来源，查找面板会把「跳过去时自动选中
 * 的词」当成用户新选的词回填进输入框，用户的替换词就凭空没了。
 */
const externalSelectionAnn = Annotation.define<boolean>();

function lineNumberExt(show: boolean) {
  return show ? lineNumbers() : [];
}

function wrapExt(wrap: boolean) {
  return wrap ? EditorView.lineWrapping : [];
}

/** 缩进：`tabSize` 管**视觉**宽度，`indentUnit` 管**插入**内容（空格或制表符） */
function indentExt(tabWidth: number, insertSpaces: boolean) {
  return [EditorState.tabSize.of(tabWidth), indentUnit.of(insertSpaces ? ' '.repeat(tabWidth) : '\t')];
}

// ---------------------------------------------------------------------------
// 不可见字符（视图 → 显示空格字符 / 显示行尾字符 / 显示换段符）
// ---------------------------------------------------------------------------

/** 三个开关的组合 */
interface InvisibleFlags {
  spaces: boolean;
  lineEnds: boolean;
  paragraphs: boolean;
}

/** 符号 widget：一个小程序渲染一枚「不会进入文档」的字符 */
class SymbolWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly kind: string,
  ) {
    super();
  }

  eq(other: SymbolWidget): boolean {
    return other.text === this.text && other.kind === this.kind;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `cm-invisible cm-invisible-${this.kind}`;
    span.textContent = this.text;
    return span;
  }

  /** 不参与命中测试：光标走到这些符号时应当按照背后的真实字符处理 */
  ignoreEvent(): boolean {
    return true;
  }
}

const SPACE_WIDGET = new SymbolWidget('·', 'space');
const TAB_WIDGET = new SymbolWidget('→', 'tab');
const LINE_END_WIDGET = new SymbolWidget('¬', 'line-end');
const PARAGRAPH_WIDGET = new SymbolWidget('¶', 'paragraph');

/**
 * 按开关把不可见字符画出来。
 *
 * - 空格 / 制表符用 `Decoration.replace`：原字符被符号「顶替」，但**文档没变**，
 *   编辑、选区、保存都不受影响（就像 Word / Sublime 的显示校对符号）。
 * - 行尾符 `¬` 只画在**有换行**的行上（最后一行没有换行就不画）。
 * - 换段符 `¶` 画在「段落的最后一行」——即下一行是空行或已到文末。
 *   同一个位置两个符号会重叠，所以勾选了换段符时该位置**优先画** `¶`。
 */
function buildInvisible(view: EditorView, flags: InvisibleFlags): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const text = line.text;
      if (flags.spaces) {
        for (let index = 0; index < text.length; index += 1) {
          const ch = text[index];
          if (ch !== ' ' && ch !== '\t') continue;
          const widget = ch === ' ' ? SPACE_WIDGET : TAB_WIDGET;
          ranges.push(Decoration.replace({ widget }).range(line.from + index, line.from + index + 1));
        }
      }
      if (line.to < to || line.number < doc.lines) {
        // 「下一行为空行」= 这一段到此结束（与段间空行工具的「每段一个非空行」同口径）
        const nextIsBlank =
          line.number === doc.lines || doc.line(line.number + 1).text.trim() === '';
        const isLastDocLine = line.number === doc.lines;
        if (flags.paragraphs && (nextIsBlank || isLastDocLine)) {
          ranges.push(Decoration.widget({ widget: PARAGRAPH_WIDGET, side: 1 }).range(line.to));
        } else if (flags.lineEnds) {
          ranges.push(Decoration.widget({ widget: LINE_END_WIDGET, side: 1 }).range(line.to));
        }
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

/** 开关全关时不挂插件（零开销），任一打开才启动 */
function invisibleExt(flags: InvisibleFlags): ViewPlugin<{
  decorations: DecorationSet;
  update(update: ViewUpdate): void;
}> | [] {
  if (!flags.spaces && !flags.lineEnds && !flags.paragraphs) return [];
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildInvisible(view, flags);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildInvisible(update.view, flags);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

export function Editor({
  tab,
  onContentChange,
  onCursorChange,
  onSelectionChange,
  pendingEdit,
  pendingSelection,
  highlights,
  commandRequest,
  readOnly,
  diffMarks,
  pairMark,
}: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** 行互换高亮的清除定时器（见下方 `flashCurrentLine`） */
  const flashTimerRef = useRef<number | null>(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const showLineNumber = useSettingsStore((s) => s.settings.appearance.showLineNumber);
  const wrap = useSettingsStore((s) => s.settings.editor.wrap);
  const tabWidth = useSettingsStore((s) => s.settings.editor.tabWidth);
  const insertSpaces = useSettingsStore((s) => s.settings.editor.insertSpaces);
  const showSpaces = useSettingsStore((s) => s.settings.appearance.showSpaces);
  const showLineEnds = useSettingsStore((s) => s.settings.appearance.showLineEnds);
  const showParagraphMarks = useSettingsStore((s) => s.settings.appearance.showParagraphMarks);
  /** 挂载时用的初值（挂载后由下面的 reconfigure effect 接管） */
  const displayRef = useRef({
    showLineNumber,
    wrap,
    tabWidth,
    insertSpaces,
    showSpaces,
    showLineEnds,
    showParagraphMarks,
  });
  // 只读是窗格级属性（F-06 比较对照窗）：挂载时固定即可
  const readOnlyRef = useRef(readOnly ?? false);
  const appliedNonceRef = useRef<number>(-1);
  const appliedSelectionNonceRef = useRef<number>(-1);
  const appliedCommandNonceRef = useRef<number>(-1);
  /** 程序性替换期间抑制 change 回调（见文件头注释） */
  const suppressRef = useRef(false);

  // 生命周期：挂载一次；卸载销毁
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: makeState(tabRef.current),
      parent: hostRef.current,
    });
    viewRef.current = view;
    if (!readOnlyRef.current) {
      view.focus();
    }
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // F-11 外观设置变更：原地重配（不重建 state，撤销历史与滚动位置都保住）
  // 用 useLayoutEffect：否则「设置已生效」会晚一帧才画出来，切行号时看得见闪动
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        lineNumberCompartment.reconfigure(lineNumberExt(showLineNumber)),
        wrapCompartment.reconfigure(wrapExt(wrap)),
        indentCompartment.reconfigure(indentExt(tabWidth, insertSpaces)),
        invisibleCompartment.reconfigure(
          invisibleExt({
            spaces: showSpaces,
            lineEnds: showLineEnds,
            paragraphs: showParagraphMarks,
          }),
        ),
      ],
    });
  }, [showLineNumber, wrap, tabWidth, insertSpaces, showSpaces, showLineEnds, showParagraphMarks]);

  // 切换标签：整体替换 doc 并恢复记录的光标行
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = tabRef.current.content;
    // 先用 O(1) 的长度比较挡一道：长度不同就必然不同，没必要再构造整篇
    // String 去比对。切换标签时两个文件长度几乎不可能相同，这条路就是常态。
    if (view.state.doc.length !== next.length || view.state.doc.toString() !== next) {
      suppressRef.current = true;
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: next,
        },
      });
      suppressRef.current = false;
    }
    const doc = view.state.doc;
    const targetLine = Math.min(tab.cursorLine, doc.lines);
    const line = doc.line(Math.max(1, targetLine));
    view.dispatch({ selection: { anchor: line.from } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // 外部内容同步（重载 / 另存为回写）：跟随 store
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    // 同上：长度先挡一道。日常编辑时 tab.content 与 doc 本来就是同一份新
    // String，长度相等，真正走到 toString() 的只在该同步的场合。
    if (doc.length !== tab.content.length || doc.toString() !== tab.content) {
      suppressRef.current = true;
      view.dispatch({
        changes: { from: 0, to: doc.length, insert: tab.content },
      });
      suppressRef.current = false;
    }
  }, [tab.content]);

  // 转换结果写入（整篇或选区）：按 nonce 触发一次，作为真实编辑计入 dirty
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !pendingEdit) return;
    if (appliedNonceRef.current === pendingEdit.nonce) return;
    appliedNonceRef.current = pendingEdit.nonce;
    const docLength = view.state.doc.length;
    const from = Math.max(0, Math.min(pendingEdit.from, docLength));
    const to = Math.max(from, Math.min(pendingEdit.to, docLength));
    view.dispatch({
      changes: { from, to, insert: pendingEdit.text },
      selection: { anchor: from + pendingEdit.text.length },
    });
    view.focus();
  }, [pendingEdit]);

  // 搜索命中高亮（文档变更时由 decoration 映射自动跟随）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setHighlights.of(highlights ?? []) });
  }, [highlights]);

  // 比较差异标红（文档变更时由 decoration 映射自动跟随）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setDiffMarks.of(diffMarks ?? []) });
  }, [diffMarks]);

  // 逐字对照标蓝
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setPairMark.of(pairMark ?? null) });
  }, [pairMark]);

  // 目标窗切换：只读状态原地翻转（用 layout 时机，避免切换时闪一帧）
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(readOnlyExt(readOnly ?? false)),
    });
  }, [readOnly]);

  // 外部选区请求（查找下一个 / 上一个）
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !pendingSelection) return;
    if (appliedSelectionNonceRef.current === pendingSelection.nonce) return;
    appliedSelectionNonceRef.current = pendingSelection.nonce;
    const docLength = view.state.doc.length;
    const from = Math.max(0, Math.min(pendingSelection.from, docLength));
    const to = Math.max(from, Math.min(pendingSelection.to, docLength));
    view.dispatch({
      selection: { anchor: from, head: to },
      scrollIntoView: true,
      annotations: externalSelectionAnn.of(true),
    });
    if (pendingSelection.focus !== false) {
      view.focus();
    }
  }, [pendingSelection]);

  /**
   * 行互换之后把光标所在行标黄约 1 秒（理由见 `flashField` 的注释）。
   *
   * 定时器记在 ref 里：连续按 Alt+↑ 时后一次要顶掉前一次，否则第一次的定时器
   * 到点会把第二次的高亮也一起清掉（闪一下就没了）。
   */
  const flashCurrentLine = (view: EditorView) => {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    view.dispatch({ effects: setFlash.of({ from: line.from, to: line.to }) });
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      // 可能已经卸载或换了 view（切标签）：只有还是同一个实例才去清
      if (viewRef.current === view) view.dispatch({ effects: setFlash.of(null) });
    }, FLASH_MS);
  };

  // 外部编辑器命令：撤销历史挂在 view 里，只能在这里 dispatch
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !commandRequest) return;
    if (appliedCommandNonceRef.current === commandRequest.nonce) return;
    appliedCommandNonceRef.current = commandRequest.nonce;
    if (commandRequest.kind === 'undo') {
      undo(view);
      view.focus();
      return;
    }
    if (commandRequest.kind === 'redo') {
      redo(view);
      view.focus();
      return;
    }
    if (
      commandRequest.kind === 'lineUp' ||
      commandRequest.kind === 'lineDown' ||
      commandRequest.kind === 'swapLineUp'
    ) {
      // 上移 / 下移直接复用 CodeMirror 的 moveLineUp / moveLineDown——它们与
      // Alt+↑ / Alt+↓ 是同一套，菜单点了和按键盘效果必须一致
      if (commandRequest.kind === 'lineUp') moveLineUp(view);
      else if (commandRequest.kind === 'lineDown') moveLineDown(view);
      else if (!swapLineUp(view)) {
        // 已经在第一行：没有可交换的对象，也不该闪一下误导用户
        view.focus();
        return;
      }
      flashCurrentLine(view);
      view.focus();
      return;
    }
    if (commandRequest.kind === 'column') {
      toRectangular(view);
      view.focus();
      return;
    }
    if (commandRequest.kind === 'insertTime') {
      insertTimestamp(view);
      view.focus();
      return;
    }
    if (commandRequest.kind === 'updateTime') {
      updateTimestamp(view);
      view.focus();
      return;
    }
    const doc = view.state.doc;
    const lineNumber = Math.max(1, Math.min(commandRequest.line ?? 1, doc.lines));
    const line = doc.line(lineNumber);
    // 选中整行：跳转后立刻能看到「到了哪一行」，比只挪光标醒目
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      scrollIntoView: true,
    });
    view.focus();
  }, [commandRequest]);

  // 卸载时收掉高亮定时器：否则 1 秒后会对着一个已经销毁的 view 去 dispatch
  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  return <div ref={hostRef} className="editor-host" />;

  function makeState(t: EditorTab): EditorState {
    const display = displayRef.current;
    return EditorState.create({
      doc: t.content,
      extensions: [
        // 外观三项走 Compartment，挂载后由 reconfigure 原地生效（见上方注释）
        lineNumberCompartment.of(lineNumberExt(display.showLineNumber)),
        wrapCompartment.of(wrapExt(display.wrap)),
        indentCompartment.of(indentExt(display.tabWidth, display.insertSpaces)),
        invisibleCompartment.of(
          invisibleExt({
            spaces: display.showSpaces,
            lineEnds: display.showLineEnds,
            paragraphs: display.showParagraphMarks,
          }),
        ),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        // 行互换要标黄当前行，所以 Alt+↑ / Alt+↓ 不能只交给 defaultKeymap 那一版：
        // 默认版只移动、不标黄，于是「按键盘没反馈、点菜单才有」，同一个动作两种
        // 表现。用最高优先级接过来，移动完顺手闪一下，两条路合成一条。
        Prec.highest(
          keymap.of([
            {
              key: 'Alt-ArrowUp',
              run: (view) => {
                moveLineUp(view);
                flashCurrentLine(view);
                return true;
              },
            },
            {
              key: 'Alt-ArrowDown',
              run: (view) => {
                moveLineDown(view);
                flashCurrentLine(view);
                return true;
              },
            },
          ]),
        ),
        // 列编辑（垂直选择）：Alt+拖动 框选矩形。矩形选区是**多光标**，
        // 而多光标必须靠 drawSelection 自绘——浏览器原生选区只支持一个范围，
        // 没有它的话多选区根本画不出来（实测选中后选区块数为 0）。
        rectangularSelection(),
        drawSelection(),
        highlightField,
        diffMarkField,
        pairMarkField,
        flashField,
        readOnlyCompartment.of(readOnlyExt(readOnlyRef.current)),
        EditorView.updateListener.of((update) => {
          // 始终以「当前标签」为准（组件实例跨标签复用）
          const id = tabRef.current.id;
          if (update.docChanged && !suppressRef.current) {
            onContentChange(id, update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            const sel = update.state.selection.main;
            const external = update.transactions.some(
              (tr) => tr.annotation(externalSelectionAnn) === true,
            );
            onSelectionChange(id, sel.from, sel.to, external);
            // 列号按字符数计（东亚宽字符友好）
            const line = update.state.doc.lineAt(sel.head);
            const column = Array.from(line.text.slice(0, sel.head - line.from)).length + 1;
            onCursorChange(id, line.number, column);
          }
        }),
      ],
    });
  }
}
