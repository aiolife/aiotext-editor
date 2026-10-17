//! 简繁转换命令（F-03 §3.4）
//!
//! 命令层只做参数解析 → 调 core → 构造返回类型。
//! 转换属重 CPU 工作（首次还需加载 OpenCC 词典），统一丢到阻塞线程池，
//! 避免占用 Tauri 的 IPC 线程导致界面卡顿。

use serde::Serialize;

use crate::core::convert::{self, ConvertPreview, ConvertReport, ConvertRequest};
use crate::core::opencc::Direction;

/// 转换方向元数据（UI 菜单数据源）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectionMeta {
    pub id: String,
    pub label: String,
}

/// 列出全部可用转换方向（F-03 §3.4 `list_opencc_directions`）
///
/// PRD v0.5 §3.5：只有 6 种方向（s2t / t2s / s2twp / tw2sp / s2hk / hk2s）——
/// 其余低频方向已从 `Direction` 枚举删除，不需要再区分「常用 / 其他」。
#[tauri::command]
pub async fn list_opencc_directions() -> Result<Vec<DirectionMeta>, String> {
    Ok(Direction::all_standard()
        .into_iter()
        .map(|direction| DirectionMeta {
            id: direction.id(),
            label: direction.label().to_owned(),
        })
        .collect())
}

/// 执行转换（F-03 §3.4 `convert_opencc`）
#[tauri::command]
pub async fn convert_opencc(req: ConvertRequest) -> Result<ConvertReport, String> {
    tauri::async_runtime::spawn_blocking(move || convert::convert(&req))
        .await
        .map_err(|e| format!("转换任务异常：{e}"))?
        .map_err(|e| e.to_string())
}

/// 转换预览：前 N 行差异（F-03 §3.4 `preview_convert`）
#[tauri::command]
pub async fn preview_convert(req: ConvertRequest) -> Result<ConvertPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        convert::preview(&req, convert::PREVIEW_LINE_LIMIT)
    })
    .await
    .map_err(|e| format!("预览任务异常：{e}"))?
    .map_err(|e| e.to_string())
}
