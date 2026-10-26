//! 自定义替换表（F-04）
//!
//! 表格式（保留 TextPro 6 风格 + 扩展，F-04 §4.3）：
//!
//! ```text
//! ; 注释
//! #name: 我的表
//! #desc: 用于佛经校勘
//! #rules: escape=1,wholeWord=0,caseSensitive=1,useRegex=0
//! 鼠标=滑鼠            ← 标准替换
//! 少/兔=㝹             ← 多对一（左侧任意数量 / 分隔）
//! ```
//!
//! 三种使用模式（F-04 §4.2）：
//! - **(A) 独立替换**：`apply_standalone` 走 Aho-Corasick（左most-最长匹配），
//!   不依赖 OpenCC；
//! - **(B) 叠加到 OpenCC**：`opencc_entries` 把表摊平为内联词典条目，交给
//!   `core::opencc::convert_with_inline_dicts` 与简繁转换合并执行；
//! - **(C) 批处理步骤**：与 (A) 共享（第五阶段接入）。
//!
//! 文件位置：`%APPDATA%/AioTextEditor/tables/*.tab`；内置示例表位于
//! `tables/builtin/*.tab`（首次启动自资源目录复制，默认禁用）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use aho_corasick::{AhoCorasickBuilder, MatchKind};
use serde::{Deserialize, Serialize};

use super::ui_lang;

use crate::error::{AppError, AppResult};

/// 表文件扩展名
pub const TABLE_EXTENSION: &str = "tab";
/// 内置示例表子目录（用户目录内）
pub const BUILTIN_SUBDIR: &str = "builtin";
/// 内置表资源子目录（随安装包分发）
pub const BUILTIN_RESOURCE_SUBDIR: &str = "data/builtin-tables";

// ---------------------------------------------------------------------------
// 数据结构（F-04 §4.5）
// ---------------------------------------------------------------------------

/// 一条替换规则（左侧可含 `/` 分隔的多个候选）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceEntry {
    /// 原始左侧写法（保留 `A/B` 形式）
    pub pattern: String,
    /// 已展开的候选（去空白项；转义已还原）
    pub candidates: Vec<String>,
    /// `=` 右侧目标（转义已还原）
    pub replacement: String,
}

/// 表级行为开关（F-04 §4.5；OpenCC 内联模式下部分项不生效）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[expect(
    clippy::struct_excessive_bools,
    reason = "这些字段是彼此正交的独立开关（不是互斥的模式选择），且经 serde 具名序列化给前端，不存在位置难辨的问题"
)]
pub struct ReplaceRules {
    /// 仅整词匹配（独立替换模式；OpenCC 内联模式不生效）
    pub whole_word: bool,
    /// 区分大小写
    pub case_sensitive: bool,
    /// 解析/写出时处理 `\n` `\t` `\\` 转义
    pub escape: bool,
    /// [v1.1] 用正则引擎代替字面替换
    pub use_regex: bool,
}

impl Default for ReplaceRules {
    fn default() -> Self {
        Self {
            whole_word: false,
            case_sensitive: true,
            escape: true,
            use_regex: false,
        }
    }
}

/// 表元信息（列表展示 / 定位）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    /// 表名（不含扩展名）
    pub name: String,
    /// 是否内置示例表
    pub builtin: bool,
    /// 条目数
    pub entry_count: usize,
    /// 表描述（`#desc:`）
    pub description: String,
    /// 绝对路径（展示用；新建表可为空）
    #[serde(default)]
    pub path: String,
}

/// 一张替换表（F-04 §4.5 `ReplaceTable`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTable {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub entries: Vec<ReplaceEntry>,
    #[serde(default)]
    pub rules: ReplaceRules,
    #[serde(default)]
    pub meta: TableMeta,
}

/// 校验问题级别
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueSeverity {
    Error,
    Warning,
}

/// 校验问题（行号 1 起；0 表示表级）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableIssue {
    pub line: usize,
    pub severity: IssueSeverity,
    pub message: String,
}

/// 校验报告（F-04 §4.6 `ValidationReport`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub ok: bool,
    pub errors: usize,
    pub warnings: usize,
    pub entry_count: usize,
    pub issues: Vec<TableIssue>,
}

/// 应用模式（F-04 §4.5 `ApplyMode`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ApplyMode {
    /// 走 Rust 引擎（Aho-Corasick 独立替换）
    #[default]
    Standalone,
    /// 走 OpenCC 内联字典（仅用户词典，不含简繁基线）
    AsOpenccDic,
}

/// 应用选项
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOpts {
    #[serde(default)]
    pub mode: ApplyMode,
}

/// 应用结果（F-04 §4.5 `ApplyReport`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub text: String,
    pub changed_count: usize,
    /// 词 → 替换次数
    pub per_entry_count: HashMap<String, usize>,
}

// ---------------------------------------------------------------------------
// 解析 / 序列化
// ---------------------------------------------------------------------------

/// 单行解析结果
enum ParsedLine {
    /// 普通条目
    Entry(ReplaceEntry),
    /// `#name:` 元数据
    Name(String),
    /// `#desc:` 元数据
    Description(String),
    /// `#rules:` 元数据
    Rules(ReplaceRules),
    /// 空行 / 注释 / 忽略
    Skip,
}

/// 还原转义（`\n` `\t` `\r` `\\` → 实际字符）
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// 写出转义（不可见字符 → `\n` `\t` `\r`；反斜杠自身转义）
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            '\\' => out.push_str("\\\\"),
            other => out.push(other),
        }
    }
    out
}

/// 解析 `#rules:` 行（容错：未知键忽略）
fn parse_rules(spec: &str, base: &ReplaceRules) -> ReplaceRules {
    let mut rules = base.clone();
    for pair in spec.split(',') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let flag = matches!(value.trim(), "1" | "true" | "yes");
        match key.trim() {
            "wholeWord" | "whole_word" => rules.whole_word = flag,
            "caseSensitive" | "case_sensitive" => rules.case_sensitive = flag,
            "escape" => rules.escape = flag,
            "useRegex" | "use_regex" => rules.use_regex = flag,
            _ => {}
        }
    }
    rules
}

/// 解析一行（不含行尾）
fn parse_line(line: &str, rules: &ReplaceRules) -> ParsedLine {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return ParsedLine::Skip;
    }
    if let Some(rest) = trimmed.strip_prefix(';') {
        let _ = rest;
        return ParsedLine::Skip;
    }
    if let Some(rest) = trimmed.strip_prefix('#') {
        let lower = rest.to_ascii_lowercase();
        if lower.starts_with("name:") {
            return ParsedLine::Name(rest[5..].trim().to_owned());
        }
        if lower.starts_with("desc:") {
            return ParsedLine::Description(rest[5..].trim().to_owned());
        }
        if lower.starts_with("rules:") {
            return ParsedLine::Rules(parse_rules(&rest[6..], rules));
        }
        return ParsedLine::Skip; // 其它 `#` 行视为注释
    }
    let Some((left, right)) = trimmed.split_once('=') else {
        // 无 `=`：作为「待校验错误」条目返回（pattern 为空、replacement 为原文）
        return ParsedLine::Entry(ReplaceEntry {
            pattern: String::new(),
            candidates: Vec::new(),
            replacement: trimmed.to_owned(),
        });
    };
    let decode = |s: &str| {
        if rules.escape {
            unescape(s)
        } else {
            s.to_owned()
        }
    };
    let candidates: Vec<String> = left
        .split('/')
        .map(|c| decode(c.trim()))
        .filter(|c| !c.is_empty())
        .collect();
    ParsedLine::Entry(ReplaceEntry {
        pattern: decode(left.trim()),
        candidates,
        replacement: decode(right.trim()),
    })
}

/// 解析表内容（含逐行诊断，F-04 §4.8）
///
/// 第二返回值仅含**解析期**问题；结构性问题请用 [`validate`]。
fn parse_with_issues(content: &str, name: &str) -> (ReplaceTable, Vec<TableIssue>) {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut table = ReplaceTable {
        name: name.to_owned(),
        description: String::new(),
        entries: Vec::new(),
        rules: ReplaceRules::default(),
        meta: TableMeta {
            name: name.to_owned(),
            ..Default::default()
        },
    };
    let mut entry_lines: Vec<usize> = Vec::new();

    for (index, raw) in content.lines().enumerate() {
        let line_no = index + 1;
        let line = raw.trim_end_matches(['\r', '\n']);
        match parse_line(line, &table.rules) {
            ParsedLine::Skip => {}
            ParsedLine::Name(value) => {
                if !value.is_empty() {
                    table.name = value;
                    table.meta.name = table.name.clone();
                }
            }
            ParsedLine::Description(value) => table.description = value,
            ParsedLine::Rules(rules) => table.rules = rules,
            ParsedLine::Entry(entry) => {
                // 结构性问题统一由 structural_issues 判定（与来源无关），
                // 此处仅记录「条目下标 → 源行号」，便于 UI 精确标红
                entry_lines.push(line_no);
                table.entries.push(entry);
            }
        }
    }
    let mut issues: Vec<TableIssue> = structural_issues(&table.entries, &table.rules)
        .into_iter()
        .map(|(idx, severity, message)| TableIssue {
            line: entry_lines.get(idx).copied().unwrap_or(0),
            severity,
            message,
        })
        .collect();
    issues.sort_by_key(|issue| issue.line);
    (table, issues)
}

/// 结构性检查（与表来源无关）：`(条目下标, 级别, 说明)`
///
/// 由 [`parse_with_issues`]（映射到源行号）与 [`validate`]（映射到条目序号）
/// 共用，避免两处判定漂移。
fn structural_issues(
    entries: &[ReplaceEntry],
    rules: &ReplaceRules,
) -> Vec<(usize, IssueSeverity, String)> {
    let mut out = Vec::new();
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        let ordinal = index + 1;
        if entry.candidates.is_empty() {
            // 这些 message 直接展示在「替换表管理」的问题列表里，是界面文案；
            // 但 `{candidate}` 是用户写的词条（PRD §3.6 L-3：不得翻译），故整条一起
            // 转——OpenCC 对 ASCII、以及本就是繁體的内容都是幂等的，不会误伤。
            let message = if entry.pattern.is_empty() && !entry.replacement.trim().is_empty() {
                ui_lang::t(&format!(
                    "第 {ordinal} 条缺少 `=`（裸文本无法作为替换规则）"
                ))
            } else {
                ui_lang::t(&format!("第 {ordinal} 条 `=` 左侧为空"))
            };
            out.push((index, IssueSeverity::Error, message));
            continue;
        }
        if entry.replacement.is_empty() {
            out.push((
                index,
                IssueSeverity::Error,
                ui_lang::t(&format!("第 {ordinal} 条 `=` 右侧为空")),
            ));
            continue;
        }
        for candidate in &entry.candidates {
            if let Some(previous) = seen.insert(candidate.as_str(), ordinal) {
                out.push((
                    index,
                    IssueSeverity::Warning,
                    ui_lang::t(&format!(
                        "第 {ordinal} 条候选 `{candidate}` 与第 {previous} 条重复，以先出现者优先"
                    )),
                ));
            }
            if candidate == &entry.replacement {
                out.push((
                    index,
                    IssueSeverity::Warning,
                    ui_lang::t(&format!(
                        "第 {ordinal} 条左右相同（`{candidate}`），该条无实际效果"
                    )),
                ));
            }
            if rules.use_regex {
                if let Err(e) = ::regex::Regex::new(candidate) {
                    out.push((
                        index,
                        IssueSeverity::Error,
                        ui_lang::t(&format!("第 {ordinal} 条正则无效：{e}")),
                    ));
                }
            }
        }
    }
    out
}

/// 校验表（F-04 §4.6 `validate_replace_table`）
pub fn validate(table: &ReplaceTable) -> ValidationReport {
    let mut issues: Vec<TableIssue> = Vec::new();

    if table.name.trim().is_empty() {
        issues.push(TableIssue {
            line: 0,
            severity: IssueSeverity::Error,
            message: ui_lang::t("表名不能为空"),
        });
    }
    if table
        .name
        .contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
    {
        issues.push(TableIssue {
            line: 0,
            severity: IssueSeverity::Error,
            message: ui_lang::t("表名不能包含路径分隔符或文件名保留字符"),
        });
    }

    for (index, severity, message) in structural_issues(&table.entries, &table.rules) {
        issues.push(TableIssue {
            line: index + 1,
            severity,
            message,
        });
    }
    report_from(table, issues)
}

/// 由问题清单汇总为报告（顺带加上表级提示）
fn report_from(table: &ReplaceTable, mut issues: Vec<TableIssue>) -> ValidationReport {
    // F-04 §4.8：> 1 万条时编译为内联字典会自动切分（此处提示用户）
    if table.entries.len() > 10_000 {
        issues.push(TableIssue {
            line: 0,
            severity: IssueSeverity::Warning,
            message: ui_lang::t(&format!(
                "表含 {} 条，超过 1 万条（编译为 OpenCC 内联字典时会自动切分）",
                table.entries.len()
            )),
        });
    }
    let errors = issues
        .iter()
        .filter(|i| i.severity == IssueSeverity::Error)
        .count();
    let warnings = issues.len() - errors;
    ValidationReport {
        ok: errors == 0,
        errors,
        warnings,
        entry_count: table.entries.len(),
        issues,
    }
}

/// 表文本解析 + 校验（F-04 UI 镜像编辑器的数据源）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTable {
    pub table: ReplaceTable,
    pub report: ValidationReport,
}

/// 解析表文本并给出来源行号级的校验报告
pub fn parse_table_text(text: &str, name: &str) -> ParsedTable {
    let (mut table, parse_issues) = parse_with_issues(text, name);
    let mut issues = parse_issues;
    // 表名合法性（解析期不判）
    if table.name.trim().is_empty() {
        issues.push(TableIssue {
            line: 0,
            severity: IssueSeverity::Error,
            message: ui_lang::t("表名不能为空"),
        });
    } else if table
        .name
        .contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
    {
        issues.push(TableIssue {
            line: 0,
            severity: IssueSeverity::Error,
            message: ui_lang::t("表名不能包含路径分隔符或文件名保留字符"),
        });
    }
    table.meta.entry_count = table.entries.len();
    let report = report_from(&table, issues);
    ParsedTable { table, report }
}

/// 解析表内容（忽略诊断）
pub fn parse(content: &str, name: &str) -> ReplaceTable {
    parse_with_issues(content, name).0
}

/// 序列化回 `.tab` 文本（与 [`parse`] 往返一致）
pub fn render(table: &ReplaceTable) -> String {
    let mut out = String::new();
    out.push_str("# AioTextEditor 自定义替换表（TextPro 风格：A/B=目标）\n");
    if !table.name.is_empty() {
        out.push_str(&format!("#name: {}\n", table.name));
    }
    if !table.description.is_empty() {
        out.push_str(&format!("#desc: {}\n", table.description));
    }
    let default_rules = ReplaceRules::default();
    if table.rules != default_rules {
        out.push_str(&format!(
            "#rules: escape={},wholeWord={},caseSensitive={},useRegex={}\n",
            u8::from(table.rules.escape),
            u8::from(table.rules.whole_word),
            u8::from(table.rules.case_sensitive),
            u8::from(table.rules.use_regex),
        ));
    }
    for entry in &table.entries {
        let left = if entry.pattern.is_empty() {
            entry.candidates.join("/")
        } else {
            entry.pattern.clone()
        };
        if left.is_empty() {
            continue; // 结构损坏行不写回
        }
        out.push_str(&escape(&left));
        out.push('=');
        out.push_str(&escape(&entry.replacement));
        out.push('\n');
    }
    out
}

// ---------------------------------------------------------------------------
// 应用（F-04 §4.2 模式 A / F-04 §4.5 ApplyMode）
// ---------------------------------------------------------------------------

/// 摊平为匹配模式表：`(候选, 目标)`，候选去重（**先出现者优先**，F-04 §4.3）
pub fn flat_pairs(table: &ReplaceTable) -> Vec<(String, String)> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for entry in &table.entries {
        if entry.replacement.is_empty() {
            continue;
        }
        for candidate in &entry.candidates {
            if candidate.is_empty() {
                continue;
            }
            if seen.insert(candidate.clone()) {
                out.push((candidate.clone(), entry.replacement.clone()));
            }
        }
    }
    out
}

/// 提供给 OpenCC 的内联词典条目（F-04 §4.4 / 模式 B）
pub fn opencc_entries(table: &ReplaceTable) -> Vec<(String, String)> {
    flat_pairs(table)
}

/// ASCII 词字符（整词匹配用；中文按 Unicode 字母数字判定）
fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

/// 按模式分派应用（F-04 §4.5 `apply_replace`）
pub fn apply(text: &str, table: &ReplaceTable, opts: &ApplyOpts) -> AppResult<ApplyReport> {
    match opts.mode {
        ApplyMode::Standalone => apply_standalone(text, table),
        ApplyMode::AsOpenccDic => {
            let entries = opencc_entries(table);
            let out = crate::core::opencc::convert_dict_only(&entries, text)?;
            let (changed_count, per_entry_count) = count_hits(text, table)?;
            Ok(ApplyReport {
                text: out,
                changed_count,
                per_entry_count,
            })
        }
    }
}

/// 构建多模式匹配器（左most-最长；重复候选已去重）
fn build_matcher(
    pairs: &[(String, String)],
    case_sensitive: bool,
) -> AppResult<aho_corasick::AhoCorasick> {
    let patterns: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
    AhoCorasickBuilder::new()
        .match_kind(MatchKind::LeftmostLongest)
        .ascii_case_insensitive(!case_sensitive)
        .build(&patterns)
        .map_err(|e| AppError::ReplaceTable(format!("构建匹配器失败：{e}")))
}

/// 统计各词命中次数（不改写文本）
fn count_hits(text: &str, table: &ReplaceTable) -> AppResult<(usize, HashMap<String, usize>)> {
    let pairs = flat_pairs(table);
    if pairs.is_empty() || text.is_empty() {
        return Ok((0, HashMap::new()));
    }
    let matcher = build_matcher(&pairs, table.rules.case_sensitive)?;
    let mut per_entry_count: HashMap<String, usize> = HashMap::new();
    let mut changed_count = 0usize;
    for m in matcher.find_iter(text) {
        *per_entry_count
            .entry(pairs[m.pattern().as_usize()].0.clone())
            .or_insert(0) += 1;
        changed_count += 1;
    }
    Ok((changed_count, per_entry_count))
}

/// 独立替换（模式 A）：左most-最长匹配 + 词边界选项
pub fn apply_standalone(text: &str, table: &ReplaceTable) -> AppResult<ApplyReport> {
    let pairs = flat_pairs(table);
    if pairs.is_empty() || text.is_empty() {
        return Ok(ApplyReport {
            text: text.to_owned(),
            changed_count: 0,
            per_entry_count: HashMap::new(),
        });
    }

    let matcher = build_matcher(&pairs, table.rules.case_sensitive)?;

    let mut out = String::with_capacity(text.len());
    let mut per_entry_count: HashMap<String, usize> = HashMap::new();
    let mut changed_count = 0usize;
    let mut cursor = 0usize;

    for m in matcher.find_iter(text) {
        if table.rules.whole_word && !whole_word_ok(text, m.start(), m.end()) {
            continue;
        }
        out.push_str(&text[cursor..m.start()]);
        out.push_str(&pairs[m.pattern().as_usize()].1);
        *per_entry_count
            .entry(pairs[m.pattern().as_usize()].0.clone())
            .or_insert(0) += 1;
        changed_count += 1;
        cursor = m.end();
    }
    out.push_str(&text[cursor..]);

    Ok(ApplyReport {
        text: out,
        changed_count,
        per_entry_count,
    })
}

/// 词边界检查：匹配两端不得紧邻词字符
fn whole_word_ok(text: &str, start: usize, end: usize) -> bool {
    let before = text[..start].chars().next_back();
    let after = text[end..].chars().next();
    let left_ok = before.is_none_or(|c| !is_word_char(c));
    let right_ok = after.is_none_or(|c| !is_word_char(c));
    left_ok && right_ok
}

// ---------------------------------------------------------------------------
// 文件与目录
// ---------------------------------------------------------------------------

/// 用户数据根目录（`%APPDATA%/AioTextEditor`，macOS/Linux 平台对应目录）
/// 用户数据根目录（实现在 [`crate::core::paths`]，此处再导出保持既有路径可用）
pub use crate::core::paths::app_data_dir;

/// 用户表目录：`<app_data>/tables`
pub fn tables_dir() -> AppResult<PathBuf> {
    let base =
        app_data_dir().ok_or_else(|| AppError::ReplaceTable("无法定位用户数据目录".into()))?;
    Ok(base.join("tables"))
}

/// 内置表目录：`<app_data>/tables/builtin`
pub fn builtin_dir() -> AppResult<PathBuf> {
    Ok(tables_dir()?.join(BUILTIN_SUBDIR))
}

/// 表名安全化（禁止路径分隔符与保留字符）
fn sanitize_name(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::ReplaceTable("表名不能为空".into()));
    }
    if trimmed.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(AppError::ReplaceTable(format!(
            "表名 `{trimmed}` 含非法字符（/ \\ : * ? \" < > |）"
        )));
    }
    Ok(trimmed.to_owned())
}

/// 扫描目录内的表
fn scan_dir(dir: &Path, builtin: bool, out: &mut Vec<TableMeta>) -> AppResult<()> {
    if !dir.exists() {
        return Ok(());
    }
    let read = std::fs::read_dir(dir)
        .map_err(|e| AppError::ReplaceTable(format!("读取 {} 失败：{e}", dir.display())))?;
    for item in read.flatten() {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some(TABLE_EXTENSION) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "跳过不可读的替换表");
                continue;
            }
        };
        let table = parse(&content, stem);
        out.push(TableMeta {
            name: table.name,
            builtin,
            entry_count: table.entries.len(),
            description: table.description,
            path: path.to_string_lossy().to_string(),
        });
    }
    Ok(())
}

/// 列出全部表（用户表在前，内置表在后；均按名称排序）
pub fn list_tables() -> AppResult<Vec<TableMeta>> {
    let mut out = Vec::new();
    scan_dir(&tables_dir()?, false, &mut out)?;
    scan_dir(&builtin_dir()?, true, &mut out)?;
    out.sort_by(|a, b| (a.builtin, &a.name).cmp(&(b.builtin, &b.name)));
    Ok(out)
}

/// 解析表名 → 文件路径与是否内置
///
/// 表名可能来自文件名（`simplified-variants`）或 `#name:` 显示名
/// （`异体字校正（兼容区）`），两者都要能定位；先精确匹配文件名，
/// 再按显示名扫描（用户目录优先于内置目录）。
fn resolve_table_path(name: &str) -> AppResult<(PathBuf, bool)> {
    let name = sanitize_name(name)?;
    let dirs = [(tables_dir()?, false), (builtin_dir()?, true)];

    for (dir, builtin) in &dirs {
        let path = dir.join(format!("{name}.{TABLE_EXTENSION}"));
        if path.exists() {
            return Ok((path, *builtin));
        }
    }
    for (dir, builtin) in &dirs {
        if !dir.exists() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for item in entries.flatten() {
            let path = item.path();
            if path.extension().and_then(|e| e.to_str()) != Some(TABLE_EXTENSION) {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_owned();
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let display = parse(&content, &stem).name;
            if display == name {
                return Ok((path, *builtin));
            }
        }
    }
    Err(AppError::ReplaceTable(format!("表 `{name}` 不存在")))
}

/// 载入表：先查用户目录，再查内置目录（按文件名或 `#name:` 显示名）
pub fn load_table(name: &str) -> AppResult<ReplaceTable> {
    let (path, builtin) = resolve_table_path(name)?;
    let display_fallback = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name)
        .to_owned();
    let content = std::fs::read_to_string(&path)
        .map_err(|e| AppError::ReplaceTable(format!("读取 {} 失败：{e}", path.display())))?;
    let (mut table, issues) = parse_with_issues(&content, &display_fallback);
    for issue in issues.iter().filter(|i| i.severity == IssueSeverity::Error) {
        tracing::warn!(
            table = %display_fallback,
            line = issue.line,
            message = %issue.message,
            "表解析告警"
        );
    }
    table.meta = TableMeta {
        name: table.name.clone(),
        builtin,
        entry_count: table.entries.len(),
        description: table.description.clone(),
        path: path.to_string_lossy().to_string(),
    };
    Ok(table)
}

/// 保存表；新建且重名时自动改名 `name (2)`（F-04 §4.8）
pub fn save_table(table: &ReplaceTable) -> AppResult<TableMeta> {
    let dir = tables_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::ReplaceTable(format!("创建表目录失败：{e}")))?;

    let requested = sanitize_name(&table.name)?;
    let mut name = requested.clone();
    let mut final_path = dir.join(format!("{name}.{TABLE_EXTENSION}"));

    // 已存在的文件若不是本表（新建重名）→ 改名
    let is_same_file = table
        .meta
        .path
        .parse::<PathBuf>()
        .ok()
        .is_some_and(|p| p == final_path);
    if final_path.exists() && !is_same_file {
        for counter in 2..1000 {
            let candidate = format!("{requested} ({counter})");
            let path = dir.join(format!("{candidate}.{TABLE_EXTENSION}"));
            if !path.exists() {
                name = candidate;
                final_path = path;
                break;
            }
        }
    }

    let mut to_write = table.clone();
    to_write.name = name.clone();
    to_write.meta.builtin = false;
    to_write.meta.path = final_path.to_string_lossy().to_string();
    std::fs::write(&final_path, render(&to_write))
        .map_err(|e| AppError::ReplaceTable(format!("写出 {} 失败：{e}", final_path.display())))?;

    Ok(TableMeta {
        name,
        builtin: false,
        entry_count: to_write.entries.len(),
        description: to_write.description,
        path: final_path.to_string_lossy().to_string(),
    })
}

/// 读取表源文本（UI 镜像编辑器用；保留注释与原始排版）
pub fn read_source(name: &str) -> AppResult<String> {
    let (path, _) = resolve_table_path(name)?;
    std::fs::read_to_string(&path)
        .map_err(|e| AppError::ReplaceTable(format!("读取 {} 失败：{e}", path.display())))
}

/// 在用户表目录内取一个不冲突的文件路径（重名时追加 ` (2)` …）
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(format!("{name}.{TABLE_EXTENSION}"));
    if !first.exists() {
        return first;
    }
    for counter in 2..1000 {
        let candidate = dir.join(format!("{name} ({counter}).{TABLE_EXTENSION}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    first
}

/// 保存表源文本（F-04 §4.8：校验不通过则阻止保存）
///
/// `source_path` 为文本来源文件：若它本身就是目标用户表则原地覆盖（保留文件名）；
/// 内置表与新建表一律落到用户目录（重名自动追加序号，不覆盖既有表）。
pub fn save_source(name: &str, text: &str, source_path: Option<&Path>) -> AppResult<TableMeta> {
    let parsed = parse_table_text(text, name);
    if !parsed.report.ok {
        let hint = parsed
            .report
            .issues
            .iter()
            .find(|i| i.severity == IssueSeverity::Error)
            .map(|i| i.message.as_str())
            .unwrap_or_default();
        return Err(AppError::ReplaceTable(format!(
            "表中有 {} 处错误，已阻止保存（{hint}）",
            parsed.report.errors
        )));
    }
    let requested = sanitize_name(&parsed.table.name)?;
    let dir = tables_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::ReplaceTable(format!("创建表目录失败：{e}")))?;

    let target = match source_path {
        Some(src)
            if src.parent() == Some(dir.as_path())
                && src.file_stem().and_then(|s| s.to_str()) == Some(requested.as_str()) =>
        {
            src.to_path_buf()
        }
        _ => unique_path(&dir, &requested),
    };

    std::fs::write(&target, text)
        .map_err(|e| AppError::ReplaceTable(format!("写出 {} 失败：{e}", target.display())))?;
    Ok(TableMeta {
        name: parsed.table.name,
        builtin: false,
        entry_count: parsed.table.entries.len(),
        description: parsed.table.description,
        path: target.to_string_lossy().to_string(),
    })
}

/// 删除用户表（内置示例表不可删）
pub fn delete_table(name: &str) -> AppResult<()> {
    let (path, builtin) = resolve_table_path(name)?;
    if builtin {
        return Err(AppError::ReplaceTable(format!(
            "`{name}` 是内置示例表，不能删除（可在「另存为」为自定义表后编辑）"
        )));
    }
    std::fs::remove_file(&path)
        .map_err(|e| AppError::ReplaceTable(format!("删除 {} 失败：{e}", path.display())))
}

/// 导入 TextPro `.tab` 文件（自动识别 `=` 与空格分隔两种格式，F-04 §4.9）
pub fn import_textpro_tab(path: &Path, name: Option<String>) -> AppResult<ReplaceTable> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| AppError::ReplaceTable(format!("读取 {} 失败：{e}", path.display())))?;
    let fallback = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("导入的表")
        .to_owned();
    let mut table = parse(&content, &name.unwrap_or(fallback));

    // 旧式空格分隔：行内无 `=`，按首个空白切分
    let mut converted = Vec::new();
    for (index, raw) in content.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with([';', '#']) || line.contains('=') {
            continue;
        }
        let Some(split) = line.find(|c: char| c.is_whitespace()) else {
            continue;
        };
        let (left, right) = line.split_at(split);
        let right = right.trim();
        if left.trim().is_empty() || right.is_empty() {
            continue;
        }
        let candidates: Vec<String> = left
            .trim()
            .split('/')
            .map(|c| c.trim().to_owned())
            .filter(|c| !c.is_empty())
            .collect();
        if candidates.is_empty() {
            continue;
        }
        tracing::debug!(line = index + 1, "按空格分隔导入");
        converted.push(ReplaceEntry {
            pattern: left.trim().to_owned(),
            candidates,
            replacement: right.to_owned(),
        });
    }
    table.entries.extend(converted);
    table.meta.entry_count = table.entries.len();
    Ok(table)
}

/// 按名称批量载入条目（供 `core::convert` 的 OpenCC 内联叠加使用）
pub fn load_entries_by_names(names: &[String]) -> AppResult<Vec<(String, String)>> {
    let mut out = Vec::new();
    for name in names {
        let table = load_table(name)?;
        out.extend(opencc_entries(&table));
    }
    Ok(out)
}

/// 内置表资源目录探测（打包资源 → 开发态 manifest → 可执行文件同级 → **内嵌展开**）
///
/// 最后一项是便携版专用：单 exe 旁边没有 `data/`，这时从编进二进制的字节里
/// 展开一份（`embedded` 模块）。安装版磁盘上就有，走不到这一步。
fn builtin_resource_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    use crate::core::embedded;
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join(BUILTIN_RESOURCE_SUBDIR));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(BUILTIN_RESOURCE_SUBDIR));
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(BUILTIN_RESOURCE_SUBDIR));
        }
    }
    // 同 `data_tables::legacy_dir`：用 `.or_else()` 兜底，别写成 `candidates.extend(expand(..))`
    // —— 那会让展开**无条件**发生，每次调用都写一份临时目录。
    candidates.into_iter().find(|p| p.is_dir()).or_else(|| {
        embedded::expand(
            "builtin-tables",
            &[
                ("ancient-usage.tab", embedded::BUILTIN_ANCIENT),
                ("cn-punct.tab", embedded::BUILTIN_CN_PUNCT),
                ("simplified-variants.tab", embedded::BUILTIN_SIMPLIFIED),
            ],
        )
    })
}

/// 首次启动把内置示例表复制到 `<tables>/builtin/`（F-04 §4.10）
///
/// 幂等：仅复制缺失文件（用户对内置表的改名/删除不会被覆盖回来）；
/// 返回本次复制的文件数。
pub fn ensure_builtin_tables(resource_dir: Option<&Path>) -> AppResult<usize> {
    let target = builtin_dir()?;
    let Some(source) = builtin_resource_dir(resource_dir) else {
        tracing::warn!("未找到内置替换表资源目录，跳过复制");
        return Ok(0);
    };
    std::fs::create_dir_all(&target)
        .map_err(|e| AppError::ReplaceTable(format!("创建内置表目录失败：{e}")))?;

    let mut copied = 0usize;
    let read = std::fs::read_dir(&source)
        .map_err(|e| AppError::ReplaceTable(format!("读取 {} 失败：{e}", source.display())))?;
    for item in read.flatten() {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some(TABLE_EXTENSION) {
            continue;
        }
        let Some(file_name) = path.file_name() else {
            continue;
        };
        let dest = target.join(file_name);
        if dest.exists() {
            continue;
        }
        std::fs::copy(&path, &dest)
            .map_err(|e| AppError::ReplaceTable(format!("复制 {} 失败：{e}", dest.display())))?;
        copied += 1;
    }
    if copied > 0 {
        tracing::info!(count = copied, dir = %target.display(), "内置替换表已就绪");
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
; 注释行
#name: 测试表
#desc: 用于单元测试

鼠标=滑鼠
少/兔=㝹
裸文本行
空目标=
";

    #[test]
    fn parse_textpro_syntax() {
        let table = parse(SAMPLE, "fallback");
        assert_eq!(table.name, "测试表");
        assert_eq!(table.description, "用于单元测试");
        assert_eq!(table.entries.len(), 4);
        assert_eq!(table.entries[0].pattern, "鼠标");
        assert_eq!(table.entries[0].candidates, vec!["鼠标".to_owned()]);
        assert_eq!(table.entries[0].replacement, "滑鼠");
        assert_eq!(
            table.entries[1].candidates,
            vec!["少".to_owned(), "兔".to_owned()]
        );
    }

    #[test]
    fn parse_reports_structural_issues() {
        let (_, issues) = parse_with_issues(SAMPLE, "t");
        assert_eq!(issues.len(), 2, "缺 = 与空目标各一条：{issues:?}");
        assert!(issues.iter().all(|i| i.severity == IssueSeverity::Error));
        // 样本第 7 行为裸文本、第 8 行 `=` 右侧为空
        assert_eq!(issues[0].line, 7);
        assert_eq!(issues[1].line, 8);
    }

    #[test]
    fn parse_escape_round_trip() {
        let content = "#name: 转义\n制表\\t符=A\\nB\n";
        let table = parse(content, "t");
        assert_eq!(table.entries[0].candidates, vec!["制表\t符".to_owned()]);
        assert_eq!(table.entries[0].replacement, "A\nB");
        let rendered = render(&table);
        let again = parse(&rendered, "t");
        assert_eq!(table.entries, again.entries, "转义序列应往返一致");
    }

    #[test]
    fn render_round_trip_keeps_entries() {
        let table = parse(SAMPLE, "t");
        // 去掉两条结构损坏行后应可无损往返
        let mut clean = table.clone();
        clean
            .entries
            .retain(|e| !e.candidates.is_empty() && !e.replacement.is_empty());
        let rendered = render(&clean);
        let again = parse(&rendered, "t");
        assert_eq!(clean.entries, again.entries);
        assert_eq!(again.name, "测试表");
        assert_eq!(again.description, "用于单元测试");
    }

    #[test]
    fn validate_flags_duplicates_and_noops() {
        let table = parse("#name: v\n鼠标=滑鼠\n鼠标=鼠标垫\n相同=相同\n", "v");
        let report = validate(&table);
        assert!(report.ok, "重复与无效果只是警告");
        assert_eq!(report.errors, 0);
        assert_eq!(report.warnings, 2);
        assert!(report.issues.iter().any(|i| i.message.contains("重复")));
        assert!(report.issues.iter().any(|i| i.message.contains("左右相同")));
    }

    #[test]
    fn validate_blocks_empty_name() {
        let table = parse("a=b\n", "  ");
        let report = validate(&table);
        assert!(!report.ok);
        assert!(report.errors >= 1);
    }

    #[test]
    fn validate_checks_regex_when_enabled() {
        let mut table = parse("#name: r\n[=x\n", "r");
        table.rules.use_regex = true;
        let report = validate(&table);
        assert!(!report.ok);
        assert!(report.issues.iter().any(|i| i.message.contains("正则无效")));
    }

    #[test]
    fn apply_standalone_matches_longest_and_counts() {
        let table = parse("#name: a\n鼠标=滑鼠\n鼠标垫=滑鼠墊\n", "a");
        let report = apply_standalone("我的鼠标垫和鼠标", &table).unwrap();
        assert_eq!(report.text, "我的滑鼠墊和滑鼠");
        assert_eq!(report.changed_count, 2);
        assert_eq!(report.per_entry_count.get("鼠标垫"), Some(&1));
        assert_eq!(report.per_entry_count.get("鼠标"), Some(&1));
    }

    #[test]
    fn apply_standalone_respects_first_wins_for_duplicates() {
        let table = parse("#name: d\n甲=一\n甲=二\n", "d");
        let report = apply_standalone("甲", &table).unwrap();
        assert_eq!(report.text, "一", "重复候选以先出现者优先");
    }

    #[test]
    fn apply_standalone_whole_word_option() {
        let mut table = parse("#name: w\ncat=猫\n", "w");
        table.rules.whole_word = true;
        let blocked = apply_standalone("concatenate", &table).unwrap();
        assert_eq!(blocked.text, "concatenate", "整词模式下不应命中词内");
        let hit = apply_standalone("a cat here", &table).unwrap();
        assert_eq!(hit.text, "a 猫 here");
    }

    #[test]
    fn apply_standalone_case_insensitive_option() {
        let mut table = parse("#name: c\nCat=猫\n", "c");
        table.rules.case_sensitive = false;
        let report = apply_standalone("CAT", &table).unwrap();
        assert_eq!(report.text, "猫");
    }

    #[test]
    fn opencc_entries_flatten_candidates() {
        let table = parse("#name: o\n少/兔=㝹\n鼠标=滑鼠\n", "o");
        assert_eq!(
            opencc_entries(&table),
            vec![
                ("少".to_owned(), "㝹".to_owned()),
                ("兔".to_owned(), "㝹".to_owned()),
                ("鼠标".to_owned(), "滑鼠".to_owned()),
            ]
        );
    }

    #[test]
    fn import_recognizes_space_separator() {
        let dir = std::env::temp_dir().join("aiotext-import-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("legacy.tab");
        std::fs::write(&path, "鼠标 滑鼠\n少/兔 㝹\n鼠标=滑鼠\n").unwrap();
        let table = import_textpro_tab(&path, Some("旧表".into())).unwrap();
        assert_eq!(table.name, "旧表");
        let pairs = flat_pairs(&table);
        assert!(pairs.contains(&("鼠标".to_owned(), "滑鼠".to_owned())));
        assert!(pairs.contains(&("兔".to_owned(), "㝹".to_owned())));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundled_builtin_tables_parse_without_errors() {
        // 守住 scripts/gen-builtin-tables.mjs 的产物质量：全部内置表必须
        // 零错误解析，且条目数合理（防止生成脚本产生破损数据）
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(BUILTIN_RESOURCE_SUBDIR);
        assert!(dir.is_dir(), "内置表资源目录缺失：{}", dir.display());
        let mut files = 0usize;
        let mut total_entries = 0usize;
        for item in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = item.path();
            if path.extension().and_then(|e| e.to_str()) != Some(TABLE_EXTENSION) {
                continue;
            }
            files += 1;
            let content = std::fs::read_to_string(&path).unwrap();
            let stem = path.file_stem().unwrap().to_string_lossy().to_string();
            let (table, issues) = parse_with_issues(&content, &stem);
            let errors: Vec<&TableIssue> = issues
                .iter()
                .filter(|i| i.severity == IssueSeverity::Error)
                .collect();
            assert!(errors.is_empty(), "{} 解析出错：{errors:?}", path.display());
            let report = validate(&table);
            let report_errors: Vec<&TableIssue> = report
                .issues
                .iter()
                .filter(|i| i.severity == IssueSeverity::Error)
                .collect();
            assert!(
                report_errors.is_empty(),
                "{} 校验未通过：{report_errors:?}",
                path.display()
            );
            assert!(!table.name.is_empty(), "{} 缺少表名", path.display());
            assert!(
                !table.description.is_empty(),
                "{} 缺少 #desc 说明",
                path.display()
            );
            total_entries += table.entries.len();
        }
        assert!(files >= 3, "内置示例表应不少于 3 个，实际 {files}");
        assert!(total_entries > 500, "内置示例表总条目偏少：{total_entries}");
    }

    #[test]
    fn sanitize_rejects_path_separators() {
        assert!(sanitize_name("a/b").is_err());
        assert!(sanitize_name("..").is_ok()); // 纯点名不含分隔符，落盘后仍在 table 目录内
        assert_eq!(sanitize_name(" 正常表 ").unwrap(), "正常表");
    }
}
