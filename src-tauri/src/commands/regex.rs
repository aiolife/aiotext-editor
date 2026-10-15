//! 中文增强正则命令（F-05 §5.4）
//!
//! `regex_find` / `regex_replace` 的偏移口径为 **UTF-16 码元**，
//! 前端 CodeMirror 6 可直接用于定位与高亮。

use crate::core::pipelines::PipelineStep;
use crate::core::regex::{self, CategoryInfo, MatchSpan, RegexOptions, RegexReplaceReport};

/// 类目列表（查找对话框的下拉数据源）
#[tauri::command]
pub async fn regex_categories() -> Result<Vec<CategoryInfo>, String> {
    Ok(regex::categories())
}

/// 查找全部命中（含捕获组内容）
#[tauri::command]
pub async fn regex_find(
    text: String,
    pattern: String,
    opts: RegexOptions,
) -> Result<Vec<MatchSpan>, String> {
    tauri::async_runtime::spawn_blocking(move || regex::find(&text, &pattern, &opts))
        .await
        .map_err(|e| format!("查找任务异常：{e}"))?
        .map_err(|e| e.to_string())
}

/// 替换（`\1` 与 `$1` 均可引用捕获组）
///
/// `skip` 跳过前若干个命中（「替换当前这一个」传当前序号）；
/// `limit` 为 None 时替换到底，`limit = 1` 表示只替换一个。
#[tauri::command]
pub async fn regex_replace(
    text: String,
    pattern: String,
    replacement: String,
    opts: RegexOptions,
    skip: Option<usize>,
    limit: Option<usize>,
) -> Result<RegexReplaceReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        regex::replace(
            &text,
            &pattern,
            &replacement,
            &opts,
            skip.unwrap_or(0),
            limit,
        )
    })
    .await
    .map_err(|e| format!("替换任务异常：{e}"))?
    .map_err(|e| e.to_string())
}

/// 对每一个命中套用整理工具（F-09 §6.2：查找替换面板的「使用工具」）
///
/// 与 `regex_replace` 的区别：替换内容不是固定字符串，而是把命中文本
/// 交给整理工具处理后写回；命中之外的内容保持不变。
#[tauri::command]
pub async fn regex_replace_with_tool(
    text: String,
    pattern: String,
    opts: RegexOptions,
    step: PipelineStep,
    skip: Option<usize>,
    limit: Option<usize>,
) -> Result<RegexReplaceReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        regex::replace_with_tool(&text, &pattern, &opts, &step, skip.unwrap_or(0), limit)
    })
    .await
    .map_err(|e| format!("替换任务异常：{e}"))?
    .map_err(|e| e.to_string())
}
