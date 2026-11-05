/**
 * Markdown 装饰规划的单测（PRD §3.11）
 *
 * 这一层刻意不依赖 EditorView / DOM，所以 vitest 的 node 环境就能跑。
 * 语法树直接由 `@lezer/markdown` 产出，与组件层 `syntaxTree(state)` 同源。
 */
import { describe, expect, it } from 'vitest';
import { GFM, Strikethrough, Table, TaskList, parser } from '@lezer/markdown';
import { Text } from '@codemirror/state';

import { isMarkdownLine, planMarkdown, type MdOp } from './markdownSpans';

const mdParser = parser.configure([GFM, Table, TaskList, Strikethrough]);

function plan(text: string, cursor = -1) {
  const doc = Text.of(text.split('\n'));
  const tree = mdParser.parse(text);
  return planMarkdown(tree, doc, 0, doc.length, cursor);
}

const ofType = (ops: MdOp[], type: MdOp['type']): MdOp[] =>
  ops.filter((o) => o.type === type);

describe('planMarkdown', () => {
  it('标题：整行样式 + 隐藏 # 和紧跟的空格', () => {
    const { ops } = plan('## 二级');
    expect(ops).toContainEqual({ type: 'line', at: 0, cls: 'cm-md-h2' });
    expect(ops).toContainEqual({ type: 'hide', from: 0, to: 3 });
  });

  it('行内的内容加 mark、标记符 hide，两者不重叠', () => {
    const { ops } = plan('**粗** *斜* ~~删~~ `码`');
    for (const cls of ['cm-md-bold', 'cm-md-italic', 'cm-md-strike', 'cm-md-inline-code']) {
      expect(ops.some((o) => o.type === 'mark' && o.cls === cls)).toBe(true);
    }
    const hides = ofType(ops, 'hide');
    const marks = ofType(ops, 'mark');
    for (const m of marks) {
      if (m.type !== 'mark') continue;
      for (const h of hides) {
        if (h.type !== 'hide') continue;
        // 不允许 hide 与 mark 在同一区间交叠
        expect(h.to <= m.from || h.from >= m.to).toBe(true);
      }
    }
  });

  it('==高亮==：lezer 没有节点，由自定义扫描补上', () => {
    const { ops } = plan('这是 ==重点== 内容');
    expect(ops).toContainEqual({ type: 'mark', from: 5, to: 7, cls: 'cm-md-highlight' });
  });

  it('脚注自动编号，且不会被 lezer 误当成链接渲染', () => {
    const { ops } = plan('正文[^a]\n\n[^a]: 说明');
    const widgets = ofType(ops, 'widget').filter(
      (o) => o.type === 'widget' && o.widget.kind === 'footnote',
    );
    expect(widgets).toHaveLength(2);
    expect(widgets.every((o) => o.type === 'widget' && o.widget.text === '1')).toBe(true);
    expect(ops.some((o) => o.type === 'mark' && o.cls === 'cm-md-link')).toBe(false);
  });

  it('[TOC] 扫全文标题生成嵌套目录，源文件标记不丢', () => {
    const { ops } = plan('[TOC]\n\n# 一\n## 二\n### 三');
    const toc = ofType(ops, 'widget').find(
      (o) => o.type === 'widget' && o.widget.kind === 'toc',
    );
    expect(toc).toBeDefined();
    if (toc?.type !== 'widget') return;
    expect(toc.widget.entries?.map((e) => e.level)).toEqual([1, 2, 3]);
    expect(toc.widget.entries?.map((e) => e.text)).toEqual(['一', '二', '三']);
  });

  it('任务列表渲染成可点击复选框，不额外画项目符号', () => {
    const { ops } = plan('- [x] 已完成\n- [ ] 未完成');
    const boxes = ofType(ops, 'widget').filter(
      (o) => o.type === 'widget' && o.widget.kind === 'checkbox',
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ widget: { checked: true } });
    expect(boxes[1]).toMatchObject({ widget: { checked: false } });
    expect(ops.some((o) => o.type === 'widget' && o.widget.kind === 'bullet')).toBe(false);
  });

  it('普通无序列表画项目符号，有序列表保留序号', () => {
    const { ops } = plan('- 甲\n- 乙\n\n1. 丙');
    const widgets = ofType(ops, 'widget').filter(
      (o) => o.type === 'widget' && (o.widget.kind === 'bullet' || o.widget.kind === 'ordered'),
    );
    expect(widgets.some((o) => o.type === 'widget' && o.widget.text === '•')).toBe(true);
    expect(widgets.some((o) => o.type === 'widget' && o.widget.text === '1.')).toBe(true);
  });

  it('javascript: 链接标成 unsafe，不生成可点击链接', () => {
    const { ops } = plan('[点我](javascript:alert(1))');
    expect(ops.some((o) => o.type === 'mark' && o.cls === 'cm-md-link-unsafe')).toBe(true);
    expect(ops.some((o) => o.type === 'mark' && o.cls === 'cm-md-link')).toBe(false);
  });

  it('https 链接正常渲染并带 title', () => {
    const { ops } = plan('[搜索](https://google.com)');
    expect(ops).toContainEqual({
      type: 'mark',
      from: 1,
      to: 3,
      cls: 'cm-md-link',
      title: 'https://google.com',
    });
  });

  it('代码围栏内部的 == 与脚注不会被渲染', () => {
    const { ops } = plan('```ts\nconst a = ==b==; // [^1]\n```');
    expect(ops.some((o) => o.type === 'mark' && o.cls === 'cm-md-highlight')).toBe(false);
    expect(ops.some((o) => o.type === 'widget' && o.widget.kind === 'footnote')).toBe(false);
  });

  it('Live Preview：光标所在块退回源码，但保留行级样式', () => {
    const text = '## 标题\n\n普通 **粗体**';
    const all = plan(text, -1);
    expect(ofType(all.ops, 'hide').length).toBeGreaterThan(0);

    // 光标落在第二段（含粗体）
    const inSecond = plan(text, text.indexOf('粗体'));
    expect(inSecond.activeBlock).not.toBeNull();
    expect(inSecond.ops.some((o) => o.type === 'mark' && o.cls === 'cm-md-bold')).toBe(false);
    // 标题块不在光标处，仍然渲染
    expect(inSecond.ops.some((o) => o.type === 'hide' && o.from === 0)).toBe(true);
    // 行级样式保留，避免光标移动时整行跳高
    expect(inSecond.ops).toContainEqual({ type: 'line', at: 0, cls: 'cm-md-h2' });
  });

  it('装饰指令按位置严格有序（Decoration.set 的前提）', () => {
    const { ops } = plan('# 一\n\n**粗** 与 *斜* 与 [链](https://a.com)\n\n> 引用\n\n| A | B |\n| - | - |\n| 1 | 2 |');
    const starts = ops.map((o) => (o.type === 'line' ? o.at : o.from));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('renderedLines 覆盖所有会占用位置的行', () => {
    const { renderedLines } = plan('## 标题\n\n普通行\n\n> 引用');
    expect(renderedLines.length).toBeGreaterThanOrEqual(2);
    for (const [a, b] of renderedLines) expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe('isMarkdownLine', () => {
  it('识别各类语法行', () => {
    for (const line of [
      '# 标题',
      '  ### 嵌套标题',
      '> 引用',
      '- 列表',
      '1. 有序',
      '- [x] 任务',
      '| A | B |',
      '```ts',
      '[TOC]',
      '[^1]: 脚注定义',
      '文字 **粗** 与 `码`',
      '[链接](https://a.com)',
    ]) {
      expect(isMarkdownLine(line), `应该识别: ${line}`).toBe(true);
    }
  });

  it('普通文本行不识别', () => {
    for (const line of ['这是一段普通中文', 'const a = 1;', '  缩进的普通文本', '']) {
      expect(isMarkdownLine(line), `不该识别: ${line}`).toBe(false);
    }
  });
});
