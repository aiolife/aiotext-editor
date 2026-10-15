//! 文件比较（F-06 §6.2）
//!
//! TextPro 式**同步逐字比较**：两个窗格各有一个「起始对齐位置」，从那里
//! 开始逐字推进；遇到第一个（以及后续每一处）不一致时停下来，让 UI 把
//! 两个光标都跳到该处（F-06 用户故事：平铺两份文本、F5 同步定位差异、
//! 逐字校对）。任一方到达尾部即完成。
//!
//! 与「求最小编辑脚本」的 diff 不同，本算法在失配处**两侧各前进一字**
//! （沿用 TextPro 的逐字口径），复杂度 O(n + m)、内存 O(1)，因此
//! 百 MB 级长文也能一次跑完；规格 §6.5 提到的 Myers/similar 方案
//! 属实现提示，实际行为以 §6.2 为准（偏差已记录在规格 F-06 实现注记）。
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

/// 差异清单上限：超出后置 `truncated` 并停止收集（百 MB 全异文本
/// 不至于生成上亿条目；UI 提示「仅显示前 N 处」）
pub const MAX_DIFFERENCES: usize = 5000;

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

/// 一处不一致（两侧字符各前进一字；任一方为 None 表示该方已到尾部）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
    /// A 文中的 UTF-16 码元偏移（指原文，不受忽略项影响）
    pub pos_a: usize,
    /// B 文中的 UTF-16 码元偏移
    pub pos_b: usize,
    pub char_a: Option<char>,
    pub char_b: Option<char>,
}

/// 比较结束原因（F-06 §6.2：任一方到达尾部提示已完成）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompareEnd {
    /// 两侧同时到达尾部（且无尾部多出内容）
    BothEnded,
    /// A 方先到尾部（B 方还有内容）
    AEnded,
    /// B 方先到尾部（A 方还有内容）
    BEnded,
    /// 差异数达到上限，提前停止收集
    Truncated,
}

/// 比较报告（F-06 §6.3 `CompareReport` 的扩展）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareReport {
    pub differences: Vec<Difference>,
    /// 差异是否超过上限被截断
    pub truncated: bool,
    /// 结束原因
    pub end: CompareEnd,
    /// 结束时 A 方剩余（未被比较的）字符数
    pub remaining_a: usize,
    /// 结束时 B 方剩余字符数
    pub remaining_b: usize,
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

fn is_ignored(ch: char, opts: &CompareOptions) -> bool {
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
struct CanonKey {
    kind: u8,
    value: u32,
}

fn canon_key(ch: char, opts: &CompareOptions, tables: &VariantTables) -> CanonKey {
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
struct CanonChar {
    key: CanonKey,
    ch: char,
    /// 原文中的 UTF-16 码元偏移
    pos: usize,
}

/// 惰性规范化流：逐字扫描原文，跳过被忽略字符
struct CanonStream<'a> {
    rest: &'a str,
    pos: usize,
    opts: &'a CompareOptions,
    tables: &'a VariantTables,
}

impl<'a> CanonStream<'a> {
    fn new(text: &'a str, opts: &'a CompareOptions, tables: &'a VariantTables) -> Self {
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

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

// ---------------------------------------------------------------------------
// 比较
// ---------------------------------------------------------------------------

/// 同步逐字比较：两侧规范化流各持一指针，等同则同进，不等则记录差异后
/// 仍然两侧各进一步（TextPro 逐字口径）。任一方耗尽即结束，并把「另一方
/// 剩多少字」报告给 UI。
pub fn compare(a: &str, b: &str, opts: &CompareOptions, tables: &VariantTables) -> CompareReport {
    let mut stream_a = CanonStream::new(a, opts, tables);
    let mut stream_b = CanonStream::new(b, opts, tables);
    let mut cur_a = stream_a.next();
    let mut cur_b = stream_b.next();
    let mut differences: Vec<Difference> = Vec::new();
    let mut truncated = false;
    let end;
    let (mut remaining_a, mut remaining_b) = (0usize, 0usize);

    loop {
        match (cur_a, cur_b) {
            (Some(x), Some(y)) => {
                if x.key == y.key {
                    cur_a = stream_a.next();
                    cur_b = stream_b.next();
                    continue;
                }
                differences.push(Difference {
                    pos_a: x.pos,
                    pos_b: y.pos,
                    char_a: Some(x.ch),
                    char_b: Some(y.ch),
                });
                if differences.len() >= MAX_DIFFERENCES {
                    truncated = true;
                    end = CompareEnd::Truncated;
                    break;
                }
                cur_a = stream_a.next();
                cur_b = stream_b.next();
            }
            (None, None) => {
                end = CompareEnd::BothEnded;
                break;
            }
            (None, Some(y)) => {
                // A 方已到尾部：报告一处「B 方多出」的尾部差异
                differences.push(Difference {
                    pos_a: utf16_len(a),
                    pos_b: y.pos,
                    char_a: None,
                    char_b: Some(y.ch),
                });
                remaining_b = 1 + stream_b.count();
                end = CompareEnd::AEnded;
                break;
            }
            (Some(x), None) => {
                differences.push(Difference {
                    pos_a: x.pos,
                    pos_b: utf16_len(b),
                    char_a: Some(x.ch),
                    char_b: None,
                });
                remaining_a = 1 + stream_a.count();
                end = CompareEnd::BEnded;
                break;
            }
        }
    }

    if differences.len() > MAX_DIFFERENCES {
        differences.truncate(MAX_DIFFERENCES);
    }

    CompareReport {
        differences,
        truncated,
        end,
        remaining_a,
        remaining_b,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::data_tables::load_variant_tables;

    fn tables() -> VariantTables {
        load_variant_tables(None).unwrap()
    }

    fn cmp(a: &str, b: &str, opts: &CompareOptions) -> CompareReport {
        compare(a, b, opts, &tables())
    }

    fn strict() -> CompareOptions {
        CompareOptions::default()
    }

    #[test]
    fn identical_texts_have_no_differences() {
        let report = cmp("甲乙\n丙", "甲乙\n丙", &strict());
        assert!(report.differences.is_empty());
        assert_eq!(report.end, CompareEnd::BothEnded);
        assert_eq!(report.remaining_a, 0);
        assert_eq!(report.remaining_b, 0);
        assert!(!report.truncated);
    }

    #[test]
    fn empty_texts_compare_equal() {
        let report = cmp("", "", &strict());
        assert!(report.differences.is_empty());
        assert_eq!(report.end, CompareEnd::BothEnded);
    }

    #[test]
    fn reports_mismatch_with_utf16_positions() {
        let report = cmp("甲乙丙", "甲X丙", &strict());
        assert_eq!(report.differences.len(), 1);
        let d = &report.differences[0];
        assert_eq!(d.pos_a, 1);
        assert_eq!(d.pos_b, 1);
        assert_eq!(d.char_a, Some('乙'));
        assert_eq!(d.char_b, Some('X'));
    }

    #[test]
    fn positions_use_utf16_code_units() {
        // 增补平面字符占 2 个码元：偏移必须按 UTF-16 口径给出
        let report = cmp("𝒜乙", "𝒜X", &strict());
        assert_eq!(report.differences.len(), 1);
        assert_eq!(report.differences[0].pos_a, 2);
        assert_eq!(report.differences[0].pos_b, 2);
    }

    #[test]
    fn positions_are_original_offsets_despite_ignored_chars() {
        // 忽略空格后，差异位置仍指向原文里的真实字符
        let opts = CompareOptions {
            ignore_half_space: true,
            ..strict()
        };
        let report = cmp("甲 乙", "甲 丙", &opts);
        assert_eq!(report.differences.len(), 1);
        assert_eq!(report.differences[0].pos_a, 2);
        assert_eq!(report.differences[0].pos_b, 2);
    }

    #[test]
    fn ignore_options_remove_chars_from_matching() {
        let nl = CompareOptions {
            ignore_newlines: true,
            ..strict()
        };
        assert!(cmp("甲\n乙", "甲乙", &nl).differences.is_empty());
        // 不忽略回车：'\n' 对 '乙' 记一处差异；两侧各进一步后 B 方已到
        // 尾部，A 方还剩内容 → 再记一处「尾部多出」差异（逐字口径）
        assert_eq!(cmp("甲\n乙", "甲乙", &strict()).differences.len(), 2);
        assert_eq!(cmp("甲\n乙", "甲乙", &strict()).end, CompareEnd::BEnded);

        let space = CompareOptions {
            ignore_half_space: true,
            ..strict()
        };
        assert!(cmp("甲 乙\t丙", "甲乙丙", &space).differences.is_empty());

        let full_punct = CompareOptions {
            ignore_full_punct: true,
            ..strict()
        };
        assert!(cmp("甲，乙。", "甲、乙！", &full_punct)
            .differences
            .is_empty());

        let half_punct = CompareOptions {
            ignore_half_punct: true,
            ..strict()
        };
        assert!(cmp("a,b.", "a;b!", &half_punct).differences.is_empty());
        // 标点被忽略，但字母数字照常比较
        let letter_diff = cmp("a,b", "a,c", &half_punct);
        assert_eq!(letter_diff.differences.len(), 1);
        assert_eq!(letter_diff.differences[0].char_a, Some('b'));
        assert_eq!(letter_diff.differences[0].char_b, Some('c'));
    }

    #[test]
    fn variant_full_eq_uses_fc1_only() {
        // fc1：伪 / 偽 完全等同；达 / 部分组（fc2）不参与
        let full = CompareOptions {
            variant_strictness: VariantStrictness::FullEq,
            ..strict()
        };
        assert!(cmp("伪甲", "偽甲", &full).differences.is_empty());
        assert_eq!(cmp("达甲", "達甲", &full).differences.len(), 1);
    }

    #[test]
    fn variant_partial_eq_stacks_fc2_on_fc1() {
        let partial = CompareOptions {
            variant_strictness: VariantStrictness::PartialEq,
            ..strict()
        };
        // fc2：㒓达達 部分等同；fc1 的完全等同自然也生效
        assert!(cmp("达甲", "達甲", &partial).differences.is_empty());
        assert!(cmp("伪甲", "僞甲", &partial).differences.is_empty());
        assert_eq!(cmp("兔甲", "达甲", &partial).differences.len(), 1);
    }

    #[test]
    fn variant_strict_compares_verbatim() {
        assert_eq!(cmp("伪甲", "偽甲", &strict()).differences.len(), 1);
    }

    #[test]
    fn one_side_ending_first_reports_terminal_difference() {
        let report = cmp("甲乙", "甲乙丙", &strict());
        assert_eq!(report.end, CompareEnd::AEnded);
        assert_eq!(report.remaining_b, 1);
        assert_eq!(report.differences.len(), 1);
        let d = &report.differences[0];
        assert_eq!(d.char_a, None);
        assert_eq!(d.char_b, Some('丙'));
        assert_eq!(d.pos_a, 2); // A 方全文长度

        let report = cmp("甲乙丙", "甲乙", &strict());
        assert_eq!(report.end, CompareEnd::BEnded);
        assert_eq!(report.remaining_a, 1);
        let d = &report.differences[0];
        assert_eq!(d.char_a, Some('丙'));
        assert_eq!(d.char_b, None);
        assert_eq!(d.pos_b, 2);
    }

    #[test]
    fn truncated_texts_report_capped_differences() {
        // 全异文本：每个字符对都是一处差异，超过上限即截断
        let a: String = "甲".repeat(MAX_DIFFERENCES + 500);
        let b: String = "乙".repeat(MAX_DIFFERENCES + 500);
        let report = cmp(&a, &b, &strict());
        assert_eq!(report.differences.len(), MAX_DIFFERENCES);
        assert!(report.truncated);
        assert_eq!(report.end, CompareEnd::Truncated);
    }

    #[test]
    fn large_texts_compare_linearly() {
        // 路线图 §7.2 的大文件用例：约 55 MB × 2，内嵌 3 处差异
        let unit = "汉字简繁转换测试，用于验证大文本比较。";
        let unit_len = unit.len(); // 全 CJK，3 字节/字符
        let repeats = 1_000_000usize;
        let mut a: String = unit.repeat(repeats);
        let mut b: String = a.clone();
        // 差异埋在字符边界上（unit 的整数倍处）
        for k in [10_000usize, 100_000, 200_000] {
            let byte = k * unit_len;
            a.replace_range(byte..byte + 3, "异");
            b.replace_range(byte..byte + 3, "变");
        }
        assert!(
            a.len() > 50 * 1024 * 1024,
            "测试文本应达 ~50MB，实际 {} B",
            a.len()
        );
        let report = cmp(&a, &b, &strict());
        assert_eq!(report.differences.len(), 3, "应恰好发现 3 处植入差异");
        for d in &report.differences {
            assert_eq!(d.char_a, Some('异'));
            assert_eq!(d.char_b, Some('变'));
        }
    }
}
