//! F-09 文本整理工具集（第五阶段）
//!
//! 每个工具都是「一个独立函数 + 一个 [`PipelineStep`] 变体」：
//! - UI 侧（「整理」菜单）把单个步骤应用到整篇或选区；
//! - 第七阶段批处理（F-08）把同一批步骤串成流水线复用（[`run_chain`]）。
//!
//! 设计要点：
//! 1. **步骤即数据**：`#[serde(tag = "kind")]` 的内部标签枚举，前端只发
//!    `{"kind":"remove_empty_lines"}`，选项一律有默认值。
//! 2. **行尾符保真**：行级工具按 `\r\n` / `\n` / `\r` 逐行拆分并原样写回
//!    （[`split_lines`]），不会因为整理动作把 CRLF 文件改成 LF；
//!    需要新增行/段的工具统一使用文件中首次出现的行尾符。
//! 3. **全半角对称**：`full_to_half` / `half_to_full` 共用一套选项，
//!    默认只动字母数字与空格（避免把中文标点 ，。 变成 ,.），
//!    需要时再显式打开「转换标点」。
//! 4. `changed` 的语义按工具而定（删除行数 / 转换字符数 / 折行数…），
//!    一律在各自的 `notes` 里给出人类可读说明。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

/// 删除半角字符的三种模式（F-09 `remove_half_width`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum HalfWidthMode {
    /// 删除全部半角可见字符（保留空格 / 制表符 / 换行）
    #[default]
    All,
    /// 仅删除半角字母与数字
    Alnum,
    /// 仅删除半角标点
    Punct,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HalfWidthOptions {
    pub mode: HalfWidthMode,
}

/// 全角 / 半角互转选项（两个方向共用）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FullHalfOptions {
    /// 转换字母与数字（全角 Ａ↔ 半角 A）
    pub convert_alnum: bool,
    /// 转换标点（全角 ，↔ 半角 ,；默认关闭以免破坏中文标点）
    pub convert_punct: bool,
    /// 空格：全角空格 ↔ 两个半角空格
    pub merge_spaces: bool,
}

impl Default for FullHalfOptions {
    fn default() -> Self {
        Self {
            convert_alnum: true,
            convert_punct: false,
            merge_spaces: true,
        }
    }
}

/// 规范行首（行首缩进）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NormalizeHeadOptions {
    /// 缩进宽度（全角空格个数）
    pub indent: usize,
    /// 空行不加缩进
    pub skip_blank: bool,
    /// 已有缩进的行也重排（关闭则只给「完全没有缩进」的行加）
    pub force: bool,
}

impl Default for NormalizeHeadOptions {
    fn default() -> Self {
        Self {
            indent: 2,
            skip_blank: true,
            force: true,
        }
    }
}

/// 删除段内回车
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IntraLineOptions {
    /// 保留段落之间的空行（关闭则全部非空行连成一行）
    pub keep_blank_runs: bool,
    /// 段内行与行之间的连接串（默认直接相连，符合中文习惯）
    pub joiner: String,
    /// 每段行首插入的字符串（如「　　」）
    pub paragraph_prefix: String,
}

impl Default for IntraLineOptions {
    fn default() -> Self {
        Self {
            keep_blank_runs: true,
            joiner: String::new(),
            paragraph_prefix: String::new(),
        }
    }
}

/// 排序方式（拼音 / 笔画排序需额外字表，见文档注记）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SortMode {
    /// 按 Unicode 码位升序
    #[default]
    Unicode,
    /// Unicode 降序
    Reverse,
    /// 按字符数升序（长度相同保持原序）
    LengthAsc,
    /// 按字符数降序
    LengthDesc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SortLinesOptions {
    pub mode: SortMode,
    /// 比较时忽略行首行末空白（写回时仍保留原行内容）
    pub ignore_surrounding_space: bool,
}

/// 删除重复行
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DedupOptions {
    /// 比较时忽略行首行末空白
    pub trim: bool,
    /// 忽略 ASCII 大小写
    pub ignore_case: bool,
    /// 仅保留最后一次出现（默认保留首次）
    pub keep_last: bool,
}

impl Default for SimpleLayoutOptions {
    fn default() -> Self {
        // F-09：简单排版默认按「行首两个全角空格」缩进
        Self { indent: 2 }
    }
}

/// 简单排版（删除空行 + 规范行首 + 删除行末空格）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SimpleLayoutOptions {
    /// 段首缩进（全角空格个数）
    pub indent: usize,
}

/// 自动分段
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SegmentOptions {
    /// 段首缩进（全角空格个数）
    pub indent: usize,
    /// 在这些标点后断句（标点保留在上一段末尾）
    pub break_after: String,
    /// 对话行（以引号 / 破折号开头）不加缩进
    pub skip_dialog: bool,
    /// 超过该长度也强制断开（字符数，0 = 不限）
    pub max_segment_chars: usize,
}

impl Default for SegmentOptions {
    fn default() -> Self {
        Self {
            indent: 2,
            break_after: "。！？…".to_owned(),
            skip_dialog: true,
            max_segment_chars: 0,
        }
    }
}

/// 控制行宽
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WidthOptions {
    /// 目标行宽（以半角字符为单位，CJK 记 2）
    pub width: usize,
    /// 续行缩进（全角空格个数）
    pub indent: usize,
    /// 优先在这些标点之后断行
    pub break_after: String,
    /// 避免出现在行首的「避头点」
    pub forbid_head: String,
}

impl Default for WidthOptions {
    fn default() -> Self {
        Self {
            width: 40,
            indent: 0,
            break_after: "，。！？；：、）】」』".to_owned(),
            forbid_head: "，。！？；：、）】」』".to_owned(),
        }
    }
}

/// 括号对（括号嵌套转换用的「主括号样式阶梯」）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BracketPair {
    pub open: String,
    pub close: String,
}

/// 括号嵌套转换 / 自动修复
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FixBracketsOptions {
    /// 由外到内的括号样式阶梯（默认 （）→「」→『』→【】）
    pub ladder: Vec<BracketPair>,
    /// 行末自动补齐未闭合的括号
    pub auto_close: bool,
}

/// 默认括号阶梯：（外层）（） →「」→『』→【】
fn default_ladder() -> Vec<BracketPair> {
    [("（", "）"), ("「", "」"), ("『", "』"), ("【", "】")]
        .iter()
        .map(|(open, close)| BracketPair {
            open: (*open).to_owned(),
            close: (*close).to_owned(),
        })
        .collect()
}

impl Default for FixBracketsOptions {
    fn default() -> Self {
        Self {
            ladder: default_ladder(),
            auto_close: true,
        }
    }
}

// ---------------------------------------------------------------------------
// v0.9 排版类工具的选项
//
// 这批工具的共同点：**规则可以按开关组合**，所以每个工具都是「若干条独立规则
// + 一个默认值集合」。规则之间互不影响，任意组合跑两遍结果不变（幂等）。
// ---------------------------------------------------------------------------

/// 引号体系（规范标点）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum QuoteStyle {
    /// 大陆：双引号 “”，单引号 ‘’
    #[default]
    Mainland,
    /// 港澳台：外层「」、内层『』
    Corner,
    /// 不动引号（保留原文写法）
    Keep,
}

/// 规范标点（GB/T 15834-2011）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PunctOptions {
    pub quote_style: QuoteStyle,
    /// 省略号统一为「……」（六点，占两格）
    pub fix_ellipsis: bool,
    /// 破折号统一为「——」（两字线）
    pub fix_dash: bool,
    /// 中文语境里的半角标点（,;:?!()）转全角
    pub half_to_full_punct: bool,
    /// 括号按嵌套阶梯改写并补齐未闭合的
    pub fix_brackets: bool,
    /// 检查括号配对（只报告，不改写正文）
    pub check_brackets: bool,
    /// 竖排标点（U+FE10 区）转横排写法
    pub vertical_to_horizontal: bool,
}

impl Default for PunctOptions {
    fn default() -> Self {
        Self {
            quote_style: QuoteStyle::Mainland,
            fix_ellipsis: true,
            fix_dash: true,
            half_to_full_punct: true,
            fix_brackets: false,
            check_brackets: true,
            vertical_to_horizontal: true,
        }
    }
}

/// 网文排版（中英文 / 中数之间补空格，段首缩进）
///
/// 参考 `vscode-pangu2`：核心是**在 CJK 与拉丁字母、数字之间补一个半角空格**，
/// 反向（去掉全角标点两侧多余空格）也在里面——网文稿件里这两种脏数据都常见。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SpacingOptions {
    /// 中文与拉丁字母之间补空格
    pub cjk_latin: bool,
    /// 中文与数字之间补空格
    pub cjk_digit: bool,
    /// 去掉全角标点两侧多余的半角空格
    pub squeeze_spaces: bool,
    /// 清理行尾空格
    pub trim_end: bool,
    /// 段首缩进（全角空格个数，0 = 不动缩进）
    pub indent: usize,
    /// 跳过 URL 与反引号内的代码（默认开启）
    pub skip_code: bool,
}

impl Default for SpacingOptions {
    fn default() -> Self {
        Self {
            cjk_latin: true,
            cjk_digit: true,
            squeeze_spaces: true,
            trim_end: true,
            indent: 2,
            skip_code: true,
        }
    }
}

/// 中文文案（chinese-copywriting-guidelines 的常用子集）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CopywritingOptions {
    /// 中文与拉丁字母之间补空格
    pub space_cjk_latin: bool,
    /// 中文与数字之间补空格
    pub space_cjk_digit: bool,
    /// 全角标点之后不留空格
    pub no_space_after_punct: bool,
    /// 重复标点合并（！！→！、。。→。）
    pub dedup_punct: bool,
    /// 省略号与破折号规范化（... → ……、-- → ——）
    pub ellipsis_and_dash: bool,
    /// 数字与英文单位之间补空格（100kg → 100 kg）
    pub digit_unit: bool,
}

impl Default for CopywritingOptions {
    fn default() -> Self {
        Self {
            space_cjk_latin: true,
            space_cjk_digit: true,
            no_space_after_punct: true,
            dedup_punct: true,
            ellipsis_and_dash: true,
            digit_unit: true,
        }
    }
}

/// 技术文档（Markdown 排版规约）
///
/// 参考 `Snippet-Scripts` 与常见中文技术写作约定：标题与内容之间要有空格、
/// 列表符号统一、代码围栏前后留空行、行尾不留空格、代码内部一律不动。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TechDocOptions {
    /// `#标题` → `# 标题`
    pub heading_space: bool,
    /// 列表符号统一为 `-`
    pub list_marker: bool,
    /// 代码围栏前后补空行
    pub fence_blank: bool,
    /// 清理行尾空格
    pub trim_end: bool,
    /// 中英文之间补空格（代码围栏内不动）
    pub cjk_space: bool,
    /// 文件末尾补一个换行
    pub final_newline: bool,
}

impl Default for TechDocOptions {
    fn default() -> Self {
        Self {
            heading_space: true,
            list_marker: true,
            fence_blank: true,
            trim_end: true,
            cjk_space: true,
            final_newline: true,
        }
    }
}

/// 片段处理（行级批处理，把原来散在菜单里的细项收进来）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SnippetOptions {
    pub trim_head: bool,
    pub trim_end: bool,
    pub remove_empty: bool,
    /// 段间空一行
    pub insert_blank: bool,
    pub dedup: bool,
    pub sort: bool,
    pub sort_mode: SortMode,
    /// 删除半角字符（模式见 `HalfWidthMode`）
    pub remove_half_width: bool,
    pub half_width_mode: HalfWidthMode,
    /// 删除段内回车（合并为一段）
    pub join_lines: bool,
}

impl Default for SnippetOptions {
    fn default() -> Self {
        Self {
            trim_head: true,
            trim_end: true,
            remove_empty: true,
            insert_blank: false,
            dedup: false,
            sort: false,
            sort_mode: SortMode::Unicode,
            remove_half_width: false,
            half_width_mode: HalfWidthMode::default(),
            join_lines: false,
        }
    }
}

// ---------------------------------------------------------------------------
// 步骤（= 工具）定义
// ---------------------------------------------------------------------------

/// 流水线步骤（F-08 §8.3 的步骤抽象；F-09 的每个工具都是一个变体）
///
/// 序列化形如 `{"kind":"remove_empty_lines"}` 或
/// `{"kind":"half_to_full","convertAlnum":true,"convertPunct":false,"mergeSpaces":true}`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PipelineStep {
    RemoveHalfWidth(HalfWidthOptions),
    FullToHalf(FullHalfOptions),
    HalfToFull(FullHalfOptions),
    NormalizeLineHead(NormalizeHeadOptions),
    TrimLineEnd,
    TrimLineHead,
    RemoveIntraLineBreaks(IntraLineOptions),
    SortLines(SortLinesOptions),
    DedupLines(DedupOptions),
    RemoveEmptyLines,
    InsertBlankBetween,
    SimpleLayout(SimpleLayoutOptions),
    AutoSegment(SegmentOptions),
    ControlWidth(WidthOptions),
    MatchBrackets,
    FixBrackets(FixBracketsOptions),
    HalfQuoteToFull,
    VerticalToHorizontal,
    // ---- v0.9 排版类工具 ----
    NormalizePunctuation(PunctOptions),
    WebNovelLayout(SpacingOptions),
    ChineseCopywriting(CopywritingOptions),
    TechDocLayout(TechDocOptions),
    SnippetProcess(SnippetOptions),
    /// 删除行首**与**行末空格（菜单里的高频直点项）
    TrimBoth,
}

impl PipelineStep {
    /// 稳定标识（与 serde 的 `kind` 取值一致，由单测锁定）
    pub fn id(&self) -> &'static str {
        match self {
            Self::RemoveHalfWidth(_) => "remove_half_width",
            Self::FullToHalf(_) => "full_to_half",
            Self::HalfToFull(_) => "half_to_full",
            Self::NormalizeLineHead(_) => "normalize_line_head",
            Self::TrimLineEnd => "trim_line_end",
            Self::TrimLineHead => "trim_line_head",
            Self::RemoveIntraLineBreaks(_) => "remove_intra_line_breaks",
            Self::SortLines(_) => "sort_lines",
            Self::DedupLines(_) => "dedup_lines",
            Self::RemoveEmptyLines => "remove_empty_lines",
            Self::InsertBlankBetween => "insert_blank_between",
            Self::SimpleLayout(_) => "simple_layout",
            Self::AutoSegment(_) => "auto_segment",
            Self::ControlWidth(_) => "control_width",
            Self::MatchBrackets => "match_brackets",
            Self::FixBrackets(_) => "fix_brackets",
            Self::HalfQuoteToFull => "half_quote_to_full",
            Self::VerticalToHorizontal => "vertical_to_horizontal",
            Self::NormalizePunctuation(_) => "normalize_punctuation",
            Self::WebNovelLayout(_) => "web_novel_layout",
            Self::ChineseCopywriting(_) => "chinese_copywriting",
            Self::TechDocLayout(_) => "tech_doc_layout",
            Self::SnippetProcess(_) => "snippet_process",
            Self::TrimBoth => "trim_both",
        }
    }

    /// 仅检查、不改写正文的步骤（匹配括号）
    pub fn inspects_only(&self) -> bool {
        matches!(self, Self::MatchBrackets)
    }
}

/// 工具元信息（前端菜单与选项对话框的数据源）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolMeta {
    /// 稳定标识（即 [`PipelineStep::id`]）
    pub id: String,
    /// 菜单文案
    pub label: String,
    /// 分组（菜单里的分隔标题）
    pub group: String,
    /// 一句话说明（菜单 title）
    pub hint: String,
    /// 是否有可调选项（UI 决定是否显示「…」入口）
    pub has_options: bool,
    /// 只检查不改写
    pub inspects_only: bool,
}

/// 步骤执行结果
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepOutcome {
    /// 处理后的文本
    pub text: String,
    /// 变更计数（语义按工具而定；0 表示无变化）
    pub changed: usize,
    /// 人类可读提示
    pub notes: Vec<String>,
    /// 括号检查结果（仅 `MatchBrackets` 会填充）
    #[serde(default)]
    pub bracket_issues: Vec<BracketIssue>,
}

/// 括号检查问题
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BracketIssue {
    /// 1 起的行号
    pub line: usize,
    /// 1 起的列号（按字符计）
    pub column: usize,
    /// 出问题的括号字符
    pub ch: String,
    pub message: String,
}

/// 工具目录（11 项，顺序即菜单顺序）
///
/// 这里列的是**菜单上露出**的项：5 个排版类工具 + 6 个高频直点项。
/// 其余 13 个步骤不再各自占一个菜单项——它们的活儿被「规范标点」「片段处理」
/// 收进了选项里（例如括号检查、排序、去重），或本就是低频能力。
/// 它们仍然可以被 [`from_id`] 构造，批处理（F-08）的流水线也照旧可用。
pub fn catalog() -> Vec<ToolMeta> {
    fn item(
        id: &str,
        label: &str,
        group: &str,
        hint: &str,
        has_options: bool,
        inspects_only: bool,
    ) -> ToolMeta {
        ToolMeta {
            id: id.to_owned(),
            label: label.to_owned(),
            group: group.to_owned(),
            hint: hint.to_owned(),
            has_options,
            inspects_only,
        }
    }
    vec![
        // ---- 排版规范 ----
        item(
            "normalize_punctuation",
            "规范标点",
            "排版规范",
            "按 GB/T 15834-2011 统一引号、省略号、破折号与半角标点",
            true,
            false,
        ),
        item(
            "web_novel_layout",
            "网文排版",
            "排版规范",
            "中英文 / 中数之间补空格、段首缩进、清理行尾空格",
            true,
            false,
        ),
        item(
            "chinese_copywriting",
            "中文文案",
            "排版规范",
            "中英空格、标点后不留空格、重复标点合并、省略号与破折号",
            true,
            false,
        ),
        item(
            "tech_doc_layout",
            "技术文档",
            "排版规范",
            "Markdown：标题空格、列表符号、代码块空行、中英空格",
            true,
            false,
        ),
        item(
            "snippet_process",
            "片段处理",
            "排版规范",
            "行级批处理：去空白、删除空行、去重、排序、合并段落",
            true,
            false,
        ),
        // ---- 常用（直接点用，不弹对话框） ----
        item(
            "trim_both",
            "删除行首行末空格",
            "常用",
            "删除每行行首与行末的半角 / 全角空格与制表符",
            false,
            false,
        ),
        item(
            "remove_empty_lines",
            "删除空行",
            "常用",
            "删除空行及只含半角 / 全角空格的行",
            false,
            false,
        ),
        item(
            "insert_blank_between",
            "段间空一行",
            "常用",
            "在段落之间插入一个空行（多余空行合并）",
            false,
            false,
        ),
        item(
            "full_to_half",
            "全角转半角",
            "常用",
            "全角字母数字转半角、全角空格转两个半角（可选转标点）",
            true,
            false,
        ),
        item(
            "half_to_full",
            "半角转全角",
            "常用",
            "半角字母数字转全角（可选转标点、合并半角空格）",
            true,
            false,
        ),
        item(
            "simple_layout",
            "简单排版",
            "常用",
            "删除空行 + 规范行首 + 删除行末空格",
            true,
            false,
        ),
    ]
}

/// 由标识构造步骤（默认选项）；未知标识报错
pub fn from_id(id: &str) -> AppResult<PipelineStep> {
    let step = match id {
        "remove_half_width" => PipelineStep::RemoveHalfWidth(HalfWidthOptions::default()),
        "full_to_half" => PipelineStep::FullToHalf(FullHalfOptions::default()),
        "half_to_full" => PipelineStep::HalfToFull(FullHalfOptions::default()),
        "normalize_line_head" => PipelineStep::NormalizeLineHead(NormalizeHeadOptions::default()),
        "trim_line_end" => PipelineStep::TrimLineEnd,
        "trim_line_head" => PipelineStep::TrimLineHead,
        "remove_intra_line_breaks" => {
            PipelineStep::RemoveIntraLineBreaks(IntraLineOptions::default())
        }
        "sort_lines" => PipelineStep::SortLines(SortLinesOptions::default()),
        "dedup_lines" => PipelineStep::DedupLines(DedupOptions::default()),
        "remove_empty_lines" => PipelineStep::RemoveEmptyLines,
        "insert_blank_between" => PipelineStep::InsertBlankBetween,
        "simple_layout" => PipelineStep::SimpleLayout(SimpleLayoutOptions::default()),
        "auto_segment" => PipelineStep::AutoSegment(SegmentOptions::default()),
        "control_width" => PipelineStep::ControlWidth(WidthOptions::default()),
        "match_brackets" => PipelineStep::MatchBrackets,
        "fix_brackets" => PipelineStep::FixBrackets(FixBracketsOptions::default()),
        "half_quote_to_full" => PipelineStep::HalfQuoteToFull,
        "vertical_to_horizontal" => PipelineStep::VerticalToHorizontal,
        "normalize_punctuation" => PipelineStep::NormalizePunctuation(PunctOptions::default()),
        "web_novel_layout" => PipelineStep::WebNovelLayout(SpacingOptions::default()),
        "chinese_copywriting" => PipelineStep::ChineseCopywriting(CopywritingOptions::default()),
        "tech_doc_layout" => PipelineStep::TechDocLayout(TechDocOptions::default()),
        "snippet_process" => PipelineStep::SnippetProcess(SnippetOptions::default()),
        "trim_both" => PipelineStep::TrimBoth,
        other => return Err(AppError::Pipeline(format!("未知整理工具：{other}"))),
    };
    Ok(step)
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/// 执行单个步骤
pub fn run_step(text: &str, step: &PipelineStep) -> AppResult<StepOutcome> {
    Ok(match step {
        PipelineStep::RemoveHalfWidth(o) => remove_half_width(text, o),
        PipelineStep::FullToHalf(o) => half_full_convert(text, o, false),
        PipelineStep::HalfToFull(o) => half_full_convert(text, o, true),
        PipelineStep::NormalizeLineHead(o) => normalize_line_head(text, o),
        PipelineStep::TrimLineEnd => trim_lines(text, true, false),
        PipelineStep::TrimLineHead => trim_lines(text, false, true),
        PipelineStep::RemoveIntraLineBreaks(o) => remove_intra_line_breaks(text, o),
        PipelineStep::SortLines(o) => sort_lines(text, o),
        PipelineStep::DedupLines(o) => dedup_lines(text, o),
        PipelineStep::RemoveEmptyLines => remove_empty_lines(text),
        PipelineStep::InsertBlankBetween => insert_blank_between(text),
        PipelineStep::SimpleLayout(o) => simple_layout(text, o),
        PipelineStep::AutoSegment(o) => auto_segment(text, o),
        PipelineStep::ControlWidth(o) => control_width(text, o),
        PipelineStep::MatchBrackets => match_brackets(text),
        PipelineStep::FixBrackets(o) => fix_brackets(text, o),
        PipelineStep::HalfQuoteToFull => half_quote_to_full(text),
        PipelineStep::VerticalToHorizontal => vertical_to_horizontal(text),
        PipelineStep::NormalizePunctuation(o) => normalize_punctuation(text, o),
        PipelineStep::WebNovelLayout(o) => web_novel_layout(text, o),
        PipelineStep::ChineseCopywriting(o) => chinese_copywriting(text, o),
        PipelineStep::TechDocLayout(o) => tech_doc_layout(text, o),
        PipelineStep::SnippetProcess(o) => snippet_process(text, o),
        PipelineStep::TrimBoth => trim_lines(text, true, true),
    })
}

/// 串行执行多步（第七阶段批处理复用同一实现）
pub fn run_chain(text: &str, steps: &[PipelineStep]) -> AppResult<StepOutcome> {
    let mut current = text.to_owned();
    let mut changed_total = 0usize;
    let mut notes: Vec<String> = Vec::new();
    let mut bracket_issues: Vec<BracketIssue> = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let outcome = run_step(&current, step)?;
        changed_total += outcome.changed;
        for note in &outcome.notes {
            notes.push(format!("{}. {note}", index + 1));
        }
        bracket_issues.extend(outcome.bracket_issues);
        current = outcome.text;
    }
    Ok(StepOutcome {
        text: current,
        changed: changed_total,
        notes,
        bracket_issues,
    })
}

// ---------------------------------------------------------------------------
// 基础工具函数
// ---------------------------------------------------------------------------

/// 按行拆分并保留每行原始行尾符：`(行内容, 行尾符)`
///
/// 末尾没有行尾符的最后一行也会返回（行尾符为空串），
/// 因此把 `(content, term)` 依次拼接即可无损还原原文。
fn split_lines(text: &str) -> Vec<(&str, &str)> {
    let bytes = text.as_bytes();
    let mut out: Vec<(&str, &str)> = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\n' => {
                out.push((&text[start..index], "\n"));
                index += 1;
                start = index;
            }
            b'\r' => {
                if bytes.get(index + 1) == Some(&b'\n') {
                    out.push((&text[start..index], "\r\n"));
                    index += 2;
                } else {
                    out.push((&text[start..index], "\r"));
                    index += 1;
                }
                start = index;
            }
            _ => index += 1,
        }
    }
    if start < text.len() {
        out.push((&text[start..], ""));
    }
    out
}

/// 文件中首次出现的行尾符（默认 `\n`）
fn dominant_terminator(text: &str) -> &'static str {
    if let Some(pos) = text.find('\n') {
        if pos > 0 && text.as_bytes()[pos - 1] == b'\r' {
            return "\r\n";
        }
        return "\n";
    }
    if text.contains('\r') {
        return "\r";
    }
    "\n"
}

/// 行首 / 行末需要处理的空白（半角空格、制表符、全角空格）
fn is_pad(ch: char) -> bool {
    ch == ' ' || ch == '\t' || ch == '\u{3000}'
}

fn trim_pad(line: &str) -> &str {
    line.trim_matches(is_pad)
}

fn starts_with_pad(line: &str) -> bool {
    line.chars().next().is_some_and(is_pad)
}

fn is_blank(line: &str) -> bool {
    trim_pad(line).is_empty()
}

/// 按 `term` 拼装行（`lines` 不含行尾符）
fn join_lines(lines: &[String], term: &str, trailing: bool) -> String {
    let mut out = String::new();
    for (index, line) in lines.iter().enumerate() {
        out.push_str(line);
        if index + 1 < lines.len() || trailing {
            out.push_str(term);
        }
    }
    out
}

/// 东亚宽字符近似判定（占 2 个半角位）
fn char_width(ch: char) -> usize {
    let code = ch as u32;
    if code == 0 {
        return 0;
    }
    let wide = matches!(code,
        0x1100..=0x115F
            | 0x2E80..=0x303E
            | 0x3041..=0x33FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA000..=0xA4CF
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE10..=0xFE19
            | 0xFE30..=0xFE6F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
            | 0x1F300..=0x1F64F
            | 0x1F900..=0x1F9FF
            | 0x20000..=0x3FFFD
    );
    if wide {
        2
    } else {
        1
    }
}

fn display_width(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

/// 逐行改写，返回 `(新文本, 改动行数)`
fn map_lines<F>(text: &str, mut transform: F) -> (String, usize)
where
    F: FnMut(&str) -> String,
{
    if text.is_empty() {
        return (String::new(), 0);
    }
    let mut changed = 0usize;
    let mut out = String::with_capacity(text.len());
    for (content, term) in split_lines(text) {
        let next = transform(content);
        if next != content {
            changed += 1;
        }
        out.push_str(&next);
        out.push_str(term);
    }
    (out, changed)
}

fn note_outcome(text: String, changed: usize, note: String) -> StepOutcome {
    StepOutcome {
        text,
        changed,
        notes: vec![note],
        bracket_issues: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// 行处理
// ---------------------------------------------------------------------------

fn trim_lines(text: &str, end: bool, head: bool) -> StepOutcome {
    let (out, changed) = map_lines(text, |line| {
        let mut next = line;
        if head {
            next = next.trim_start_matches(is_pad);
        }
        if end {
            next = next.trim_end_matches(is_pad);
        }
        next.to_owned()
    });
    let what = match (head, end) {
        (true, true) => "行首行末",
        (true, false) => "行首",
        _ => "行末",
    };
    note_outcome(
        out,
        changed,
        if changed == 0 {
            format!("没有需要删除的{what}空格")
        } else {
            format!("清理 {changed} 行{what}空格")
        },
    )
}

fn remove_empty_lines(text: &str) -> StepOutcome {
    let lines = split_lines(text);
    let trailing = lines.last().is_some_and(|(_, term)| !term.is_empty());
    let kept: Vec<String> = lines
        .iter()
        .filter(|(content, _)| !is_blank(content))
        .map(|(content, _)| (*content).to_owned())
        .collect();
    let removed = lines.len() - kept.len();
    let out = join_lines(
        &kept,
        dominant_terminator(text),
        trailing && !kept.is_empty(),
    );
    note_outcome(
        out,
        removed,
        if removed == 0 {
            "没有空行".to_owned()
        } else {
            format!("删除 {removed} 个空行")
        },
    )
}

/// 段间空一行：**每个非空行视为一段**，让相邻两段之间恰好隔一个空行。
///
/// 早先的实现把「段」定义成**连续非空行**（多行一段），只在遇到真空行时才切段，
/// 于是 `甲\n乙` 被算成 1 个段落、一个空行都不插——用户反馈「段间空行功能无效、
/// 两段之间没有插入空行」正是这个原因。现在改成：既把缺失的空行补上，
/// 也把多余的连续空行合并成一个。
fn insert_blank_between(text: &str) -> StepOutcome {
    let lines = split_lines(text);
    let trailing = lines.last().is_some_and(|(_, t)| !t.is_empty());
    let body: Vec<&str> = lines
        .iter()
        .map(|(content, _)| *content)
        .filter(|line| !is_blank(line))
        .collect();

    if body.len() < 2 {
        return note_outcome(
            text.to_owned(),
            0,
            if body.is_empty() {
                "没有内容行".to_owned()
            } else {
                "只有一段，无需插入空行".to_owned()
            },
        );
    }

    let term = dominant_terminator(text);
    let mut out = String::with_capacity(text.len() + body.len() * term.len());
    for (index, line) in body.iter().enumerate() {
        out.push_str(line);
        out.push_str(term);
        if index + 1 < body.len() {
            out.push_str(term); // 段间空一行
        }
    }
    if !trailing {
        out.truncate(out.len().saturating_sub(term.len()));
    }

    // 实质变化看「行数差」：补上的空行算插入，被合并掉的算减少
    let blank_before = lines.iter().filter(|(content, _)| is_blank(content)).count();
    let blank_after = body.len() - 1;
    let delta = blank_after as isize - blank_before as isize;
    let note = if delta >= 0 {
        format!("{} 段，插入 {} 个空行", body.len(), delta)
    } else {
        format!("{} 段，合并掉 {} 个多余空行", body.len(), -delta)
    };
    note_outcome(out, delta.unsigned_abs(), note)
}

fn dedup_lines(text: &str, opts: &DedupOptions) -> StepOutcome {
    let lines = split_lines(text);
    let trailing = lines.last().is_some_and(|(_, t)| !t.is_empty());
    let key = |line: &str| -> String {
        let base = if opts.trim { trim_pad(line) } else { line };
        if opts.ignore_case {
            base.to_ascii_lowercase()
        } else {
            base.to_owned()
        }
    };

    let mut kept: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut removed = 0usize;
    if opts.keep_last {
        for (content, _) in lines.iter().rev() {
            if seen.insert(key(content)) {
                kept.push((*content).to_owned());
            } else {
                removed += 1;
            }
        }
        kept.reverse();
    } else {
        for (content, _) in &lines {
            if seen.insert(key(content)) {
                kept.push((*content).to_owned());
            } else {
                removed += 1;
            }
        }
    }
    let out = join_lines(
        &kept,
        dominant_terminator(text),
        trailing && !kept.is_empty(),
    );
    note_outcome(
        out,
        removed,
        if removed == 0 {
            "没有重复行".to_owned()
        } else {
            format!("删除 {removed} 行重复内容")
        },
    )
}

fn sort_lines(text: &str, opts: &SortLinesOptions) -> StepOutcome {
    let lines = split_lines(text);
    let trailing = lines.last().is_some_and(|(_, t)| !t.is_empty());
    let mut items: Vec<String> = lines.iter().map(|(c, _)| (*c).to_owned()).collect();
    if items.is_empty() {
        return note_outcome(text.to_owned(), 0, "没有可排序的行".to_owned());
    }
    let key = |line: &str| -> String {
        if opts.ignore_surrounding_space {
            trim_pad(line).to_owned()
        } else {
            line.to_owned()
        }
    };
    // 稳定排序：长度相同的行保持原有相对顺序
    match opts.mode {
        SortMode::Unicode => items.sort_by_key(|line| key(line)),
        SortMode::Reverse => {
            items.sort_by_key(|line| key(line));
            items.reverse();
        }
        SortMode::LengthAsc => items.sort_by_key(|line| key(line).chars().count()),
        SortMode::LengthDesc => {
            items.sort_by_key(|line| key(line).chars().count());
            items.reverse();
        }
    }
    let out = join_lines(&items, dominant_terminator(text), trailing);
    let changed = usize::from(out != text) * items.len();
    note_outcome(
        out,
        changed,
        if changed == 0 {
            "顺序已符合要求".to_owned()
        } else {
            format!("重排 {} 行", items.len())
        },
    )
}

// ---------------------------------------------------------------------------
// 空格与全半角
// ---------------------------------------------------------------------------

fn remove_half_width(text: &str, opts: &HalfWidthOptions) -> StepOutcome {
    let target = |ch: char| -> bool {
        // 空格与制表符等控制字符一律保留（只处理可见半角字符）
        if !ch.is_ascii() || ch == ' ' || ch.is_ascii_control() {
            return false;
        }
        match opts.mode {
            HalfWidthMode::All => true,
            HalfWidthMode::Alnum => ch.is_ascii_alphanumeric(),
            HalfWidthMode::Punct => ch.is_ascii_punctuation(),
        }
    };
    let mut removed = 0usize;
    let out: String = text
        .chars()
        .filter(|ch| {
            if target(*ch) {
                removed += 1;
                false
            } else {
                true
            }
        })
        .collect();
    let mode = match opts.mode {
        HalfWidthMode::All => "全部半角字符",
        HalfWidthMode::Alnum => "半角字母数字",
        HalfWidthMode::Punct => "半角标点",
    };
    note_outcome(out, removed, format!("删除 {removed} 个{mode}"))
}

/// 全角 ↔ 半角（`to_full = true` 时半角→全角）
fn half_full_convert(text: &str, opts: &FullHalfOptions, to_full: bool) -> StepOutcome {
    let mut changed = 0usize;
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        let code = ch as u32;

        // 空格：全角空格 ↔ 两个半角空格
        if to_full && opts.merge_spaces && ch == ' ' {
            let mut run = 0usize;
            while index + run < chars.len() && chars[index + run] == ' ' {
                run += 1;
            }
            for _ in 0..(run / 2) {
                out.push('\u{3000}');
                changed += 1;
            }
            for _ in 0..(run % 2) {
                out.push(' ');
            }
            index += run;
            continue;
        }
        if !to_full && opts.merge_spaces && ch == '\u{3000}' {
            out.push_str("  ");
            changed += 1;
            index += 1;
            continue;
        }

        // 字母数字：半角 0x30..=0x39 / 0x41..=0x5A / 0x61..=0x7A ↔ 全角同区 +0xFEE0
        let alnum_offset = |code: u32| -> Option<u32> {
            match code {
                0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A => Some(0xFEE0),
                0xFF10..=0xFF19 | 0xFF21..=0xFF3A | 0xFF41..=0xFF5A => Some(0xFEE0),
                _ => None,
            }
        };
        // 标点：0x21..=0x2F / 0x3A..=0x40 / 0x5B..=0x60 / 0x7B..=0x7E ↔ 全角同区
        let punct = |code: u32| -> bool {
            matches!(code,
                0x21..=0x2F | 0x3A..=0x40 | 0x5B..=0x60 | 0x7B..=0x7E
                    | 0xFF01..=0xFF0F | 0xFF1A..=0xFF20 | 0xFF3B..=0xFF40 | 0xFF5B..=0xFF5E)
        };

        let mut converted = None;
        if to_full {
            if (opts.convert_alnum && alnum_offset(code).is_some() && code < 0x80)
                || (opts.convert_punct && punct(code) && code < 0x80)
            {
                converted = char::from_u32(code + 0xFEE0);
            }
        } else if (opts.convert_alnum && alnum_offset(code).is_some() && code >= 0xFF00)
            || (opts.convert_punct && punct(code) && code >= 0xFF00)
        {
            converted = char::from_u32(code - 0xFEE0);
        }

        match converted {
            Some(next) => {
                out.push(next);
                changed += 1;
            }
            None => out.push(ch),
        }
        index += 1;
    }
    let direction = if to_full {
        "半角→全角"
    } else {
        "全角→半角"
    };
    note_outcome(out, changed, format!("{direction}：转换 {changed} 个字符"))
}

// ---------------------------------------------------------------------------
// 标点与括号
// ---------------------------------------------------------------------------

/// 竖排（U+FE10 区）标点 → 横排写法
const VERTICAL_MAP: [(char, &str); 27] = [
    ('\u{FE10}', "，"),
    ('\u{FE11}', "、"),
    ('\u{FE12}', "。"),
    ('\u{FE13}', "："),
    ('\u{FE14}', "；"),
    ('\u{FE15}', "！"),
    ('\u{FE16}', "？"),
    ('\u{FE17}', "〖"),
    ('\u{FE18}', "〗"),
    ('\u{FE19}', "…"),
    ('\u{FE30}', "‥"),
    ('\u{FE31}', "—"),
    ('\u{FE32}', "–"),
    ('\u{FE33}', "＿"),
    ('\u{FE34}', "＿"),
    ('\u{FE35}', "（"),
    ('\u{FE36}', "）"),
    ('\u{FE37}', "｛"),
    ('\u{FE38}', "｝"),
    ('\u{FE39}', "〔"),
    ('\u{FE3A}', "〕"),
    ('\u{FE3B}', "【"),
    ('\u{FE3C}', "】"),
    ('\u{FE3D}', "《"),
    ('\u{FE3E}', "》"),
    ('\u{FE3F}', "〈"),
    ('\u{FE40}', "〉"),
];

fn vertical_mapping(ch: char) -> Option<&'static str> {
    if let Some((_, mapped)) = VERTICAL_MAP.iter().find(|(from, _)| *from == ch) {
        return Some(*mapped);
    }
    match ch {
        '\u{FE41}' => Some("「"),
        '\u{FE42}' => Some("」"),
        '\u{FE43}' => Some("『"),
        '\u{FE44}' => Some("』"),
        '\u{FE47}' => Some("［"),
        '\u{FE48}' => Some("］"),
        _ => None,
    }
}

fn vertical_to_horizontal(text: &str) -> StepOutcome {
    let mut changed = 0usize;
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match vertical_mapping(ch) {
            Some(to) => {
                out.push_str(to);
                changed += 1;
            }
            None => out.push(ch),
        }
    }
    note_outcome(out, changed, format!("转换 {changed} 个竖排符号"))
}

fn half_quote_to_full(text: &str) -> StepOutcome {
    let mut changed = 0usize;
    let (out, _) = map_lines(text, |line| {
        let mut next = String::with_capacity(line.len());
        let mut double_open = true;
        let mut single_open = true;
        for ch in line.chars() {
            match ch {
                '"' => {
                    next.push(if double_open { '“' } else { '”' });
                    double_open = !double_open;
                    changed += 1;
                }
                '\'' => {
                    next.push(if single_open { '‘' } else { '’' });
                    single_open = !single_open;
                    changed += 1;
                }
                _ => next.push(ch),
            }
        }
        next
    });
    note_outcome(out, changed, format!("转换 {changed} 个半角引号"))
}

/// 括号配对表（开 → 闭）
const BRACKET_PAIRS: [(char, char); 16] = [
    ('(', ')'),
    ('（', '）'),
    ('[', ']'),
    ('［', '］'),
    ('{', '}'),
    ('｛', '｝'),
    ('〈', '〉'),
    ('《', '》'),
    ('「', '」'),
    ('『', '』'),
    ('【', '】'),
    ('〖', '〗'),
    ('〔', '〕'),
    ('“', '”'),
    ('‘', '’'),
    ('<', '>'),
];

fn open_pair(ch: char) -> Option<char> {
    BRACKET_PAIRS
        .iter()
        .find(|(open, _)| *open == ch)
        .map(|(_, close)| *close)
}

fn close_pair(ch: char) -> Option<char> {
    BRACKET_PAIRS
        .iter()
        .find(|(_, close)| *close == ch)
        .map(|(open, _)| *open)
}

fn match_brackets(text: &str) -> StepOutcome {
    let mut issues: Vec<BracketIssue> = Vec::new();
    // 逐行检查：行末未闭合一律报出（每行自成一体）
    for (line_index, (content, _)) in split_lines(text).iter().enumerate() {
        let line_no = line_index + 1;
        let mut stack: Vec<(char, usize)> = Vec::new();
        for (char_index, ch) in content.chars().enumerate() {
            let column = char_index + 1;
            if open_pair(ch).is_some() {
                stack.push((ch, column));
            } else if let Some(expected_open) = close_pair(ch) {
                match stack.pop() {
                    None => issues.push(BracketIssue {
                        line: line_no,
                        column,
                        ch: ch.to_string(),
                        message: format!("第 {line_no} 行第 {column} 列：多余的右括号 `{ch}`"),
                    }),
                    Some((open, open_column)) if open != expected_open => {
                        issues.push(BracketIssue {
                            line: line_no,
                            column,
                            ch: ch.to_string(),
                            message: format!(
                                "第 {line_no} 行第 {column} 列：`{ch}` 与第 {open_column} 列的 `{open}` 不匹配"
                            ),
                        });
                        stack.push((open, open_column));
                    }
                    Some(_) => {}
                }
            }
        }
        for (open, column) in stack {
            issues.push(BracketIssue {
                line: line_no,
                column,
                ch: open.to_string(),
                message: format!("第 {line_no} 行第 {column} 列：`{open}` 未闭合"),
            });
        }
    }
    StepOutcome {
        text: text.to_owned(),
        changed: 0,
        notes: vec![if issues.is_empty() {
            "括号配对检查通过".to_owned()
        } else {
            format!("检出 {} 处括号问题", issues.len())
        }],
        bracket_issues: issues,
    }
}

fn fix_brackets(text: &str, opts: &FixBracketsOptions) -> StepOutcome {
    let ladder: Vec<(char, char)> = {
        let parsed: Vec<(char, char)> = opts
            .ladder
            .iter()
            .filter_map(|pair| {
                let open = pair.open.chars().next()?;
                let close = pair.close.chars().next()?;
                Some((open, close))
            })
            .collect();
        if parsed.is_empty() {
            default_ladder()
                .iter()
                .filter_map(|p| Some((p.open.chars().next()?, p.close.chars().next()?)))
                .collect()
        } else {
            parsed
        }
    };

    // 改写族：半角 / 全角圆括号（OCR 产物里同款嵌套最常见）
    // 追踪族：阶梯中出现过的其他括号样式（「」『』【】…）—— 只用于统计嵌套层数，
    // 内容原样保留，这样「（甲「乙」）」重跑一次不会被改写。
    let rewrite_open = ['(', '（'];
    let rewrite_close = [')', '）'];
    let track_open: Vec<char> = ladder
        .iter()
        .map(|(open, _)| *open)
        .filter(|ch| !rewrite_open.contains(ch))
        .collect();
    let track_close: Vec<char> = ladder
        .iter()
        .map(|(_, close)| *close)
        .filter(|ch| !rewrite_close.contains(ch))
        .collect();

    let mut changed = 0usize;
    let (out, _) = map_lines(text, |line| {
        let mut depth = 0usize;
        let mut next = String::with_capacity(line.len() + 4);
        for ch in line.chars() {
            if rewrite_open.contains(&ch) {
                let (open, _) = ladder[depth % ladder.len()];
                if open != ch {
                    changed += 1;
                }
                next.push(open);
                depth += 1;
            } else if rewrite_close.contains(&ch) {
                if depth == 0 {
                    // 多余的右括号原样保留，不臆造左括号
                    next.push(ch);
                } else {
                    depth -= 1;
                    let (_, close) = ladder[depth % ladder.len()];
                    if close != ch {
                        changed += 1;
                    }
                    next.push(close);
                }
            } else if track_open.contains(&ch) {
                depth += 1;
                next.push(ch);
            } else if track_close.contains(&ch) {
                depth = depth.saturating_sub(1);
                next.push(ch);
            } else {
                next.push(ch);
            }
        }
        if depth > 0 && opts.auto_close {
            for level in (0..depth).rev() {
                let (_, close) = ladder[level % ladder.len()];
                next.push(close);
                changed += 1;
            }
        }
        next
    });
    note_outcome(
        out,
        changed,
        if changed == 0 {
            "括号嵌套已符合阶梯".to_owned()
        } else {
            format!("调整 / 补齐 {changed} 个括号")
        },
    )
}

// ---------------------------------------------------------------------------
// 排版与分段
// ---------------------------------------------------------------------------

fn normalize_line_head(text: &str, opts: &NormalizeHeadOptions) -> StepOutcome {
    let indent: String = std::iter::repeat_n('\u{3000}', opts.indent).collect();
    let (out, changed) = map_lines(text, |line| {
        if opts.skip_blank && is_blank(line) {
            return line.to_owned();
        }
        if !opts.force && starts_with_pad(line) {
            return line.to_owned();
        }
        format!("{indent}{}", line.trim_start_matches(is_pad))
    });
    note_outcome(
        out,
        changed,
        format!("规范 {changed} 行行首（缩进 {} 个全角空格）", opts.indent),
    )
}

fn remove_intra_line_breaks(text: &str, opts: &IntraLineOptions) -> StepOutcome {
    let term = dominant_terminator(text);
    let lines = split_lines(text);
    let trailing = lines.last().is_some_and(|(_, t)| !t.is_empty());

    let mut out = String::with_capacity(text.len());
    let mut paragraph: Vec<String> = Vec::new();
    let mut merged = 0usize;
    let mut paragraph_index = 0usize;

    fn flush(
        out: &mut String,
        paragraph: &mut Vec<String>,
        merged: &mut usize,
        paragraph_index: &mut usize,
        term: &str,
        opts: &IntraLineOptions,
    ) {
        if paragraph.is_empty() {
            return;
        }
        if *paragraph_index > 0 && opts.keep_blank_runs {
            out.push_str(term);
        }
        if !opts.paragraph_prefix.is_empty() {
            out.push_str(&opts.paragraph_prefix);
        }
        *merged += paragraph.len().saturating_sub(1);
        out.push_str(&paragraph.join(&opts.joiner));
        out.push_str(term);
        paragraph.clear();
        *paragraph_index += 1;
    }

    for (content, _) in &lines {
        if is_blank(content) {
            // 保留空行时，空行是段落分隔；不保留时视为段内回车一并删除
            if opts.keep_blank_runs {
                flush(
                    &mut out,
                    &mut paragraph,
                    &mut merged,
                    &mut paragraph_index,
                    term,
                    opts,
                );
            }
            continue;
        }
        paragraph.push((*content).to_owned());
    }
    flush(
        &mut out,
        &mut paragraph,
        &mut merged,
        &mut paragraph_index,
        term,
        opts,
    );
    if !trailing && !out.is_empty() {
        out.truncate(out.len().saturating_sub(term.len()));
    }
    note_outcome(
        out,
        merged,
        format!("合并 {merged} 处段内回车（{paragraph_index} 段）"),
    )
}

/// 对话行起始字符（自动分段时不加段首缩进）
fn is_dialog_start(ch: char) -> bool {
    matches!(ch, '「' | '『' | '“' | '"' | '‘' | '—' | '–' | '（')
}

/// 断句后不应出现在行首的收尾符号
fn is_closing_mark(ch: char) -> bool {
    matches!(
        ch,
        '」' | '』' | '”' | '’' | '）' | '》' | '】' | '〗' | '〕' | '〉' | ')' | '"' | '\''
    )
}

fn auto_segment(text: &str, opts: &SegmentOptions) -> StepOutcome {
    let term = dominant_terminator(text);
    let indent: String = std::iter::repeat_n('\u{3000}', opts.indent).collect();
    let break_chars: Vec<char> = opts.break_after.chars().collect();
    let source_lines = split_lines(text).len();
    let mut produced = 0usize;
    let mut out = String::new();

    for (content, _) in split_lines(text) {
        if is_blank(content) {
            out.push_str(content);
            out.push_str(term);
            continue;
        }
        let chars: Vec<char> = content.chars().collect();
        let mut segment = String::new();
        let mut segments: Vec<String> = Vec::new();
        // 句末标点后若紧跟收尾引号（。」），断句推迟到引号之后
        let mut pending_break = false;
        for (index, ch) in chars.iter().enumerate() {
            // 待断未断：遇到第一个非收尾符号时先断句（保证「。」与后面的引号同行）
            if pending_break && !is_closing_mark(*ch) {
                segments.push(std::mem::take(&mut segment));
                pending_break = false;
            }
            segment.push(*ch);
            let too_long =
                opts.max_segment_chars > 0 && segment.chars().count() >= opts.max_segment_chars;
            if break_chars.contains(ch) {
                let next_is_closer = chars.get(index + 1).is_some_and(|c| is_closing_mark(*c));
                if next_is_closer {
                    pending_break = true;
                    continue;
                }
                segments.push(std::mem::take(&mut segment));
                pending_break = false;
                continue;
            }
            if too_long {
                segments.push(std::mem::take(&mut segment));
                pending_break = false;
            }
        }
        if !segment.is_empty() {
            segments.push(segment);
        }
        for segment in segments {
            let skip_indent =
                opts.skip_dialog && segment.chars().next().is_some_and(is_dialog_start);
            if !skip_indent {
                out.push_str(&indent);
            }
            out.push_str(&segment);
            out.push_str(term);
            produced += 1;
        }
    }
    let added = produced.saturating_sub(source_lines);
    note_outcome(
        out,
        added,
        format!(
            "分段为 {produced} 行（缩进 {} 个全角空格，对话行{}）",
            opts.indent,
            if opts.skip_dialog {
                "不缩进"
            } else {
                "同缩进"
            }
        ),
    )
}

fn control_width(text: &str, opts: &WidthOptions) -> StepOutcome {
    let term = dominant_terminator(text);
    let limit = opts.width.max(1);
    let indent: String = std::iter::repeat_n('\u{3000}', opts.indent).collect();
    let indent_width = display_width(&indent);
    let mut wrapped = 0usize;
    let mut out = String::new();

    for (content, original_term) in split_lines(text) {
        if is_blank(content) {
            out.push_str(content);
            out.push_str(original_term);
            continue;
        }
        let mut lines: Vec<String> = Vec::new();
        let mut buffer = String::new();
        let mut buffer_width = 0usize;
        let chars: Vec<char> = content.chars().collect();
        let mut index = 0usize;
        while index < chars.len() {
            let ch = chars[index];
            let budget = if lines.is_empty() {
                limit
            } else {
                limit.saturating_sub(indent_width).max(1)
            };
            let width = char_width(ch);
            if !buffer.is_empty() && buffer_width + width > budget {
                // 优先在断点标点之后断开（至少保留半行，避免过度回溯）
                let buffer_chars: Vec<char> = buffer.chars().collect();
                let min_keep = (buffer_chars.len() / 2).max(1);
                let mut cut = buffer_chars.len();
                for position in (min_keep..buffer_chars.len()).rev() {
                    if opts.break_after.contains(buffer_chars[position]) {
                        cut = position + 1;
                        break;
                    }
                }
                let tail: String = buffer_chars[cut..].iter().collect();
                lines.push(buffer_chars[..cut].iter().collect());
                wrapped += 1;
                buffer = tail;
                buffer_width = display_width(&buffer);
                // 避头点：断行后若下一字符是避头点，并入上一行
                if buffer.is_empty() && opts.forbid_head.contains(ch) {
                    if let Some(last) = lines.last_mut() {
                        last.push(ch);
                        index += 1;
                        continue;
                    }
                }
                continue;
            }
            buffer.push(ch);
            buffer_width += width;
            index += 1;
        }
        if !buffer.is_empty() {
            lines.push(buffer);
        }
        for (position, line) in lines.iter().enumerate() {
            if position > 0 && !indent.is_empty() {
                out.push_str(&indent);
            }
            out.push_str(line);
            out.push_str(term);
        }
    }
    note_outcome(
        out,
        wrapped,
        format!("按 {} 个半角宽折行，新增 {wrapped} 行", opts.width),
    )
}

fn simple_layout(text: &str, opts: &SimpleLayoutOptions) -> StepOutcome {
    let mut current = text.to_owned();
    let mut changed = 0usize;
    let mut notes: Vec<String> = Vec::new();

    let empty = remove_empty_lines(&current);
    if empty.changed > 0 {
        notes.push(format!("删除 {} 个空行", empty.changed));
    }
    changed += empty.changed;
    current = empty.text;

    let trimmed = trim_lines(&current, true, false);
    if trimmed.changed > 0 {
        notes.push(format!("清理 {} 行行末空格", trimmed.changed));
    }
    changed += trimmed.changed;
    current = trimmed.text;

    let head = normalize_line_head(
        &current,
        &NormalizeHeadOptions {
            indent: opts.indent,
            skip_blank: true,
            force: true,
        },
    );
    if head.changed > 0 {
        notes.push(format!("规范 {} 行行首", head.changed));
    }
    changed += head.changed;
    current = head.text;

    if notes.is_empty() {
        notes.push("无需整理".to_owned());
    }
    StepOutcome {
        text: current,
        changed,
        notes,
        bracket_issues: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// v0.9 排版类工具
// ---------------------------------------------------------------------------

/// 东亚文字（汉字、假名、谚文、CJK 符号与全角区）
fn is_cjk_char(ch: char) -> bool {
    matches!(ch as u32,
        0x1100..=0x11FF
            | 0x2E80..=0x303E
            | 0x3041..=0x33FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA000..=0xA4CF
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE30..=0xFE4F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
            | 0x20000..=0x3FFFD)
}

fn is_latin_char(ch: char) -> bool {
    ch.is_ascii_alphabetic()
}

/// 中文里常用的全角标点（判断「空格该不该挨着它」用）
fn is_full_punct(ch: char) -> bool {
    matches!(
        ch,
        '，' | '。'
            | '！'
            | '？'
            | '；'
            | '：'
            | '、'
            | '（'
            | '）'
            | '【'
            | '】'
            | '《'
            | '》'
            | '「'
            | '」'
            | '『'
            | '』'
            | '“'
            | '”'
            | '‘'
            | '’'
            | '—'
            | '…'
            | '～'
            | '·'
    )
}

/// 一行里「不该动」的位置：行内代码与 URL
///
/// 中英文之间插空格这条规则一旦撞上 `https://…` 或 `` `code` `` 就会把人家的
/// 字符串打散，所以先把这些区间标出来，插空格时跳过。
fn protected_spans(chars: &[char], skip_code: bool) -> Vec<bool> {
    let mut out = vec![false; chars.len()];
    if !skip_code {
        return out;
    }
    // 行内代码：反引号成对
    let mut in_code = false;
    for (index, &ch) in chars.iter().enumerate() {
        if ch == '`' {
            in_code = !in_code;
            out[index] = true;
            continue;
        }
        if in_code {
            out[index] = true;
        }
    }
    // URL：以 http:// https:// www. 开头，直到空白为止
    for index in 0..chars.len() {
        if out[index] {
            continue;
        }
        let head: String = chars[index..].iter().take(8).collect();
        if head.starts_with("http://") || head.starts_with("https://") || head.starts_with("www.") {
            for (offset, &ch) in chars[index..].iter().enumerate() {
                if ch.is_whitespace() {
                    break;
                }
                out[index + offset] = true;
            }
        }
    }
    out
}

/// 按选项给一行补 / 删空格，返回 `(新行, 变更处数)`
///
/// 只在「两边都不是空格且都不在保护区」时插入，因此重复执行结果不变（幂等）。
fn spacing_line(line: &str, o: &SpacingOptions) -> (String, usize) {
    let chars: Vec<char> = line.chars().collect();
    let protected = protected_spans(&chars, o.skip_code);
    let mut out = String::with_capacity(line.len() + 8);
    let mut changed = 0usize;
    for (index, &cur) in chars.iter().enumerate() {
        // 全角标点挨着的半角空格是多余的：删掉
        if o.squeeze_spaces && cur == ' ' && !protected[index] {
            let prev = index.checked_sub(1).and_then(|i| chars.get(i)).copied();
            let next = chars.get(index + 1).copied();
            let near_punct =
                prev.is_some_and(is_full_punct) || next.is_some_and(is_full_punct);
            if near_punct {
                changed += 1;
                continue;
            }
        }
        if index > 0 {
            let prev = chars[index - 1];
            let need_space = prev != ' ' && cur != ' ' && !protected[index] && !protected[index - 1];
            // 全角标点与英文之间不加空格（中文习惯），也避免与「标点后不留空格」互相拉锯
            let boundary = !is_full_punct(prev) && !is_full_punct(cur);
            let cjk_latin = o.cjk_latin
                && ((is_cjk_char(prev) && is_latin_char(cur))
                    || (is_latin_char(prev) && is_cjk_char(cur)));
            let cjk_digit = o.cjk_digit
                && ((is_cjk_char(prev) && cur.is_ascii_digit())
                    || (prev.is_ascii_digit() && is_cjk_char(cur)));
            if need_space && boundary && (cjk_latin || cjk_digit) {
                out.push(' ');
                changed += 1;
            }
        }
        out.push(cur);
    }
    (out, changed)
}

/// 网文排版：补空格 + 缩进行首 + 清理行尾
fn web_novel_layout(text: &str, o: &SpacingOptions) -> StepOutcome {
    let indent: String = "\u{3000}".repeat(o.indent.min(8));
    let mut changed = 0usize;
    let mut indented = 0usize;
    let (out, _) = map_lines(text, |line| {
        let trimmed = if o.trim_end {
            line.trim_end_matches(is_pad)
        } else {
            line
        };
        let (spaced, delta) = spacing_line(trimmed, o);
        changed += delta;
        if trimmed != line {
            changed += 1;
        }
        // 段首缩进：已经有缩进的行不动（幂等）
        if o.indent > 0 && !is_blank(&spaced) && !starts_with_pad(&spaced) {
            indented += 1;
            format!("{indent}{spaced}")
        } else {
            spaced
        }
    });
    let mut notes = vec![format!("补空格 {changed} 处")];
    if o.indent > 0 {
        notes.push(format!("加段首缩进 {indented} 行"));
    }
    note_outcome(out, changed + indented, notes.join("；"))
}

/// 省略号与破折号规范化（GB/T 15834-2011）
///
/// - `...` / `。。。` / 单个 `…` → `……`（六点，占两格）
/// - 两个及以上连续 `-` → `——`；只有一个 `-` 不动（可能是连字符）
fn fix_ellipsis_dash(line: &str) -> (String, usize) {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut changed = 0usize;
    let mut index = 0usize;
    while index < chars.len() {
        let cur = chars[index];
        // 省略号：三个半角点
        if cur == '.'
            && chars.get(index + 1) == Some(&'.')
            && chars.get(index + 2) == Some(&'.')
            && chars.get(index + 3) != Some(&'.')
        {
            out.push_str("……");
            changed += 1;
            index += 3;
            continue;
        }
        // 省略号：中文句号连用 / 单个 … / 奇数个 …
        if cur == '…' || cur == '。' {
            let mut run = 0usize;
            while matches!(chars.get(index + run), Some('…') | Some('。')) {
                run += 1;
            }
            if run >= 2 {
                out.push_str("……");
                changed += 1;
                index += run;
                continue;
            }
        }
        // 破折号：连续两个及以上半角减号
        if cur == '-' && chars.get(index + 1) == Some(&'-') {
            let mut run = 0usize;
            while chars.get(index + run) == Some(&'-') {
                run += 1;
            }
            out.push_str("——");
            changed += 1;
            index += run;
            continue;
        }
        out.push(cur);
        index += 1;
    }
    (out, changed)
}

/// 半角标点转全角（只动「挨着中文」的那些，英文句子里的不动）
fn half_punct_to_full(line: &str) -> (String, usize) {
    const MAP: [(char, char); 10] = [
        (',', '，'),
        (';', '；'),
        (':', '：'),
        ('?', '？'),
        ('!', '！'),
        ('(', '（'),
        (')', '）'),
        ('[', '［'),
        (']', '］'),
        ('~', '～'),
    ];
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut changed = 0usize;
    for (index, &cur) in chars.iter().enumerate() {
        let mapped = MAP.iter().find(|(from, _)| *from == cur).map(|(_, to)| *to);
        match mapped {
            Some(to) => {
                let prev = index.checked_sub(1).and_then(|i| chars.get(i)).copied();
                let next = chars.get(index + 1).copied();
                let near_cjk = prev.is_some_and(is_cjk_char) || next.is_some_and(is_cjk_char);
                if near_cjk {
                    out.push(to);
                    changed += 1;
                } else {
                    out.push(cur);
                }
            }
            None => out.push(cur),
        }
    }
    (out, changed)
}

/// 直引号按前后文配成对（沿用「半角引号转全角」的配对思路，只是引号样式可选）
fn pair_quotes(line: &str, style: QuoteStyle) -> (String, usize) {
    let (open2, close2, open1, close1) = match style {
        QuoteStyle::Mainland => ('“', '”', '‘', '’'),
        QuoteStyle::Corner => ('「', '」', '『', '』'),
        QuoteStyle::Keep => return (line.to_owned(), 0),
    };
    let mut out = String::with_capacity(line.len());
    let mut changed = 0usize;
    let mut double_open = true;
    let mut single_open = true;
    for ch in line.chars() {
        match ch {
            '"' => {
                out.push(if double_open { open2 } else { close2 });
                double_open = !double_open;
                changed += 1;
            }
            '\'' => {
                out.push(if single_open { open1 } else { close1 });
                single_open = !single_open;
                changed += 1;
            }
            other => out.push(other),
        }
    }
    (out, changed)
}

/// 规范标点（GB/T 15834-2011）
fn normalize_punctuation(text: &str, o: &PunctOptions) -> StepOutcome {
    let mut changed = 0usize;
    let mut current = String::new();
    for (content, term) in split_lines(text) {
        let mut line = content.to_owned();
        if o.vertical_to_horizontal {
            let mut converted = String::with_capacity(line.len());
            for ch in line.chars() {
                match vertical_mapping(ch) {
                    Some(to) => {
                        converted.push_str(to);
                        changed += 1;
                    }
                    None => converted.push(ch),
                }
            }
            line = converted;
        }
        let (quoted, delta) = pair_quotes(&line, o.quote_style);
        changed += delta;
        line = quoted;
        if o.fix_ellipsis {
            let (fixed, delta) = fix_ellipsis_dash(&line);
            changed += delta;
            line = fixed;
        }
        if o.half_to_full_punct {
            let (fixed, delta) = half_punct_to_full(&line);
            changed += delta;
            line = fixed;
        }
        current.push_str(&line);
        current.push_str(term);
    }

    let mut bracket_issues: Vec<BracketIssue> = Vec::new();
    if o.check_brackets {
        bracket_issues = match_brackets(&current).bracket_issues;
    }
    if o.fix_brackets {
        let fixed = fix_brackets(&current, &FixBracketsOptions::default());
        changed += fixed.changed;
        current = fixed.text;
    }

    let mut notes = vec![format!("规范标点 {changed} 处")];
    if !bracket_issues.is_empty() {
        notes.push(format!("括号配对有 {} 处可疑", bracket_issues.len()));
    }
    if o.check_brackets && bracket_issues.is_empty() {
        notes.push("括号配对正常".to_owned());
    }
    StepOutcome {
        text: current,
        changed,
        notes,
        bracket_issues,
    }
}

/// 数字与英文单位之间补空格（100kg → 100 kg）
fn space_digit_unit(line: &str) -> (String, usize) {
    const UNITS: [&str; 12] = ["kg", "cm", "mm", "km", "px", "ms", "GB", "MB", "KB", "TB", "Hz", "GHz"];
    let lower = line.to_lowercase();
    let chars: Vec<char> = line.chars().collect();
    let lower_chars: Vec<char> = lower.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut changed = 0usize;
    let mut index = 0usize;
    while index < chars.len() {
        let cur = chars[index];
        if cur.is_ascii_digit() {
            // 吃掉整个数字串
            let start = index;
            while index < chars.len() && chars[index].is_ascii_digit() {
                index += 1;
            }
            out.push_str(&chars[start..index].iter().collect::<String>());
            // 数字后紧跟单位？
            let rest: String = lower_chars[index..].iter().take(3).collect();
            if let Some(unit) = UNITS.iter().find(|u| rest.starts_with(*u)) {
                let len = unit.chars().count();
                let after = chars.get(index + len).copied();
                // 单位后面必须是非字母（避免把 kilogram 切成 kg ram）
                if after.is_none_or(|c| !c.is_ascii_alphabetic()) {
                    out.push(' ');
                    changed += 1;
                }
            }
            continue;
        }
        out.push(cur);
        index += 1;
    }
    (out, changed)
}

/// 中文文案（chinese-copywriting-guidelines 常用子集）
fn chinese_copywriting(text: &str, o: &CopywritingOptions) -> StepOutcome {
    let mut changed = 0usize;
    let mut current = String::new();
    for (content, term) in split_lines(text) {
        let mut line = content.to_owned();
        if o.ellipsis_and_dash {
            let (fixed, delta) = fix_ellipsis_dash(&line);
            changed += delta;
            line = fixed;
        }
        if o.dedup_punct {
            let mut out = String::with_capacity(line.len());
            let mut prev: Option<char> = None;
            for ch in line.chars() {
                let dup = matches!(ch, '！' | '？' | '，' | '。' | '；' | '：' | '、')
                    && prev == Some(ch);
                if dup {
                    changed += 1;
                    continue;
                }
                out.push(ch);
                prev = Some(ch);
            }
            line = out;
        }
        if o.digit_unit {
            let (fixed, delta) = space_digit_unit(&line);
            changed += delta;
            line = fixed;
        }
        // 中英 / 中数空格与「标点后不留空格」共用网文排版的核心
        let spaced = spacing_line(
            &line,
            &SpacingOptions {
                cjk_latin: o.space_cjk_latin,
                cjk_digit: o.space_cjk_digit,
                squeeze_spaces: o.no_space_after_punct,
                trim_end: false,
                indent: 0,
                skip_code: true,
            },
        );
        changed += spaced.1;
        current.push_str(&spaced.0);
        current.push_str(term);
    }
    note_outcome(current, changed, format!("中文文案规范 {changed} 处"))
}

/// 代码围栏行？（``` 或 ~~~ 开头）
fn is_fence_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

/// 技术文档（Markdown 排版规约）
fn tech_doc_layout(text: &str, o: &TechDocOptions) -> StepOutcome {
    let lines = split_lines(text);
    let term = dominant_terminator(text);
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut in_fence = false;
    let mut changed = 0usize;

    for (content, _) in &lines {
        let original = *content;
        if is_fence_line(original) {
            // 围栏前后留一个空行（幂等：已经有空行就不补）
            if o.fence_blank && out.last().is_some_and(|prev| !prev.trim().is_empty()) {
                out.push(String::new());
                changed += 1;
            }
            out.push(original.to_owned());
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            out.push(original.to_owned());
            continue;
        }

        let mut line = original.to_owned();
        if o.heading_space {
            let hashes = line.chars().take_while(|c| *c == '#').count();
            if hashes > 0 {
                let rest: String = line.chars().skip(hashes).collect();
                if !rest.is_empty() && !rest.starts_with(' ') {
                    line = format!("{} {}", "#".repeat(hashes), rest);
                    changed += 1;
                }
            }
        }
        if o.list_marker {
            let lead = line.chars().take_while(|c| *c == ' ' || *c == '\t').count();
            let rest: String = line.chars().skip(lead).collect();
            let marker = rest.chars().next();
            if matches!(marker, Some('*') | Some('+')) && rest.chars().nth(1) == Some(' ') {
                let body: String = rest.chars().skip(2).collect();
                line = format!("{}- {}", &line[..lead], body);
                changed += 1;
            }
        }
        if o.trim_end {
            let trimmed = line.trim_end_matches(is_pad).to_owned();
            if trimmed != line {
                changed += 1;
                line = trimmed;
            }
        }
        if o.cjk_space {
            let (spaced, delta) = spacing_line(
                &line,
                &SpacingOptions {
                    cjk_latin: true,
                    cjk_digit: true,
                    squeeze_spaces: false,
                    trim_end: false,
                    indent: 0,
                    skip_code: true,
                },
            );
            changed += delta;
            line = spaced;
        }
        // 围栏行之后的空行（收尾）
        out.push(line);
    }

    let trailing = lines.last().is_some_and(|(_, t)| !t.is_empty());
    let mut text = join_lines(&out, term, trailing);
    if o.final_newline && !text.is_empty() && !text.ends_with('\n') && !text.ends_with('\r') {
        text.push_str(term);
        changed += 1;
    }
    note_outcome(text, changed, format!("技术文档排版 {changed} 处"))
}

/// 片段处理：把原来散在菜单里的行级细项按顺序串起来
fn snippet_process(text: &str, o: &SnippetOptions) -> StepOutcome {
    let mut current = text.to_owned();
    let mut changed_total = 0usize;
    let mut notes: Vec<String> = Vec::new();

    // 用宏而不是闭包：闭包会一直持有 `current` 的可变借用，
    // 而每一步都要先「读 current」再「写回 current」，借用会打架。
    macro_rules! apply {
        ($outcome:expr, $label:expr) => {{
            let outcome = $outcome;
            if outcome.changed > 0 {
                notes.push(format!("{} {}", $label, outcome.changed));
            }
            changed_total += outcome.changed;
            current = outcome.text;
        }};
    }

    if o.trim_head || o.trim_end {
        apply!(trim_lines(&current, o.trim_end, o.trim_head), "清理空格");
    }
    if o.remove_half_width {
        apply!(
            remove_half_width(&current, &HalfWidthOptions { mode: o.half_width_mode }),
            "删除半角"
        );
    }
    if o.remove_empty {
        apply!(remove_empty_lines(&current), "删除空行");
    }
    if o.dedup {
        apply!(dedup_lines(&current, &DedupOptions::default()), "去重");
    }
    if o.sort {
        apply!(
            sort_lines(
                &current,
                &SortLinesOptions {
                    mode: o.sort_mode,
                    ignore_surrounding_space: false,
                },
            ),
            "排序"
        );
    }
    if o.join_lines {
        apply!(
            remove_intra_line_breaks(&current, &IntraLineOptions::default()),
            "合并段内回车"
        );
    }
    if o.insert_blank {
        apply!(insert_blank_between(&current), "段间空行");
    }

    if notes.is_empty() {
        notes.push("没有需要处理的片段".to_owned());
    }
    note_outcome(current, changed_total, notes.join("；"))
}

// ---------------------------------------------------------------------------
// 单测
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试便捷入口：`(步骤, 文本)` 顺序（正式 API 是 `(文本, 步骤)`）
    fn run_step_of(step: PipelineStep, text: &str) -> AppResult<StepOutcome> {
        run_step(text, &step)
    }

    fn run(step: PipelineStep, text: &str) -> String {
        run_step_of(step, text).unwrap().text
    }

    fn by_id(id: &str, text: &str) -> String {
        run(from_id(id).unwrap(), text)
    }

    // ---- 目录与序列化 ----

    /// 菜单上露出的项（v0.9 起是精选的 11 项）
    #[test]
    fn catalog_covers_every_step_kind() {
        let metas = catalog();
        assert_eq!(metas.len(), 11, "菜单上应露出 11 项");
        let mut ids: Vec<&str> = metas.iter().map(|m| m.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 11, "工具标识必须唯一");
        for id in ids {
            let step = from_id(id).expect("目录中的标识必须可构造");
            assert_eq!(step.id(), id);
            let json = serde_json::to_value(&step).unwrap();
            assert_eq!(
                json.get("kind").and_then(|v| v.as_str()),
                Some(id),
                "serde kind 与 id 不一致：{id}"
            );
        }
    }

    /// 收进工具内部的步骤（片段处理 / 规范标点用得到，批处理 F-08 也会选）
    /// 必须照样能构造出来 —— 菜单不露出 ≠ 能力被删掉。
    #[test]
    fn internal_steps_are_still_constructible() {
        for id in [
            "trim_line_head",
            "trim_line_end",
            "dedup_lines",
            "sort_lines",
            "remove_half_width",
            "normalize_line_head",
            "remove_intra_line_breaks",
            "auto_segment",
            "control_width",
            "match_brackets",
            "fix_brackets",
            "half_quote_to_full",
            "vertical_to_horizontal",
        ] {
            let step = from_id(id).unwrap_or_else(|_| panic!("{id} 必须可构造"));
            assert_eq!(step.id(), id);
        }
    }

    #[test]
    fn step_deserializes_with_defaults() {
        // 前端只发 kind 时应取默认选项
        let step: PipelineStep = serde_json::from_str(r#"{"kind":"half_to_full"}"#).unwrap();
        assert_eq!(
            step,
            PipelineStep::HalfToFull(FullHalfOptions {
                convert_alnum: true,
                convert_punct: false,
                merge_spaces: true
            })
        );
        let step: PipelineStep =
            serde_json::from_str(r#"{"kind":"control_width","width":12,"indent":2}"#).unwrap();
        match step {
            PipelineStep::ControlWidth(opts) => {
                assert_eq!(opts.width, 12);
                assert_eq!(opts.indent, 2);
                assert!(opts.break_after.contains('，'), "未给出的选项应取默认值");
            }
            other => panic!("解析结果不对：{other:?}"),
        }
        assert!(serde_json::from_str::<PipelineStep>(r#"{"kind":"nope"}"#).is_err());
    }

    // ---- v0.9 排版类工具 ----

    #[test]
    fn normalize_punctuation_follows_gb_t_15834() {
        // 引号配对 + 省略号 + 破折号 + 半角标点（挨着中文的）转全角
        assert_eq!(
            by_id("normalize_punctuation", "他说\"你好\",真的吗?"),
            "他说“你好”，真的吗？"
        );
        assert_eq!(by_id("normalize_punctuation", "等等..."), "等等……");
        assert_eq!(by_id("normalize_punctuation", "他--走了"), "他——走了");
        // 英文句子里的半角标点不动
        assert_eq!(by_id("normalize_punctuation", "hello, world"), "hello, world");
        // 竖排符号横转
        assert_eq!(by_id("normalize_punctuation", "甲︐乙"), "甲，乙");
    }

    #[test]
    fn normalize_punctuation_is_idempotent() {
        let sample = "他说\"你好\"...真的吗?他--走了\n甲︐乙";
        let once = by_id("normalize_punctuation", sample);
        assert_eq!(by_id("normalize_punctuation", &once), once);
    }

    #[test]
    fn web_novel_layout_adds_spaces_and_indent() {
        // 只补空格、不动缩进
        let no_indent = run(
            PipelineStep::WebNovelLayout(SpacingOptions {
                indent: 0,
                ..SpacingOptions::default()
            }),
            "中文abc混合",
        );
        assert_eq!(no_indent, "中文 abc 混合");
        // 段首缩进（全角空格 ×2）+ 中数之间补空格
        assert_eq!(by_id("web_novel_layout", "第1章"), "\u{3000}\u{3000}第 1 章");
    }

    #[test]
    fn web_novel_layout_leaves_urls_and_code_alone() {
        let text = "见 https://a.com/x?y=1 与 `中文abc` 内";
        let out = run(
            PipelineStep::WebNovelLayout(SpacingOptions {
                indent: 0,
                ..SpacingOptions::default()
            }),
            text,
        );
        assert_eq!(out, text);
    }

    #[test]
    fn web_novel_layout_is_idempotent() {
        let sample = "第1章 中文abc\n第二行def";
        let once = by_id("web_novel_layout", sample);
        assert_eq!(by_id("web_novel_layout", &once), once, "缩进不该越加越多");
    }

    #[test]
    fn chinese_copywriting_normalizes_text() {
        // 中英空格 + 标点后不留空格 + 重复标点合并 + 数字与单位
        assert_eq!(
            by_id("chinese_copywriting", "中文， abc！！重量100kg"),
            "中文，abc！重量 100 kg"
        );
        assert_eq!(by_id("chinese_copywriting", "等等..."), "等等……");
        // 不该把 kilogram 切成 kg ram
        assert_eq!(by_id("chinese_copywriting", "100kilogram"), "100kilogram");
    }

    #[test]
    fn chinese_copywriting_is_idempotent() {
        let sample = "中文， abc！！重量100kg...嗯--好";
        let once = by_id("chinese_copywriting", sample);
        assert_eq!(by_id("chinese_copywriting", &once), once);
    }

    #[test]
    fn tech_doc_layout_normalizes_markdown() {
        let text = "#标题\n* 项目\n```\ncode中文\n```\n";
        let out = by_id("tech_doc_layout", text);
        assert_eq!(out, "# 标题\n- 项目\n\n```\ncode中文\n\n```\n");
    }

    #[test]
    fn tech_doc_layout_is_idempotent() {
        let sample = "#标题\n* 项目\n```\ncode中文\n```\n";
        let once = by_id("tech_doc_layout", sample);
        assert_eq!(by_id("tech_doc_layout", &once), once);
    }

    #[test]
    fn snippet_process_combines_line_steps() {
        // 默认：清理行首行末 + 删除空行
        assert_eq!(by_id("snippet_process", "  b  \n  a  \n\nb"), "b\na\nb");
        // 去重 + 排序（默认选项关着，这里显式打开）
        let opts = SnippetOptions {
            dedup: true,
            sort: true,
            ..SnippetOptions::default()
        };
        assert_eq!(
            run(PipelineStep::SnippetProcess(opts), "b\na\nb"),
            "a\nb"
        );
    }

    #[test]
    fn trim_both_clears_head_and_tail() {
        assert_eq!(by_id("trim_both", "  a  \n\u{3000}b\t"), "a\nb");
    }

    #[test]
    fn unknown_tool_id_is_rejected() {
        assert!(from_id("no_such_tool").is_err());
    }

    #[test]
    fn match_brackets_is_inspect_only() {
        assert!(from_id("match_brackets").unwrap().inspects_only());
        assert!(!from_id("trim_line_end").unwrap().inspects_only());
    }

    // ---- 行尾符保真 ----

    #[test]
    fn split_lines_round_trips() {
        for text in ["", "a", "a\n", "a\r\nb", "a\rb\n", "a\r\n\r\nb\r\n"] {
            let restored: String = split_lines(text)
                .iter()
                .map(|(content, term)| format!("{content}{term}"))
                .collect();
            assert_eq!(restored, text, "行拆分未保真：{text:?}");
        }
        assert_eq!(dominant_terminator("a\r\nb"), "\r\n");
        assert_eq!(dominant_terminator("a\nb"), "\n");
        assert_eq!(dominant_terminator("甲"), "\n");
    }

    #[test]
    fn line_tools_keep_crlf() {
        assert_eq!(by_id("trim_line_end", "甲  \r\n乙 \r\n"), "甲\r\n乙\r\n");
        assert_eq!(
            by_id("remove_empty_lines", "甲\r\n\r\n乙\r\n"),
            "甲\r\n乙\r\n"
        );
        assert_eq!(by_id("trim_line_head", "  甲\n 乙"), "甲\n乙");
        assert_eq!(by_id("normalize_line_head", "甲\r\n乙"), "　　甲\r\n　　乙");
    }

    // ---- 行处理 ----

    #[test]
    fn trim_handles_half_and_full_width_pad() {
        assert_eq!(by_id("trim_line_head", "　　甲"), "甲");
        assert_eq!(by_id("trim_line_end", "甲　　"), "甲");
        assert_eq!(by_id("trim_line_end", "甲   "), "甲");
        // 行内空格不动
        assert_eq!(by_id("trim_line_end", "甲 乙 "), "甲 乙");
    }

    #[test]
    fn remove_empty_lines_removes_blank_and_space_only_lines() {
        let out = run_step_of(PipelineStep::RemoveEmptyLines, "甲\n\n　\n   \n乙\n").unwrap();
        assert_eq!(out.text, "甲\n乙\n");
        assert_eq!(out.changed, 3);
        assert!(out.notes[0].contains("删除 3 个空行"));
    }

    #[test]
    fn insert_blank_between_adds_and_collapses() {
        // 每段 = 一个非空行：缺的空行补上、多的合并掉
        let out = by_id("insert_blank_between", "甲\n乙\n\n\n丙\n");
        assert_eq!(out, "甲\n\n乙\n\n丙\n");
        // 幂等
        assert_eq!(by_id("insert_blank_between", &out), out);
        // 单换行分隔的两段之间**必须**插入空行（用户反馈的 bug）
        assert_eq!(by_id("insert_blank_between", "甲\n乙"), "甲\n\n乙");
        // 只是一段时原样返回
        assert_eq!(by_id("insert_blank_between", "甲"), "甲");
        // CRLF 沿用原文行尾
        assert_eq!(by_id("insert_blank_between", "甲\r\n乙"), "甲\r\n\r\n乙");
    }

    #[test]
    fn dedup_keeps_first_by_default() {
        assert_eq!(by_id("dedup_lines", "甲\n乙\n甲\n丙\n"), "甲\n乙\n丙\n");
        let keep_last = run(
            PipelineStep::DedupLines(DedupOptions {
                keep_last: true,
                ..DedupOptions::default()
            }),
            "甲\n乙\n甲\n",
        );
        assert_eq!(keep_last, "乙\n甲\n");
        // 空行也是独立的一行：删掉重复的「甲」后空行保留
        assert_eq!(by_id("dedup_lines", "甲\n\n甲\n"), "甲\n\n");
        assert_eq!(by_id("dedup_lines", "甲\n\n甲\n\n"), "甲\n\n");
    }

    #[test]
    fn dedup_can_trim_and_ignore_case() {
        let opts = DedupOptions {
            trim: true,
            ignore_case: true,
            keep_last: false,
        };
        let out = run(PipelineStep::DedupLines(opts), "Ab\nab \nCD\n");
        assert_eq!(out.lines().count(), 2);
    }

    #[test]
    fn sort_lines_modes() {
        // 码位：丙 U+4E19 < 乙 U+4E59 < 甲 U+7532
        assert_eq!(by_id("sort_lines", "甲\n乙\n丙\n"), "丙\n乙\n甲\n");
        assert_eq!(
            run(
                PipelineStep::SortLines(SortLinesOptions {
                    mode: SortMode::LengthAsc,
                    ignore_surrounding_space: false,
                }),
                "甲乙丙\n甲\n甲乙\n"
            ),
            "甲\n甲乙\n甲乙丙\n"
        );
        assert_eq!(
            run(
                PipelineStep::SortLines(SortLinesOptions {
                    mode: SortMode::Reverse,
                    ignore_surrounding_space: false,
                }),
                "甲\n乙\n丙\n"
            ),
            "甲\n乙\n丙\n"
        );
    }

    // ---- 空格与全半角 ----

    #[test]
    fn remove_half_width_modes() {
        assert_eq!(
            run(
                PipelineStep::RemoveHalfWidth(HalfWidthOptions {
                    mode: HalfWidthMode::Alnum
                }),
                "abc 甲 １"
            ),
            " 甲 １"
        );
        assert_eq!(
            run(
                PipelineStep::RemoveHalfWidth(HalfWidthOptions {
                    mode: HalfWidthMode::Punct
                }),
                "a,b.甲"
            ),
            "ab甲"
        );
        // All 模式保留空格与制表符
        assert_eq!(
            run(
                PipelineStep::RemoveHalfWidth(HalfWidthOptions {
                    mode: HalfWidthMode::All
                }),
                "a b,\t甲"
            ),
            " \t甲"
        );
    }

    #[test]
    fn full_to_half_defaults_keep_chinese_punctuation() {
        assert_eq!(by_id("full_to_half", "ＡＢＣ１２３"), "ABC123");
        // 全角空格 → 两个半角
        assert_eq!(by_id("full_to_half", "甲　乙"), "甲  乙");
        // 中文标点（全角逗号 U+FF0C）默认不动
        assert_eq!(by_id("full_to_half", "甲，乙。"), "甲，乙。");
        // 显式打开标点转换才会动
        let punct = run(
            PipelineStep::FullToHalf(FullHalfOptions {
                convert_alnum: true,
                convert_punct: true,
                merge_spaces: true,
            }),
            "甲，乙！",
        );
        assert_eq!(punct, "甲,乙!");
    }

    #[test]
    fn half_to_full_options() {
        assert_eq!(by_id("half_to_full", "abc"), "ａｂｃ");
        // 默认转字母数字、不动标点
        assert_eq!(by_id("half_to_full", "a,b"), "ａ,ｂ");
        // 关闭字母数字转换
        assert_eq!(
            run(
                PipelineStep::HalfToFull(FullHalfOptions {
                    convert_alnum: false,
                    convert_punct: false,
                    merge_spaces: true,
                }),
                "a,b"
            ),
            "a,b"
        );
        // 打开标点转换
        assert_eq!(
            run(
                PipelineStep::HalfToFull(FullHalfOptions {
                    convert_alnum: false,
                    convert_punct: true,
                    merge_spaces: true,
                }),
                "a,b"
            ),
            "a，b"
        );
        // 合并半角空格：两格合一全角，落单保留
        assert_eq!(by_id("half_to_full", "甲  乙 丙"), "甲　乙 丙");
        assert_eq!(
            run(
                PipelineStep::HalfToFull(FullHalfOptions {
                    merge_spaces: false,
                    ..FullHalfOptions::default()
                }),
                "甲  乙"
            ),
            "甲  乙"
        );
    }

    // ---- 标点与括号 ----

    #[test]
    fn vertical_forms_convert_to_horizontal() {
        assert_eq!(
            by_id("vertical_to_horizontal", "\u{FE10}\u{FE12}\u{FE16}"),
            "，。？"
        );
        // ﹁﹂ 是竖排直角引号（→「」），﹃﹄ 是竖排白直角引号（→『』）
        assert_eq!(
            by_id("vertical_to_horizontal", "﹁甲﹂﹃乙﹄"),
            "「甲」『乙』"
        );
        assert_eq!(
            by_id("vertical_to_horizontal", "︵甲︶︻乙︼"),
            "（甲）【乙】"
        );
        // 普通文本不受影响
        assert_eq!(by_id("vertical_to_horizontal", "甲乙。"), "甲乙。");
    }

    #[test]
    fn half_quotes_become_curly_pairs() {
        assert_eq!(by_id("half_quote_to_full", r#""甲" "乙""#), "“甲” “乙”");
        assert_eq!(by_id("half_quote_to_full", "'甲'"), "‘甲’");
        // 每行重新配对
        assert_eq!(by_id("half_quote_to_full", "\"甲\n\"乙"), "“甲\n“乙");
    }

    #[test]
    fn match_brackets_reports_problems() {
        let ok = run_step_of(PipelineStep::MatchBrackets, "甲（乙「丙」）").unwrap();
        assert!(ok.bracket_issues.is_empty());
        assert_eq!(ok.text, "甲（乙「丙」）");
        assert!(ok.notes[0].contains("通过"));

        let bad = run_step_of(PipelineStep::MatchBrackets, "甲（乙\n丙）\n丁」").unwrap();
        assert_eq!(bad.bracket_issues.len(), 3, "{:?}", bad.bracket_issues);
        assert_eq!(bad.bracket_issues[0].line, 1);
        assert!(bad.bracket_issues[0].message.contains("未闭合"));
        assert!(bad.bracket_issues[2].message.contains("多余"));
    }

    #[test]
    fn fix_brackets_ladders_and_auto_closes() {
        assert_eq!(
            by_id("fix_brackets", "（甲（乙（丙）））"),
            "（甲「乙『丙』」）"
        );
        assert_eq!(by_id("fix_brackets", "（甲「乙"), "（甲「乙」）");
        // 多余的右括号原样保留
        assert_eq!(by_id("fix_brackets", "甲）乙"), "甲）乙");
        // 半角圆括号也参与（统一为阶梯样式）
        assert_eq!(by_id("fix_brackets", "(甲(乙))"), "（甲「乙」）");
        // 关闭自动补齐
        assert_eq!(
            run(
                PipelineStep::FixBrackets(FixBracketsOptions {
                    auto_close: false,
                    ..FixBracketsOptions::default()
                }),
                "（甲"
            ),
            "（甲"
        );
    }

    #[test]
    fn fix_brackets_is_idempotent_on_ladder_styles() {
        // 已经是阶梯样式的文本不应被改写（含已配对好的内层括号）
        for text in [
            "（甲「乙」）",
            "（甲「乙『丙』」）",
            "【独立白括号】保持不变",
            "普通（圆括号）与「直角引号」混排",
        ] {
            let once = by_id("fix_brackets", text);
            assert_eq!(once, text, "首次运行改写了本不该动的文本");
            assert_eq!(by_id("fix_brackets", &once), once, "二次运行不幂等");
        }
        // 未闭合的阶梯样式也会被补齐
        assert_eq!(by_id("fix_brackets", "（甲「乙"), "（甲「乙」）");
    }

    // ---- 排版与分段 ----

    #[test]
    fn normalize_line_head_indent() {
        assert_eq!(
            by_id("normalize_line_head", "甲\n　　乙\n\n丙"),
            "　　甲\n　　乙\n\n　　丙"
        );
        // force = false：只给完全没有缩进的行加
        assert_eq!(
            run(
                PipelineStep::NormalizeLineHead(NormalizeHeadOptions {
                    indent: 2,
                    skip_blank: true,
                    force: false,
                }),
                "甲\n　　乙"
            ),
            "　　甲\n　　乙"
        );
        // indent = 0 → 删除行首缩进；且不动行末空格
        assert_eq!(
            run(
                PipelineStep::NormalizeLineHead(NormalizeHeadOptions {
                    indent: 0,
                    skip_blank: true,
                    force: true,
                }),
                "　　甲 "
            ),
            "甲 "
        );
    }

    #[test]
    fn remove_intra_line_breaks_merges_paragraphs() {
        let out = run_step_of(
            PipelineStep::RemoveIntraLineBreaks(IntraLineOptions::default()),
            "甲一\n甲二\n\n乙一\n乙二\n",
        )
        .unwrap();
        assert_eq!(out.text, "甲一甲二\n\n乙一乙二\n");
        assert_eq!(out.changed, 2);

        assert_eq!(
            run(
                PipelineStep::RemoveIntraLineBreaks(IntraLineOptions {
                    keep_blank_runs: true,
                    joiner: "／".to_owned(),
                    paragraph_prefix: "　　".to_owned(),
                }),
                "甲一\n甲二\n"
            ),
            "　　甲一／甲二\n"
        );

        // 不保留空行 → 空行也当段内回车删掉
        assert_eq!(
            run(
                PipelineStep::RemoveIntraLineBreaks(IntraLineOptions {
                    keep_blank_runs: false,
                    ..IntraLineOptions::default()
                }),
                "甲\n\n乙\n"
            ),
            "甲乙\n"
        );
    }

    #[test]
    fn auto_segment_splits_and_indents() {
        let out = run_step_of(
            PipelineStep::AutoSegment(SegmentOptions {
                indent: 2,
                break_after: "。！？".to_owned(),
                skip_dialog: true,
                max_segment_chars: 0,
            }),
            "甲一。甲二！\n「对话。」乙。\n",
        )
        .unwrap();
        // 收尾引号不另起一行；对话行不加缩进
        assert_eq!(out.text, "　　甲一。\n　　甲二！\n「对话。」\n　　乙。\n");
        assert_eq!(out.changed, 2);
    }

    #[test]
    fn auto_segment_respects_max_chars() {
        assert_eq!(
            run(
                PipelineStep::AutoSegment(SegmentOptions {
                    indent: 0,
                    break_after: "。".to_owned(),
                    skip_dialog: false,
                    max_segment_chars: 3,
                }),
                "甲乙丙丁戊。"
            ),
            "甲乙丙\n丁戊。\n"
        );
    }

    #[test]
    fn control_width_wraps_at_cjk_boundary() {
        assert_eq!(
            run(
                PipelineStep::ControlWidth(WidthOptions {
                    width: 10,
                    indent: 0,
                    break_after: "，".to_owned(),
                    forbid_head: "，".to_owned(),
                }),
                "甲乙丙丁，戊己庚辛壬癸\n"
            ),
            "甲乙丙丁，\n戊己庚辛壬\n癸\n"
        );
    }

    #[test]
    fn control_width_keeps_short_lines_and_indents_continuations() {
        assert_eq!(by_id("control_width", "短行\n"), "短行\n");
        assert_eq!(
            run(
                PipelineStep::ControlWidth(WidthOptions {
                    width: 6,
                    indent: 1,
                    break_after: String::new(),
                    forbid_head: String::new(),
                }),
                "甲甲甲甲甲甲\n"
            ),
            // 续行缩进 1 个全角空格（占 2 个半角宽），故续行预算为 6-2=4 → 2 字
            "甲甲甲\n　甲甲\n　甲\n"
        );
    }

    #[test]
    fn defaults_match_spec() {
        // 默认值即「菜单里直接点一下」的效果，必须与 F-09 一致
        assert_eq!(
            SimpleLayoutOptions::default().indent,
            2,
            "简单排版默认缩进两个全角空格"
        );
        assert_eq!(NormalizeHeadOptions::default().indent, 2);
        assert_eq!(SegmentOptions::default().indent, 2);
        assert_eq!(WidthOptions::default().width, 40);
        assert_eq!(
            FullHalfOptions::default(),
            FullHalfOptions {
                convert_alnum: true,
                convert_punct: false,
                merge_spaces: true
            }
        );
        assert_eq!(
            DedupOptions::default(),
            DedupOptions {
                trim: false,
                ignore_case: false,
                keep_last: false
            }
        );
        // 默认设置下「简单排版」会加两个全角空格缩进
        assert_eq!(by_id("simple_layout", "甲\n"), "　　甲\n");
    }

    #[test]
    fn simple_layout_composes_three_steps() {
        let out = run_step_of(
            PipelineStep::SimpleLayout(SimpleLayoutOptions { indent: 2 }),
            "　　甲 \n\n　\n乙结尾  \n",
        )
        .unwrap();
        assert_eq!(out.text, "　　甲\n　　乙结尾\n");
        assert!(out.notes.len() >= 3, "{:?}", out.notes);
    }

    // ---- 串联与边界 ----

    #[test]
    fn run_chain_accumulates_notes_and_changes() {
        let steps = vec![
            from_id("remove_empty_lines").unwrap(),
            from_id("normalize_line_head").unwrap(),
        ];
        let out = run_chain("甲\n\n乙", &steps).unwrap();
        assert_eq!(out.text, "　　甲\n　　乙");
        assert_eq!(out.changed, 3);
        assert_eq!(out.notes.len(), 2);
    }

    #[test]
    fn empty_input_is_safe_for_every_tool() {
        for meta in catalog() {
            let step = from_id(&meta.id).unwrap();
            let out = run_step("", &step).unwrap();
            assert_eq!(out.text, "", "工具 {} 在空输入下改写了文本", meta.id);
        }
    }

    #[test]
    fn char_width_counts_cjk_as_two() {
        assert_eq!(display_width("甲乙"), 4);
        assert_eq!(display_width("ab"), 2);
        assert_eq!(display_width("　"), 2);
        assert_eq!(display_width("，"), 2);
    }
}
