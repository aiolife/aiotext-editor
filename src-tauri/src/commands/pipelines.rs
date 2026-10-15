//! 文本整理工具命令（F-09）
//!
//! 纯文本进、纯文本出：前端「整理」菜单取 [`pipelines_catalog`] 渲染菜单，
//! 选中后把步骤对象交给 [`apply_pipeline_step`] 应用到整篇或选区。
//! 第七阶段批处理会复用同一套步骤（[`apply_pipeline_chain`]）。

use crate::core::pipelines::{self, PipelineStep, StepOutcome, ToolMeta};

/// 工具目录（菜单与选项对话框的数据源）
#[tauri::command]
pub async fn pipelines_catalog() -> Result<Vec<ToolMeta>, String> {
    Ok(pipelines::catalog())
}

/// 应用单个整理工具（`step` 形如 `{"kind":"remove_empty_lines"}`）
#[tauri::command]
pub async fn apply_pipeline_step(text: String, step: PipelineStep) -> Result<StepOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || pipelines::run_step(&text, &step))
        .await
        .map_err(|e| format!("整理任务异常：{e}"))?
        .map_err(|e| e.to_string())
}

/// 串行应用多个整理工具（组合整理 / 批处理共用）
#[tauri::command]
pub async fn apply_pipeline_chain(
    text: String,
    steps: Vec<PipelineStep>,
) -> Result<StepOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || pipelines::run_chain(&text, &steps))
        .await
        .map_err(|e| format!("整理任务异常：{e}"))?
        .map_err(|e| e.to_string())
}
