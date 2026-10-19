//! 字符级差异（F-06 §6.2）—— **差异计数、F5 跳差异、标红，全都走这一套口径**。
//!
//! ## 为什么是最小编辑脚本
//!
//! TextPro 式**同步逐字**（已废弃的 `compare`）：在某处失配就记一笔，然后两侧
//! 各进一步。这会让后面全部错位 —— 两文只差一个字，后半篇也全是「差异」。
//! 这里求的是最小编辑脚本，只把真正多出来 / 缺失的字标出来。
//!
//! ## 三级漏斗（为什么不直接跑 LCS）
//!
//! LCS 的动态规划是 O(n·m)：50 MB 的文本约 1200 万字符，两两相乘是想都别想的
//! 量。好在真实文本的差异往往稀疏，于是按代价从低到高逐层放大：
//!
//!   1. 裁掉公共前后缀 —— 多数情况一步就把问题缩到很小；
//!   2. 剩下的还够小 → 直接 DP（**这一步是精确最优的**）；
//!   3. 剩得多、但有换行 → **按行对齐**（Myers，O(N·D)，D 是行差数，通常个位
//!      数），失配的行块内部再回到第 1 层递归；
//!   4. 没有换行、但**两侧等长** → 逐位比较，一趟线性扫完（同一文件的两个版本
//!      常常只改了几个字、长度不变 —— 那时这一层就够，且最省）；
//!   5. 兜不住 → `degraded = true`，前端据此明说「未能完整比较」，
//!      而不是悄悄退回另一套口径。
//!
//! 每层给出的数据结构都一样（差异块），上层不必知道走的哪一层。

use serde::{Deserialize, Serialize};

use crate::core::compare::{self, CanonKey, CanonStream, CompareOptions};
use crate::core::data_tables::VariantTables;

/// 差异块上限（沿用旧 compare 的 `MAX_DIFFERENCES` 数量级）
pub const MAX_BLOCKS: usize = 5000;

/// 字符级 DP 的单元格上限（约 16 MB）—— 超过就交给下一层
const MAX_DP_CELLS: usize = 4_000_000;

/// Myers 回溯要按 O(D²) 存每一步的 V，编辑距离超过这个数就认输换层
const MAX_TRACE_D: usize = 4096;

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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Equal,
    /// A 侧有、B 侧没有
    Delete,
    /// B 侧有、A 侧没有
    Insert,
}

/// 一处差异：两侧的偏移与长度。长度为 0 的一侧表示「那一侧没有对应的字」。
///
/// 两侧都有长度，是把某处的旧字换成了新字：`len_a` 是被换掉的那几个字，
/// `len_b` 是换上来的那几个字。**相邻的「一缺一多」已经并成一块** —— 换了一个
/// 字算一处，这与人在屏幕上的观感一致，也是工具条上那个「第 i/N 处」的 N。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffBlock {
    /// A 文中的 UTF-16 码元偏移
    pub pos_a: usize,
    /// B 文中的 UTF-16 码元偏移
    pub pos_b: usize,
    pub len_a: usize,
    pub len_b: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    /// 差异块，按文中出现的先后顺序排列
    pub blocks: Vec<DiffBlock>,
    /// 差异块数超过上限，已被截断
    pub truncated: bool,
    /// 文本过大或差异过密，几层都没兜住：这份结果是近似的
    pub degraded: bool,
}

// ---------------------------------------------------------------------------
// 入口
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

/// 求两份文本的差异。`blocks` 为空即两文一致（在给定选项下）。
pub fn diff(a: &str, b: &str, opts: &CompareOptions, tables: &VariantTables) -> DiffResult {
    let items_a = items_of(a, opts, tables);
    let items_b = items_of(b, opts, tables);
    let a_len = compare::utf16_len(a);
    let b_len = compare::utf16_len(b);

    let mut degraded = false;
    let blocks = match plan_ops(&items_a, &items_b, &mut degraded) {
        Some(ops) => blocks_from_ops(&items_a, &items_b, a_len, b_len, &ops),
        // 一层都没兜住：把两侧从第一个字到最后一个字算成一块差异，并标 degraded
        None => {
            degraded = true;
            vec![DiffBlock {
                pos_a: 0,
                pos_b: 0,
                len_a: a_len,
                len_b: b_len,
            }]
        }
    };

    let truncated = blocks.len() > MAX_BLOCKS;
    let blocks = if truncated {
        blocks[..MAX_BLOCKS].to_vec()
    } else {
        blocks
    };
    DiffResult {
        blocks,
        truncated,
        degraded,
    }
}

// ---------------------------------------------------------------------------
// 第 1 层：裁公共前后缀，再交给下面
// ---------------------------------------------------------------------------

/// 求出整段的编辑脚本；`degraded` 置 true 表示中途有一处没能算准
fn plan_ops(a: &[Item], b: &[Item], degraded: &mut bool) -> Option<Vec<Op>> {
    let (n, m) = (a.len(), b.len());
    if n == 0 {
        return Some(vec![Op::Insert; m]);
    }
    if m == 0 {
        return Some(vec![Op::Delete; n]);
    }

    let mut head = 0;
    while head < n && head < m && a[head].key == b[head].key {
        head += 1;
    }
    let mut tail = 0;
    while tail < n - head && tail < m - head && a[n - 1 - tail].key == b[m - 1 - tail].key {
        tail += 1;
    }

    let mut ops: Vec<Op> = Vec::with_capacity(n + m);
    ops.resize(head, Op::Equal);
    let mid_a = &a[head..n - tail];
    let mid_b = &b[head..m - tail];
    if !mid_a.is_empty() || !mid_b.is_empty() {
        ops.extend(mid_ops(mid_a, mid_b, degraded)?);
    }
    ops.resize(ops.len() + tail, Op::Equal);
    Some(ops)
}

/// 中间那截：按代价从低到高挑一层来算
fn mid_ops(a: &[Item], b: &[Item], degraded: &mut bool) -> Option<Vec<Op>> {
    let (n, m) = (a.len(), b.len());
    if n == 0 {
        return Some(vec![Op::Insert; m]);
    }
    if m == 0 {
        return Some(vec![Op::Delete; n]);
    }
    // 2. 够小就精确跑
    if (n + 1) * (m + 1) <= MAX_DP_CELLS {
        return lcs_dp_ops(a, b);
    }
    // 3. 有换行：先把行数降下来
    if let Some(ops) = line_ops(a, b, degraded) {
        return Some(ops);
    }
    // 4. 没换行但两边一样长：逐位比较，一趟线性
    if n == m {
        return Some(bitwise_ops(a, b));
    }
    None
}

// ---------------------------------------------------------------------------
// 第 2 层：字符级 DP（精确最优）
// ---------------------------------------------------------------------------

fn lcs_dp_ops(a: &[Item], b: &[Item]) -> Option<Vec<Op>> {
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

// ---------------------------------------------------------------------------
// 第 3 层：按行对齐（Myers），失配的行块内部再递归
// ---------------------------------------------------------------------------

/// 一_nodes 兰 newline 的 Canonical key 不会被异体字表改写
fn is_newline(key: CanonKey) -> bool {
    key.kind == 0 && key.value == '\n' as u32
}

/// 按换行切成行（每行的 item 索引区间，行含换行符本身）。
/// 只有一行（或压根没有换行）就返回 None —— 那就没有「按行」这层可用。
fn lines_of(items: &[Item]) -> Option<Vec<(usize, usize)>> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, it) in items.iter().enumerate() {
        if is_newline(it.key) {
            out.push((start, i + 1));
            start = i + 1;
        }
    }
    if start < items.len() {
        out.push((start, items.len()));
    }
    if out.len() <= 1 {
        return None;
    }
    Some(out)
}

/// 一行内容压成一个 u64（FNV-1a），行级比较只比这个数，比字符串快得多
fn hash_items(items: &[Item]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for it in items {
        for part in [it.key.kind as u64, it.key.value as u64] {
            hash ^= part;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}

fn line_ops(a: &[Item], b: &[Item], degraded: &mut bool) -> Option<Vec<Op>> {
    let la = lines_of(a)?;
    let lb = lines_of(b)?;
    let sa: Vec<u64> = la.iter().map(|&(s, e)| hash_items(&a[s..e])).collect();
    let sb: Vec<u64> = lb.iter().map(|&(s, e)| hash_items(&b[s..e])).collect();
    let line_plan = myers_ops(&sa, &sb, MAX_TRACE_D)?;

    // 行序列还原成字符序列：相等的行照抄，失配的行整块递归
    let mut ops = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j, mut k) = (0usize, 0usize, 0usize);
    while k < line_plan.len() {
        match line_plan[k] {
            Op::Equal => {
                ops.resize(ops.len() + (la[i].1 - la[i].0), Op::Equal);
                i += 1;
                j += 1;
                k += 1;
            }
            _ => {
                let (i0, j0) = (i, j);
                while k < line_plan.len() && line_plan[k] != Op::Equal {
                    match line_plan[k] {
                        Op::Delete => i += 1,
                        Op::Insert => j += 1,
                        Op::Equal => unreachable!(),
                    }
                    k += 1;
                }
                if i == i0 && j == j0 {
                    return None; // 防御：不该走到这里
                }
                // 前后缀裁剪过的话，头尾的行可能是「半行」，所以失配块完全
                // 可以只有一侧有行 —— 那一侧的区间就是空的
                let range_a = if i == i0 { 0..0 } else { la[i0].0..la[i - 1].1 };
                let range_b = if j == j0 { 0..0 } else { lb[j0].0..lb[j - 1].1 };
                let sub_a = &a[range_a];
                let sub_b = &b[range_b];
                match plan_ops(sub_a, sub_b, degraded) {
                    Some(sub) => ops.extend(sub),
                    None => {
                        // 这一段自己也兜不住：整段算一删一增，但不瞒着
                        *degraded = true;
                        ops.resize(ops.len() + sub_a.len(), Op::Delete);
                        ops.resize(ops.len() + sub_b.len(), Op::Insert);
                    }
                }
            }
        }
    }
    Some(ops)
}

/// Myers 贪心（保存每一步的 V 以便回溯）：时间在 O(N·D)、内存在 O(D²)
fn myers_ops<T: PartialEq>(a: &[T], b: &[T], max_d: usize) -> Option<Vec<Op>> {
    let (n, m) = (a.len(), b.len());
    if n == 0 {
        return Some(vec![Op::Insert; m]);
    }
    if m == 0 {
        return Some(vec![Op::Delete; n]);
    }
    let offset = (n + m) as isize;
    let mut v = vec![0isize; 2 * (n + m) + 1];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut arrived = false;

    for d in 0..=(n + m) {
        if d > max_d {
            return None;
        }
        trace.push(v.clone());
        let d = d as isize;
        let mut k = -d;
        while k <= d {
            let down =
                k == -d || (k != d && v[(k - 1 + offset) as usize] < v[(k + 1 + offset) as usize]);
            let mut x = if down {
                v[(k + 1 + offset) as usize]
            } else {
                v[(k - 1 + offset) as usize] + 1
            };
            let mut y = x - k;
            while x < n as isize && y < m as isize && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[(k + offset) as usize] = x;
            if x >= n as isize && y >= m as isize {
                arrived = true;
                break;
            }
            k += 2;
        }
        if arrived {
            break;
        }
    }
    if !arrived {
        return None;
    }
    Some(backtrack_ops(&trace, n, m, offset))
}

/// 从右下角沿 trace 往回走，倒着攒出编辑脚本
fn backtrack_ops(trace: &[Vec<isize>], n: usize, m: usize, offset: isize) -> Vec<Op> {
    let mut ops = Vec::new();
    let (mut x, mut y) = (n as isize, m as isize);
    for (d, snapshot) in trace.iter().enumerate().rev() {
        let d = d as isize;
        let k = x - y;
        let k_prev = if k == -d
            || (k != d && snapshot[(k - 1 + offset) as usize] < snapshot[(k + 1 + offset) as usize])
        {
            k + 1
        } else {
            k - 1
        };
        let prev_x = snapshot[(k_prev + offset) as usize];
        let prev_y = prev_x - k_prev;
        while x > prev_x && y > prev_y {
            ops.push(Op::Equal);
            x -= 1;
            y -= 1;
        }
        if d > 0 {
            if x == prev_x {
                ops.push(Op::Insert);
            } else {
                ops.push(Op::Delete);
            }
        }
        x = prev_x;
        y = prev_y;
    }
    ops.reverse();
    ops
}

// ---------------------------------------------------------------------------
// 第 4 层：两侧等长就逐位比较
// ---------------------------------------------------------------------------

/// 两侧字符数相同：同一位置两个字符换掉了，就是一处替换。
///
/// 一趟线性，不占额外内存。差异稀疏时（绝大多数情形：只改了几个字）这就是最小
/// 编辑脚本；万一差异密集，块会比最优结果粗一点 —— 但总好过把整篇判成差异。
fn bitwise_ops(a: &[Item], b: &[Item]) -> Vec<Op> {
    debug_assert_eq!(a.len(), b.len());
    let n = a.len();
    let mut ops = Vec::with_capacity(2 * n);
    for i in 0..n {
        if a[i].key == b[i].key {
            ops.push(Op::Equal);
        } else {
            ops.push(Op::Delete);
            ops.push(Op::Insert);
        }
    }
    ops
}

// ---------------------------------------------------------------------------
// 编辑脚本 → 差异块
// ---------------------------------------------------------------------------

fn blocks_from_ops(
    a: &[Item],
    b: &[Item],
    a_len: usize,
    b_len: usize,
    ops: &[Op],
) -> Vec<DiffBlock> {
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
            _ => {
                // 相邻的「缺」和「多」是同一处（比如把一个字换掉了）。
                // 编辑脚本里两者的先后不一定 —— 回溯时先撞见哪个就先记哪个 ——
                // 所以先看眼前这一串是什么，再配它的另一半。
                // 一次只配一对：否则一大片没有相同字符的区域会被整个吞成一块。
                let pos_a = if i < a.len() { a[i].pos } else { a_len };
                let pos_b = if j < b.len() { b[j].pos } else { b_len };
                let (mut end_a, mut end_b) = (pos_a, pos_b);
                macro_rules! eat_run {
                    ($op:expr) => {
                        while k < ops.len() && ops[k] == $op {
                            if $op == Op::Delete {
                                end_a = a[i].pos + a[i].len;
                                i += 1;
                            } else {
                                end_b = b[j].pos + b[j].len;
                                j += 1;
                            }
                            k += 1;
                        }
                    };
                }
                let first = ops[k];
                let second = if first == Op::Delete {
                    Op::Insert
                } else {
                    Op::Delete
                };
                eat_run!(first);
                eat_run!(second);
                out.push(DiffBlock {
                    pos_a,
                    pos_b,
                    len_a: end_a - pos_a,
                    len_b: end_b - pos_b,
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::compare::VariantStrictness;
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

    // -- 基本形状 -----------------------------------------------------------

    #[test]
    fn identical_texts_have_no_blocks() {
        let r = d("甲乙丙丁", "甲乙丙丁");
        assert!(r.blocks.is_empty());
        assert!(!r.degraded);
        assert!(!r.truncated);
    }

    #[test]
    fn both_empty_is_equal() {
        let r = d("", "");
        assert!(r.blocks.is_empty());
        assert!(!r.degraded);
    }

    #[test]
    fn one_empty_side_is_one_block() {
        let r = d("", "甲乙");
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(
            r.blocks[0],
            DiffBlock {
                pos_a: 0,
                pos_b: 0,
                len_a: 0,
                len_b: 2
            }
        );

        let r = d("甲乙", "");
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(
            r.blocks[0],
            DiffBlock {
                pos_a: 0,
                pos_b: 0,
                len_a: 2,
                len_b: 0
            }
        );
    }

    // -- 只标真正的差异（这一版存在的理由）---------------------------------

    #[test]
    fn one_extra_char_marks_only_that_char() {
        // 逐字口径会把后面的「软件」也记成差异；这里不许
        let r = d("汉字软件", "汉字兔软件");
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(
            r.blocks[0],
            DiffBlock {
                pos_a: 2,
                pos_b: 2,
                len_a: 0,
                len_b: 1
            }
        );
    }

    #[test]
    fn one_missing_char_marks_only_that_char() {
        let r = d("汉字兔软件", "汉字软件");
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(
            r.blocks[0],
            DiffBlock {
                pos_a: 2,
                pos_b: 2,
                len_a: 1,
                len_b: 0
            }
        );
    }

    #[test]
    fn replaced_char_is_one_block_not_two() {
        // 界面上「第 i/N 处」的 N 就是这么数的：换掉一个字算一处
        let r = d("汉字兔件", "汉字龟件");
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(
            r.blocks[0],
            DiffBlock {
                pos_a: 2,
                pos_b: 2,
                len_a: 1,
                len_b: 1
            }
        );
    }

    #[test]
    fn differences_after_the_first_one_are_still_found() {
        // 逐字口径失配后会一路错位；这里三处差异都要各自对得上
        let r = d("第一处X第二处Y第三处Z", "第一处1第二处2第三处3");
        assert_eq!(r.blocks.len(), 3);
        for block in &r.blocks {
            assert_eq!(block.len_a, 1);
            assert_eq!(block.len_b, 1);
        }
    }

    #[test]
    fn terminal_difference_is_a_block() {
        let r = d("甲乙", "甲乙丙");
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(
            r.blocks[0],
            DiffBlock {
                pos_a: 2,
                pos_b: 2,
                len_a: 0,
                len_b: 1
            }
        );

        let r = d("甲乙丙", "甲乙");
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(
            r.blocks[0],
            DiffBlock {
                pos_a: 2,
                pos_b: 2,
                len_a: 1,
                len_b: 0
            }
        );
    }

    // -- 偏移口径 -----------------------------------------------------------

    #[test]
    fn offsets_are_utf16_code_units() {
        // 前面放一个非 BMP 字符（UTF-16 里占两个码元），偏移必须按码元算
        let r = d("𠀀汉字软件", "𠀀汉字兔软件");
        assert_eq!(r.blocks[0].pos_a, 4, "𠀀 占 2 个码元 + 汉字 2 字");
        assert_eq!(r.blocks[0].pos_b, 4);
        assert_eq!(r.blocks[0].len_b, 1);
    }

    #[test]
    fn offsets_are_original_offsets_despite_ignored_chars() {
        // 忽略了 half 空格之后，偏移仍要落在原文的坐标上
        let opts = CompareOptions {
            ignore_half_space: true,
            ..strict()
        };
        let r = with("甲 乙", "甲兔 乙", &opts);
        assert_eq!(r.blocks.len(), 1);
        let b = r.blocks[0];
        assert_eq!(b.pos_b, 1, "B 文的第 1 个码元处多出一个「兔」");
        assert_eq!(b.len_b, 1);
    }

    // -- 忽略项与异体字 -----------------------------------------------------

    #[test]
    fn ignore_options_remove_chars_from_matching() {
        let opts = CompareOptions {
            ignore_newlines: true,
            ignore_half_space: true,
            ..strict()
        };
        assert!(with("甲\n乙 丙", "甲乙丙", &opts).blocks.is_empty());

        let opts = CompareOptions {
            ignore_full_punct: true,
            ..strict()
        };
        assert!(with("甲，乙。丙", "甲乙丙", &opts).blocks.is_empty());
    }

    #[test]
    fn variant_strictness_decides_equality() {
        let full = CompareOptions {
            variant_strictness: VariantStrictness::FullEq,
            ..strict()
        };
        let partial = CompareOptions {
            variant_strictness: VariantStrictness::PartialEq,
            ..strict()
        };
        // 数据表里 fc1 的完全等同：伪 / 偽
        assert!(with("伪甲", "偽甲", &full).blocks.is_empty());
        // 默认 Strict（逐字比），同一个字对就算差异
        assert_eq!(with("伪甲", "偽甲", &strict()).blocks.len(), 1);
        // fc2 的部分等同：达 / 達，要 PartialEq 及以上才放行
        assert!(with("达甲", "達甲", &partial).blocks.is_empty());
        assert_eq!(with("达甲", "達甲", &full).blocks.len(), 1);
    }

    // -- 限制 ---------------------------------------------------------------

    #[test]
    fn too_many_blocks_is_truncated() {
        // 全异文本：几乎每个字都是一处差异，超过上限即截断
        let a: String = "甲".repeat(MAX_BLOCKS + 500);
        let b: String = "乙".repeat(MAX_BLOCKS + 500);
        let r = diff(&a, &b, &strict(), &tables());
        assert_eq!(r.blocks.len(), MAX_BLOCKS);
        assert!(r.truncated);
    }

    // -- 三层的能力：中等文本、大文本都必须只找出零星几处 -------------------

    #[test]
    fn line_anchors_handle_inserted_paragraphs() {
        // 中间整段多出来：必须走「按行」那层，而且只算一处
        let unit = "这是正文的一行。\n";
        let a: String = unit.repeat(2000);
        let mut b: String = unit.repeat(1000);
        b.push_str("这是插入的一整段。\n");
        b.push_str(&unit.repeat(1000));
        let r = diff(&a, &b, &strict(), &tables());
        assert_eq!(r.blocks.len(), 1, "整段插入应只算一处差异");
        assert_eq!(r.blocks[0].len_a, 0);
        // 「这是插入的一整段。」9 个字，连带换行一共 10 个码元
        assert_eq!(r.blocks[0].len_b, 10);
        assert!(!r.degraded);
    }

    #[test]
    fn mixed_edits_in_a_long_text_are_each_found() {
        // 每行都要带上行号才行：若两边是同一句话重复到底，那么「多出来的 /
        // 少掉的是哪一行」会有好几个编辑距离相同的答案，位置就不唯一了。
        // 这是 diff 的固有特性，不是 bug —— 测的时候得避开这种歧义。
        let unit = |k: usize| format!("第 {} 行：汉字简繁转换测试，用于验证大文本比较。\n", k);
        let mut a = String::new();
        let mut b = String::new();
        for k in 0..20_000 {
            if k == 3_000 {
                // 只差一个字：应当算「一处」替换
                a.push_str("这一行的内容是甲。\n");
                b.push_str("这一行的内容是乙。\n");
            } else if k == 9_000 {
                a.push_str(&unit(k)); // 这一行 B 侧没有
            } else if k == 15_000 {
                a.push_str(&unit(k));
                b.push_str(&unit(k));
                b.push_str("这是 B 多出来的一行。\n");
            } else {
                a.push_str(&unit(k));
                b.push_str(&unit(k));
            }
        }
        let r = diff(&a, &b, &strict(), &tables());
        assert_eq!(r.blocks.len(), 3, "应恰好发现 3 处差异");
        assert!(!r.degraded);
        assert!(!r.truncated);
    }

    #[test]
    fn large_texts_without_newlines_compare_linearly() {
        // 路线图 §7.2 的大文件用例：约 55 MB × 2，内嵌 3 处差异
        // （这个用例两侧等长且没有换行 —— 走的是「逐位比较」那层）
        let unit = "汉字简繁转换测试，用于验证大文本比较。";
        let unit_len = unit.len(); // 全 CJK，3 字节/字符
        let repeats = 1_000_000usize;
        let mut a: String = unit.repeat(repeats);
        let mut b: String = a.clone();
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
        let r = diff(&a, &b, &strict(), &tables());
        assert_eq!(r.blocks.len(), 3, "应恰好发现 3 处植入差异");
        assert!(!r.degraded);
        for block in &r.blocks {
            assert_eq!(block.len_a, 1);
            assert_eq!(block.len_b, 1);
        }
    }

    #[test]
    fn large_texts_with_newlines_use_line_anchors() {
        // 同样是 ~50 MB，但这次是「正常」文本（有换行），走的行锚点那层
        let unit = "汉字简繁转换测试，用于验证大文本比较。\n";
        let repeats = 800_000usize;
        let a: String = unit.repeat(repeats);
        let mut b: String = a.clone();
        // 在第 10 万行的行首换掉一个字
        let unit_len = unit.len();
        for k in [10_000usize, 200_000, 500_000] {
            let byte = k * unit_len;
            b.replace_range(byte..byte + 3, "異");
        }
        assert!(
            a.len() > 40 * 1024 * 1024,
            "测试文本应在 40MB 以上，实际 {} B",
            a.len()
        );
        let r = diff(&a, &b, &strict(), &tables());
        assert_eq!(r.blocks.len(), 3, "应恰好发现 3 处植入差异");
        assert!(!r.degraded, "不应退化");
    }

    #[test]
    fn unreconcilable_texts_report_degraded_instead_of_lying() {
        // 两侧都很长、没有换行、长度又不等 —— 哪一层都兜不住，那就认
        let unit = "汉字简繁转换测试。";
        // 长度不等是刻意的：等长会走「逐位比较」那层（见上面那条测试）
        let a: String = unit.repeat(400_000);
        let b: String = "完全不同的另一篇。".repeat(399_000);
        let r = diff(&a, &b, &strict(), &tables());
        assert!(r.degraded, "这种形状应当明确报 degraded，而不是假装算准了");
        assert!(!r.blocks.is_empty());
    }

    #[test]
    fn symmetric_when_sides_are_swapped() {
        // 换过来看应当是同一处差异，只是长度落在另一侧
        let forward = d("汉字软件", "汉字兔软件");
        let backward = d("汉字兔软件", "汉字软件");
        assert_eq!(forward.blocks.len(), 1);
        assert_eq!(backward.blocks.len(), 1);
        assert_eq!(forward.blocks[0].pos_a, backward.blocks[0].pos_a);
        assert_eq!(forward.blocks[0].len_b, backward.blocks[0].len_a);
    }
}
