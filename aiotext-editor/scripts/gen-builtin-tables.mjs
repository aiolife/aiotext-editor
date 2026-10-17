/**
 * 生成 AioTextEditor 内置示例替换表（F-04 §4.10）
 *
 * 数据来源：opencc-sys 内嵌的 OpenCC 原始文本词典
 *   - CJK_Compatibility_Ideographs.txt（兼容区异体字 → 通用字）
 *   - TWVariants.txt + HKVariants.txt（台湾/香港异体字 → 标准字形）
 *   - 中文标点修正表由本脚本内联定义（半角 → 全角）
 *
 * 许可：OpenCC 词典数据 Apache-2.0（© Carbo Kuo 等），经 opencc-sys 编译期嵌入；
 *       本脚本产出的派生表随产品分发时保留本说明。
 *
 * 用法：node scripts/gen-builtin-tables.mjs
 *       产物写入 src-tauri/data/builtin-tables/*.tab（UTF-8 无 BOM、LF）
 *
 * 注意：表格式以首个 `=` 分列、以 `/` 分割左侧候选、以 `\` 引导转义，
 *       因此键/值中若含 `=` `/` `\` 与不可见字符的条目会被跳过（见 sanitize）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'src-tauri', 'data', 'builtin-tables');

/** 读取 Cargo.lock，取本项目实际使用的 opencc-sys 版本 */
function lockedVersion() {
  const candidates = [
    resolve(here, '..', 'src-tauri', 'Cargo.lock'),
    resolve(here, '..', 'Cargo.lock'),
  ];
  const lockPath = candidates.find((p) => existsSync(p));
  if (!lockPath) return null;
  const text = readFileSync(lockPath, 'utf8');
  const match = text.match(/name = "opencc-sys"\r?\nversion = "([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * 在 cargo registry 中定位 opencc-sys 的 OpenCC 词典目录。
 * registry 里可能残留多个版本（旧版本词典文件不全），故：
 * 1) 只接受含本次所需词典文件的目录；2) 优先 Cargo.lock 记录的版本。
 */
function findDictionaryDir() {
  const required = ['CJK_Compatibility_Ideographs.txt', 'TWVariants.txt', 'HKVariants.txt'];
  const roots = [
    process.env.CARGO_HOME && join(process.env.CARGO_HOME, 'registry', 'src'),
    join(homedir(), '.cargo', 'registry', 'src'),
  ].filter((p) => p && existsSync(p));

  const candidates = [];
  for (const root of roots) {
    for (const registry of readdirSync(root)) {
      const registryDir = join(root, registry);
      for (const entry of readdirSync(registryDir)) {
        if (!entry.startsWith('opencc-sys-')) continue;
        const dir = join(registryDir, entry, 'OpenCC', 'data', 'dictionary');
        if (!required.every((f) => existsSync(join(dir, f)))) continue;
        // Cargo.lock 里的版本形如 `0.5.2+1.4.1`（含内嵌 OpenCC 版本），整体比对
        const version = entry.slice('opencc-sys-'.length);
        candidates.push({ dir, version, entry });
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error('未找到含所需词典的 opencc-sys 目录（请先执行一次 cargo fetch/build）');
  }
  const locked = lockedVersion();
  const preferred = candidates.find((c) => c.version === locked);
  if (locked && !preferred) {
    console.warn(`警告：Cargo.lock 记录 opencc-sys ${locked}，但注册表中未找到该版本词典目录`);
  }
  const chosen = preferred ?? [...candidates].sort((a, b) => (a.entry < b.entry ? 1 : -1))[0];
  console.log(`opencc-sys 版本：${chosen.version}（Cargo.lock: ${locked ?? '未知'}）`);
  return chosen.dir;
}

/** 读取 OpenCC 词典：`key<TAB>value1 value2 …` → [{ key, value }]（取首个值） */
function readDictionary(path) {
  const pairs = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const key = line.slice(0, tab).trim();
    const value = line.slice(tab + 1).trim().split(/\s+/)[0] ?? '';
    if (key && value) pairs.push({ key, value });
  }
  return pairs;
}

/** 过滤无法在表格式中表达的条目 */
function sanitize(pairs) {
  const bad = /[=\\\n\r\t\s/]/;
  return pairs.filter((p) => !bad.test(p.key) && !bad.test(p.value) && p.key !== p.value);
}

/**
 * 按解析器规则统计「有多少行真的会成为条目」。
 * 与 Rust `core::replace::parse` 的规则保持一致：`;`/`#` 开头的行是注释，
 * 且 `=` 两侧都不能为空。
 */
function countParsableEntries(lines) {
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (!trimmed.slice(0, eq).trim() || !trimmed.slice(eq + 1).trim()) continue;
    count += 1;
  }
  return count;
}

/**
 * 写表：表头 + `左=右` 行（UTF-8 无 BOM、LF）。
 * 写完立即用解析器规则回读校验：条目数必须与输入一致，否则抛错——
 * 防止「以 `;` / `#` 开头的键」被当注释静默吞掉（曾真实发生）。
 */
function writeTable(fileName, header, pairs) {
  const body = pairs.map(({ key, value }) => `${key}=${value}`);
  const lines = [...header, ...body];
  const parsable = countParsableEntries(lines);
  if (parsable !== pairs.length) {
    throw new Error(
      `${fileName}: 产出 ${pairs.length} 条但解析器只认 ${parsable} 条，` +
        '请检查是否有以 `;` / `#` 开头或含 `=` `/` 的键',
    );
  }
  writeFileSync(join(outDir, fileName), `${lines.join('\n')}\n`, 'utf8');
  console.log(`  ${fileName}: ${pairs.length} 条（解析器回读一致）`);
}

const dictDir = findDictionaryDir();
console.log(`词典目录：${dictDir}`);
mkdirSync(outDir, { recursive: true });

// ① 异体字校正（兼容区 → 通用字）
writeTable(
  'simplified-variants.tab',
  [
    '# AioTextEditor 内置示例表（TextPro 风格：A/B=目标）',
    '#name: 异体字校正（兼容区）',
    '#desc: 把 CJK 兼容区异体字统一为通用字形，适合处理旧系统/PDF 提取的文本',
    '#source: OpenCC CJK_Compatibility_Ideographs.txt（Apache-2.0，© Carbo Kuo 等）',
  ],
  sanitize(readDictionary(join(dictDir, 'CJK_Compatibility_Ideographs.txt'))),
);

// ② 古籍异体字规整（台湾 + 香港变体 → 标准字形）
const merged = new Map();
for (const pair of [
  ...readDictionary(join(dictDir, 'TWVariants.txt')),
  ...readDictionary(join(dictDir, 'HKVariants.txt')),
]) {
  if (!merged.has(pair.key)) merged.set(pair.key, pair.value);
}
writeTable(
  'ancient-usage.tab',
  [
    '# AioTextEditor 内置示例表（TextPro 风格：A/B=目标）',
    '#name: 古籍异体字规整',
    '#desc: 按台湾/香港标准把异体字规整为常用字形（古籍与佛经整理常用）',
    '#source: OpenCC TWVariants.txt + HKVariants.txt（Apache-2.0，© Carbo Kuo 等）',
  ],
  sanitize(
    [...merged.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, value]) => ({ key, value })),
  ),
);

// ③ 中文标点修正（半角 → 全角）
//
// 表格式的限制（键无法表达的情况，均在表头 `#注意:` 中向用户说明）：
//   - `=`（分列）与 `/`（候选分隔）是保留字符
//   - `;` 与 `#` 在行首表示注释，故不能作为键
//   - `\` 需转义为 `\\`
const punct = [
  [',', '，'], ['.', '。'], ['?', '？'], ['!', '！'], [':', '：'],
  ['(', '（'], [')', '）'], ['[', '［'], [']', '］'], ['{', '｛'], ['}', '｝'],
  ['<', '＜'], ['>', '＞'], ['"', '＂'], ["'", '＇'], ['\\', '＼'], ['|', '｜'],
  ['~', '～'], ['`', '｀'], ['@', '＠'], ['$', '＄'], ['%', '％'],
  ['^', '＾'], ['&', '＆'], ['*', '＊'], ['-', '－'], ['_', '＿'], ['+', '＋'],
];
writeTable(
  'cn-punct.tab',
  [
    '# AioTextEditor 内置示例表（TextPro 风格：A/B=目标）',
    '#name: 中文标点修正（半角→全角）',
    '#desc: 把半角标点替换为全角，适合中文排版前的整理；数字/英文/代码场景请勿启用',
    '#注意: = 与 / 是分列/候选保留字符，行首 ; 与 # 表示注释，故这四者无法作为键；反斜杠写作 \\\\',
  ],
  punct.map(([key, value]) => ({
    key: key === '\\' ? '\\\\' : key,
    value,
  })),
);

console.log('完成。');
