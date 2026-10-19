//! 文件比较命令（F-06 §6.4）
//!
//! 比较只有**一个口径**：`core::text_diff` 求的最小编辑脚本 —— 差异计数、F5
//! 跳差异、标红，全都用这一份结果，屏幕上看到的数量与工具条上的数字必然一致。
//! 偏移口径为 **UTF-16 码元**，前端 CodeMirror 可直接用于定位与跳转。
//! 异体字组表按进程缓存（`core::data_tables`）。

use tauri::Manager;

use crate::core::compare::CompareOptions;
use crate::core::data_tables;
use crate::core::text_diff::{self, DiffResult};
use crate::error::{AppError, AppResult};

/// 求两份文本的差异
///
/// 相邻的「缺 + 多」已经并成一「处」，所以这里的块数就是界面上说的「N 处」。
/// `degraded` 为真表示文本过大或差异过密，结果只是近似 —— UI 会照实说明。
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
