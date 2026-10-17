/**
 * 接口层单测（F-03 简繁互转部分）
 *
 * 校验前端调用与 Rust 端命令契约一致：命令名、参数包装（req）、
 * 豁免括号对结构、方向元数据字段名。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
/** 每次 `new Channel()` 都记一笔（断言 batchRun 确实建了通道） */
const channelCtorMock = vi.hoisted(() => vi.fn());

/**
 * Tauri 2 的 `Channel<T>` 在前端是「带 onmessage 的回调容器」。
 * 单测里给个最小实现：`onmessage` 可赋值，测试用 `emit` 模拟后端推消息。
 */
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class {
    onmessage: ((msg: unknown) => void) | null = null;
    constructor() {
      channelCtorMock();
    }
    emit(msg: unknown) {
      this.onmessage?.(msg);
    }
  },
}));

import {
  BRACKET_PRESETS,
  DEFAULT_COMPARE_OPTIONS,
  DEFAULT_MERGE_PATTERNS,
  DEFAULT_REGEX_OPTIONS,
  ENCODING_OPTIONS,
  ENCODING_OR_AUTO_OPTIONS,
  FONT_SIZE_RANGE,
  LINE_ENDING_OPTIONS,
  NEW_TABLE_TEMPLATE,
  TAB_WIDTH_RANGE,
  THEME_OPTIONS,
  TOOL_OPTION_DEFAULTS,
  TOOL_SHORTCUTS,
  VARIANT_STRICTNESS_OPTIONS,
  applyPipelineChain,
  applyPipelineStep,
  applyReplace,
  batchCancel,
  batchPlan,
  batchRun,
  compareTexts,
  convertOpencc,
  deleteReplaceTable,
  importTextproTab,
  listOpenccDirections,
  listReplaceTables,
  loadReplaceTable,
  mergeFiles,
  parseReplaceTableText,
  pipelinesCatalog,
  previewConvert,
  readReplaceTableSource,
  regexCategories,
  regexFind,
  regexReplace,
  regexReplaceWithTool,
  saveReplaceTableSource,
  settingsGet,
  settingsReset,
  settingsSave,
  type ConvertRequest,
  type ReplaceTable,
  type ToolId,
} from './tauriApi';
import { DEFAULT_SETTINGS } from '../store/settingsStore';

function baseRequest(overrides: Partial<ConvertRequest> = {}): ConvertRequest {
  return {
    text: '头发',
    direction: 's2t',
    skipInside: [],
    applyUserTables: [],
    diagnostics: false,
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe('listOpenccDirections', () => {
  it('调用无参命令并映射元数据', async () => {
    // PRD v0.5 §3.5：引擎只提供 6 种，字段也不再有「common」
    invokeMock.mockResolvedValue([
      { id: 's2t', label: '简体 → 繁体（OpenCC 标准）' },
      { id: 'hk2s', label: '香港繁体 → 简体' },
    ]);
    const list = await listOpenccDirections();
    expect(invokeMock).toHaveBeenCalledWith('list_opencc_directions');
    expect(list.map((d) => d.id)).toEqual(['s2t', 'hk2s']);
  });
});

describe('convertOpencc', () => {
  it('以 { req } 包装请求并返回报告', async () => {
    invokeMock.mockResolvedValue({
      text: '頭髮',
      changedCount: 2,
      ambiguities: [],
      appliedTables: [],
      directionLabel: '简体 → 繁体（OpenCC 标准）',
    });
    const report = await convertOpencc(baseRequest());
    expect(invokeMock).toHaveBeenCalledWith('convert_opencc', { req: baseRequest() });
    expect(report.text).toBe('頭髮');
    expect(report.changedCount).toBe(2);
  });

  it('歧义片段按契约字段返回', async () => {
    invokeMock.mockResolvedValue({
      text: '鼠標',
      changedCount: 1,
      ambiguities: [{ start: 3, end: 5, candidates: ['滑鼠'], primary: '鼠標' }],
      appliedTables: [],
      directionLabel: '简体 → 繁体（OpenCC 标准）',
    });
    const report = await convertOpencc(baseRequest({ diagnostics: true }));
    expect(report.ambiguities[0]).toEqual({
      start: 3,
      end: 5,
      candidates: ['滑鼠'],
      primary: '鼠標',
    });
  });
});

describe('previewConvert', () => {
  it('传递括号对豁免与诊断开关', async () => {
    invokeMock.mockResolvedValue({
      text: '[] 头发',
      changedCount: 0,
      changedLines: 0,
      totalLines: 1,
      lines: [],
      truncated: false,
      directionLabel: '简体 → 繁体（OpenCC 标准）',
      ambiguities: [],
    });
    const request = baseRequest({
      skipInside: [{ open: '[', close: ']' }],
      diagnostics: true,
    });
    await previewConvert(request);
    expect(invokeMock).toHaveBeenCalledWith('preview_convert', { req: request });
  });

  it('行内差异区间按 [start, end] 元组返回', async () => {
    invokeMock.mockResolvedValue({
      text: '第二行 頭髮',
      changedCount: 2,
      changedLines: 1,
      totalLines: 2,
      lines: [
        {
          lineNumber: 2,
          old: '第二行 头发',
          new: '第二行 頭髮',
          oldRange: [4, 6],
          newRange: [4, 6],
        },
      ],
      truncated: false,
      directionLabel: '简体 → 繁体（OpenCC 标准）',
      ambiguities: [],
    });
    const preview = await previewConvert(baseRequest());
    expect(preview.lines[0].oldRange).toEqual([4, 6]);
    expect(preview.changedLines).toBe(1);
    expect(preview.totalLines).toBe(2);
  });
});

const sampleTable: ReplaceTable = {
  name: '测试表',
  description: '单测用',
  entries: [
    { pattern: '少/兔', candidates: ['少', '兔'], replacement: '㝹' },
  ],
  rules: { wholeWord: false, caseSensitive: true, escape: true, useRegex: false },
  meta: { name: '测试表', builtin: false, entryCount: 1, description: '单测用', path: 'C:/t/测试表.tab' },
};

describe('F-04 替换表接口', () => {
  it('listReplaceTables 返回元数据列表', async () => {
    invokeMock.mockResolvedValue([
      { name: '我的表', builtin: false, entryCount: 3, description: '', path: 'C:/t/a.tab' },
      { name: '异体字校正', builtin: true, entryCount: 1002, description: '', path: 'C:/t/b.tab' },
    ]);
    const list = await listReplaceTables();
    expect(invokeMock).toHaveBeenCalledWith('list_replace_tables');
    expect(list.filter((t) => t.builtin)).toHaveLength(1);
  });

  it('loadReplaceTable 以 name 传参', async () => {
    invokeMock.mockResolvedValue(sampleTable);
    const table = await loadReplaceTable('测试表');
    expect(invokeMock).toHaveBeenCalledWith('load_replace_table', { name: '测试表' });
    expect(table.entries[0].candidates).toEqual(['少', '兔']);
  });

  it('readReplaceTableSource 返回源文本', async () => {
    invokeMock.mockResolvedValue('#name: 测试表\n少/兔=㝹\n');
    const text = await readReplaceTableSource('测试表');
    expect(invokeMock).toHaveBeenCalledWith('read_replace_table_source', { name: '测试表' });
    expect(text).toContain('少/兔=㝹');
  });

  it('parseReplaceTableText 返回表与行号级报告', async () => {
    invokeMock.mockResolvedValue({
      table: sampleTable,
      report: {
        ok: false,
        errors: 1,
        warnings: 0,
        entryCount: 1,
        issues: [{ line: 7, severity: 'error', message: '第 7 条缺少 =' }],
      },
    });
    const parsed = await parseReplaceTableText('x', '测试表');
    expect(invokeMock).toHaveBeenCalledWith('parse_replace_table_text', {
      text: 'x',
      name: '测试表',
    });
    expect(parsed.report.issues[0].line).toBe(7);
    expect(parsed.report.ok).toBe(false);
  });

  it('saveReplaceTableSource 传 name/text/sourcePath', async () => {
    invokeMock.mockResolvedValue({
      name: '测试表',
      builtin: false,
      entryCount: 1,
      description: '',
      path: 'C:/t/测试表.tab',
    });
    await saveReplaceTableSource('测试表', 'a=b\n', 'C:/t/测试表.tab');
    expect(invokeMock).toHaveBeenCalledWith('save_replace_table_source', {
      name: '测试表',
      text: 'a=b\n',
      sourcePath: 'C:/t/测试表.tab',
    });
  });

  it('deleteReplaceTable 直接传表名', async () => {
    invokeMock.mockResolvedValue(undefined);
    await deleteReplaceTable('测试表');
    expect(invokeMock).toHaveBeenCalledWith('delete_replace_table', { name: '测试表' });
  });

  it('applyReplace 以 opts 指定模式', async () => {
    invokeMock.mockResolvedValue({ text: '㝹', changedCount: 1, perEntryCount: { 兔: 1 } });
    const report = await applyReplace('兔', sampleTable, { mode: 'asOpenccDic' });
    expect(invokeMock).toHaveBeenCalledWith('apply_replace', {
      text: '兔',
      table: sampleTable,
      opts: { mode: 'asOpenccDic' },
    });
    expect(report.perEntryCount['兔']).toBe(1);
  });

  it('importTextproTab 传路径与可选表名', async () => {
    invokeMock.mockResolvedValue(sampleTable);
    await importTextproTab('C:/legacy.tab', null);
    expect(invokeMock).toHaveBeenCalledWith('import_textpro_tab', {
      path: 'C:/legacy.tab',
      name: null,
    });
  });

  it('新建模板含元数据行且不带反引号（避免模板串被截断）', () => {
    expect(NEW_TABLE_TEMPLATE).toContain('#name:');
    expect(NEW_TABLE_TEMPLATE).toContain('#desc:');
    expect(NEW_TABLE_TEMPLATE).not.toContain('`');
  });
});

describe('F-05 正则接口', () => {
  it('regexFind 返回 UTF-16 区间与捕获组', async () => {
    invokeMock.mockResolvedValue([{ start: 0, end: 2, text: '你好', groups: ['你好'] }]);
    const spans = await regexFind('你好世界', '(你好)', DEFAULT_REGEX_OPTIONS);
    expect(invokeMock).toHaveBeenCalledWith('regex_find', {
      text: '你好世界',
      pattern: '(你好)',
      opts: DEFAULT_REGEX_OPTIONS,
    });
    expect(spans[0].end).toBe(2);
  });

  it('regexReplace 传 skip/limit 与替换回显', async () => {
    invokeMock.mockResolvedValue({
      text: 'a-X-a',
      count: 1,
      spans: [{ start: 2, end: 3, text: 'a', groups: [] }],
      replacements: ['X'],
    });
    const report = await regexReplace('a-a-a', 'a', 'X', DEFAULT_REGEX_OPTIONS, 1, 1);
    expect(invokeMock).toHaveBeenCalledWith('regex_replace', {
      text: 'a-a-a',
      pattern: 'a',
      replacement: 'X',
      opts: DEFAULT_REGEX_OPTIONS,
      skip: 1,
      limit: 1,
    });
    expect(report.replacements).toEqual(['X']);
  });

  it('regexCategories 返回类目下拉数据', async () => {
    invokeMock.mockResolvedValue([
      { token: '\\c[GBK]', label: 'GBK 全部字符', sample: '汉' },
    ]);
    const list = await regexCategories();
    expect(invokeMock).toHaveBeenCalledWith('regex_categories');
    expect(list[0].token).toBe('\\c[GBK]');
  });

  it('默认选项：正则与转义开启，忽略开关关闭', () => {
    expect(DEFAULT_REGEX_OPTIONS).toEqual({
      regex: true,
      ignoreNewlines: false,
      ignorePunct: false,
      ignoreHalfSpace: false,
      caseInsensitive: false,
      useEscape: true,
    });
  });
});

describe('F-09 整理工具接口', () => {
  it('pipelinesCatalog 走 pipelines_catalog 命令', async () => {
    invokeMock.mockResolvedValue([
      {
        id: 'simple_layout',
        label: '简单排版',
        group: '排版与分段',
        hint: '删除空行 + 规范行首 + 删除行末空格',
        hasOptions: true,
        inspectsOnly: false,
      },
    ]);
    const list = await pipelinesCatalog();
    expect(invokeMock).toHaveBeenCalledWith('pipelines_catalog');
    expect(list[0].id).toBe('simple_layout');
    expect(list[0].hasOptions).toBe(true);
  });

  it('applyPipelineStep 以 {text, step} 传参（step 带 kind）', async () => {
    invokeMock.mockResolvedValue({
      text: '甲\n乙\n',
      changed: 1,
      notes: ['删除 1 个空行'],
      bracketIssues: [],
    });
    const outcome = await applyPipelineStep('甲\n\n乙\n', { kind: 'remove_empty_lines' });
    expect(invokeMock).toHaveBeenCalledWith('apply_pipeline_step', {
      text: '甲\n\n乙\n',
      step: { kind: 'remove_empty_lines' },
    });
    expect(outcome.notes).toEqual(['删除 1 个空行']);
  });

  it('applyPipelineChain 传步骤数组（保留顺序）', async () => {
    invokeMock.mockResolvedValue({
      text: '　甲\n',
      changed: 2,
      notes: ['1. 清理 1 行行末空格', '2. 规范 1 行行首'],
      bracketIssues: [],
    });
    const steps = [
      { kind: 'trim_line_end' as const },
      { kind: 'normalize_line_head' as const, indent: 1 },
    ];
    const outcome = await applyPipelineChain('甲 \n', steps);
    expect(invokeMock).toHaveBeenCalledWith('apply_pipeline_chain', { text: '甲 \n', steps });
    expect(outcome.changed).toBe(2);
  });

  it('匹配括号的检查结果带回行号与列号', async () => {
    invokeMock.mockResolvedValue({
      text: '甲（乙',
      changed: 0,
      notes: ['检出 1 处括号问题'],
      bracketIssues: [{ line: 1, column: 2, ch: '（', message: '第 1 行第 2 列：`（` 未闭合' }],
    });
    const outcome = await applyPipelineStep('甲（乙', { kind: 'match_brackets' });
    expect(outcome.bracketIssues[0]).toMatchObject({ line: 1, column: 2, ch: '（' });
    // 只检查不改写
    expect(outcome.text).toBe('甲（乙');
  });

  it('regexReplaceWithTool 传工具步骤而非替换串', async () => {
    invokeMock.mockResolvedValue({
      text: 'ａ甲',
      count: 1,
      spans: [{ start: 0, end: 1, text: 'a', groups: [] }],
      replacements: ['ａ'],
    });
    await regexReplaceWithTool(
      'a甲',
      '[a]',
      DEFAULT_REGEX_OPTIONS,
      { kind: 'half_to_full' },
      0,
      null,
    );
    expect(invokeMock).toHaveBeenCalledWith('regex_replace_with_tool', {
      text: 'a甲',
      pattern: '[a]',
      opts: DEFAULT_REGEX_OPTIONS,
      step: { kind: 'half_to_full' },
      skip: 0,
      limit: null,
    });
  });

  it('每个工具都有默认选项，且与后端字段名一致', () => {
    const ids: ToolId[] = [
      'remove_half_width',
      'full_to_half',
      'half_to_full',
      'normalize_line_head',
      'trim_line_end',
      'trim_line_head',
      'remove_intra_line_breaks',
      'sort_lines',
      'dedup_lines',
      'remove_empty_lines',
      'insert_blank_between',
      'simple_layout',
      'auto_segment',
      'control_width',
      'match_brackets',
      'fix_brackets',
      'half_quote_to_full',
      'vertical_to_horizontal',
    ];
    expect(Object.keys(TOOL_OPTION_DEFAULTS).sort()).toEqual([...ids].sort());
    // 关键默认值与 F-09 一致（Rust 端由单测 defaults_match_spec 锁定同一组值）
    expect(TOOL_OPTION_DEFAULTS.simple_layout.indent).toBe(2);
    expect(TOOL_OPTION_DEFAULTS.normalize_line_head).toMatchObject({ indent: 2, force: true });
    expect(TOOL_OPTION_DEFAULTS.control_width.width).toBe(40);
    expect(TOOL_OPTION_DEFAULTS.half_to_full).toMatchObject({
      convertAlnum: true,
      convertPunct: false,
      mergeSpaces: true,
    });
    expect(TOOL_OPTION_DEFAULTS.auto_segment).toMatchObject({ indent: 2, skipDialog: true });
    // 工具栏快捷入口都在目录内且不重复
    expect(new Set(TOOL_SHORTCUTS).size).toBe(TOOL_SHORTCUTS.length);
    for (const id of TOOL_SHORTCUTS) expect(ids).toContain(id);
  });
});

describe('BRACKET_PRESETS', () => {
  it('覆盖常用括号对且均为单字符', () => {
    const specs = BRACKET_PRESETS.map((p) => `${p.open}${p.close}`);
    expect(specs).toContain('[]');
    expect(specs).toContain('()');
    expect(specs).toContain('「」');
    expect(specs).toContain('“”');
    for (const preset of BRACKET_PRESETS) {
      expect(Array.from(preset.open)).toHaveLength(1);
      expect(Array.from(preset.close)).toHaveLength(1);
    }
  });
});

describe('F-06 文件比较接口', () => {
  it('compareTexts 以 camelCase 选项调用 compare_texts', async () => {
    invokeMock.mockResolvedValue({
      differences: [{ posA: 1, posB: 1, charA: '乙', charB: 'X' }],
      truncated: false,
      end: 'bothEnded',
      remainingA: 0,
      remainingB: 0,
    });
    const report = await compareTexts('甲乙丙', '甲X丙', DEFAULT_COMPARE_OPTIONS);
    expect(invokeMock).toHaveBeenCalledWith('compare_texts', {
      a: '甲乙丙',
      b: '甲X丙',
      opts: DEFAULT_COMPARE_OPTIONS,
    });
    expect(report.differences[0]).toMatchObject({ posA: 1, charA: '乙', charB: 'X' });
    expect(report.end).toBe('bothEnded');
  });

  it('默认比较选项：全不忽略、逐字比较（与后端 Default 一致）', () => {
    expect(DEFAULT_COMPARE_OPTIONS).toEqual({
      ignoreNewlines: false,
      ignoreHalfSpace: false,
      ignoreFullPunct: false,
      ignoreHalfPunct: false,
      variantStrictness: 'strict',
    });
  });

  it('异体字策略取值与后端枚举一一对应', () => {
    const values = VARIANT_STRICTNESS_OPTIONS.map((option) => option.value).sort();
    expect(values).toEqual(['fullEq', 'partialEq', 'strict']);
  });
});

describe('F-07 文件合并接口', () => {
  it('手工合并：平铺 JSON 形状（mode 判别 + 共用字段同层）', async () => {
    invokeMock.mockResolvedValue({
      outputs: [{ path: 'C:\\out\\merged.txt', name: 'merged.txt', fileCount: 2, charCount: 8, order: ['a.txt', 'b.txt'] }],
      skipped: [],
      scanned: 2,
    });
    const report = await mergeFiles({
      mode: 'manual',
      files: ['a.txt', 'b.txt'],
      strategy: 'simple',
      sortKey: null,
      outputPath: 'C:\\out\\merged.txt',
      overwrite: true,
    });
    expect(invokeMock).toHaveBeenCalledWith('merge_files', {
      req: {
        mode: 'manual',
        files: ['a.txt', 'b.txt'],
        strategy: 'simple',
        sortKey: null,
        outputPath: 'C:\\out\\merged.txt',
        overwrite: true,
      },
    });
    expect(report.outputs[0]).toMatchObject({ fileCount: 2, order: ['a.txt', 'b.txt'] });
  });

  it('自动合并：正则三件套随请求平铺（F-07 §7.2 示例）', async () => {
    invokeMock.mockResolvedValue({ outputs: [], skipped: [], scanned: 0 });
    await mergeFiles({
      mode: 'auto',
      directory: 'D:\\splits',
      strategy: 'sameName',
      sourcePattern: '(\\d+)_(\\d+)\\.txt',
      outputPattern: '\\1.txt',
      sortKey: '\\2',
      overwrite: false,
    });
    expect(invokeMock).toHaveBeenCalledWith('merge_files', {
      req: {
        mode: 'auto',
        directory: 'D:\\splits',
        strategy: 'sameName',
        sourcePattern: '(\\d+)_(\\d+)\\.txt',
        outputPattern: '\\1.txt',
        sortKey: '\\2',
        overwrite: false,
      },
    });
  });

  it('跳过项带原因（读取失败 / 输出已存在）', async () => {
    invokeMock.mockResolvedValue({
      outputs: [],
      skipped: [{ path: 'x.txt', reason: '输出文件已存在（未勾选覆盖）' }],
      scanned: 1,
    });
    const report = await mergeFiles({
      mode: 'manual',
      files: ['x.txt'],
      strategy: 'simple',
      outputPath: 'out.txt',
      overwrite: false,
    });
    expect(report.skipped[0].reason).toContain('已存在');
  });

  it('自动合并的正则三件套默认值即规格示例', () => {
    expect(DEFAULT_MERGE_PATTERNS).toEqual({
      sourcePattern: '(\\d+)_(\\d+)\\.txt',
      outputPattern: '\\1.txt',
      sortKey: '\\2',
    });
  });
});

describe('F-08 批处理接口', () => {
  it('batchRun 走 Tauri 2 Channel<BatchProgress> 通道并原样转发', async () => {
    channelCtorMock.mockClear();
    invokeMock.mockImplementation(
      async (cmd: string, args?: { progress?: { emit: (m: unknown) => void } }) => {
        // 后端已合并进度（至多 ~10 条/秒），这里用 emit 模拟几条快照
        args?.progress?.emit({
          kind: 'progress',
          done: 1,
          total: 2,
          modified: 1,
          errors: 0,
          current: 'a.txt',
          lastError: null,
        });
        args?.progress?.emit({
          kind: 'progress',
          done: 2,
          total: 2,
          modified: 1,
          errors: 0,
          current: 'b.txt',
          lastError: null,
        });
        args?.progress?.emit({
          kind: 'finished',
          report: {
            scanned: 2,
            unchanged: 1,
            written: 1,
            backedUp: 1,
            cancelled: false,
            errors: [],
            elapsedMs: 42,
          },
        });
        expect(cmd).toBe('batch_run');
        return {
          scanned: 2,
          unchanged: 1,
          written: 1,
          backedUp: 1,
          cancelled: false,
          errors: [],
          elapsedMs: 42,
        };
      },
    );
    const collected: { kind: string }[] = [];
    const report = await batchRun(
      {
        inputs: ['D:\\incoming'],
        recursive: true,
        backup: true,
        preserveMtime: true,
        inputEncoding: 'auto',
        outputEncoding: 'utf-8',
        steps: [{ kind: 'remove_empty_lines' }, { kind: 'trim_line_end' }],
      },
      (msg) => collected.push(msg),
    );
    // 通道被构造一次，请求被原样转发（含 progress 通道对象）
    expect(channelCtorMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      'batch_run',
      expect.objectContaining({
        req: {
          inputs: ['D:\\incoming'],
          recursive: true,
          backup: true,
          preserveMtime: true,
          inputEncoding: 'auto',
          outputEncoding: 'utf-8',
          steps: [{ kind: 'remove_empty_lines' }, { kind: 'trim_line_end' }],
        },
      }),
    );
    // 前端 onmessage 确实收到了 3 条事件（含终态）
    expect(collected).toHaveLength(3);
    expect(collected[0].kind).toBe('progress');
    expect(collected[2].kind).toBe('finished');
    expect(report.written).toBe(1);
    expect(report.errors).toHaveLength(0);
  });

  it('batchCancel 直接调 batch_cancel', async () => {
    invokeMock.mockResolvedValue(undefined);
    await batchCancel();
    expect(invokeMock).toHaveBeenCalledWith('batch_cancel');
  });

  it('batchPlan 返回 fileCount + 路径样本', async () => {
    invokeMock.mockResolvedValue({
      fileCount: 12,
      sample: ['D:\\incoming\\a.txt', 'D:\\incoming\\b.txt'],
    });
    const plan = await batchPlan({
      inputs: ['D:\\incoming'],
      recursive: false,
      backup: false,
      preserveMtime: true,
      inputEncoding: 'auto',
      outputEncoding: 'auto',
      steps: [],
    });
    expect(plan.fileCount).toBe(12);
    expect(plan.sample).toEqual(['D:\\incoming\\a.txt', 'D:\\incoming\\b.txt']);
  });
});

describe('F-11 偏好设置接口', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('settingsGet 走 settings_get，无参数', async () => {
    invokeMock.mockResolvedValue({ appearance: { theme: 'dark' } });
    const s = await settingsGet();
    expect(invokeMock).toHaveBeenCalledWith('settings_get');
    expect(s.appearance.theme).toBe('dark');
  });

  it('settingsSave 把设置包一层 settings 传过去（与后端参数名一致）', async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: { settings: unknown }) => args.settings);
    const written = await settingsSave({ ...DEFAULT_SETTINGS, shortcuts: { 'f5': 'compare.next' } });
    expect(invokeMock).toHaveBeenCalledWith(
      'settings_save',
      expect.objectContaining({
        settings: expect.objectContaining({ shortcuts: { f5: 'compare.next' } }),
      }),
    );
    expect(written.shortcuts.f5).toBe('compare.next');
  });

  it('settingsReset 走 settings_reset', async () => {
    invokeMock.mockResolvedValue(DEFAULT_SETTINGS);
    await settingsReset();
    expect(invokeMock).toHaveBeenCalledWith('settings_reset');
  });

  it('默认值常量与后端 Settings::default() 逐字段一致', () => {
    // 这些字面量必须与 core/settings.rs 的 Default 实现同步
    expect(DEFAULT_SETTINGS.appearance.fontSize).toBe(14);
    expect(DEFAULT_SETTINGS.appearance.showLineNumber).toBe(true);
    expect(DEFAULT_SETTINGS.appearance.showToolbar).toBe(true);
    expect(DEFAULT_SETTINGS.appearance.showStatusBar).toBe(true);
    expect(DEFAULT_SETTINGS.appearance.theme).toBe('system');
    expect(DEFAULT_SETTINGS.editor.tabWidth).toBe(4);
    expect(DEFAULT_SETTINGS.editor.insertSpaces).toBe(true);
    expect(DEFAULT_SETTINGS.editor.wrap).toBe(false);
    expect(DEFAULT_SETTINGS.editor.defaultEncoding).toBe('auto');
    expect(DEFAULT_SETTINGS.editor.defaultLineEnding).toBe('lf');
    expect(DEFAULT_SETTINGS.conversion.bracketSkip).toBe('[]');
    expect(DEFAULT_SETTINGS.conversion.preserveConverted).toBe(false);
    expect(DEFAULT_SETTINGS.compare).toEqual(DEFAULT_COMPARE_OPTIONS);
    // 快捷键默认是空覆盖表，默认键位只在命令注册表里
    expect(DEFAULT_SETTINGS.shortcuts).toEqual({});
  });

  it('编码 / 行尾 / 主题下拉项的取值是后端认得的字面量', () => {
    // 后端 `Encoding::from_label` 只认小写标签；主题是 lowercased 枚举
    for (const { value } of ENCODING_OR_AUTO_OPTIONS) {
      expect(value).toBe(value.toLowerCase());
    }
    // 「自动」只出现在可读一侧；保存一侧必须落到具体编码
    expect(ENCODING_OR_AUTO_OPTIONS[0].value).toBe('auto');
    expect(ENCODING_OPTIONS.some((o) => o.value === 'auto')).toBe(false);
    // 具体编码清单只有一份事实来源（保存那份），读取那份由它派生
    expect(ENCODING_OR_AUTO_OPTIONS.slice(1)).toEqual(ENCODING_OPTIONS);
    expect(LINE_ENDING_OPTIONS.map((o) => o.value)).toEqual(['lf', 'crlf', 'cr']);
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual(['system', 'light', 'dark']);
  });

  it('字号 / 缩进区间与规格一致（12–32、1–16）', () => {
    expect(FONT_SIZE_RANGE).toEqual({ min: 12, max: 32 });
    expect(TAB_WIDTH_RANGE).toEqual({ min: 1, max: 16 });
  });
});
