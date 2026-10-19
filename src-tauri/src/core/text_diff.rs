//! 字符级差异 —— **只服务于「标红」**（F-06 §6.2）
//!
//! ## 为什么要有两套比较
//!
//! `core::compare` 是 TextPro 式**同步逐字**：在某处失配就记一笔，然后两侧
//! 各进一步。这个口径正合「按 F5 一处一处往下校」，但拿它来标红会出事 ——
//! 两篇文本只在开头多一个字，后面所有字都跟着错位，于是整篇后半都被染红。
//!
//! 这里求的是**最小编辑脚本**（LCS 回溯）：只把真正多出来 / 缺失的字标出来，
//! 之后恢复对齐的部分不标。**F5 跳差异仍旧用 `compare` 的逐字口径，一行不改。**
//!
//! ## 内存与降级
//!
//! `compare` 是惰性流、O(1) 内存；LCS 必须整体持有字符，做不到。故：
//! - 单侧超过 `MAX_DIFF_CHARS` 个字符 → 退回 `compare` 的逐字结果；
//! - 中间那次 DP 的规模超过 `MAX_DP_CELLS` → 同样退回。
//! 退回时 `approximate = true`，前端据此知道「这一次的标红仍是逐字口径」。
//! 宁可不精确，也不能让 50 MB 的文本把内存吃掉。

use serde::{Deserialize, Serialize};

use crate::core::compare::{self, CanonKey, CanonStream, CompareOptions};
use crate::core::data_tables::VariantTables;

/// 单侧超过这么多字符就不求最小编辑脚本（退回逐字口径）
pub const MAX_DIFF_CHARS: usize = 2_000_000;

/// DP 表的单元格上限（约 16 MB）——超过就退回逐字口径
const MAX_DP_CELLS: usize = 4_000_000;

/// 差异段上限（与 `compare::MAX_DIFFERENCES` 同数量级）
pub const MAX_SEGMENTS: usize = 5000;

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/// 参与比较的字符：等同键 + 原文偏移 + 长度（UTF-16 码元）
#[derive(Clone, Copy)]
struct Item {
    key: CanonKey,
    pos: usize,
    len: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Equal,
    /// A 侧有、B 侧没有（A 多出）
    Delete,
    /// B 侧有、A 侧没有（B 多出）
    Insert,
}

/// 差异段：长度为 0 的一侧表示「那一侧没有对应的字」
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffKind {
    /// A 多出（目标窗在 A 时：这些字该删）
    Delete,
    /// B 多出（目标窗在 A 时：A 缺这些字）
    Insert,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSegment {
    /// A 文中的 UTF-16 码元偏移
    pub pos_a: usize,
    /// B 文中的 UTF-16 码元偏移
    pub pos_b: usize,
    /// A 侧被这一笔覆盖的长度（0 = A 侧没有对应的字）
    pub len_a: usize,
    /// B 侧被这一笔覆盖的长度
    pub len_b: usize,
    pub kind: DiffKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub segments: Vec<DiffSegment>,
    pub truncated: bool,
    /// true = 文本过大，这次给的是逐字口径的结果，不是最小编辑脚本
    pub approximate: bool,
}

// ---------------------------------------------------------------------------
// 算法
// ---------------------------------------------------------------------------

fn items_of(text: &str, opts: &CompareOptions, tables: &VariantTables) -> Vec<Item> {
    CanonStream::new(text, opts, tables)
        .map(|c| Item {
            key: c.key,
            pos: c.pos,
            len: c.ch.len_utf16(),
        })
        .collect()
}

/// LCS 回溯（O(n·m) 时间 / 内存）。规模超限时返回 `None`，由调用方降级。
fn lcs_ops(a: &[Item], b: &[Item]) -> Option<Vec<Op>> {
    let (n, m) = (a.len(), b.len());

    // 大多数文本只在中间几处不同：先把公共前后缀裁掉，DP 能小一个数量级
    let mut head = 0;
    while head < n && head < m && a[head].key == b[head].key {
        head += 1;
    }
    let mut tail = 0;
    while tail < n - head && tail < m - head && a[n - 1 - tail].key == b[m - 1 - tail].key {
        tail += 1;
    }

    let mut ops = Vec::with_capacity(n + m);
    ops.resize(head, Op::Equal);
    ops.extend(lcs_core(&a[head..n - tail], &b[head..m - tail])?);
    ops.resize(ops.len() + tail, Op::Equal);
    Some(ops)
}

/// 已经裁过前后缀的那一截，真正跑 DP 的部分
fn lcs_core(a: &[Item], b: &[Item]) -> Option<Vec<Op>> {
    let (n, m) = (a.len(), b.len());
    if n == 0 {
        return Some(vec![Op::Insert; m]);
    }
    if m == 0 {
        return Some(vec![Op::Delete; n]);
    }
    if (n + 1) * (m + 1) > MAX_DP_CELLS {
        return None;
    }

    let width = m + 1;
    let mut dp = vec![0u32; (n + 1) * width];
    for i in 1..=n {
        let row = i * width;
        let prev = row - width;
        for j in 1..=m {
            dp[row + j] = if a[i - 1].key == b[j - 1].key {
                dp[prev + j - 1] + 1
            } else {
                dp[prev + j].max(dp[row + j - 1])
            };
        }
    }

    // 从右下角回溯出编辑脚本
    let mut ops = Vec::with_capacity(n + m);
    let (mut i, mut j) = (n, m);
    while i > 0 && j > 0 {
        if a[i - 1].key == b[j - 1].key {
            ops.push(Op::Equal);
            i -= 1;
            j -= 1;
        } else if dp[(i - 1) * width + j] >= dp[i * width + j - 1] {
            ops.push(Op::Delete);
            i -= 1;
        } else {
            ops.push(Op::Insert);
            j -= 1;
        }
    }
    while i > 0 {
        ops.push(Op::Delete);
        i -= 1;
    }
    while j > 0 {
        ops.push(Op::Insert);
        j -= 1;
    }
    ops.reverse();
    Some(ops)
}

/// 把编辑脚本合并成差异段：连续的同类操作合成一段，偏移用原文的 UTF-16 口径
fn segments_from_ops(
    a: &[Item],
    b: &[Item],
    a_len: usize,
    b_len: usize,
    ops: &[Op],
) -> Vec<DiffSegment> {
    let mut out = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    let mut k = 0usize;
    while k < ops.len() {
        match ops[k] {
            Op::Equal => {
                i += 1;
                j += 1;
                k += 1;
            }
            Op::Delete => {
                let pos_a = a[i].pos;
                let pos_b = if j < b.len() { b[j].pos } else { b_len };
                let mut end_a = pos_a;
                while k < ops.len() && ops[k] == Op::Delete {
                    end_a = a[i].pos + a[i].len;
                    i += 1;
                    k += 1;
                }
                out.push(DiffSegment {
                    pos_a,
                    pos_b,
                    len_a: end_a - pos_a,
                    len_b: 0,
                    kind: DiffKind::Delete,
                });
            }
            Op::Insert => {
                let pos_a = if i < a.len() { a[i].pos } else { a_len };
                let pos_b = b[j].pos;
                let mut end_b = pos_b;
                while k < ops.len() && ops[k] == Op::Insert {
                    end_b = b[j].pos + b[j].len;
                    j += 1;
                    k += 1;
                }
                out.push(DiffSegment {
                    pos_a,
                    pos_b,
                    len_a: 0,
                    len_b: end_b - pos_b,
                    kind: DiffKind::Insert,
                });
            }
        }
    }
    out
}

/// 退化路径：把 `compare` 的逐字差异翻译成同样的段结构。
/// 两侧都有字（换了一个字）拆成两段 —— 两边各标各自的。
fn fallback(a: &str, b: &str, opts: &CompareOptions, tables: &VariantTables) -> DiffResult {
    let report = compare::compare(a, b, opts, tables);
    let mut segments = Vec::new();
    for d in report.differences {
        if let Some(ch) = d.char_a {
            segments.push(DiffSegment {
                pos_a: d.pos_a,
                pos_b: d.pos_b,
                len_a: ch.len_utf16(),
                len_b: 0,
                kind: DiffKind::Delete,
            });
        }
        if let Some(ch) = d.char_b {
            segments.push(DiffSegment {
                pos_a: d.pos_a,
                pos_b: d.pos_b,
                len_a: 0,
                len_b: ch.len_utf16(),
                kind: DiffKind::Insert,
            });
        }
    }
    let truncated = segments.len() > MAX_SEGMENTS;
    if truncated {
        segments.truncate(MAX_SEGMENTS);
    }
    DiffResult {
        segments,
        truncated,
        approximate: true,
    }
}

/// 求最小编辑脚本，给出两文真正的差异段（供标红）
pub fn diff(a: &str, b: &str, opts: &CompareOptions, tables: &VariantTables) -> DiffResult {
    // 先算长度再扫：这样超大文本连一遍扫描都不必做
    let estimate = a.len() / 2 + b.len() / 2;
    if estimate > MAX_DIFF_CHARS {
        return fallback(a, b, opts, tables);
    }

    let items_a = items_of(a, opts, tables);
    let items_b = items_of(b, opts, tables);
    let Some(ops) = lcs_ops(&items_a, &items_b) else {
        return fallback(a, b, opts, tables);
    };

    let a_len = compare::utf16_len(a);
    let b_len = compare::utf16_len(b);
    let mut segments = segments_from_ops(&items_a, &items_b, a_len, b_len, &ops);
    let truncated = segments.len() > MAX_SEGMENTS;
    if truncated {
        segments.truncate(MAX_SEGMENTS);
    }
    DiffResult {
        segments,
        truncated,
        approximate: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::data_tables::load_variant_tables;

    fn tables() -> VariantTables {
        load_variant_tables(None).unwrap()
    }

    fn strict() -> CompareOptions {
        CompareOptions::default()
    }

    fn d(a: &str, b: &str) -> DiffResult {
        diff(a, b, &strict(), &tables())
    }

    fn with(a: &str, b: &str, opts: &CompareOptions) -> DiffResult {
        diff(a, b, opts, &tables())
    }

    #[test]
    fn identical_texts_have_no_segments() {
        let r = d("甲乙丙丁", "甲乙丙丁");
        assert!(r.segments.is_empty());
        assert!(!r.approximate);
    }

    #[test]
    fn empty_sides_are_whole_segments() {
        let r = d("", "甲乙");
        assert_eq!(r.segments.len(), 1);
        assert_eq!(r.segments[0].kind, DiffKind::Insert);
        assert_eq!(r.segments[0].len_b, 2);

        let r = d("甲乙", "");
        assert_eq!(r.segments.len(), 1);
        assert_eq!(r.segments[0].kind, DiffKind::Delete);
    }

    #[test]
    fn one_extra_char_in_the_middle_marks_only_that_char() {
        // 逐字口径会把「软件」也染红；这里只应标出多出来的那个「兔」
        let r = d("汉字软件", "汉字兔软件");
        assert_eq!(r.segments.len(), 1);
        let s = r.segments[0];
        assert_eq!(s.kind, DiffKind::Insert);
        assert_eq!(s.pos_b, 2);
        assert_eq!(s.len_b, 1);
        assert_eq!(s.len_a, 0, "A 侧没有对应的字，不该占长度");
    }

    #[test]
    fn one_missing_char_in_the_middle_marks_only_that_char() {
        let r = d("汉字兔软件", "汉字软件");
        assert_eq!(r.segments.len(), 1);
        let s = r.segments[0];
        assert_eq!(s.kind, DiffKind::Delete);
        assert_eq!(s.pos_a, 2);
        assert_eq!(s.len_a, 1);
    }

    #[test]
    fn replaced_char_yields_one_delete_plus_one_insert() {
        let r = d("汉字兔件", "汉字龟件");
        // LCS 会把「兔→龟」算成一删一增，两边各标各的那个字
        assert_eq!(r.segments.len(), 2);
        assert!(r
            .segments
            .iter()
            .any(|s| s.kind == DiffKind::Delete && s.len_a == 1));
        assert!(r
            .segments
            .iter()
            .any(|s| s.kind == DiffKind::Insert && s.len_b == 1));
    }

    #[test]
    fn consecutive_differences_are_merged_into_one_segment() {
        let r = d("开头结尾", "开头插入的一小段结尾");
        assert_eq!(r.segments.len(), 1);
        assert_eq!(r.segments[0].kind, DiffKind::Insert);
        // 「插入的一小段」六个字，合成一段而不是六段
        assert_eq!(r.segments[0].len_b, 6);
    }

    #[test]
    fn ignored_chars_do_not_create_differences() {
        let nl = CompareOptions {
            ignore_newlines: true,
            ..strict()
        };
        let r = with("甲\n乙", "甲乙", &nl);
        assert!(r.segments.is_empty());
    }

    #[test]
    fn full_equivalent_variants_are_not_differences() {
        let eq = CompareOptions {
            variant_strictness: compare::VariantStrictness::FullEq,
            ..strict()
        };
        assert!(with("兔", "兎", &eq).segments.is_empty());
        // 严格模式下同一个字仍是差异
        assert_eq!(with("兔", "兎", &strict()).segments.len(), 2);
    }

    #[test]
    fn offsets_are_utf16_and_survive_non_ascii() {
        // 前面放一个非 BMP 字符（UTF-16 里占两个码元），偏移必须按码元算
        let r = d("𠀀汉字软件", "𠀀汉字兔软件");
        let s = r.segments[0];
        assert_eq!(s.pos_a, 4, "𠀀 占 2 个码元 + 汉字 2 字");
        assert_eq!(s.pos_b, 4);
        assert_eq!(s.len_b, 1);
    }

    #[test]
    fn too_large_text_falls_back_to_word_by_word() {
        // 超过 MAX_DIFF_CHARS 就别求 LCS 了，退回逐字口径并标 approximate
        let big: String = "甲乙丙丁".repeat(MAX_DIFF_CHARS / 4 + 10);
        let r = diff(&big, "甲乙丙丁", &strict(), &tables());
        assert!(r.approximate, "超大文本应退回逐字口径");
        assert!(!r.segments.is_empty());
    }

    #[test]
    fn diff_stays_symmetric_in_kind() {
        // A 多出一个字 ↔ B 多出一个字，段类型应当正好反过来
        let forward = d("汉字软件", "汉字兔软件");
        let backward = d("汉字兔软件", "汉字软件");
        assert_eq!(forward.segments[0].kind, DiffKind::Insert);
        assert_eq!(backward.segments[0].kind, DiffKind::Delete);
    }
}
