//! 文件比较命令（F-06 §6.4）
//!
//! `compare_texts` 的偏移口径为 **UTF-16 码元**，前端 CodeMirror 可直接
//! 用于定位与跳转。异体字组表按进程缓存（`core::data_tables`）。

use tauri::Manager;

use crate::core::compare::{self, CompareOptions, CompareReport};
use crate::core::data_tables;
use crate::core::text_diff::{self, DiffResult};
use crate::error::{AppError, AppResult};

/// 同步逐字比较两份文本（忽略项与异体字策略见 `CompareOptions`）
#[tauri::command]
pub async fn compare_texts(
    app: tauri::AppHandle,
    a: String,
    b: String,
    opts: CompareOptions,
) -> Result<CompareReport, String> {
    let run = move || -> AppResult<CompareReport> {
        let resource_dir = app.path().resource_dir().ok();
        let tables = data_tables::get_variant_tables(resource_dir.as_deref())?;
        Ok(compare::compare(&a, &b, &opts, tables))
    };
    tauri::async_runtime::spawn_blocking(run)
        .await
        .map_err(|e| format!("比较任务异常：{e}"))?
        .map_err(|e: AppError| e.to_string())
}

/// 字符级差异（最小编辑脚本）—— **只给「标红」用**
///
/// 与 `compare_texts` 的区别见 `core::text_diff` 的模块注释：这里求的是真正的
/// 编辑脚本，多一个字就只标那一个字，后面恢复对齐的部分不标。
/// F5 跳差异仍旧走 `compare_texts` 的逐字口径（那是 TextPro 的校对口子）。
#[tauri::command]
pub async fn compare_diff(
    app: tauri::AppHandle,
    a: String,
    b: String,
    opts: CompareOptions,
) -> Result<DiffResult, String> {
    let run = move || -> AppResult<DiffResult> {
        let resource_dir = app.path().resource_dir().ok();
        let tables = data_tables::get_variant_tables(resource_dir.as_deref())?;
        Ok(text_diff::diff(&a, &b, &opts, tables))
    };
    tauri::async_runtime::spawn_blocking(run)
        .await
        .map_err(|e| format!("差异任务异常：{e}"))?
        .map_err(|e: AppError| e.to_string())
}
