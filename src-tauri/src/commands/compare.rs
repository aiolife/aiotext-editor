//! 文件比较命令（F-06 §6.4）
//!
//! `compare_texts` 的偏移口径为 **UTF-16 码元**，前端 CodeMirror 可直接
//! 用于定位与跳转。异体字组表按进程缓存（`core::data_tables`）。

use tauri::Manager;

use crate::core::compare::{self, CompareOptions, CompareReport};
use crate::core::data_tables;
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
