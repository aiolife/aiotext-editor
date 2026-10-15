//! F-11 偏好设置命令（第八阶段）
//!
//! 三个命令都很轻（一份几 KB 的 JSON），按本项目的既有约定写成 `async fn`
//! 但不再套 `spawn_blocking`（那点 I/O 不值得多一次线程切换）。
//!
//! 前端策略是**改动即存**（防抖 300ms）+ 立即生效，所以没有「取消」语义；
//! `settings_save` 返回**实际落盘的值**（可能已被钳制 / 清洗），前端据此把
//! 自己的状态对齐到磁盘真值。

use crate::core::settings::{self, Settings};

/// 读取设置。
///
/// **永不失败**：文件不存在（首次启动）、不可读、JSON 坏掉、字段越界，
/// 都会得到一份可用的设置（坏字段回落默认值，原文件另存为 `.bad`）。
/// 这是刻意的——设置文件不该有能力让应用起不来。
#[tauri::command]
pub async fn settings_get() -> Settings {
    settings::load()
}

/// 保存设置；返回实际落盘的值（钳制 `fontSize` / `tabWidth`、清洗 `fontFamily` 与快捷键）
#[tauri::command]
pub async fn settings_save(settings: Settings) -> Result<Settings, String> {
    settings::save(&settings).map_err(|e| e.to_string())
}

/// 恢复默认：删掉 `settings.json`（连同可能残留的 `.bad` / `.tmp`），返回默认值
#[tauri::command]
pub async fn settings_reset() -> Result<Settings, String> {
    settings::reset().map_err(|e| e.to_string())
}
