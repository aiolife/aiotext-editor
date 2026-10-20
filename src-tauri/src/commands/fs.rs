//! 文件 I/O 命令（F-02 多编码 I/O）
//!
//! 命令层约定（docs/03-tech-architecture.md §3.2）：
//! 只做参数解析 → 调 core → 构造返回类型，不含业务逻辑。
//!
//! 读与写一律套 `spawn_blocking`：解码 / 编码是**同步**的重活，50 MB 的文件
//! 一次就是几百毫秒，直接跑在异步运行时上会占住调度线程 —— 界面那头会跟着
//! 发木。项目里其它重活（转换 / 比较 / 批处理）本就是这么做的。

use crate::core::encoding::{self, Encoding, SaveOptions};

/// 读取文件：自动探测编码并解码（F-02 §2.2 检测顺序）。
#[tauri::command]
pub async fn fs_read(path: String) -> Result<encoding::LoadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        encoding::read_file(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("读取任务异常：{e}"))?
}

/// 按手选编码重新读取（「重新载入」，F-02 §2.2）。
#[tauri::command]
pub async fn fs_read_with(
    path: String,
    encoding_label: String,
) -> Result<encoding::LoadResult, String> {
    let enc = Encoding::from_label(&encoding_label)
        .ok_or_else(|| format!("不支持的编码：{encoding_label}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        encoding::read_file_with(&path, enc).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("读取任务异常：{e}"))?
}

/// 保存前预检：定位目标编码不可表示的字符（F-02 §2.4）。
#[tauri::command]
pub async fn fs_check_mappable(
    text: String,
    encoding_label: String,
) -> Result<Vec<encoding::UnmappableChar>, String> {
    let enc = Encoding::from_label(&encoding_label)
        .ok_or_else(|| format!("不支持的编码：{encoding_label}"))?;
    tauri::async_runtime::spawn_blocking(move || encoding::check_mappable(&text, enc))
        .await
        .map_err(|e| format!("预检任务异常：{e}"))
}

/// 编码写出文件（F-02 §2.4 `fs_write`）。
///
/// `UnmappablePolicy::Ask` 且存在不可编码字符时返回错误，
/// 前端据此弹窗供用户决策后，以 CharRef / ToUtf8 重调本命令。
#[tauri::command]
pub async fn fs_write(
    path: String,
    text: String,
    opts: SaveOptions,
) -> Result<encoding::SaveReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        encoding::write_file(&path, &text, opts).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("写出任务异常：{e}"))?
}
