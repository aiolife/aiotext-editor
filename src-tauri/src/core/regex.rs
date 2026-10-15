//! 中文增强正则（F-05）
//!
//! 在 `regex` crate（HFA 引擎）之上做**编译前预转换**：把 TextPro 风格的
//! 中文类目写成的位置替换为等价的 Unicode 范围集合，再交给正则引擎。
//!
//! ```text
//! \c[GBK]      GBK 全部双字节字符（含简繁、符号；由 encoding_rs 精确枚举）
//! \c[BIG5]     BIG5 全部双字节字符（同上）
//! \c[数字]      中英文数字       \c[天干]  甲乙丙丁戊己庚辛壬癸
//! \c[地支]      十二地支         \c[大写金额] 零壹贰叁…整
//! \c[标点]      中英文标点       \c[汉字]   汉字（CJK 统一表意）
//! \a  ASCII 字母   \d 数字（同 \c[数字]）   \n 换行   \t 制表符
//! \xhhhhhh   1-6 位十六进制 Unicode     \\ 反斜杠
//! ```
//!
//! 位置口径：对外返回的偏移一律为 **UTF-16 码元**（前端 CodeMirror 6 的
//! 文档坐标），便于直接做高亮与替换定位。
//!
//! 已知限制：`regex` crate 不支持反向引用（`\1` 在**模式**中无效）；
//! 捕获组引用仅在**替换串**中支持（`\1` 与 `$1` 均可）。

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 搜索/替换选项（F-05 §5.3 `RegexOptions` 扩展）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegexOptions {
    /// 正则模式（false = 字面查找，仍受 `use_escape` 影响）
    #[serde(default = "default_true")]
    pub regex: bool,
    /// 忽略回车换行（匹配时跳过这些字符）
    #[serde(default)]
    pub ignore_newlines: bool,
    /// 忽略标点
    #[serde(default)]
    pub ignore_punct: bool,
    /// 忽略半角空格
    #[serde(default)]
    pub ignore_half_space: bool,
    /// 大小写不敏感
    #[serde(default)]
    pub case_insensitive: bool,
    /// 处理 `\n` `\t` `\x...` 转义
    #[serde(default = "default_true")]
    pub use_escape: bool,
}

fn default_true() -> bool {
    true
}

impl Default for RegexOptions {
    fn default() -> Self {
        Self {
            regex: true,
            ignore_newlines: false,
            ignore_punct: false,
            ignore_half_space: false,
            case_insensitive: false,
            use_escape: true,
        }
    }
}

/// 命中区间（偏移为 UTF-16 码元，前端可直接用于 CodeMirror 定位）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchSpan {
    pub start: usize,
    pub end: usize,
    pub text: String,
    /// 捕获组 1..n 的内容（未参与匹配的组为空串）
    #[serde(default)]
    pub groups: Vec<String>,
}

/// 替换结果（F-05 §5.4 `regex_replace`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegexReplaceReport {
    pub text: String,
    /// 实际替换次数
    pub count: usize,
    /// 被替换的区间（替换前坐标）
    pub spans: Vec<MatchSpan>,
    /// 每个区间的实际替换文本（与 `spans` 一一对应）
    ///
    /// 供 UI 做「只替换当前这一个」时精确改写编辑器（避免整篇替换丢光标）。
    pub replacements: Vec<String>,
}

/// 类目元数据（UI 下拉用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInfo {
    /// 写法，如 `\c[GBK]`
    pub token: String,
    pub label: String,
    /// 少量示例字符
    pub sample: String,
}

// ---------------------------------------------------------------------------
// 字符集（精确枚举 + 范围合并）
// ---------------------------------------------------------------------------

/// GBK 双字节字符集（缓存）
fn gbk_charset() -> &'static str {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE.get_or_init(|| {
        enumerate_two_byte(
            encoding_rs::GBK,
            &[(0x81, 0xFE)],
            &[(0x40, 0x7E), (0x80, 0xFE)],
        )
    })
}

/// BIG5 双字节字符集（缓存）
fn big5_charset() -> &'static str {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE.get_or_init(|| {
        enumerate_two_byte(
            encoding_rs::BIG5,
            &[(0x81, 0xFE)],
            &[(0x40, 0x7E), (0xA1, 0xFE)],
        )
    })
}

/// 枚举双字节编码的全部可解码字符，并合并为紧凑的正则字符类
fn enumerate_two_byte(
    encoding: &'static encoding_rs::Encoding,
    leads: &[(u8, u8)],
    trails: &[(u8, u8)],
) -> String {
    let mut chars: Vec<char> = Vec::new();
    for (lead_start, lead_end) in leads {
        for lead in *lead_start..=*lead_end {
            for (trail_start, trail_end) in trails {
                for trail in *trail_start..=*trail_end {
                    let bytes = [lead, trail];
                    let (decoded, had_errors) = encoding.decode_without_bom_handling(&bytes);
                    if had_errors {
                        continue;
                    }
                    let mut iter = decoded.chars();
                    if let (Some(ch), None) = (iter.next(), iter.next()) {
                        if ch != '\u{FFFD}' {
                            chars.push(ch);
                        }
                    }
                }
            }
        }
    }
    ranges_to_class(&mut chars)
}

/// 码点集合 → 正则字符类（连续区段合并）
fn ranges_to_class(chars: &mut Vec<char>) -> String {
    chars.sort_unstable();
    chars.dedup();
    let mut out = String::from("[");
    let mut index = 0usize;
    while index < chars.len() {
        let start = chars[index];
        let mut end = start;
        while index + 1 < chars.len() && chars[index + 1] as u32 == end as u32 + 1 {
            index += 1;
            end = chars[index];
        }
        if start == end {
            push_class_char(&mut out, start);
        } else if end as u32 == start as u32 + 1 {
            push_class_char(&mut out, start);
            push_class_char(&mut out, end);
        } else {
            out.push_str(&format!(
                "\\x{{{:X}}}-\\x{{{:X}}}",
                start as u32, end as u32
            ));
        }
        index += 1;
    }
    out.push(']');
    out
}

/// 字符类内的安全写法（转义会破坏类语法的字符）
fn push_class_char(out: &mut String, ch: char) {
    match ch {
        '\\' | ']' | '[' | '^' | '-' => {
            out.push('\\');
            out.push(ch);
        }
        _ => out.push(ch),
    }
}

/// 根据类目名取字符类表达式
fn class_for(name: &str) -> Option<String> {
    let upper = name.trim().to_ascii_uppercase();
    let class = match upper.as_str() {
        "GBK" | "汉字" | "HAN" => gbk_charset().to_owned(),
        "BIG5" => big5_charset().to_owned(),
        "数字" | "DIGIT" => "[0-9０-９〇零一二三四五六七八九十百千万亿]".to_owned(),
        "天干" => "[甲乙丙丁戊己庚辛壬癸]".to_owned(),
        "地支" => "[子丑寅卯辰巳午未申酉戌亥]".to_owned(),
        "大写金额" => "[零壹贰叁肆伍陆柒捌玖拾佰仟万亿元角分整貳參陸圓億萬]".to_owned(),
        "标点" => concat!(
            "[!-/:-@\\[-`{-~",
            "\\x{2000}-\\x{206F}\\x{3000}-\\x{303F}\\x{FF00}-\\x{FFEF}]"
        )
        .to_owned(),
        "字母" | "ALPHA" => "[A-Za-zａ-ｚＡ-Ｚ]".to_owned(),
        "空白" | "SPACE" => "[\\s\\x{3000}]".to_owned(),
        _ => return None,
    };
    Some(class)
}

/// 可用类目列表（UI 下拉数据源）
pub fn categories() -> Vec<CategoryInfo> {
    let spec = [
        ("\\c[GBK]", "GBK 全部字符（含简繁、符号）", "汉Ａ①"),
        ("\\c[BIG5]", "BIG5 全部字符", "漢ㄅ①"),
        ("\\c[数字]", "中英文数字", "123０１２三"),
        ("\\c[天干]", "十天干", "甲乙丙丁"),
        ("\\c[地支]", "十二地支", "子丑寅卯"),
        ("\\c[大写金额]", "大写金额用字", "壹贰叁肆"),
        ("\\c[标点]", "中英文标点", "，。！？「」"),
        ("\\c[汉字]", "汉字（CJK 统一表意，同 GBK 集合）", "汉字测试"),
        ("\\c[字母]", "全半角字母", "aAａＡ"),
        ("\\a", "ASCII 字母", "abcXYZ"),
        ("\\d", "数字（同 \\c[数字]）", "0-9"),
        ("\\xhhhhhh", "1-6 位十六进制 Unicode", "\\x4E00"),
    ];
    spec.iter()
        .map(|(token, label, sample)| CategoryInfo {
            token: (*token).to_owned(),
            label: (*label).to_owned(),
            sample: (*sample).to_owned(),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 预转换
// ---------------------------------------------------------------------------

/// 把中文类目写法替换为等价正则片段（F-05 §5.5）
pub fn extend(pattern: &str) -> AppResult<String> {
    let mut out = String::with_capacity(pattern.len() + 32);
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        if ch != '\\' {
            out.push(ch);
            index += 1;
            continue;
        }
        let Some(next) = chars.get(index + 1).copied() else {
            out.push('\\');
            break;
        };
        match next {
            'c' => {
                // \c[类目]
                if chars.get(index + 2) != Some(&'[') {
                    return Err(AppError::Regex("`\\c` 后缺少 `[类目]`".into()));
                }
                let mut end = index + 3;
                while end < chars.len() && chars[end] != ']' {
                    end += 1;
                }
                if end >= chars.len() {
                    return Err(AppError::Regex("类目缺少右括号 `]`".into()));
                }
                let name: String = chars[index + 3..end].iter().collect();
                let class = class_for(&name)
                    .ok_or_else(|| AppError::Regex(format!("未知中文类目：{name}")))?;
                out.push_str(&class);
                index = end + 1;
            }
            'a' => {
                out.push_str("[A-Za-z]");
                index += 2;
            }
            'd' => {
                out.push_str(&class_for("数字").expect("内置类目"));
                index += 2;
            }
            'n' => {
                out.push_str("\\n");
                index += 2;
            }
            't' => {
                out.push_str("\\t");
                index += 2;
            }
            'x' => {
                let mut end = index + 2;
                let mut hex = String::new();
                while end < chars.len() && hex.len() < 6 && chars[end].is_ascii_hexdigit() {
                    hex.push(chars[end]);
                    end += 1;
                }
                if hex.is_empty() {
                    return Err(AppError::Regex("`\\x` 后缺少十六进制码位".into()));
                }
                let code =
                    u32::from_str_radix(&hex, 16).map_err(|e| AppError::Regex(format!("{e}")))?;
                char::from_u32(code)
                    .ok_or_else(|| AppError::Regex(format!("无效码位：U+{code:X}")))?;
                // ASCII 字母数字可直接写；其余（含标点、需转义的字符）统一用 \x{...}
                if code < 0x80 && (code as u8 as char).is_ascii_alphanumeric() {
                    out.push(code as u8 as char);
                } else {
                    out.push_str(&format!("\\x{{{code:X}}}"));
                }
                index = end;
            }
            '\\' => {
                out.push_str("\\\\");
                index += 2;
            }
            _ => {
                // 其它转义原样交给正则引擎（\w \s \1 \. 等）
                out.push('\\');
                out.push(next);
                index += 2;
            }
        }
    }
    Ok(out)
}

/// 字面查找：还原转义后整体转义为正则
fn literal_pattern(pattern: &str, opts: &RegexOptions) -> AppResult<String> {
    let unescaped = if opts.use_escape {
        unescape_literal(pattern)?
    } else {
        pattern.to_owned()
    };
    Ok(::regex::escape(&unescaped))
}

/// 还原 `\n` `\t` `\r` `\\` `\x...`（字面查找用）
fn unescape_literal(pattern: &str) -> AppResult<String> {
    let mut out = String::with_capacity(pattern.len());
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        if ch != '\\' {
            out.push(ch);
            index += 1;
            continue;
        }
        let Some(next) = chars.get(index + 1).copied() else {
            out.push('\\');
            break;
        };
        match next {
            'n' => {
                out.push('\n');
                index += 2;
            }
            't' => {
                out.push('\t');
                index += 2;
            }
            'r' => {
                out.push('\r');
                index += 2;
            }
            '\\' => {
                out.push('\\');
                index += 2;
            }
            'x' => {
                let mut end = index + 2;
                let mut hex = String::new();
                while end < chars.len() && hex.len() < 6 && chars[end].is_ascii_hexdigit() {
                    hex.push(chars[end]);
                    end += 1;
                }
                if hex.is_empty() {
                    return Err(AppError::Regex("`\\x` 后缺少十六进制码位".into()));
                }
                let code =
                    u32::from_str_radix(&hex, 16).map_err(|e| AppError::Regex(e.to_string()))?;
                let decoded = char::from_u32(code)
                    .ok_or_else(|| AppError::Regex(format!("无效码位：U+{code:X}")))?;
                out.push(decoded);
                index = end;
            }
            other => {
                out.push('\\');
                out.push(other);
                index += 2;
            }
        }
    }
    Ok(out)
}

/// 编译为正则（含类目预转换与字面模式）
pub fn compile(pattern: &str, opts: &RegexOptions) -> AppResult<::regex::Regex> {
    let source = if opts.regex {
        extend(pattern)?
    } else {
        literal_pattern(pattern, opts)?
    };
    ::regex::RegexBuilder::new(&source)
        .case_insensitive(opts.case_insensitive)
        .size_limit(64 << 20)
        .build()
        .map_err(|e| AppError::Regex(format!("{e}")))
}

// ---------------------------------------------------------------------------
// 忽略开关（把被忽略字符从匹配空间中摘除，再映射回原坐标）
// ---------------------------------------------------------------------------

/// 是否应被忽略（F-05 §5.2 三个开关）
fn is_ignored(ch: char, opts: &RegexOptions) -> bool {
    if opts.ignore_newlines && (ch == '\n' || ch == '\r') {
        return true;
    }
    if opts.ignore_half_space && ch == ' ' {
        return true;
    }
    if opts.ignore_punct && is_punct(ch) {
        return true;
    }
    false
}

/// 标点判定（ASCII 标点 + 通用/CJK/全角标点区）
fn is_punct(ch: char) -> bool {
    if ch.is_ascii() {
        return ch.is_ascii_punctuation();
    }
    matches!(ch as u32,
        0x2000..=0x206F | 0x3000..=0x303F | 0xFF00..=0xFFEF)
}

/// 过滤后的文本 + 命中边界 → 原文偏移的映射
///
/// 忽略开关的实现方式是「把被忽略字符从匹配空间中摘除」，故命中边界必须映射
/// 回原文；且**起点与终点规则不同**：
/// - 起点 → 该处字符在原文中的起始偏移（其前的被忽略字符计入命中）
/// - 终点 → 前一个参与匹配字符在原文中的结束偏移（其后的被忽略字符不计入）
///
/// 否则在 `关 键 词 ` 中命中 `关键词`、或在 `词 出现` 中命中 `词`，都会把尾随
/// 空格一并吞掉（真实 UI 端到端回归时发现并修正）。
struct Filtered {
    text: String,
    /// `(过滤文本字节偏移, 原文起始字节, 原文结束字节)`，按过滤偏移升序
    chars: Vec<(usize, usize, usize)>,
}

impl Filtered {
    fn build(text: &str, opts: &RegexOptions) -> Self {
        let mut filtered = String::with_capacity(text.len());
        let mut chars = Vec::new();
        for (offset, ch) in text.char_indices() {
            if is_ignored(ch, opts) {
                continue;
            }
            chars.push((filtered.len(), offset, offset + ch.len_utf8()));
            filtered.push(ch);
        }
        Self {
            text: filtered,
            chars,
        }
    }

    /// 命中起点：过滤偏移 → 原文偏移
    fn start(&self, filtered_byte: usize) -> usize {
        match self.chars.binary_search_by_key(&filtered_byte, |c| c.0) {
            Ok(index) => self.chars[index].1,
            Err(index) => self
                .chars
                .get(index)
                .map(|c| c.1)
                .unwrap_or_else(|| self.chars.last().map(|c| c.2).unwrap_or(0)),
        }
    }

    /// 命中终点：过滤偏移 → 原文偏移（前一个命中字符的末尾）
    fn end(&self, filtered_byte: usize) -> usize {
        let index = self.chars.partition_point(|c| c.0 < filtered_byte);
        match index.checked_sub(1) {
            Some(prev) => self.chars[prev].2,
            None => self.chars.first().map(|c| c.1).unwrap_or(0),
        }
    }
}

/// 原文中 `[..byte]` 的 UTF-16 码元长度
fn utf16_offset(text: &str, byte: usize) -> usize {
    text[..byte].chars().map(char::len_utf16).sum()
}

// ---------------------------------------------------------------------------
// 查找 / 替换
// ---------------------------------------------------------------------------

/// 查找全部命中（F-05 §5.4 `regex_find`）
pub fn find(text: &str, pattern: &str, opts: &RegexOptions) -> AppResult<Vec<MatchSpan>> {
    let re = compile(pattern, opts)?;
    let filtered = Filtered::build(text, opts);
    let mut spans = Vec::new();
    for caps in re.captures_iter(&filtered.text) {
        let whole = caps.get(0).expect("captures_iter 必含整体匹配");
        let start = filtered.start(whole.start());
        let end = filtered.end(whole.end()).max(start);
        spans.push(MatchSpan {
            start: utf16_offset(text, start),
            end: utf16_offset(text, end),
            text: text[start..end].to_owned(),
            // 捕获组按「过滤后文本」的切片返回（被忽略字符不在其中）
            groups: (1..caps.len())
                .map(|i| {
                    caps.get(i)
                        .map(|m| m.as_str().to_owned())
                        .unwrap_or_default()
                })
                .collect(),
        });
    }
    Ok(spans)
}

/// 替换（F-05 §5.4 `regex_replace`）
///
/// `skip` 为跳过的命中个数（用于「替换当前这一个」），`limit` 为 None 表示
/// 从第 `skip` 个起全部替换。
pub fn replace(
    text: &str,
    pattern: &str,
    replacement: &str,
    opts: &RegexOptions,
    skip: usize,
    limit: Option<usize>,
) -> AppResult<RegexReplaceReport> {
    let expanded = expand_replacement(replacement, opts.use_escape);
    replace_generic(text, pattern, opts, skip, limit, |caps, _matched| {
        let mut rendered = String::new();
        caps.expand(&expanded, &mut rendered);
        Ok(rendered)
    })
}

/// 对每个命中套用一个整理工具（F-09 §6.2：查找替换面板的「使用工具」）
///
/// 命中区间先交给 [`crate::core::pipelines::run_step`] 处理，再用结果改写原文；
/// 命中之外的文本（含被忽略的字符）保持原样，因此可以「只改命中的内容」。
pub fn replace_with_tool(
    text: &str,
    pattern: &str,
    opts: &RegexOptions,
    step: &crate::core::pipelines::PipelineStep,
    skip: usize,
    limit: Option<usize>,
) -> AppResult<RegexReplaceReport> {
    replace_generic(text, pattern, opts, skip, limit, |_caps, matched| {
        Ok(crate::core::pipelines::run_step(matched, step)?.text)
    })
}

/// 替换的公共实现：每处命中替换成什么由 `render` 决定
fn replace_generic<F>(
    text: &str,
    pattern: &str,
    opts: &RegexOptions,
    skip: usize,
    limit: Option<usize>,
    mut render: F,
) -> AppResult<RegexReplaceReport>
where
    F: FnMut(&::regex::Captures<'_>, &str) -> AppResult<String>,
{
    let re = compile(pattern, opts)?;
    let filtered = Filtered::build(text, opts);

    let mut spans: Vec<MatchSpan> = Vec::new();
    let mut replacements: Vec<String> = Vec::new();
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let mut seen: usize = 0;
    for caps in re.captures_iter(&filtered.text) {
        if seen < skip {
            seen += 1;
            continue;
        }
        seen += 1;
        if let Some(max) = limit {
            if edits.len() >= max {
                break;
            }
        }
        let whole = caps.get(0).expect("captures_iter 必含整体匹配");
        let start = filtered.start(whole.start());
        let end = filtered.end(whole.end()).max(start);
        // 命中文本依原文区间截取（被忽略字符也在其中，交由工具自行处理）
        let rendered = render(&caps, &text[start..end])?;
        replacements.push(rendered.clone());
        edits.push((start, end, rendered));
        spans.push(MatchSpan {
            start: utf16_offset(text, start),
            end: utf16_offset(text, end),
            text: text[start..end].to_owned(),
            groups: (1..caps.len())
                .map(|i| {
                    caps.get(i)
                        .map(|m| m.as_str().to_owned())
                        .unwrap_or_default()
                })
                .collect(),
        });
    }

    // 自后向前落盘，避免偏移失效
    let mut out = text.to_owned();
    for (start, end, rendered) in edits.iter().rev() {
        out.replace_range(*start..*end, rendered);
    }
    Ok(RegexReplaceReport {
        text: out,
        count: edits.len(),
        spans,
        replacements,
    })
}

/// 替换串转换：`$` 字面量化 + `\1`…`\9` → `${N}`（TextPro 风格，F-05 §5.2）
fn expand_replacement(replacement: &str, use_escape: bool) -> String {
    let cooked = if use_escape {
        unescape_literal(replacement).unwrap_or_else(|_| replacement.to_owned())
    } else {
        replacement.to_owned()
    };
    let chars: Vec<char> = cooked.chars().collect();
    let mut out = String::with_capacity(cooked.len() + 8);
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        if ch == '$' {
            let next = chars.get(index + 1).copied();
            let is_group = matches!(next, Some('{')) || next.is_some_and(|c| c.is_ascii_digit());
            out.push_str(if is_group { "$" } else { "$$" });
            index += 1;
            continue;
        }
        if ch == '\\' {
            if let Some(next) = chars.get(index + 1).copied() {
                if next.is_ascii_digit() && next != '0' {
                    out.push_str(&format!("${{{next}}}"));
                    index += 2;
                    continue;
                }
                if next == '\\' {
                    out.push('\\');
                    index += 2;
                    continue;
                }
            }
            out.push('\\');
            index += 1;
            continue;
        }
        out.push(ch);
        index += 1;
    }
    out
}

/// 便捷：统计命中数（不构造 span 详情）
pub fn count_matches(text: &str, pattern: &str, opts: &RegexOptions) -> AppResult<usize> {
    let re = compile(pattern, opts)?;
    let filtered = Filtered::build(text, opts);
    Ok(re.captures_iter(&filtered.text).count())
}

/// 供 UI 展示的类目 → 字符数量估算（调试用）
pub fn class_size(name: &str) -> Option<usize> {
    let class = class_for(name)?;
    Some(class.len())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// 类目表的 HashMap 视图（仅测试）
    fn category_map() -> HashMap<String, String> {
        categories()
            .into_iter()
            .map(|c| (c.token, c.label))
            .collect()
    }

    fn opts() -> RegexOptions {
        RegexOptions::default()
    }

    #[test]
    fn extend_translates_categories() {
        let out = extend("\\c[天干]\\d\\a\\n\\t").unwrap();
        assert_eq!(
            out,
            "[甲乙丙丁戊己庚辛壬癸][0-9０-９〇零一二三四五六七八九十百千万亿][A-Za-z]\\n\\t"
        );
    }

    #[test]
    fn extend_keeps_unknown_escapes() {
        let out = extend("\\w+\\.\\1").unwrap();
        assert_eq!(out, "\\w+\\.\\1", "未知转义原样保留");
    }

    #[test]
    fn extend_hex_and_backslash() {
        assert_eq!(extend("\\x4E00").unwrap(), "\\x{4E00}");
        assert_eq!(extend("\\\\").unwrap(), "\\\\");
    }

    #[test]
    fn extend_rejects_unknown_category() {
        let err = extend("\\c[不存在]").unwrap_err();
        assert!(err.to_string().contains("未知中文类目"));
        assert!(extend("\\c[GBK").is_err());
        assert!(extend("\\c").is_err());
    }

    #[test]
    fn gbk_charset_is_exact_and_compact() {
        let class = gbk_charset();
        assert!(class.starts_with('[') && class.ends_with(']'));
        // 代表性字符必须在内：简、繁、全角符号、GBK 独有的生僻字
        let re = ::regex::Regex::new(class).unwrap();
        for ch in ['简', '繁', '，', '丂', '龚', '〇'] {
            assert!(re.is_match(&ch.to_string()), "GBK 集合应含 {ch}");
        }
        // ASCII 与增补平面汉字不在集合内（类目只覆盖 GBK 双字节区）
        assert!(!re.is_match("A"));
        assert!(!re.is_match("𠀀"), "U+20000 非 GBK 字符");
        // 范围合并后长度远小于逐字符枚举
        assert!(class.len() < 8000, "合并后长度 {} 过大", class.len());
    }

    #[test]
    fn big5_charset_contains_traditional() {
        let re = ::regex::Regex::new(big5_charset()).unwrap();
        assert!(re.is_match("繁"));
        assert!(re.is_match("灣"));
    }

    #[test]
    fn find_returns_utf16_offsets_with_groups() {
        let text = "你好 世界 你好";
        let spans = find(text, "(你好)", &opts()).unwrap();
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].start, 0);
        assert_eq!(spans[0].end, 2);
        assert_eq!(spans[0].groups, vec!["你好".to_owned()]);
        // 第二个命中位于 UTF-16 偏移 5（"你好 世界 " = 2+1+2+1 = 6? 逐字核对）
        let expected = utf16_offset(text, text.rfind("你好").unwrap());
        assert_eq!(spans[1].start, expected);
    }

    #[test]
    fn find_ignores_newlines_when_asked() {
        let text = "第一行\n第二行";
        let plain = find(text, "第一行第二行", &opts()).unwrap();
        assert!(plain.is_empty(), "默认不忽略回车");
        let mut ignore = opts();
        ignore.ignore_newlines = true;
        let spans = find(text, "第一行第二行", &ignore).unwrap();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "第一行\n第二行", "命中区间应覆盖被忽略字符");
    }

    #[test]
    fn find_ignores_half_space() {
        let mut ignore = opts();
        ignore.ignore_half_space = true;
        let spans = find("关 键 词", "关键词", &ignore).unwrap();
        assert_eq!(spans.len(), 1);
    }

    #[test]
    fn literal_mode_escapes_metacharacters() {
        let mut literal = opts();
        literal.regex = false;
        let spans = find("价格 1+1=2 元", "1+1=2", &literal).unwrap();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "1+1=2");
    }

    #[test]
    fn replace_supports_group_references() {
        let report = replace("张三 李四", "(\\S+) (\\S+)", "\\2 \\1", &opts(), 0, None).unwrap();
        assert_eq!(report.text, "李四 张三");
        assert_eq!(report.count, 1);
        // `$1` 写法同样可用
        let dollar = replace("abc", "(a)(b)", "$2$1", &opts(), 0, None).unwrap();
        assert_eq!(dollar.text, "bac");
    }

    #[test]
    fn replace_literal_dollar() {
        let report = replace("价格", "价格", "价格$", &opts(), 0, None).unwrap();
        assert_eq!(report.text, "价格$");
    }

    #[test]
    fn replace_respects_limit() {
        let report = replace("aaa", "a", "b", &opts(), 0, Some(2)).unwrap();
        assert_eq!(report.text, "bba");
        assert_eq!(report.count, 2);
    }

    #[test]
    fn replace_reports_rendered_text_per_span() {
        let report = replace("张三李四", "(\\S)(\\S)", "[\\2\\1]", &opts(), 1, Some(1)).unwrap();
        assert_eq!(report.count, 1);
        assert_eq!(report.spans[0].text, "李四");
        assert_eq!(report.replacements, vec!["[四李]".to_owned()]);
        assert_eq!(report.text, "张三[四李]");
    }

    #[test]
    fn replace_with_tool_rewrites_matches_only() {
        use crate::core::pipelines::from_id;
        // 命中全角字母 → 只改命中内容（工具：全角转半角）
        let to_half = from_id("full_to_half").unwrap();
        let report = replace_with_tool("Ａ甲Ａ", "Ａ", &opts(), &to_half, 0, None).unwrap();
        assert_eq!(report.text, "A甲A");
        assert_eq!(report.count, 2);
        assert_eq!(report.replacements, vec!["A".to_owned(), "A".to_owned()]);

        // 只处理第二个命中
        let one = replace_with_tool("Ａ甲Ａ", "Ａ", &opts(), &to_half, 1, Some(1)).unwrap();
        assert_eq!(one.text, "Ａ甲A");

        // 工具对该文本无效果时，命中内容原样写回
        let noop = replace_with_tool(
            "甲 ",
            "甲",
            &opts(),
            &from_id("trim_line_end").unwrap(),
            0,
            None,
        )
        .unwrap();
        assert_eq!(noop.text, "甲 ");

        // 行级工具作用在「命中文本」上：命中「甲 」→ 行末空格被清理
        let trimmed = replace_with_tool(
            "x甲 x",
            "甲 ",
            &opts(),
            &from_id("trim_line_end").unwrap(),
            0,
            None,
        )
        .unwrap();
        assert_eq!(trimmed.text, "x甲x");
    }

    #[test]
    fn replace_skips_to_target_occurrence() {
        // 只替换第二个命中（UI「替换当前这一个」）
        let report = replace("a-a-a", "a", "X", &opts(), 1, Some(1)).unwrap();
        assert_eq!(report.text, "a-X-a");
        assert_eq!(report.count, 1);
        assert_eq!(report.spans[0].start, 2);
        // skip 超出命中数时不做任何替换
        let none = replace("a", "a", "X", &opts(), 5, Some(1)).unwrap();
        assert_eq!(none.text, "a");
        assert_eq!(none.count, 0);
    }

    #[test]
    fn match_end_does_not_swallow_trailing_ignored_chars() {
        let mut ignore = opts();
        ignore.ignore_half_space = true;
        // 命中之后仍有被忽略的空格：区间应止于最后一个命中字符
        let spans = find("关 键 词   ", "关键词", &ignore).unwrap();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "关 键 词");
        // 替换同理：尾随空格必须原样保留
        let report = replace("关 键 词   ", "关键词", "词键关", &ignore, 0, None).unwrap();
        assert_eq!(report.text, "词键关   ");
        // 忽略回车时跨越换行，区间同样止于最后一个命中字符
        let mut cross = opts();
        cross.ignore_newlines = true;
        let spans = find("甲\n乙\n", "甲乙", &cross).unwrap();
        assert_eq!(spans[0].text, "甲\n乙");
    }

    #[test]
    fn replace_keeps_ignored_chars_outside_match() {
        let mut ignore = opts();
        ignore.ignore_half_space = true;
        // 命中跨越被忽略空格：整个区间被替换（文档化行为）
        let report = replace("关 键 词", "关键词", "词键关", &ignore, 0, None).unwrap();
        assert_eq!(report.text, "词键关");
    }

    #[test]
    fn invalid_pattern_reports_error() {
        let err = compile("(", &opts()).unwrap_err();
        assert!(matches!(err, AppError::Regex(_)));
    }

    #[test]
    fn categories_are_listed_for_ui() {
        let map = category_map();
        for token in [
            "\\c[GBK]",
            "\\c[BIG5]",
            "\\c[数字]",
            "\\c[天干]",
            "\\a",
            "\\d",
        ] {
            assert!(map.contains_key(token), "缺少类目 {token}");
        }
        assert!(class_size("GBK").unwrap() > 100);
    }
}
