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

/// 批量把**界面文案**转成台湾正体（PRD §3.6 `ui_texts_to_traditional`）
///
/// 与 `convert_opencc` 的分工：那个是 F-03 的文档转换功能（用户数据），这个是给
/// i18n 用的（界面文案）。方向写死 `S2TWP`——界面统一走台湾正体，不做地区选择。
///
/// ## 为什么整批一次转而不是逐条转
///
/// 前端启动时要把全部文案转一遍（约几百条）。逐条 IPC 会来回几百趟，光序列化
/// 开销就比转换本身还贵。整批一次过来，后端一次性转完返回，前端按位置配对成
/// 「原文 → 繁體」映射后缓存，切语言时查表即可，渲染期不再碰 OpenCC。
///
/// ## 首次调用的代价
///
/// `opencc::convert` 首次会展开内嵌数据到临时目录并加载词典（几十毫秒量级），
/// 之后池化复用。所以这个命令**只在前端启动时调一次**，不在切语言时调。
#[tauri::command]
pub async fn ui_texts_to_traditional(texts: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        texts
            .iter()
            .map(|text| crate::core::opencc::convert(&Direction::S2TWP, text).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|e| format!("界面文案转换任务异常：{e}"))?
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
