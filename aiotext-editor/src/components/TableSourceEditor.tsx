/**
 * 替换表源文本编辑器（F-04 §4.9「UI 镜像编辑器」）
 *
 * 直接编辑 `.tab` 源文本（保留注释与排版），由后端解析后把**错误行**标红；
 * 文件名与 `#name:` 显示名解耦，故编辑器内的文本始终是唯一事实来源。
 */
import { useEffect, useRef } from 'react';
import { EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

interface TableSourceEditorProps {
  value: string;
  /** 需要标红的行号（1 起；来自后端校验报告） */
  errorLines: number[];
  onChange: (text: string) => void;
}

const setErrorLines = StateEffect.define<number[]>();

/** 错误行整行底色（用行装饰避免与正文标记冲突） */
const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setErrorLines)) continue;
      const doc = transaction.state.doc;
      const ranges: Range<Decoration>[] = [];
      for (const lineNumber of effect.value) {
        if (lineNumber < 1 || lineNumber > doc.lines) continue;
        ranges.push(
          Decoration.line({ class: 'cm-table-error-line' }).range(doc.line(lineNumber).from),
        );
      }
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function TableSourceEditor({ value, errorLines, onChange }: TableSourceEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /** 程序性同步期间不回抛变更（避免光标跳动与循环） */
  const syncingRef = useRef(false);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          errorLineField,
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncingRef.current) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部换表 → 整篇替换
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === value) return;
    syncingRef.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    syncingRef.current = false;
  }, [value]);

  // 错误行标红
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setErrorLines.of(errorLines) });
  }, [errorLines]);

  return <div ref={hostRef} className="table-editor-host" />;
}
