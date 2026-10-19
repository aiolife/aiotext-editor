/**
 * 查找 / 替换面板（F-05 §5.4 + F-09 §6.2「使用工具」）
 *
 * - 支持中文增强正则（`\c[GBK]` 等类目可在下拉中直接插入）
 * - 忽略回车 / 忽略半角空格 / 忽略标点 / 区分大小写 / 使用转义符
 * - 上一个 / 下一个 / 替换当前 / 全部替换；命中实时高亮（见 Editor.tsx）
 * - 「使用工具」：不填替换内容，改为把每个命中交给整理工具处理（F-09）
 *
 * 偏移口径：后端返回 **UTF-16 码元**，与 CodeMirror 文档坐标一致，
 * 因此高亮与选区请求可直接使用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_REGEX_OPTIONS,
  regexCategories,
  regexFind,
  regexReplace,
  regexReplaceWithTool,
  type MatchSpan,
  type RegexCategory,
  type RegexOptions,
  type ToolId,
  type ToolMeta,
} from '../platform/tauriApi';
import type { SearchHighlight } from './Editor';
import { escapeForFind } from '../shared/findText';

interface SearchPanelProps {
  /** 当前标签正文（查找/替换的作用对象） */
  content: string;
  /** 可用的整理工具（「使用工具」下拉；F-09） */
  tools?: ToolMeta[];
  /** 命中变化 → 编辑器高亮 */
  onHighlights: (highlights: SearchHighlight[]) => void;
  /** 定位到某个命中 → 编辑器选区 */
  onSelect: (from: number, to: number) => void;
  /** 写回文本（整篇或某一段） */
  onApplyEdit: (from: number, to: number, text: string) => void;
  onClose: () => void;
  /**
   * 外部命令（F-11 命令分发器驱动）：`nonce` 变化时执行一次。
   *
   * 用「非 0 序号」而不是布尔标志：连续按两次 F3 必须各执行一次，
   * 布尔值第二次就无效了。`Ctrl+F` / `Ctrl+H` 也走这里，从而能直接落到
   * 查找框或替换框上——不必给面板再加一套 ref 转发。
   */
  external?: {
    kind: 'next' | 'prev' | 'focusFind' | 'focusReplace';
    nonce: number;
    /** 要填进查找框的文字（用户在编辑器里选中了文字才带过来） */
    text?: string;
  } | null;
}

const OPTION_ITEMS: { key: keyof RegexOptions; label: string }[] = [
  { key: 'regex', label: '正则' },
  { key: 'ignoreNewlines', label: '忽略回车' },
  { key: 'ignoreHalfSpace', label: '忽略半角空格' },
  { key: 'ignorePunct', label: '忽略标点' },
  { key: 'caseInsensitive', label: '忽略大小写' },
  { key: 'useEscape', label: '使用转义符' },
];

export function SearchPanel({
  content,
  tools = [],
  onHighlights,
  onSelect,
  onApplyEdit,
  onClose,
  external = null,
}: SearchPanelProps) {
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  /** 外部填入查找词后自动查找的序号（0 = 还没被填过） */
  const [autoFind, setAutoFind] = useState(0);
  /** 「使用工具」：非空时替换内容 = 该工具对命中文本的处理结果 */
  const [toolId, setToolId] = useState<ToolId | ''>('');
  const [opts, setOpts] = useState<RegexOptions>(DEFAULT_REGEX_OPTIONS);
  const [spans, setSpans] = useState<MatchSpan[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [categories, setCategories] = useState<RegexCategory[]>([]);
  const findRef = useRef<HTMLInputElement | null>(null);
  const replaceRef = useRef<HTMLInputElement | null>(null);
  /** 替换后需要按新内容刷新命中区间 */
  const refreshRef = useRef(false);
  /** 已处理过的外部命令序号（见 `external` 的说明） */
  const externalNonceRef = useRef(0);

  useEffect(() => {
    findRef.current?.focus();
    regexCategories().then(setCategories).catch(() => setCategories([]));
  }, []);

  /** 命中列表 + 当前序号 → 同步给编辑器 */
  const publish = useCallback(
    (nextSpans: MatchSpan[], nextActive: number) => {
      setSpans(nextSpans);
      setActive(nextActive);
      onHighlights(
        nextSpans.map((span, index) => ({
          start: span.start,
          end: span.end,
          active: index === nextActive,
        })),
      );
      const current = nextSpans[nextActive];
      if (current) onSelect(current.start, current.end);
    },
    [onHighlights, onSelect],
  );

  const clear = useCallback(() => {
    setSpans([]);
    setActive(0);
    onHighlights([]);
  }, [onHighlights]);

  /** 执行查找；`keepIndex` 尽量保持当前序号 */
  const runFind = useCallback(
    async (keepIndex = true) => {
      if (!findText) {
        clear();
        setError(null);
        setInfo(null);
        return;
      }
      setBusy(true);
      try {
        const found = await regexFind(content, findText, opts);
        setError(null);
        const index = keepIndex && found.length > 0 ? Math.min(active, found.length - 1) : 0;
        publish(found, index);
        setInfo(found.length === 0 ? '没有命中' : `第 ${index + 1} / ${found.length} 个命中`);
      } catch (e) {
        clear();
        setInfo(null);
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [active, clear, content, findText, opts, publish],
  );

  // 替换后正文变化 → 自动按新内容刷新命中（保持当前序号）
  useEffect(() => {
    if (!refreshRef.current) return;
    refreshRef.current = false;
    void runFind(true);
  }, [content, runFind]);

  /** 上一个 / 下一个 */
  const step = useCallback(
    (delta: number) => {
      if (spans.length === 0) return;
      const index = (active + delta + spans.length) % spans.length;
      publish(spans, index);
      setInfo(`第 ${index + 1} / ${spans.length} 个命中`);
    },
    [active, publish, spans],
  );

  /**
   * 外部命令（F-11 的 `search.find` / `search.replace` / `search.findNext` /
   * `search.findPrevious`）。`step` 在依赖里会随命中变化而重建，
   * 但靠 `externalNonceRef` 去重，所以重建不会导致重复执行。
   */
  useEffect(() => {
    if (external === null || external.nonce === externalNonceRef.current) return;
    externalNonceRef.current = external.nonce;
    // 先选中文字、再开面板：把选中的文字直接带进查找框。
    // 空选区一个字都不动 —— 否则用户边输入边被覆盖，那是很难用的 bug。
    if (external.text) {
      const escaped = escapeForFind(external.text);
      // 转义改了内容，说明原文里带元字符或换行，那就只能按正则查
      if (escaped !== external.text) {
        setOpts((prev) => ({ ...prev, regex: true }));
      }
      setFindText(escaped);
      setAutoFind((n) => n + 1);
    }
    switch (external.kind) {
      case 'next':
        step(1);
        break;
      case 'prev':
        step(-1);
        break;
      case 'focusFind':
        findRef.current?.focus();
        break;
      case 'focusReplace':
        replaceRef.current?.focus();
        break;
    }
  }, [external, step]);

  /**
   * 外部填入查找词后自动跑一次查找。
   *
   * 单独一轮 effect：`setFindText` 之后紧接着调 `runFind` 的话，
   * 闭包里拿到的还是旧词；等这一轮渲染完成再查，才是刚填进去的那个。
   */
  useEffect(() => {
    if (autoFind === 0) return;
    void runFind(false);
    // 只在「外部填入」时触发，不跟随 runFind 的重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFind]);

  /** 替换当前这一个（精确到区间，光标不跳） */
  const replaceCurrent = useCallback(async () => {
    const target = spans[active];
    if (!target) return;
    setBusy(true);
    try {
      const report = toolId
        ? await regexReplaceWithTool(content, findText, opts, { kind: toolId }, active, 1)
        : await regexReplace(content, findText, replaceText, opts, active, 1);
      if (report.count === 0) {
        setInfo('没有可替换的命中');
        return;
      }
      onApplyEdit(target.start, target.end, report.replacements[0] ?? '');
      setInfo(toolId ? '已用工具处理 1 处' : '已替换 1 处');
      setError(null);
      refreshRef.current = true; // 等新正文回流后刷新命中
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [active, content, findText, onApplyEdit, opts, replaceText, spans, toolId]);

  /** 全部替换（或对全部命中套用工具） */
  const replaceAll = useCallback(async () => {
    if (!findText) return;
    setBusy(true);
    try {
      const report = toolId
        ? await regexReplaceWithTool(content, findText, opts, { kind: toolId }, 0, null)
        : await regexReplace(content, findText, replaceText, opts, 0, null);
      if (report.count === 0) {
        setInfo('没有可替换的命中');
        return;
      }
      onApplyEdit(0, content.length, report.text);
      clear();
      setInfo(toolId ? `已用工具处理 ${report.count} 处` : `已替换 ${report.count} 处`);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [clear, content, findText, onApplyEdit, opts, replaceText, toolId]);

  /** 在查找框中插入类目写法 */
  const insertCategory = useCallback(
    (token: string) => {
      const input = findRef.current;
      if (!input) {
        setFindText((text) => text + token);
        return;
      }
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const next = input.value.slice(0, start) + token + input.value.slice(end);
      setFindText(next);
      requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(start + token.length, start + token.length);
      });
    },
    [],
  );

  const optionSummary = useMemo(() => {
    const off = OPTION_ITEMS.filter((item) => !opts[item.key]).map((item) => item.label);
    return off.length > 0 ? `关闭：${off.join('、')}` : '全部开关开启';
  }, [opts]);

  return (
    <div className="search-panel" role="search">
      <div className="search-row">
        <label className="search-label" htmlFor="search-find">
          查找
        </label>
        <input
          id="search-find"
          ref={findRef}
          className="search-input"
          value={findText}
          placeholder="支持 \c[GBK]、\c[天干]、\a、\d 等中文类目"
          onChange={(e) => setFindText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void runFind(false);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <select
          className="search-category"
          value=""
          title="插入中文类目"
          onChange={(e) => {
            if (e.target.value) insertCategory(e.target.value);
            e.target.value = '';
          }}
        >
          <option value="">类目…</option>
          {categories.map((category) => (
            <option key={category.token} value={category.token}>
              {category.label}（{category.sample}）
            </option>
          ))}
        </select>
      </div>

      <div className="search-row">
        <label className="search-label" htmlFor="search-replace">
          替换
        </label>
        <input
          id="search-replace"
          ref={replaceRef}
          className="search-input"
          value={replaceText}
          disabled={Boolean(toolId)}
          placeholder={
            toolId ? '已选择「使用工具」，替换内容由工具生成' : '可用 \\1 或 $1 引用捕获组'
          }
          onChange={(e) => setReplaceText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <label className="search-tool" htmlFor="search-tool">
          使用工具
        </label>
        <select
          id="search-tool"
          className="search-category"
          value={toolId}
          title="把每个命中交给整理工具处理（F-09）"
          onChange={(e) => setToolId(e.target.value as ToolId | '')}
        >
          <option value="">（不使用）</option>
          {tools
            .filter((tool) => !tool.inspectsOnly)
            .map((tool) => (
              <option key={tool.id} value={tool.id}>
                {tool.label}
                {tool.hasOptions ? '（默认选项）' : ''}
              </option>
            ))}
        </select>
      </div>

      <div className="search-options" title={optionSummary}>
        {OPTION_ITEMS.map((item) => (
          <label key={item.key} className="search-option">
            <input
              type="checkbox"
              checked={opts[item.key]}
              onChange={(e) => setOpts((prev) => ({ ...prev, [item.key]: e.target.checked }))}
            />
            {item.label}
          </label>
        ))}
      </div>

      <div className="search-actions">
        <button type="button" onClick={() => void runFind(false)} disabled={busy}>
          查找
        </button>
        <button type="button" onClick={() => step(-1)} disabled={busy || spans.length === 0}>
          上一个
        </button>
        <button type="button" onClick={() => step(1)} disabled={busy || spans.length === 0}>
          下一个
        </button>
        <button
          type="button"
          onClick={() => void replaceCurrent()}
          disabled={busy || spans.length === 0}
        >
          {toolId ? '处理当前' : '替换'}
        </button>
        <button type="button" onClick={() => void replaceAll()} disabled={busy || !findText}>
          {toolId ? '全部处理' : '全部替换'}
        </button>
        <button type="button" className="search-close" onClick={onClose}>
          关闭
        </button>
      </div>

      {error && <div className="search-error">{error}</div>}
      {!error && info && <div className="search-info">{info}</div>}
    </div>
  );
}
