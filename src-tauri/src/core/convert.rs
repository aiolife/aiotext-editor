//! 简繁转换链（F-03 §3.2）
//!
//! ```text
//! [输入文本] → [括号对豁免分段] → [OpenCC + 用户内联词典] → [变更统计 + 歧义诊断]
//! ```
//!
//! - **括号对豁免**：把成对括号内的片段切出来不参与转换（只对可转换段调用引擎，
//!   无需占位符），支持嵌套与左右相同的引号对；未闭合的括号保护到文本末尾。
//! - **用户词典叠加**：`apply_user_tables` 指定的 F-04 表文件（`tables/<name>.tab`）
//!   被编译为 OpenCC 内联字典，优先级高于标准词库。
//! - **歧义诊断**：C API 不暴露 OpenCC 内部 Segments（CLI `--ambiguities` 用的私有
//!   接口），故本实现采用**同族方向差分**——同一段文本在 s2t / s2tw / s2twp / s2hk
//!   等标准下用字不同的区段即视为歧义片段，`candidates` 为各族结果，`primary` 为
//!   当前方向结果。这是自研诊断，语义与 CLI 的"一对多提示"一致（用户可据此决定
//!   是否改用其他地区标准）。

use serde::{Deserialize, Serialize};

use crate::core::opencc::{self, Direction};
use crate::error::AppResult;

/// 括号对（F-03 §3.3 `BracketPair`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BracketPair {
    pub open: char,
    pub close: char,
}

/// 转换请求（F-03 §3.3 `ConvertRequest`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    pub text: String,
    pub direction: Direction,
    /// 括号对豁免（TextPro 风格）：范围内的字符不参与转换
    #[serde(default)]
    pub skip_inside: Vec<BracketPair>,
    /// 叠加的用户自定义表名（F-04，`tables/<name>.tab`）
    #[serde(default)]
    pub apply_user_tables: Vec<String>,
    /// 是否返回歧义片段诊断
    #[serde(default)]
    pub diagnostics: bool,
}

/// 歧义片段（F-03 §3.3 `AmbiguitySpan`；索引为**结果文本**的码点位置）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbiguitySpan {
    pub start: usize,
    pub end: usize,
    pub candidates: Vec<String>,
    pub primary: String,
}

/// 转换结果（F-03 §3.3 `ConvertReport`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertReport {
    pub text: String,
    /// 变更字符数（码点口径）
    pub changed_count: usize,
    pub ambiguities: Vec<AmbiguitySpan>,
    /// 实际叠加的用户表
    pub applied_tables: Vec<String>,
    pub direction_label: String,
}

/// 预览中的一行差异
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// 原文行号（1 起）
    pub line_number: usize,
    pub old: String,
    pub new: String,
    /// 行内差异区间（码点下标，左闭右开）
    pub old_range: Option<(usize, usize)>,
    pub new_range: Option<(usize, usize)>,
}

/// 转换预览（F-03 §3.4 `preview_convert`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertPreview {
    /// 转换后全文（前端确认后直接应用，无需二次转换）
    pub text: String,
    pub changed_count: usize,
    /// 有差异的行总数
    pub changed_lines: usize,
    pub total_lines: usize,
    /// 前 N 个差异行
    pub lines: Vec<DiffLine>,
    /// 是否因行数上限截断
    pub truncated: bool,
    pub direction_label: String,
    pub ambiguities: Vec<AmbiguitySpan>,
}

/// 预览默认行数上限（F-03 §3.2：转换前预览 Diff 首屏 200 行）
pub const PREVIEW_LINE_LIMIT: usize = 200;

// ---------------------------------------------------------------------------
// 用户自定义表（F-04：解析与文件访问见 core::replace）
// ---------------------------------------------------------------------------

/// 载入指定用户表并摊平为 OpenCC 内联词典条目
///
/// （F-04 模式 B：`apply_user_tables` 中的表名按顺序叠加，先出现者优先）
fn load_user_tables(names: &[String]) -> AppResult<Vec<(String, String)>> {
    crate::core::replace::load_entries_by_names(names)
}

// ---------------------------------------------------------------------------
// 括号对豁免分段
// ---------------------------------------------------------------------------

/// 分段结果：`true` = 参与转换，`false` = 豁免保护
#[derive(Debug, PartialEq, Eq)]
struct Segment<'a> {
    convert: bool,
    text: &'a str,
}

/// 按括号对把文本切成「可转换 / 豁免」交替片段
///
/// 采用栈处理嵌套；左右相同的字符（如 `"`、`「」` 之外的 `“”`）在栈空时视为开、
/// 非空时视为闭；未闭合的括号保护到文本末尾。
fn split_segments<'a>(text: &'a str, pairs: &[BracketPair]) -> Vec<Segment<'a>> {
    if pairs.is_empty() {
        return vec![Segment {
            convert: true,
            text,
        }];
    }
    // 开括号 → 闭括号查找表
    let mut segments = Vec::new();
    let mut stack: Vec<char> = Vec::new(); // 期待的闭括号
    let mut cursor = 0usize;
    let mut current_is_convert = true;

    for (idx, ch) in text.char_indices() {
        if current_is_convert {
            if let Some(pair) = pairs.iter().find(|p| p.open == ch) {
                if idx > cursor {
                    segments.push(Segment {
                        convert: true,
                        text: &text[cursor..idx],
                    });
                }
                cursor = idx;
                stack.push(pair.close);
                current_is_convert = false;
            }
        } else {
            let expected = *stack.last().expect("非转换态必有待闭合括号");
            let is_close = expected == ch
                || (stack.len() == 1 && pairs.iter().any(|p| p.open == p.close && p.close == ch));
            if is_close {
                stack.pop();
                if stack.is_empty() {
                    // 闭合括号属于豁免段
                    segments.push(Segment {
                        convert: false,
                        text: &text[cursor..idx + ch.len_utf8()],
                    });
                    cursor = idx + ch.len_utf8();
                    current_is_convert = true;
                }
            } else if let Some(pair) = pairs.iter().find(|p| p.open == ch) {
                stack.push(pair.close); // 嵌套
            }
        }
    }
    if cursor < text.len() {
        segments.push(Segment {
            convert: current_is_convert,
            text: &text[cursor..],
        });
    }
    if segments.is_empty() {
        segments.push(Segment {
            convert: true,
            text,
        });
    }
    segments
}

/// 按分段渲染：可转换段走引擎，豁免段原样保留
fn render_segments<F>(segments: &[Segment<'_>], mut convert_fn: F) -> AppResult<String>
where
    F: FnMut(&str) -> AppResult<String>,
{
    let mut out = String::new();
    for segment in segments {
        if segment.convert {
            out.push_str(&convert_fn(segment.text)?);
        } else {
            out.push_str(segment.text);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 差异工具
// ---------------------------------------------------------------------------

/// 剥去公共前缀与后缀，返回（前缀码点数, a 中段, b 中段）
fn common_affix(a: &str, b: &str) -> (usize, String, String) {
    let av: Vec<char> = a.chars().collect();
    let bv: Vec<char> = b.chars().collect();
    let mut prefix = 0;
    while prefix < av.len() && prefix < bv.len() && av[prefix] == bv[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < av.len() - prefix
        && suffix < bv.len() - prefix
        && av[av.len() - 1 - suffix] == bv[bv.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let a_mid: String = av[prefix..av.len() - suffix].iter().collect();
    let b_mid: String = bv[prefix..bv.len() - suffix].iter().collect();
    (prefix, a_mid, b_mid)
}

/// 变更字符数（码点口径）
///
/// 长度相同 → 逐位比较计数（简繁转换多为一一对应，结果准确）；
/// 长度不同 → 剥去公共前后缀后取中段较大长度（保守，偏大）。
pub fn count_changes(original: &str, converted: &str) -> usize {
    if original == converted {
        return 0;
    }
    let av: Vec<char> = original.chars().collect();
    let bv: Vec<char> = converted.chars().collect();
    if av.len() == bv.len() {
        return av.iter().zip(bv.iter()).filter(|(x, y)| x != y).count();
    }
    let (_, a_mid, b_mid) = common_affix(original, converted);
    a_mid.chars().count().max(b_mid.chars().count())
}

// ---------------------------------------------------------------------------
// 转换入口
// ---------------------------------------------------------------------------

/// 转换核心：分段 → 引擎（含用户词典）→ 统计（+ 诊断）
pub fn convert(req: &ConvertRequest) -> AppResult<ConvertReport> {
    let entries = load_user_tables(&req.apply_user_tables)?;
    let mut applied_tables = Vec::new();
    if !entries.is_empty() {
        applied_tables = req.apply_user_tables.clone();
    }

    // F-03 §3.7：极短文本（< 4 字节，按 UTF-8 计）不走引擎
    if req.text.len() < 4 {
        return Ok(ConvertReport {
            text: req.text.clone(),
            changed_count: 0,
            ambiguities: Vec::new(),
            applied_tables,
            direction_label: req.direction.label().to_owned(),
        });
    }

    let segments = split_segments(&req.text, &req.skip_inside);
    let text = render_segments(&segments, |chunk| {
        opencc::convert_with_inline_dicts(&req.direction, &entries, chunk)
    })?;
    let changed_count = count_changes(&req.text, &text);

    let ambiguities = if req.diagnostics {
        diagnose(&segments, &req.direction, &text, &entries)?
    } else {
        Vec::new()
    };

    Ok(ConvertReport {
        text,
        changed_count,
        ambiguities,
        applied_tables,
        direction_label: req.direction.label().to_owned(),
    })
}

/// 歧义诊断：同族方向差分
fn diagnose(
    segments: &[Segment<'_>],
    direction: &Direction,
    primary_text: &str,
    entries: &[(String, String)],
) -> AppResult<Vec<AmbiguitySpan>> {
    let mut spans: Vec<AmbiguitySpan> = Vec::new();
    for alt in direction.family() {
        if &alt == direction {
            continue;
        }
        // 自定义方向（无内嵌配置）跳过
        if matches!(alt, Direction::Custom(_)) {
            continue;
        }
        let alt_text = match render_segments(segments, |chunk| {
            opencc::convert_with_inline_dicts(&alt, entries, chunk)
        }) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(direction = %alt.id(), error = %e, "歧义诊断方向跳过");
                continue;
            }
        };
        collect_spans(primary_text, &alt_text, &mut spans);
    }
    // 同一区间的多候选合并
    spans.sort_by_key(|s| (s.start, s.end));
    let mut merged: Vec<AmbiguitySpan> = Vec::new();
    for span in spans {
        if let Some(last) = merged.last_mut() {
            if last.start == span.start && last.end == span.end {
                if !last.candidates.contains(&span.candidates[0]) {
                    last.candidates.extend(span.candidates);
                }
                continue;
            }
        }
        merged.push(span);
    }
    Ok(merged)
}

/// 逐行差分：把 `alt` 相对 `primary` 的差异区段收集为歧义片段
fn collect_spans(primary: &str, alt: &str, out: &mut Vec<AmbiguitySpan>) {
    let p_lines: Vec<&str> = primary.split('\n').collect();
    let a_lines: Vec<&str> = alt.split('\n').collect();
    if p_lines.len() != a_lines.len() {
        return; // 结构变化（理论上不会发生）时不猜
    }
    let mut offset = 0usize; // primary 中的码点偏移
    for (p_line, a_line) in p_lines.iter().zip(a_lines.iter()) {
        if p_line != a_line {
            let (prefix, p_mid, a_mid) = common_affix(p_line, a_line);
            if !p_mid.is_empty() {
                let start = offset + prefix;
                let end = start + p_mid.chars().count();
                out.push(AmbiguitySpan {
                    start,
                    end,
                    candidates: vec![a_mid],
                    primary: p_mid,
                });
            }
        }
        offset += p_line.chars().count() + 1;
    }
}

/// 转换预览：产出前 `limit` 个差异行（F-03 §3.4 `preview_convert`）
pub fn preview(req: &ConvertRequest, limit: usize) -> AppResult<ConvertPreview> {
    let report = convert(req)?;
    let old_lines: Vec<&str> = req.text.split('\n').collect();
    let new_lines: Vec<&str> = report.text.split('\n').collect();
    let mut lines = Vec::new();
    let mut changed_lines = 0usize;

    for (idx, (old, new)) in old_lines.iter().zip(new_lines.iter()).enumerate() {
        if old == new {
            continue;
        }
        changed_lines += 1;
        if lines.len() >= limit {
            continue; // 继续计数，但不再收集
        }
        let (prefix, old_mid, new_mid) = common_affix(old, new);
        let old_len = old.chars().count();
        let new_len = new.chars().count();
        lines.push(DiffLine {
            line_number: idx + 1,
            old: (*old).to_owned(),
            new: (*new).to_owned(),
            old_range: (!(old_mid.is_empty() && new_mid.is_empty())).then_some((
                prefix,
                if new_mid.is_empty() {
                    old_len
                } else {
                    prefix + old_mid.chars().count()
                },
            )),
            new_range: (!(old_mid.is_empty() && new_mid.is_empty())).then_some((
                prefix,
                if old_mid.is_empty() {
                    new_len
                } else {
                    prefix + new_mid.chars().count()
                },
            )),
        });
    }

    Ok(ConvertPreview {
        text: report.text,
        changed_count: report.changed_count,
        changed_lines,
        total_lines: old_lines.len(),
        truncated: changed_lines > lines.len(),
        lines,
        direction_label: report.direction_label,
        ambiguities: report.ambiguities,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::opencc::Direction;

    fn req(text: &str, direction: Direction) -> ConvertRequest {
        ConvertRequest {
            text: text.to_owned(),
            direction,
            skip_inside: Vec::new(),
            apply_user_tables: Vec::new(),
            diagnostics: false,
        }
    }

    fn pair(spec: &str) -> BracketPair {
        let mut chars = spec.chars();
        BracketPair {
            open: chars.next().unwrap(),
            close: chars.next().unwrap(),
        }
    }

    #[test]
    fn convert_basic_s2t() {
        let report = convert(&req("头发发展", Direction::S2T)).unwrap();
        assert_eq!(report.text, "頭髮發展");
        // 头→頭、发→髮、发→發 三处不同（展 简繁同形）
        assert_eq!(report.changed_count, 3);
        assert!(report.ambiguities.is_empty()); // 未开启诊断
    }

    #[test]
    fn convert_very_short_text_skips_engine() {
        // F-03 §3.7：< 4 字节不转换
        let report = convert(&req("a", Direction::S2T)).unwrap();
        assert_eq!(report.text, "a");
        assert_eq!(report.changed_count, 0);
    }

    #[test]
    fn bracket_skip_protects_regions() {
        let mut request = req("下面 [] 里的字 头发 不转", Direction::S2T);
        request.skip_inside = vec![pair("[]")];
        let report = convert(&request).unwrap();
        assert!(
            report.text.contains("[]"),
            "括号内容应完整保留：{}",
            report.text
        );
        assert!(
            report.text.contains("頭髮"),
            "括号外应转换：{}",
            report.text
        );
    }

    #[test]
    fn bracket_skip_handles_nesting_and_unclosed() {
        let mut request = req("a (b [c] d) e", Direction::S2T);
        request.skip_inside = vec![pair("()"), pair("[]")];
        let report = convert(&request).unwrap();
        assert_eq!(report.text, "a (b [c] d) e");

        // 未闭合 → 保护到末尾
        let mut unclosed = req("abc (未闭合 头发", Direction::S2T);
        unclosed.skip_inside = vec![pair("()")];
        let out = convert(&unclosed).unwrap();
        assert!(
            out.text.ends_with("头发"),
            "未闭合括号保护到末尾：{}",
            out.text
        );
    }

    #[test]
    fn bracket_skip_with_quote_pairs() {
        let mut request = req("他说“头发”很好", Direction::S2T);
        request.skip_inside = vec![pair("“”")];
        let report = convert(&request).unwrap();
        assert!(
            report.text.contains("“头发”"),
            "引号内应豁免：{}",
            report.text
        );
        assert!(report.text.contains("很好"));
    }

    #[test]
    fn segments_split_is_lossless() {
        let text = "中文[不改]结尾(括号";
        let segments = split_segments(text, &[pair("[]"), pair("()")]);
        let joined: String = segments.iter().map(|s| s.text).collect();
        assert_eq!(joined, text, "分段必须无损拼接");
    }

    #[test]
    fn count_changes_variants() {
        assert_eq!(count_changes("abc", "abc"), 0);
        assert_eq!(count_changes("头发", "頭髮"), 2);
        // 测→測、试→試 两处（中文 简繁同形）
        assert_eq!(count_changes("中文测试", "中文測試"), 2);
        // 长度不同：剥公共前后缀
        assert!(count_changes("abc", "abcdef") >= 3);
    }

    #[test]
    fn preview_reports_diff_lines() {
        // 首尾两行用简繁同形字（保持/第/行），确保只有中间一行有差异
        let text = "第一行保持\n第二行 头发\n第三行保持";
        let preview = preview(&req(text, Direction::S2T), PREVIEW_LINE_LIMIT).unwrap();
        assert_eq!(preview.changed_lines, 1);
        assert_eq!(preview.total_lines, 3);
        assert!(!preview.truncated);
        let line = &preview.lines[0];
        assert_eq!(line.line_number, 2);
        assert_eq!(line.old, "第二行 头发");
        assert_eq!(line.new, "第二行 頭髮");
        assert!(line.old_range.is_some());
        assert_eq!(preview.text, "第一行保持\n第二行 頭髮\n第三行保持");
    }

    #[test]
    fn preview_truncates_beyond_limit() {
        let text = (0..5)
            .map(|i| format!("第{i}行 头发"))
            .collect::<Vec<_>>()
            .join("\n");
        let preview = preview(&req(&text, Direction::S2T), 2).unwrap();
        assert_eq!(preview.changed_lines, 5);
        assert_eq!(preview.lines.len(), 2);
        assert!(preview.truncated);
    }

    #[test]
    fn diagnose_finds_regional_differences() {
        // s2t 与 s2twp 在「鼠标」上不同（鼠标 → 鼠標 / 滑鼠）
        let mut request = req("屏幕上的鼠标", Direction::S2T);
        request.diagnostics = true;
        let report = convert(&request).unwrap();
        assert_eq!(report.text, "屏幕上的鼠標");
        assert!(!report.ambiguities.is_empty(), "应检出地区用字差异");
        let span = &report.ambiguities[0];
        assert!(span.end > span.start);
        assert!(!span.primary.is_empty());
        assert!(!span.candidates.is_empty());
        // 索引落在结果文本范围内
        assert!(span.end <= report.text.chars().count());
    }

    #[test]
    fn diagnose_disabled_by_default() {
        let request = req("屏幕上的鼠标", Direction::S2T);
        let report = convert(&request).unwrap();
        assert!(report.ambiguities.is_empty());
    }
}
