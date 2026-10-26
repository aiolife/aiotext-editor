//! 文件比较的**规范化口径**（F-06 §6.2）
//!
//! 差异求解本身在 `core::text_diff`（最小编辑脚本 + 三级漏斗）：差异计数、
//! F5 跳差异、标红，三处共用同一份结果 —— 这里只留两边都要用的规范化设施：
//! 忽略项、异体字等同、UTF-16 偏移。
//!
//! 这里原先有一套 TextPro 式「同步逐字」比较（失配后两侧各进一步），已删除：
//! 它在第一处差异之后就把后面全部错位，与标红的口径也对不上。
//!
//! 忽略项在比较前把对应字符从匹配空间摘除，但**报告的偏移始终是原文的
//! UTF-16 码元位置**（与 CodeMirror 文档坐标一致，前端零换算）。
//!
//! 异体字策略（fc1 = 完全等同 / fc2 = 部分等同）通过把组内字符映射到
//! 同一个「组键」实现等同比较：
//! - `FullEq`：只用 fc1；
//! - `PartialEq`：fc1 优先，再叠加 fc2（完全等同自然也属部分等同）；
//! - `Strict`：一律逐字比较。

use serde::{Deserialize, Serialize};

use crate::core::data_tables::VariantTables;

/// 异体字等同强度（F-06 §6.3 `VariantStrictness`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum VariantStrictness {
    /// 完全等同视为相同（fc1.txt：音义全同，如「兔兎」）
    FullEq,
    /// 部分等同也视为相同（在 fc1 之上叠加 fc2.txt，如「㒓达達」）
    PartialEq,
    /// 不忽略异体字，逐字比较
    #[default]
    Strict,
}

/// 比较选项（F-06 §6.3 `CompareOptions`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "这些字段是彼此正交的独立开关（不是互斥的模式选择），且经 serde 具名序列化给前端，不存在位置难辨的问题"
)]
pub struct CompareOptions {
    /// 忽略回车（CR / LF）
    pub ignore_newlines: bool,
    /// 忽略半角空格（含制表符）
    pub ignore_half_space: bool,
    /// 忽略全角标点
    pub ignore_full_punct: bool,
    /// 忽略半角标点
    pub ignore_half_punct: bool,
    /// 异体字等同强度
    pub variant_strictness: VariantStrictness,
}

// ---------------------------------------------------------------------------
// 忽略项判定
// ---------------------------------------------------------------------------

/// 全角标点（F-06 §6.2「忽略全角标点」的字符集）
fn is_full_punct(ch: char) -> bool {
    matches!(
        ch,
        '，' | '。'
            | '、'
            | '：'
            | '；'
            | '！'
            | '？'
            | '（'
            | '）'
            | '《'
            | '》'
            | '〈'
            | '〉'
            | '「'
            | '」'
            | '『'
            | '』'
            | '【'
            | '】'
            | '〔'
            | '〕'
            | '｛'
            | '｝'
            | '“'
            | '”'
            | '‘'
            | '’'
            | '…'
            | '—'
            | '～'
            | '·'
            | '％'
            | '＋'
            | '－'
            | '＊'
            | '／'
            | '＝'
    )
}

/// 半角标点（F-06 §6.2「忽略半角标点」的字符集）
fn is_half_punct(ch: char) -> bool {
    matches!(
        ch,
        ',' | '.'
            | '!'
            | '?'
            | ':'
            | ';'
            | '"'
            | '\''
            | '('
            | ')'
            | '['
            | ']'
            | '{'
            | '}'
            | '<'
            | '>'
            | '~'
            | '`'
            | '@'
            | '#'
            | '$'
            | '%'
            | '^'
            | '&'
            | '*'
            | '-'
            | '_'
            | '+'
            | '='
            | '|'
            | '\\'
            | '/'
    )
}

// `pub(crate)`：`core::text_diff`（标红用的最小编辑脚本）要与这里共用同一套
// 规范化口径 —— 忽略项与异体字的判定一旦两边不一致，标红的位置就会偏。
pub(crate) fn is_ignored(ch: char, opts: &CompareOptions) -> bool {
    (opts.ignore_newlines && (ch == '\n' || ch == '\r'))
        || (opts.ignore_half_space && (ch == ' ' || ch == '\t'))
        || (opts.ignore_full_punct && is_full_punct(ch))
        || (opts.ignore_half_punct && is_half_punct(ch))
}

// ---------------------------------------------------------------------------
// 规范化流：原文 → 「参与比较的字符」流（惰性，O(1) 内存）
// ---------------------------------------------------------------------------

/// 规范化字符的等同键：0 = 原字符本身；1 = 完全等同组；2 = 部分等同组
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CanonKey {
    pub(crate) kind: u8,
    pub(crate) value: u32,
}

pub(crate) fn canon_key(ch: char, opts: &CompareOptions, tables: &VariantTables) -> CanonKey {
    if opts.variant_strictness != VariantStrictness::Strict {
        if let Some(group) = tables.full_group(ch) {
            return CanonKey {
                kind: 1,
                value: group,
            };
        }
        if opts.variant_strictness == VariantStrictness::PartialEq {
            if let Some(group) = tables.partial_group(ch) {
                return CanonKey {
                    kind: 2,
                    value: group,
                };
            }
        }
    }
    CanonKey {
        kind: 0,
        value: ch as u32,
    }
}

/// 一个参与比较的字符（保留原文 UTF-16 偏移与原字符，供差异报告）
#[derive(Debug, Clone, Copy)]
pub(crate) struct CanonChar {
    pub(crate) key: CanonKey,
    pub(crate) ch: char,
    /// 原文中的 UTF-16 码元偏移
    pub(crate) pos: usize,
}

/// 惰性规范化流：逐字扫描原文，跳过被忽略字符
pub(crate) struct CanonStream<'a> {
    rest: &'a str,
    pos: usize,
    opts: &'a CompareOptions,
    tables: &'a VariantTables,
}

impl<'a> CanonStream<'a> {
    pub(crate) fn new(text: &'a str, opts: &'a CompareOptions, tables: &'a VariantTables) -> Self {
        Self {
            rest: text,
            pos: 0,
            opts,
            tables,
        }
    }
}

impl Iterator for CanonStream<'_> {
    type Item = CanonChar;

    fn next(&mut self) -> Option<CanonChar> {
        while let Some(ch) = self.rest.chars().next() {
            self.rest = &self.rest[ch.len_utf8()..];
            let pos = self.pos;
            self.pos += ch.len_utf16();
            if is_ignored(ch, self.opts) {
                continue;
            }
            return Some(CanonChar {
                key: canon_key(ch, self.opts, self.tables),
                ch,
                pos,
            });
        }
        None
    }
}

pub(crate) fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}
