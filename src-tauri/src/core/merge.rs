//! 文件合并（F-07）
//!
//! 两种模式（F-07 §7.2），共享同一套「排序 → 分组 → 拼接」的纯函数规划器：
//!
//! - **手工合并**：用户挑好源文件清单与输出文件，可选给一个「排序关键字」
//!   （对文件名求值的正则，取第 1 捕获组或整段命中），按序拼接；
//! - **自动合并（正则）**：给目录 + 源文件名正则（含捕获组，如
//!   `(\d+)_(\d+)\.txt`），按 **第 1 捕获组** 分组，组内按「排序关键字」
//!   模板（如 `\2`，对源正则的捕获组求值）排序，每组输出一个文件，
//!   文件名由「输出文件名模板」（如 `\1.txt`）渲染。
//!
//! 规划器只吃内存数据（`MergeItem`），文件读写与编码探测在命令层
//! （`commands/merge.rs`）完成——这样「1 万文件合并」可以在单测里
//! 直接构造，无需真实落盘。
//!
//! 排序为**自然排序**（数字段按数值比较）：`2` < `10`，对
//! `(\d+)_(\d+)\.txt` 这类文件名是显然正确的语义。
//!
//! 拼接策略（简单拼接 = 行尾追加空行）：各文件去尾换行后以一个空行
//! 相接，结果保证单个结尾换行；读入的文本已由编码层归一为 LF。

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use super::ui_lang;

/// 拼接策略（F-07 §7.2「合并策略」）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum MergeStrategy {
    /// 简单拼接（全部文件按序接成一个，行尾追加空行）
    #[default]
    Simple,
    /// 同名段拼接：按源正则第 1 捕获组分文件去重，组内按序追加
    SameName,
}

/// 规划选项
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MergePlanOptions {
    pub strategy: MergeStrategy,
    /// 源文件名正则（含捕获组；自动合并必需，手工合并可选）
    pub source_pattern: Option<String>,
    /// 输出文件名模板（`\1.txt`；仅自动合并使用）
    pub output_pattern: Option<String>,
    /// 排序关键字：有源正则时是模板（`\2`），否则是对文件名求值的正则
    pub sort_key: Option<String>,
}

/// 一个待合并文件（内存表示；命令层负责从磁盘读出）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeItem {
    /// 文件名（不含路径，用于正则匹配与排序）
    pub name: String,
    pub text: String,
}

/// 一个合并产物
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedOutput {
    /// 输出名（自动合并 = 模板渲染名；手工合并 = 输出路径的文件名）
    pub name: String,
    /// 参与文件（按合并顺序）
    pub order: Vec<String>,
    pub text: String,
}

// ---------------------------------------------------------------------------
// 排序与模板
// ---------------------------------------------------------------------------

/// 从迭代器里取尽连续数字段（只 peek 不越界消费，非数字字符留在流里）
fn take_digits(it: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut out = String::new();
    while let Some(&ch) = it.peek() {
        if !ch.is_ascii_digit() {
            break;
        }
        out.push(ch);
        it.next();
    }
    out
}

/// 自然排序：连续数字段按数值比较（`9` < `10`），其余逐字符比较
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let mut ia = a.chars().peekable();
    let mut ib = b.chars().peekable();
    loop {
        match (ia.peek().copied(), ib.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                if x.is_ascii_digit() && y.is_ascii_digit() {
                    let sa = take_digits(&mut ia);
                    let sb = take_digits(&mut ib);
                    // 先比位数（去前导零后），再比数值；都相同则前导零多者排后（稳定约定）
                    let ta = sa.trim_start_matches('0');
                    let tb = sb.trim_start_matches('0');
                    let ord = ta
                        .len()
                        .cmp(&tb.len())
                        .then_with(|| ta.cmp(tb))
                        .then_with(|| sa.len().cmp(&sb.len()));
                    if ord != Ordering::Equal {
                        return ord;
                    }
                } else {
                    let ord = x.cmp(&y);
                    if ord != Ordering::Equal {
                        return ord;
                    }
                    ia.next();
                    ib.next();
                }
            }
        }
    }
}

/// 把模板里的 `\1`..`\9` 换成捕获组内容（越界/未命中 → 空串）
pub fn render_template(template: &str, captures: &[String]) -> String {
    let mut out = String::new();
    let mut chars = template.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(&digit) = chars.peek() {
                if digit.is_ascii_digit() {
                    chars.next();
                    let index = digit as usize - '0' as usize;
                    if index >= 1 {
                        if let Some(value) = captures.get(index - 1) {
                            out.push_str(value);
                        }
                    }
                    continue;
                }
            }
        }
        out.push(ch);
    }
    out
}

// ---------------------------------------------------------------------------
// 规划
// ---------------------------------------------------------------------------

struct Prepared {
    item: usize,
    /// 源正则的捕获组（1..9；无源正则或未命中 → 空）
    captures: Vec<String>,
    /// 排序键（无关键字 → 空串，保持输入顺序）
    key: String,
}

/// 计算每个文件的捕获组与排序键
fn prepare(names: &[&str], opts: &MergePlanOptions) -> AppResult<Vec<Prepared>> {
    use regex::Regex;

    let source_re = match &opts.source_pattern {
        Some(pattern) if !pattern.is_empty() => {
            Some(Regex::new(pattern).map_err(|e| AppError::Merge(format!("源正则错误：{e}")))?)
        }
        _ => None,
    };
    // 无源正则时，排序关键字按「对文件名求值的正则」处理
    let sort_re = match (&source_re, &opts.sort_key) {
        (None, Some(key)) if !key.is_empty() => {
            Some(Regex::new(key).map_err(|e| AppError::Merge(format!("排序正则错误：{e}")))?)
        }
        _ => None,
    };

    let mut out = Vec::with_capacity(names.len());
    for (index, name) in names.iter().enumerate() {
        let captures: Vec<String> = source_re
            .as_ref()
            .and_then(|re| re.captures(name))
            .map(|caps| {
                (1..caps.len())
                    .map(|i| {
                        caps.get(i)
                            .map(|m| m.as_str().to_owned())
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .unwrap_or_default();
        let key = if let Some(k) = &opts.sort_key {
            if k.is_empty() {
                String::new()
            } else if source_re.is_some() {
                // 模板口径：对源正则捕获组求值（如 `\2`）
                render_template(k, &captures)
            } else {
                // 正则口径：对文件名求值，取第 1 捕获组或整段命中
                sort_re
                    .as_ref()
                    .and_then(|re| re.captures(name))
                    .map(|caps| {
                        caps.get(1)
                            .or_else(|| caps.get(0))
                            .map(|m| m.as_str().to_owned())
                            .unwrap_or_default()
                    })
                    .unwrap_or_default()
            }
        } else {
            String::new()
        };
        out.push(Prepared {
            item: index,
            captures,
            key,
        });
    }
    Ok(out)
}

/// 拼接：各文件去尾换行，以一个空行相接，结果单个结尾换行
fn join_parts(texts: &[&str]) -> String {
    let mut out = String::new();
    for (index, text) in texts.iter().enumerate() {
        if index > 0 {
            out.push_str("\n\n");
        }
        out.push_str(text.trim_end_matches('\n'));
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

/// 排序（稳定）：按自然序比较排序键；给了排序关键字时，键相同再按
/// 文件名自然序（`1_10.txt` 排在 `2_10.txt` 前，与文件管理器一致）；
/// 完全没给关键字时保持用户挑文件的输入顺序
fn sort_by_key(prepared: &mut [Prepared], names: &[&str], tiebreak_by_name: bool) {
    prepared.sort_by(|a, b| {
        let ord = natural_cmp(&a.key, &b.key);
        if tiebreak_by_name {
            ord.then_with(|| natural_cmp(names[a.item], names[b.item]))
        } else {
            ord
        }
    });
}

/// 规划合并：`Simple` 产出一个合并件；`SameName` 按第 1 捕获组逐组产出
pub fn plan_merge(items: &[MergeItem], opts: &MergePlanOptions) -> AppResult<Vec<MergedOutput>> {
    let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
    let mut prepared = prepare(&names, opts)?;

    match opts.strategy {
        MergeStrategy::Simple => {
            let tiebreak = opts.sort_key.as_deref().is_some_and(|k| !k.is_empty());
            sort_by_key(&mut prepared, &names, tiebreak);
            let order: Vec<String> = prepared
                .iter()
                .map(|p| items[p.item].name.clone())
                .collect();
            let texts: Vec<&str> = prepared
                .iter()
                .map(|p| items[p.item].text.as_str())
                .collect();
            // 手工合并的输出名由命令层用输出路径覆盖；模板给自动模式用
            let name = match &opts.output_pattern {
                Some(pattern) if !pattern.is_empty() => render_template(
                    pattern,
                    &prepared
                        .first()
                        .map(|p| p.captures.clone())
                        .unwrap_or_default(),
                ),
                // 输出名会显示在合并结果报告里，是界面文案
                _ => ui_lang::t("合并结果"),
            };
            Ok(vec![MergedOutput {
                name,
                order,
                text: join_parts(&texts),
            }])
        }
        MergeStrategy::SameName => {
            let source = opts.source_pattern.as_deref().unwrap_or("");
            if source.is_empty() {
                return Err(AppError::Merge(
                    "同名段拼接需要「源文件名正则」（含捕获组，如 (\\d+)_(\\d+)\\.txt）".into(),
                ));
            }
            let output = opts
                .output_pattern
                .as_deref()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| {
                    AppError::Merge("同名段拼接需要「输出文件名模板」（如 \\1.txt）".into())
                })?;
            // 未命中源正则的文件无从分组：点名报错（调用方负责跳过它们）
            let unmatched: Vec<&str> = prepared
                .iter()
                .filter(|p| p.captures.is_empty())
                .map(|p| names[p.item])
                .collect();
            if !unmatched.is_empty() {
                return Err(AppError::Merge(format!(
                    "以下文件不匹配源正则，无法分组：{}",
                    unmatched.join("、")
                )));
            }
            // 按第 1 捕获组分文件（保持首次出现顺序）
            let mut groups: Vec<(String, Vec<Prepared>)> = Vec::new();
            for p in prepared.iter() {
                let group_key = p.captures.first().cloned().unwrap_or_default();
                let cloned = Prepared {
                    item: p.item,
                    captures: p.captures.clone(),
                    key: p.key.clone(),
                };
                match groups.iter_mut().find(|(k, _)| *k == group_key) {
                    Some((_, list)) => list.push(cloned),
                    None => groups.push((group_key, vec![cloned])),
                }
            }
            let mut out = Vec::with_capacity(groups.len());
            // 输出按组名自然排序，与用户在文件管理器里看到的顺序一致
            groups.sort_by(|a, b| natural_cmp(&a.0, &b.0));
            for (group_key, mut list) in groups {
                let tiebreak = opts.sort_key.as_deref().is_some_and(|k| !k.is_empty());
                sort_by_key(&mut list, &names, tiebreak);
                let order: Vec<String> = list.iter().map(|p| items[p.item].name.clone()).collect();
                let texts: Vec<&str> = list.iter().map(|p| items[p.item].text.as_str()).collect();
                out.push(MergedOutput {
                    name: render_template(output, &[group_key]),
                    order,
                    text: join_parts(&texts),
                });
            }
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str, text: &str) -> MergeItem {
        MergeItem {
            name: name.to_owned(),
            text: text.to_owned(),
        }
    }

    fn auto_opts() -> MergePlanOptions {
        MergePlanOptions {
            strategy: MergeStrategy::SameName,
            source_pattern: Some(r"(\d+)_(\d+)\.txt".into()),
            output_pattern: Some(r"\1.txt".into()),
            sort_key: Some(r"\2".into()),
        }
    }

    #[test]
    fn simple_concat_inserts_blank_line() {
        let items = [item("a.txt", "甲\n\n"), item("b.txt", "乙")];
        let opts = MergePlanOptions::default();
        let out = plan_merge(&items, &opts).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "甲\n\n乙\n");
        assert_eq!(out[0].order, vec!["a.txt", "b.txt"]);
    }

    #[test]
    fn empty_inputs_produce_empty_output() {
        let out = plan_merge(&[], &MergePlanOptions::default()).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "");
        assert!(out[0].order.is_empty());
    }

    #[test]
    fn natural_sort_orders_numbers_numerically() {
        // 2 < 9 < 10：字符串序会把 10 排在 2 之前
        let items = [
            item("2_10.txt", "二十一"),
            item("1_10.txt", "一零"),
            item("1_9.txt", "一九"),
            item("1_2.txt", "一二"),
        ];
        let mut opts = auto_opts();
        opts.strategy = MergeStrategy::Simple;
        let out = plan_merge(&items, &opts).unwrap();
        assert_eq!(
            out[0].order,
            vec!["1_2.txt", "1_9.txt", "1_10.txt", "2_10.txt"]
        );
    }

    #[test]
    fn same_name_groups_by_first_capture() {
        let items = [
            item("2_10.txt", "二十一"),
            item("1_2.txt", "一二"),
            item("1_10.txt", "一十"),
            item("1_9.txt", "一九"),
        ];
        let out = plan_merge(&items, &auto_opts()).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "1.txt");
        assert_eq!(out[0].order, vec!["1_2.txt", "1_9.txt", "1_10.txt"]);
        assert_eq!(out[0].text, "一二\n\n一九\n\n一十\n");
        assert_eq!(out[1].name, "2.txt");
        assert_eq!(out[1].order, vec!["2_10.txt"]);
    }

    #[test]
    fn same_name_requires_source_pattern_and_output_template() {
        let items = [item("a.txt", "甲")];
        let mut opts = auto_opts();
        opts.source_pattern = None;
        assert!(plan_merge(&items, &opts).is_err());
        opts = auto_opts();
        opts.output_pattern = None;
        assert!(plan_merge(&items, &opts).is_err());
    }

    #[test]
    fn same_name_reports_unmatched_files() {
        let items = [item("1_2.txt", "甲"), item("随便.txt", "乙")];
        let err = plan_merge(&items, &auto_opts()).unwrap_err().to_string();
        assert!(err.contains("随便.txt"), "错误信息应点名未命中文件：{err}");
    }

    #[test]
    fn manual_sort_key_regex_applies_to_filename() {
        // 无源正则时，排序关键字是对文件名求值的正则（第 1 捕获组）
        let items = [
            item("序-12-甲.txt", "甲"),
            item("序-9-乙.txt", "乙"),
            item("序-100-丙.txt", "丙"),
        ];
        let opts = MergePlanOptions {
            strategy: MergeStrategy::Simple,
            sort_key: Some(r"序-(\d+)-".into()),
            ..MergePlanOptions::default()
        };
        let out = plan_merge(&items, &opts).unwrap();
        assert_eq!(
            out[0].order,
            vec!["序-9-乙.txt", "序-12-甲.txt", "序-100-丙.txt"]
        );
    }

    #[test]
    fn no_sort_key_keeps_input_order() {
        let items = [item("b.txt", "乙"), item("a.txt", "甲")];
        let out = plan_merge(&items, &MergePlanOptions::default()).unwrap();
        assert_eq!(out[0].order, vec!["b.txt", "a.txt"]);
    }

    #[test]
    fn template_renders_captures() {
        let captures = vec!["1".to_owned(), "2".to_owned()];
        assert_eq!(render_template(r"\1.txt", &captures), "1.txt");
        assert_eq!(render_template(r"第\2章-\1", &captures), "第2章-1");
        assert_eq!(render_template(r"\9", &captures), ""); // 越界 → 空串
        assert_eq!(render_template("无引用", &captures), "无引用");
    }

    #[test]
    fn natural_cmp_basics() {
        use std::cmp::Ordering;
        assert_eq!(natural_cmp("9", "10"), Ordering::Less);
        assert_eq!(natural_cmp("a2", "a10"), Ordering::Less);
        assert_eq!(
            natural_cmp("1a", "1b"),
            Ordering::Less,
            "数字段后的字符仍参与比较"
        );
        assert_eq!(
            natural_cmp("1_2", "1_10"),
            Ordering::Less,
            "数字段后的分隔符不能被吞掉"
        );
        assert_eq!(natural_cmp("甲1", "甲1"), Ordering::Equal);
        assert_eq!(natural_cmp("007", "7"), Ordering::Greater); // 数值同，前导零多者排后
        assert_eq!(
            natural_cmp("乙", "甲"),
            Ordering::Less,
            "非数字段按码点序（乙 U+4E59 < 甲 U+7532）"
        );
    }

    #[test]
    fn merges_ten_thousand_files() {
        // 路线图 §7.2「1 万文件合并」：纯规划器直测，无需落盘
        let items: Vec<MergeItem> = (0..10_000)
            .map(|i| item(&format!("1_{i}.txt"), "甲"))
            .collect();
        let mut opts = auto_opts();
        opts.sort_key = Some(r"\2".into());
        let out = plan_merge(&items, &opts).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "1.txt");
        assert_eq!(out[0].order.first().unwrap(), "1_0.txt");
        assert_eq!(out[0].order.last().unwrap(), "1_9999.txt");
        assert_eq!(out[0].order.len(), 10_000);
    }
}
