/**
 * Markdown 实时渲染的 CodeMirror 视图层（PRD §3.11）
 *
 * 把 `shared/markdownSpans.ts` 产出的纯数据指令翻译成 `Decoration`。
 * 关键设计：
 *
 * - **独立 Compartment**：现有 `invisibleCompartment` 每改任一外观项都整体
 *   `reconfigure`，渲染插件塞进去会随切行号/字号全量重算。
 * - **增量语法树**：`markdown({ extensions: [...] })` 挂进同一个 Compartment，
 *   `syntaxTree(state)` 由 CodeMirror 增量维护；百万字文档不会每次击键全量 parse。
 * - **只算视口**：`visibleRanges`，与 `buildInvisible` 同一套做法。
 * - **不改文档**：全部是装饰，doc 里始终是原始 Markdown 纯文本。
 * - **不渲染用户 HTML**：所有 widget 用 `createElement` + `textContent`，
 *   从不 `innerHTML`，故不需要 DOMPurify。链接也从不生成 `<a href>`。
 */
import { markdown } from '@codemirror/lang-markdown';
import { GFM, Strikethrough, Table, TaskList } from '@lezer/markdown';
import { syntaxTree } from '@codemirror/language';
import { Compartment, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import {
  planMarkdown,
  type MdOp,
  type MdPlan,
  type MdWidgetSpec,
} from '../shared/markdownSpans';

/** 独立的 Compartment：只由「文件类型 + 设置开关」驱动 */
export const markdownCompartment = new Compartment();

/** 开启时的扩展：带 GFM 的增量语法树 + 渲染插件 */
export function markdownExt() {
  const language = markdown({
    extensions: [GFM, Table, TaskList, Strikethrough],
  });
  return [language, MarkdownViewPlugin];
}

/** 关闭时返回空数组（零开销） */
export const NO_MARKDOWN: [] = [];

class MdWidget extends WidgetType {
  constructor(readonly spec: MdWidgetSpec) {
    super();
  }

  eq(other: MdWidget): boolean {
    return (
      other.spec.kind === this.spec.kind &&
      other.spec.text === this.spec.text &&
      other.spec.checked === this.spec.checked &&
      other.spec.source === this.spec.source &&
      other.spec.entries?.length === this.spec.entries?.length
    );
  }

  toDOM(view: EditorView): HTMLElement {
    switch (this.spec.kind) {
      case 'toc':
        return tocDOM(view, this.spec.entries ?? []);
      case 'checkbox': {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = Boolean(this.spec.checked);
        box.className = 'cm-md-checkbox';
        box.setAttribute('aria-label', '任务完成状态');
        box.addEventListener('change', () => {
          const at = view.posAtDOM(box);
          const src = view.state.doc.sliceString(at, at + 3);
          if (!/^\[[ xX]\]$/.test(src)) return;
          view.dispatch({
            changes: { from: at, to: at + 3, insert: this.spec.checked ? '[ ]' : '[x]' },
          });
        });
        return box;
      }
      case 'footnote': {
        const sup = document.createElement('sup');
        sup.className = 'cm-md-footnote';
        sup.textContent = this.spec.text ?? '';
        return sup;
      }
      case 'codeLang': {
        const tag = document.createElement('span');
        tag.className = 'cm-md-code-lang';
        tag.textContent = this.spec.text ?? '';
        return tag;
      }
      default: {
        const span = document.createElement('span');
        span.className = this.spec.kind === 'ordered' ? 'cm-md-ordered' : 'cm-md-bullet';
        span.textContent = this.spec.text ?? '•';
        return span;
      }
    }
  }

  /** 一律不参与命中测试：列选 / 矩形选区按原始行列算，widget 不该抢事件 */
  ignoreEvent(): boolean {
    return true;
  }
}

function tocDOM(view: EditorView, entries: { level: number; text: string; at: number }[]): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'cm-md-toc';
  if (entries.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'cm-md-toc-empty';
    empty.textContent = '（暂无标题）';
    nav.appendChild(empty);
  }
  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = `cm-md-toc-item cm-md-toc-l${Math.min(6, entry.level)}`;
    item.textContent = entry.text;
    item.addEventListener('click', () => {
      view.dispatch({
        selection: { anchor: entry.at },
        effects: EditorView.scrollIntoView(entry.at, { y: 'start' }),
      });
      view.focus();
    });
    nav.appendChild(item);
  }
  return nav;
}

function opToRange(op: MdOp): Range<Decoration> {
  switch (op.type) {
    case 'line':
      return Decoration.line({ class: op.cls }).range(op.at);
    case 'mark':
      return Decoration.mark({
        class: op.cls,
        ...(op.title ? { attributes: { title: op.title } } : {}),
      }).range(op.from, op.to);
    case 'hide':
      return Decoration.replace({}).range(op.from, op.to);
    case 'widget':
      return Decoration.replace({ widget: new MdWidget(op.widget) }).range(op.from, op.to);
  }
}

/** 把多个 visibleRange 的指令合并、去重、排序 */
function buildDecorations(view: EditorView): DecorationSet {
  const tree = syntaxTree(view.state);
  const cursor = view.state.selection.main.head;
  const seen = new Set<string>();
  const ops: MdOp[] = [];

  for (const { from, to } of view.visibleRanges) {
    const plan: MdPlan = planMarkdown(tree, view.state.doc, from, to, cursor);
    for (const op of plan.ops) {
      const a = op.type === 'line' ? op.at : op.from;
      const b = op.type === 'line' ? op.at : op.to;
      const key = `${op.type}:${a}:${b}:${'cls' in op ? op.cls : ''}:${
        op.type === 'widget' ? op.widget.kind : ''
      }`;
      if (seen.has(key)) continue;
      seen.add(key);
      ops.push(op);
    }
  }

  ops.sort((x, y) => {
    const ax = x.type === 'line' ? x.at : x.from;
    const ay = y.type === 'line' ? y.at : y.from;
    if (ax !== ay) return ax - ay;
    const rank = (o: MdOp): number =>
      o.type === 'line' ? 0 : o.type === 'widget' ? 1 : o.type === 'mark' ? 2 : 3;
    return rank(x) - rank(y);
  });

  try {
    return Decoration.set(ops.map(opToRange), true);
  } catch (e) {
    // 装饰区间万一重叠（自定义语法与 lezer 节点撞上），退化成空装饰而不是白屏。
    // 宁可这一屏不渲染，也不能让编辑器打不开。
    console.warn('[markdown] 装饰区间冲突，本帧跳过渲染', e);
    return Decoration.none;
  }
}

const MarkdownViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      // 选区变化也要重建：Live Preview 是「光标所在块退回源码」
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
