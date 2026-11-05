/**
 * Markdown 装饰规划（纯函数层，PRD §3.11）
 *
 * 这一层**不依赖 DOM、不依赖 EditorView**：输入 lezer 语法树 + 文档 + 光标位置，
 * 输出一串「装饰指令」纯数据，由 `components/markdownView.ts` 翻译成 CodeMirror
 * 的 `Decoration`。拆开有两个原因：
 *
 * 1. vitest 是 node 环境（无 jsdom），这样语法覆盖与偏移可以直接单测，不必引入
 *    jsdom（PRD §3.11 明确不新增依赖）；
 * 2. 大文档目标（PRD §3.5 的 100 万字）要求用 CodeMirror 的**增量**语法树，
 *    而 `syntaxTree(state)` 只能在组件层拿到。把「树 → 指令」独立出来，组件层
 *    就能只传 `visibleRanges`，不必每次击键全量 parse。
 *
 * ## 偏移口径
 * lezer 与 CodeMirror 一样按 JS string 的 **UTF-16 码元**计偏移，与项目全局口径
 * 一致。这里**不做任何换算**——不要照搬 Rust 侧的码点/字节换算。
 *
 * ## 不渲染用户 HTML
 * 只产出 class 名与纯文本 widget 指令，组件层一律 `createElement` + `textContent`，
 * 从不 `innerHTML`。因此不需要 DOMPurify。
 */
import type { Tree } from '@lezer/common';
import type { Text } from '@codemirror/state';

export type MdWidgetKind =
  | 'bullet'
  | 'ordered'
  | 'checkbox'
  | 'footnote'
  | 'toc'
  | 'codeLang';

export interface TocEntry {
  level: number;
  text: string;
  /** 标题行在文档中的起始偏移，用于点击跳转 */
  at: number;
}

export interface MdWidgetSpec {
  kind: MdWidgetKind;
  /** bullet 的 •、有序列表的 `1.`、脚注编号、语言名… */
  text?: string;
  checked?: boolean;
  /** checkbox 写回文档时要替换的标记区间与文本 */
  source?: string;
  entries?: TocEntry[];
}

/**
 * 一条装饰指令。
 *
 * - `line`：行级 class（标题字号、引用左边框、代码块底色…）
 * - `mark`：行内 class，**只覆盖内容，不覆盖标记符**
 * - `hide`：把源码标记符从视觉上移除（`Decoration.replace({})`）
 * - `widget`：把一段源码换成 DOM 元素（复选框、目录、脚注编号…）
 *
 * `mark` 与 `hide` 刻意不重叠：CodeMirror 的 replace 装饰与 inline mark 叠在同一
 * 区间会互相吞掉，排版错乱很难查。
 */
export type MdOp =
  | { type: 'line'; at: number; cls: string }
  | { type: 'mark'; from: number; to: number; cls: string; title?: string }
  | { type: 'hide'; from: number; to: number }
  | { type: 'widget'; from: number; to: number; widget: MdWidgetSpec };

export interface MdPlan {
  ops: MdOp[];
  /** 光标所在块的 [from, to]，没有则为 null */
  activeBlock: [number, number] | null;
  /** 含 Markdown 语法的行区间（渲染层会占用这些位置，不可见字符要避开） */
  renderedLines: [number, number][];
}

/** Live Preview 以「块」为单位退回源码，不按行撕裂表格 / 代码块 */
const BLOCK_NODES = new Set([
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'Paragraph',
  'FencedCode',
  'CodeBlock',
  'Blockquote',
  'ListItem',
  'Table',
]);

/** 行内节点 → (class, 首尾标记符宽度) */
const INLINE: Record<string, [string, number]> = {
  StrongEmphasis: ['cm-md-bold', 2],
  Emphasis: ['cm-md-italic', 1],
  Strikethrough: ['cm-md-strike', 2],
  InlineCode: ['cm-md-inline-code', 1],
};

interface CustomSpan {
  from: number;
  to: number;
  kind: 'highlight' | 'footnoteRef' | 'footnoteDef' | 'toc';
  label?: string;
  entries?: TocEntry[];
}

/** 扫 lezer 没有节点的自定义语法：`==高亮==`、脚注、`[TOC]` */
function scanCustom(text: string, tree: Tree): CustomSpan[] {
  const spans: CustomSpan[] = [];

  // 代码围栏内部的 `==` / `[^1]` / `[TOC]` 不是 Markdown 语法，不能渲染
  const codeRanges: [number, number][] = [];
  tree.iterate({
    enter: (n) => {
      if (n.name === 'FencedCode' || n.name === 'CodeBlock') {
        codeRanges.push([n.from, n.to]);
      }
    },
  });
  const inCode = (pos: number): boolean =>
    codeRanges.some(([a, b]) => pos >= a && pos < b);

  for (const m of text.matchAll(/==([^=\n]+)==/g)) {
    const from = m.index ?? 0;
    if (!inCode(from)) spans.push({ from, to: from + m[0].length, kind: 'highlight' });
  }

  for (const m of text.matchAll(/^\[\^([^\]\n]+)\]:/gm)) {
    const from = m.index ?? 0;
    if (!inCode(from)) {
      spans.push({ from, to: from + m[0].length, kind: 'footnoteDef', label: m[1] });
    }
  }
  for (const m of text.matchAll(/\[\^([^\]\n]+)\](?!:)/g)) {
    const from = m.index ?? 0;
    if (inCode(from) || spans.some((s) => from >= s.from && from < s.to)) continue;
    spans.push({ from, to: from + m[0].length, kind: 'footnoteRef', label: m[1] });
  }

  // `[TOC]` 单独一行时扫**全文**标题生成嵌套目录（标题可能在视口外）
  const entries: TocEntry[] = [];
  tree.iterate({
    enter: (n) => {
      const h = /^ATXHeading([1-6])$/.exec(n.name);
      if (!h) return;
      const title = text
        .slice(n.from, n.to)
        .replace(/^#{1,6}[ \t]+/, '')
        .replace(/[ \t]+#+[ \t]*$/, '')
        .trim();
      entries.push({ level: Number(h[1]), text: title, at: n.from });
    },
  });
  for (const m of text.matchAll(/^\[TOC\][ \t]*$/gm)) {
    const from = m.index ?? 0;
    if (!inCode(from)) {
      spans.push({ from, to: from + '[TOC]'.length, kind: 'toc', entries: [...entries] });
    }
  }

  return spans;
}

/**
 * 规划一段可视区域的 Markdown 装饰。
 *
 * @param tree   CodeMirror 增量语法树（`syntaxTree(state)`）；单测里可直接用
 *               `@lezer/markdown` 的 `parser.parse(text)` 造一棵
 * @param from   视口起点，`to` 为视口终点
 * @param cursor 光标位置；其所在块退回源码（Live Preview）
 */
export function planMarkdown(
  tree: Tree,
  doc: Text,
  from: number,
  to: number,
  cursor: number,
): MdPlan {
  const text = doc.toString();
  const ops: MdOp[] = [];
  const seenLines = new Set<number>();
  const renderedLines: [number, number][] = [];

  const markLine = (pos: number): void => {
    if (pos < 0 || pos > doc.length) return;
    const line = doc.lineAt(pos);
    if (seenLines.has(line.from)) return;
    seenLines.add(line.from);
    renderedLines.push([line.from, line.to]);
  };
  const pushLine = (pos: number, cls: string): void => {
    if (pos < 0 || pos > doc.length) return;
    ops.push({ type: 'line', at: doc.lineAt(pos).from, cls });
    markLine(pos);
  };

  // ---- 1. 光标所在的最小块 ----
  let activeBlock: [number, number] | null = null;
  tree.iterate({
    from: Math.max(0, cursor - 1),
    to: Math.min(doc.length, cursor + 1),
    enter: (n) => {
      if (!BLOCK_NODES.has(n.name) || cursor < n.from || cursor > n.to) return;
      if (!activeBlock || n.to - n.from < activeBlock[1] - activeBlock[0]) {
        activeBlock = [n.from, n.to];
      }
    },
  });

  const custom = scanCustom(text, tree);
  // lezer 会把 `[^1]` / `[TOC]` 误认成 Link / LinkReference，这些区间整体跳过
  const special = custom.filter((s) => s.kind !== 'highlight');
  const isSpecial = (a: number, b: number): boolean =>
    special.some((s) => a >= s.from && b <= s.to && a < s.to);

  // ---- 2. 语法树（只遍历视口） ----
  tree.iterate({
    from,
    to,
    enter: (n) => {
      const { name } = n;
      if (n.from < from || n.to > to) return;
      if (isSpecial(n.from, n.to)) return;

      // 标题
      const heading = /^ATXHeading([1-6])$/.exec(name);
      if (heading) {
        pushLine(n.from, `cm-md-h${heading[1]}`);
        const w = /^#{1,6}/.exec(text.slice(n.from, n.to))?.[0].length ?? 0;
        if (w > 0) {
          let b = n.from + w;
          while (b < doc.length && (text[b] === ' ' || text[b] === '\t')) b += 1;
          ops.push({ type: 'hide', from: n.from, to: b });
        }
        return;
      }

      // 引用块 / 代码块：逐行加样式
      if (name === 'Blockquote' || name === 'FencedCode' || name === 'CodeBlock') {
        const cls = name === 'Blockquote' ? 'cm-md-quote' : 'cm-md-code';
        for (let p = n.from; p <= n.to && p < doc.length; ) {
          const line = doc.lineAt(p);
          pushLine(line.from, cls);
          if (line.to >= n.to) break;
          p = line.to + 1;
        }
      }

      // 表格行
      if (name === 'TableHeader' || name === 'TableRow') {
        pushLine(n.from, name === 'TableHeader' ? 'cm-md-table-head' : 'cm-md-table-row');
      }
      if (name === 'TableCell') {
        ops.push({ type: 'mark', from: n.from, to: n.to, cls: 'cm-md-cell' });
      }
      if (name === 'TableDelimiter') {
        if (n.to - n.from > 1) {
          // 对齐分隔行 `| :-- | --: |` 压成一条线
          pushLine(n.from, 'cm-md-table-sep');
        } else {
          ops.push({ type: 'hide', from: n.from, to: n.to });
          markLine(n.from);
        }
      }

      // 引用符 `>`（连同后随空格）
      if (name === 'QuoteMark') {
        let b = n.to;
        while (b < doc.length && (text[b] === ' ' || text[b] === '\t')) b += 1;
        ops.push({ type: 'hide', from: n.from, to: b });
        markLine(n.from);
      }

      // 代码围栏的 ``` （语言名留在行内，由 CSS 弱化）
      if (name === 'CodeMark') {
        ops.push({ type: 'hide', from: n.from, to: n.to });
        markLine(n.from);
      }
      if (name === 'CodeInfo') {
        ops.push({ type: 'mark', from: n.from, to: n.to, cls: 'cm-md-code-lang' });
      }

      // 行内：内容 mark + 首尾标记符 hide
      const inline = INLINE[name];
      if (inline) {
        const [cls, width] = inline;
        const slice = text.slice(n.from, n.to);
        const lead = width === 2 ? 2 : 1;
        if (slice.length > lead * 2) {
          ops.push({ type: 'mark', from: n.from + lead, to: n.to - lead, cls });
          ops.push({ type: 'hide', from: n.from, to: n.from + lead });
          ops.push({ type: 'hide', from: n.to - lead, to: n.to });
          markLine(n.from);
        }
      }

      // 链接：按源码 `[文字](url)` 一次性拆开，避免重复 hide
      if (name === 'Link') {
        const close = text.indexOf('](', n.from);
        if (close < 0 || close >= n.to) return;
        const labelFrom = n.from + 1;
        const labelTo = close;
        const urlFrom = close + 2;
        const urlTo = n.to - 1;
        const url = text.slice(urlFrom, urlTo).trim();
        const safe = /^(https?:|mailto:|\/|#|\.{1,2}\/)/i.test(url);
        ops.push({ type: 'hide', from: n.from, to: labelFrom }); // [
        ops.push({ type: 'hide', from: close, to: urlFrom }); // ](
        ops.push({ type: 'hide', from: urlFrom, to: urlTo }); // url
        ops.push({ type: 'hide', from: urlTo, to: n.to }); // )
        if (labelTo > labelFrom) {
          ops.push({
            type: 'mark',
            from: labelFrom,
            to: labelTo,
            cls: safe ? 'cm-md-link' : 'cm-md-link-unsafe',
            title: safe ? url : '链接协议不允许',
          });
        }
        markLine(n.from);
      }

      // 列表项：按行首文本定位标记与任务框
      if (name === 'ListItem') {
        const line = doc.lineAt(n.from);
        const lineText = text.slice(line.from, line.to);
        const indent = lineText.length - lineText.trimStart().length;
        pushLine(line.from, `cm-md-li-${Math.min(4, Math.floor(indent / 2) + 1)}`);
        const m = /^([ \t]*)([-*+]|\d+\.)[ \t]+/.exec(lineText);
        if (m) {
          const markFrom = line.from + m[1].length;
          const markTo = markFrom + m[2].length;
          let after = markTo;
          while (after < line.to && (text[after] === ' ' || text[after] === '\t')) after += 1;
          const ordered = /^\d/.test(m[2]);
          const task = /^\[([ xX])\]/.exec(text.slice(after, Math.min(line.to, after + 3)));
          if (task) {
            // 任务列表用复选框替代项目符号：列表标记直接隐藏，不画 •
            ops.push({ type: 'hide', from: markFrom, to: after });
            ops.push({
              type: 'widget',
              from: after,
              to: after + 3,
              widget: {
                kind: 'checkbox',
                checked: task[1].toLowerCase() === 'x',
                source: task[0],
              },
            });
          } else {
            ops.push({
              type: 'widget',
              from: markFrom,
              to: after,
              widget: { kind: ordered ? 'ordered' : 'bullet', text: ordered ? m[2] : '•' },
            });
          }
          markLine(line.from);
        }
      }
    },
  });

  // ---- 3. 自定义语法 ----
  const noteNumbers = new Map<string, number>();
  custom
    .filter((s) => s.kind === 'footnoteDef')
    .forEach((s, i) => {
      if (s.label) noteNumbers.set(s.label, i + 1);
    });
  let extra = noteNumbers.size;
  const noteNo = (label: string): number => {
    if (!noteNumbers.has(label)) noteNumbers.set(label, ++extra);
    return noteNumbers.get(label) ?? extra;
  };

  for (const s of custom) {
    if (s.to <= from || s.from >= to) continue;
    switch (s.kind) {
      case 'highlight':
        ops.push({ type: 'hide', from: s.from, to: s.from + 2 });
        ops.push({ type: 'mark', from: s.from + 2, to: s.to - 2, cls: 'cm-md-highlight' });
        ops.push({ type: 'hide', from: s.to - 2, to: s.to });
        markLine(s.from);
        break;
      case 'footnoteRef':
      case 'footnoteDef':
        ops.push({
          type: 'widget',
          from: s.from,
          to: s.to,
          widget: { kind: 'footnote', text: String(noteNo(s.label ?? '?')) },
        });
        if (s.kind === 'footnoteDef') {
          pushLine(s.from, 'cm-md-footnote-def');
        }
        markLine(s.from);
        break;
      case 'toc': {
        const line = doc.lineAt(s.from);
        ops.push({
          type: 'widget',
          from: line.from,
          to: line.to,
          widget: { kind: 'toc', entries: s.entries ?? [] },
        });
        markLine(s.from);
        break;
      }
    }
  }

  // ---- 4. Live Preview：光标所在块退回源码 ----
  // 保留 line 级样式（标题字号 / 引用框 / 代码块底色），避免光标移动时整行跳高；
  // 只撤掉该块内的 hide / mark / widget，让标记符重新可见。
  const finalOps = activeBlock
    ? ops.filter((op) => {
        if (op.type === 'line') return true;
        const a = op.from;
        const b = op.type === 'hide' || op.type === 'widget' ? op.to : a;
        return !(a >= activeBlock![0] && b <= activeBlock![1]);
      })
    : ops;

  // Decoration.set 要求按位置严格有序；同位置让 line → widget → mark → hide
  finalOps.sort((x, y) => {
    const ax = x.type === 'line' ? x.at : x.from;
    const ay = y.type === 'line' ? y.at : y.from;
    if (ax !== ay) return ax - ay;
    const rank = (o: MdOp): number =>
      o.type === 'line' ? 0 : o.type === 'widget' ? 1 : o.type === 'mark' ? 2 : 3;
    return rank(x) - rank(y);
  });

  return { ops: finalOps, activeBlock, renderedLines };
}

/**
 * 快速判断一行是否含 Markdown 语法（供 `buildInvisible` 跳过不可见字符）。
 *
 * 刻意用正则而不是再解析一遍语法树：`buildInvisible` 每次视口变化都会跑，
 * 这里只需要「这一行会不会被渲染层占用位置」的是/否答案。
 */
export function isMarkdownLine(line: string): boolean {
  const t = line.trimStart();
  if (/^\[TOC\][ \t]*$/.test(t)) return true;
  if (/^#{1,6}[ \t]+/.test(t)) return true;
  if (/^>[ \t]?/.test(t)) return true;
  if (/^([-*+]|\d+\.)[ \t]+/.test(t)) return true;
  if (/^\[\^[^\]\n]+\]:/.test(t)) return true;
  if (/^\|.*\|[ \t]*$/.test(t)) return true;
  if (/^(`{3,}|~{3,})/.test(t)) return true;
  if (
    /(\*\*[^*\n]+\*\*|(?<!\*)\*[^*\n]+\*(?!\*)|~~[^~\n]+~~|==[^=\n]+==|`[^`\n]+`|\[\^[^\]\n]+\]|\[[^\]\n]*\]\([^)\n]*\))/.test(
      line,
    )
  ) {
    return true;
  }
  return false;
}
