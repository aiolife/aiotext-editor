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
import { Compartment, EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
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

interface EditorProps {
  tab: EditorTab;
  onContentChange: (id: string, content: string) => void;
  onCursorChange: (id: string, line: number, column: number) => void;
  /** 选区变更（from/to 为文档偏移；相等表示无选区） */
  onSelectionChange: (id: string, from: number, to: number) => void;
  /** 待应用的外部替换（按 nonce 触发一次） */
  pendingEdit?: PendingEdit | null;
  /** 待应用的外部选区（按 nonce 触发一次） */
  pendingSelection?: SelectionRequest | null;
  /** 搜索命中高亮 */
  highlights?: SearchHighlight[];
  /** 只读（F-06 比较窗格：可看可选不可改） */
  readOnly?: boolean;
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

export function Editor({
  tab,
  onContentChange,
  onCursorChange,
  onSelectionChange,
  pendingEdit,
  pendingSelection,
  highlights,
  readOnly,
}: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const showLineNumber = useSettingsStore((s) => s.settings.appearance.showLineNumber);
  const wrap = useSettingsStore((s) => s.settings.editor.wrap);
  const tabWidth = useSettingsStore((s) => s.settings.editor.tabWidth);
  const insertSpaces = useSettingsStore((s) => s.settings.editor.insertSpaces);
  /** 挂载时用的初值（挂载后由下面的 reconfigure effect 接管） */
  const displayRef = useRef({ showLineNumber, wrap, tabWidth, insertSpaces });
  // 只读是窗格级属性（F-06 比较对照窗）：挂载时固定即可
  const readOnlyRef = useRef(readOnly ?? false);
  const appliedNonceRef = useRef<number>(-1);
  const appliedSelectionNonceRef = useRef<number>(-1);
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
      ],
    });
  }, [showLineNumber, wrap, tabWidth, insertSpaces]);

  // 切换标签：整体替换 doc 并恢复记录的光标行
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() !== tabRef.current.content) {
      suppressRef.current = true;
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: tabRef.current.content,
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
    if (view.state.doc.toString() !== tab.content) {
      suppressRef.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: tab.content },
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

  // 外部选区请求（查找下一个 / 上一个）
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !pendingSelection) return;
    if (appliedSelectionNonceRef.current === pendingSelection.nonce) return;
    appliedSelectionNonceRef.current = pendingSelection.nonce;
    const docLength = view.state.doc.length;
    const from = Math.max(0, Math.min(pendingSelection.from, docLength));
    const to = Math.max(from, Math.min(pendingSelection.to, docLength));
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    if (pendingSelection.focus !== false) {
      view.focus();
    }
  }, [pendingSelection]);

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
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        highlightField,
        // 只读窗格（比较对照）：可看可选不可改
        ...(readOnlyRef.current
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : []),
        EditorView.updateListener.of((update) => {
          // 始终以「当前标签」为准（组件实例跨标签复用）
          const id = tabRef.current.id;
          if (update.docChanged && !suppressRef.current) {
            onContentChange(id, update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            const sel = update.state.selection.main;
            onSelectionChange(id, sel.from, sel.to);
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
